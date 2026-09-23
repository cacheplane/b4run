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
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { DrafterManifestSchema as TheDraftersSchema } from "../../drafter/src/drafter-manifest.ts"
import { DrafterManifestSchema, writeDrafterManifest } from "../src/lib/drafter-manifest.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()

/** A small repository the include rules select three files from. */
function repo(): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-drafter-manifest-repo-"))
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

function appRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-drafter-manifest-app-"))
  dirs.push(dir)
  return dir
}

describe("writeDrafterManifest", () => {
  it("stages, captures and writes the work order's manifest, then removes the staging", async () => {
    const { root, pin } = repo()
    const app = appRoot()
    const dir = join(app, "manifests", "nested")
    const result = await writeDrafterManifest({
      workOrderId: WORK_ORDER,
      pin,
      repositoryRoot: root,
      dir,
      appRoot: app,
      signal: new AbortController().signal,
    })
    expect(result.path).toBe(join(dir, `${WORK_ORDER}.json`))
    expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    const text = readFileSync(result.path, "utf8")
    expect(text.endsWith("\n")).toBe(true)
    const raw = JSON.parse(text)
    expect(text).toBe(`${JSON.stringify(raw, null, 2)}\n`)
    expect(raw).toMatchObject({ version: 1, workOrderId: WORK_ORDER })
    expect("baseline" in raw.workspace).toBe(false)
    // The drafter's OWN schema accepts what the controller wrote.
    const manifest = TheDraftersSchema.parse(raw)
    expect(manifest.workspace.source.digest).toBe(result.sourceDigest)
    const workspace = verifyCapturedWorkspaceDefinition(manifest.workspace)
    expect(workspace.source.files.map((f) => f.path)).toEqual([
      "repo/package.json",
      "repo/packages/cli/package.json",
      "repo/packages/cli/src/index.ts",
    ])
    expect(workspace.environmentLinks).toEqual([])
    // The staging instance directory is gone: the bytes live in the manifest now.
    const captures = join(app, ".factory", "captures", "drafter")
    expect(existsSync(captures) ? readdirSync(captures) : []).toEqual([])
  })

  it("is deterministic: the same inputs give the same source digest", async () => {
    const { root, pin } = repo()
    const app = appRoot()
    const options = {
      workOrderId: WORK_ORDER,
      pin,
      repositoryRoot: root,
      dir: join(app, "m"),
      appRoot: app,
    }
    const first = await writeDrafterManifest(options)
    const second = await writeDrafterManifest(options)
    expect(second.sourceDigest).toBe(first.sourceDigest)
    expect(second.path).toBe(first.path)
  })

  it("refuses a work order id that is not a catalog id before touching git", async () => {
    await expect(
      writeDrafterManifest({
        workOrderId: "../x",
        pin: "0".repeat(40),
        repositoryRoot: "/nonexistent",
        dir: join(appRoot(), "m"),
      }),
    ).rejects.toThrow(/workOrderId/)
  })

  it("keeps the drafter's copy of the schema identical", () => {
    const here = readFileSync(new URL("../src/lib/drafter-manifest.ts", import.meta.url), "utf8")
    const there = readFileSync(
      new URL("../../drafter/src/drafter-manifest.ts", import.meta.url),
      "utf8",
    )
    const schema = (text: string) =>
      text.slice(
        text.indexOf("export const DrafterManifestSchema"),
        text.indexOf("export type DrafterManifest"),
      )
    expect(schema(here).length).toBeGreaterThan(0)
    expect(schema(there)).toBe(schema(here))
    // And the controller's copy parses what it wrote, like the drafter's does.
    expect(DrafterManifestSchema).toBeDefined()
  })
})
