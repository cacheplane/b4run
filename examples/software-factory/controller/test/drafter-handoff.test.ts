import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSourceBundle, verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import {
  drafterHandoffOf,
  refuseRetiredVariables,
  stagedDrafterWorkspace,
  DrafterHandoffSchema as TheDraftersSchema,
} from "../../drafter/src/drafter-handoff.ts"
import { stagedReferenceOf } from "../src/lib/builder-handoff.ts"
import { captureDrafterHandoff, DrafterHandoffSchema } from "../src/lib/drafter-handoff.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()

/** A small repository the include rules select three files from. */
function repo(): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-drafter-handoff-repo-"))
  dirs.push(root)
  git(root, "init", "-q")
  git(root, "config", "user.email", "t@example.com")
  git(root, "config", "user.name", "t")
  mkdirSync(join(root, "packages", "cli", "src"), { recursive: true })
  writeFileSync(join(root, "package.json"), "{}\n")
  writeFileSync(join(root, "packages", "cli", "package.json"), "{}\n")
  writeFileSync(join(root, "packages", "cli", "src", "index.ts"), "export const a = 1\n")
  writeFileSync(join(root, "README.md"), "not captured\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "one")
  return { root, pin: git(root, "rev-parse", "HEAD") }
}

const WORK_ORDER = "wo-0123456789abcdef"

function captureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-drafter-handoff-app-"))
  dirs.push(dir)
  return dir
}

describe("captureDrafterHandoff", () => {
  it("stages and captures the work order's workspace, names it in the handoff, and removes the staging", async () => {
    const { root, pin } = repo()
    const app = captureRoot()
    const { handoff, workspace } = await captureDrafterHandoff({
      workOrderId: WORK_ORDER,
      pin,
      repositoryRoot: root,
      captureRoot: app,
      signal: new AbortController().signal,
    })
    expect(handoff).toEqual({
      version: 2,
      workOrderId: WORK_ORDER,
      workspace: { sourceDigest: workspace.source.digest, environmentLinks: [] },
    })
    // The handoff names exactly the reference the thread is created with, with no baseline.
    expect(handoff.workspace).toEqual(stagedReferenceOf(workspace))
    expect("baseline" in workspace).toBe(false)
    // The drafter's OWN schema accepts what the controller sends, and its own check the capture.
    expect(TheDraftersSchema.parse(handoff)).toEqual(handoff)
    expect(stagedDrafterWorkspace(workspace, handoff).source.digest).toBe(workspace.source.digest)
    const verified = verifyCapturedWorkspaceDefinition(workspace)
    expect(verified.source.files.map((f) => f.path)).toEqual([
      "repo/package.json",
      "repo/packages/cli/package.json",
      "repo/packages/cli/src/index.ts",
    ])
    // The staging instance directory is gone: the bytes live in the capture now.
    const captures = join(app, "captures", "drafter")
    expect(existsSync(captures) ? readdirSync(captures) : []).toEqual([])
  })

  it("is deterministic: the same inputs give the same source digest", async () => {
    const { root, pin } = repo()
    const app = captureRoot()
    const options = { workOrderId: WORK_ORDER, pin, repositoryRoot: root, captureRoot: app }
    const first = await captureDrafterHandoff(options)
    const second = await captureDrafterHandoff(options)
    expect(second.handoff.workspace.sourceDigest).toBe(first.handoff.workspace.sourceDigest)
  })

  it("refuses a work order id that is not a catalog id before touching git", async () => {
    await expect(
      captureDrafterHandoff({
        workOrderId: "../x",
        pin: "0".repeat(40),
        repositoryRoot: "/nonexistent",
        captureRoot: captureRoot(),
      }),
    ).rejects.toThrow(/workOrderId/)
  })

  it("with an already-aborted signal, captures nothing and leaves no staging behind", async () => {
    const { root, pin } = repo()
    const app = captureRoot()
    const controller = new AbortController()
    controller.abort()
    await expect(
      captureDrafterHandoff({
        workOrderId: WORK_ORDER,
        pin,
        repositoryRoot: root,
        captureRoot: app,
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(existsSync(join(app, "captures"))).toBe(false)
  })
})

const SOURCE = createSourceBundle([
  { path: "repo/a.ts", bytes: new TextEncoder().encode("a"), executable: false },
])
const handoff = {
  version: 2 as const,
  workOrderId: "wo-1",
  workspace: { sourceDigest: SOURCE.digest, environmentLinks: [] },
}
const staged = { version: 1 as const, source: SOURCE, environmentLinks: [] }

describe("the drafter's handoff", () => {
  it("reads factoryDrafter strictly from the thread's metadata", () => {
    expect(
      drafterHandoffOf({
        factoryWorkOrderId: "wo-1",
        factoryStage: "intake",
        factoryDrafter: handoff,
      }),
    ).toEqual(handoff)
    expect(() => drafterHandoffOf({ factoryWorkOrderId: "wo-1" })).toThrow(
      /factoryDrafter is required/,
    )
    expect(() => drafterHandoffOf({ factoryWorkOrderId: "wo-2", factoryDrafter: handoff })).toThrow(
      /names work order wo-1/,
    )
    expect(() =>
      drafterHandoffOf({ factoryWorkOrderId: "wo-1", factoryDrafter: { ...handoff, extra: 1 } }),
    ).toThrow(/factoryDrafter is invalid/)
    expect(() =>
      drafterHandoffOf({
        factoryWorkOrderId: "wo-1",
        factoryDrafter: { ...handoff, workspace: { ...handoff.workspace, baseline: "git" } },
      }),
    ).toThrow(/factoryDrafter is invalid/)
    expect(() => drafterHandoffOf({ factoryWorkOrderId: "../x", factoryDrafter: handoff })).toThrow(
      /catalog id/,
    )
  })

  it("serves only the staged workspace the handoff names, and never one with a baseline", () => {
    expect(stagedDrafterWorkspace(staged, handoff).source.digest).toBe(SOURCE.digest)
    expect(() => stagedDrafterWorkspace(undefined, handoff)).toThrow(/without a staged workspace/)
    expect(() => stagedDrafterWorkspace({ ...staged, baseline: "git" }, handoff)).toThrow(
      /carries no baseline/,
    )
    for (const workspace of [
      { ...handoff.workspace, sourceDigest: "f".repeat(64) },
      { ...handoff.workspace, environmentLinks: [{ path: "node_modules", target: "/opt/deps" }] },
    ])
      expect(() => stagedDrafterWorkspace(staged, { ...handoff, workspace })).toThrow(
        /is not the one work order wo-1 names/,
      )
  })

  it("refuses the retired manifest directory by name", () => {
    expect(() => refuseRetiredVariables({ FACTORY_DRAFTER_MANIFEST_DIR: "/m" })).toThrow(
      /FACTORY_DRAFTER_MANIFEST_DIR is retired/,
    )
    expect(() => refuseRetiredVariables({})).not.toThrow()
  })
})

describe("the drafter's copy of the schema", () => {
  it("keeps the drafter's copy of the schema identical", () => {
    const here = readFileSync(new URL("../src/lib/drafter-handoff.ts", import.meta.url), "utf8")
    const there = readFileSync(
      new URL("../../drafter/src/drafter-handoff.ts", import.meta.url),
      "utf8",
    )
    const schema = (text: string) =>
      text.slice(
        text.indexOf("export const DrafterHandoffSchema"),
        text.indexOf("export type DrafterHandoff"),
      )
    expect(schema(here).length).toBeGreaterThan(0)
    expect(schema(there)).toBe(schema(here))
    // The schema names CATALOG_ID, so the two regex sources must agree too.
    const catalogId = (text: string) => text.match(/^const CATALOG_ID = (.*)$/m)?.[1]
    expect(catalogId(here)).toBeDefined()
    expect(catalogId(there)).toBe(catalogId(here))
    // And the controller's copy parses what it sends, like the drafter's does.
    expect(DrafterHandoffSchema.parse(handoff)).toEqual(TheDraftersSchema.parse(handoff))
  })
})
