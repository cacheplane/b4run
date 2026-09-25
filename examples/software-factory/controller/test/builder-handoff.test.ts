import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSourceBundle, verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import {
  builderHandoffOf,
  refuseRetiredVariables,
  stagedBuilderWorkspace,
  BuilderHandoffSchema as TheBuildersHandoffSchema,
} from "../../server/src/builder-handoff.ts"
import {
  BuilderHandoffSchema,
  captureBuilderHandoff,
  stagedReferenceOf,
} from "../src/lib/builder-handoff.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { imageTag } from "../src/lib/targets/images.ts"
import { builderPermissions } from "../src/lib/targets/permissions.ts"
import { targetSandboxPolicy } from "../src/lib/targets/workspace.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe("captureBuilderHandoff", () => {
  it("carries the work order, the task, the target and the reference its workspace is staged under, no prompt", async () => {
    const app = tempDir("factory-handoff-app-")
    const task = loadTask("cli-flags")
    const { handoff, workspace } = await captureBuilderHandoff(task, {
      workOrderId: "wo-0123456789abcdef",
      captureRoot: app,
    })
    // The prompt is the run's user message; the handoff does not carry a second copy, and the
    // workspace's files travel as the upload, not in the handoff.
    expect(Object.keys(handoff).sort()).toEqual([
      "target",
      "targetId",
      "taskId",
      "version",
      "workOrderId",
      "workspace",
    ])
    expect(handoff.version).toBe(3)
    expect(handoff.target).toEqual({
      image: imageTag(task.target),
      pin: task.target.pin,
      policy: targetSandboxPolicy(task.target),
      permissions: builderPermissions(task.target),
    })
    expect(TheBuildersHandoffSchema.parse(handoff)).toEqual(BuilderHandoffSchema.parse(handoff))
    expect(handoff).toMatchObject({
      workOrderId: "wo-0123456789abcdef",
      taskId: "cli-flags",
      targetId: task.target.id,
    })
    // The handoff names exactly the reference the thread is created with.
    expect(handoff.workspace).toEqual(stagedReferenceOf(workspace))
    const verified = verifyCapturedWorkspaceDefinition(workspace)
    expect(handoff.workspace.sourceDigest).toBe(verified.source.digest)
    expect(verified.source.files.some((f) => f.path === "TASK.md")).toBe(true)
    // The capture carries the target's dependency-tree links, not just its files: a builder
    // handed a bundle without them cannot run the target's commands.
    expect(handoff.workspace.environmentLinks.map((link) => link.path)).toEqual(
      task.target.environmentLinks.map((link) => link.path).sort(),
    )
    expect(handoff.workspace.baseline).toBe("git")
    // The builder's own check accepts what the controller captured.
    expect(stagedBuilderWorkspace(workspace, handoff).source.digest).toBe(
      handoff.workspace.sourceDigest,
    )
    // The staging directory was the call's own, and is gone.
    expect(readdirSync(join(app, "captures", "builder"))).toEqual([])
  })

  it("defaults the work order to the task, and two work orders of one task share the bytes", async () => {
    const app = tempDir("factory-handoff-app-")
    const task = loadTask("cli-flags")
    const [first, second, third] = await Promise.all([
      captureBuilderHandoff(task, { captureRoot: app }),
      captureBuilderHandoff(task, { workOrderId: "wo-a", captureRoot: app }),
      captureBuilderHandoff(task, { workOrderId: "wo-b", captureRoot: app }),
    ])
    expect(first?.handoff.workOrderId).toBe("cli-flags")
    // Concurrent captures of one task each staged in their own directory, so each read the
    // same pinned bytes rather than a directory another was renaming into place.
    expect(new Set([first, second, third].map((c) => c?.handoff.workspace.sourceDigest)).size).toBe(
      1,
    )
  })

  it("refuses a work order id that is not a catalog id", async () => {
    await expect(
      captureBuilderHandoff(loadTask("cli-flags"), {
        workOrderId: "../escape",
        captureRoot: tempDir("factory-handoff-app-"),
      }),
    ).rejects.toThrow(/catalog id/)
  })
})

const DIGEST_SOURCE = createSourceBundle([
  { path: "a.ts", bytes: new TextEncoder().encode("a"), executable: false },
])
const handoff = {
  version: 3,
  workOrderId: "wo-1",
  taskId: "cli-flags",
  targetId: "cli-flags",
  workspace: { sourceDigest: DIGEST_SOURCE.digest, environmentLinks: [], baseline: "git" },
  target: {
    image: `b4-factory-cli-flags:${"a".repeat(12)}-${"b".repeat(12)}`,
    pin: "a".repeat(40),
    policy: {
      network: { mode: "deny" },
      env: {},
      resources: { memoryMb: 1024, cpus: 1, timeoutMs: 60_000 },
    },
    permissions: { bash: ["node "] },
  },
}
const staged = {
  version: 1 as const,
  source: DIGEST_SOURCE,
  environmentLinks: [],
  baseline: "git" as const,
}

describe("the builder's handoff", () => {
  it("reads factoryBuilder strictly from the thread's metadata", () => {
    expect(
      builderHandoffOf({
        factoryWorkOrderId: "wo-1",
        factoryBuilder: handoff,
        route: "/build#agent",
      }),
    ).toEqual(handoff)
    expect(() => builderHandoffOf({ factoryWorkOrderId: "wo-1" })).toThrow(
      /factoryBuilder is required/,
    )
    expect(() => builderHandoffOf({ factoryWorkOrderId: "wo-2", factoryBuilder: handoff })).toThrow(
      /names work order wo-1/,
    )
    expect(() =>
      builderHandoffOf({
        factoryWorkOrderId: "wo-1",
        factoryBuilder: { ...handoff, target: { ...handoff.target, netwrok: 1 } },
      }),
    ).toThrow(/factoryBuilder is invalid/)
    expect(() =>
      builderHandoffOf({
        factoryWorkOrderId: "wo-1",
        factoryBuilder: { ...handoff, workspace: { ...handoff.workspace, source: {} } },
      }),
    ).toThrow(/factoryBuilder is invalid/)
    // A key inherited, not the metadata's own, is not a handoff.
    expect(() =>
      builderHandoffOf(
        Object.assign(Object.create({ factoryBuilder: handoff }), { factoryWorkOrderId: "wo-1" }),
      ),
    ).toThrow(/factoryBuilder is required/)
  })

  it("serves only the staged workspace the handoff names", () => {
    expect(stagedBuilderWorkspace(staged, handoff as never).source.digest).toBe(
      DIGEST_SOURCE.digest,
    )
    expect(() => stagedBuilderWorkspace(undefined, handoff as never)).toThrow(
      /without a staged workspace/,
    )
    for (const workspace of [
      { ...handoff.workspace, sourceDigest: "f".repeat(64) },
      { ...handoff.workspace, environmentLinks: [{ path: "node_modules", target: "/opt/deps" }] },
      { sourceDigest: DIGEST_SOURCE.digest, environmentLinks: [] },
    ])
      expect(() => stagedBuilderWorkspace(staged, { ...handoff, workspace } as never)).toThrow(
        /is not the one work order wo-1 names/,
      )
  })

  it("matches links named in any order: the staged workspace's are sorted by path", () => {
    const links = [
      { path: "node_modules", target: "/deps/node_modules" },
      { path: "b-cache", target: "/deps/cache" },
    ]
    const sorted = [...links].sort((a, b) => (a.path < b.path ? -1 : 1))
    const linked = verifyCapturedWorkspaceDefinition({ ...staged, environmentLinks: sorted })
    expect(linked.environmentLinks.map((link) => link.path)).toEqual(["b-cache", "node_modules"])
    const unsorted = { ...handoff, workspace: { ...handoff.workspace, environmentLinks: links } }
    expect(stagedBuilderWorkspace(linked, unsorted as never).environmentLinks).toEqual(sorted)
    // Order is the only freedom: a target that differs is still another workspace.
    const retargeted = [links[0], { path: "b-cache", target: "/deps/other" }]
    expect(() =>
      stagedBuilderWorkspace(linked, {
        ...handoff,
        workspace: { ...handoff.workspace, environmentLinks: retargeted },
      } as never),
    ).toThrow(/is not the one work order wo-1 names/)
  })

  it("refuses the retired variables by name", () => {
    expect(() => refuseRetiredVariables({ FACTORY_BUILDER_MANIFEST_DIR: "/m" })).toThrow(
      /FACTORY_BUILDER_MANIFEST_DIR is retired/,
    )
    expect(() => refuseRetiredVariables({ FACTORY_BUILDER_TARGET: "x" })).toThrow(
      /FACTORY_BUILDER_TARGET is retired/,
    )
    expect(() => refuseRetiredVariables({})).not.toThrow()
  })
})

describe("the handoff's target block", () => {
  const good = () => ({
    version: 3,
    workOrderId: "wo-a",
    taskId: "cli-flags",
    targetId: "cli-flags",
    workspace: { sourceDigest: "c".repeat(64), environmentLinks: [], baseline: "git" },
    target: {
      image: "b4-factory-cli-flags:6a59e00aed46-0123456789ab",
      pin: `6a59e00aed46${"0".repeat(28)}`,
      policy: {
        network: { mode: "deny" },
        env: {},
        resources: { memoryMb: 1024, cpus: 1, timeoutMs: 60_000 },
      },
      permissions: { bash: ["npm test"] } as Record<string, string[]>,
    },
  })
  type Handoff = ReturnType<typeof good>
  const withTarget = (m: Handoff, target: Record<string, unknown>) => ({
    ...m,
    target: { ...m.target, ...target },
  })
  const withPolicy = (m: Handoff, policy: Record<string, unknown>) =>
    withTarget(m, { policy: { ...m.target.policy, ...policy } })
  const withWorkspace = (m: Handoff, workspace: Record<string, unknown>) => ({
    ...m,
    workspace: { ...m.workspace, ...workspace },
  })

  it("parses what the controller sends", () => {
    expect(() => BuilderHandoffSchema.parse(good())).not.toThrow()
    expect(() => TheBuildersHandoffSchema.parse(good())).not.toThrow()
  })
  it.each([
    ["an open network", (m: Handoff) => withPolicy(m, { network: { mode: "allow" } })],
    [
      "a network list",
      (m: Handoff) => withPolicy(m, { network: { mode: "deny", allowlist: ["10.0.0.0/8"] } }),
    ],
    [
      "an image that is not the factory's",
      (m: Handoff) => withTarget(m, { image: "alpine:latest" }),
    ],
    [
      "a factory-named image under a floating tag",
      (m: Handoff) => withTarget(m, { image: "b4-factory-cli-flags:latest" }),
    ],
    ["a security key", (m: Handoff) => withPolicy(m, { security: {} })],
    [
      "a disk size",
      (m: Handoff) => withPolicy(m, { resources: { ...m.target.policy.resources, diskGb: 10 } }),
    ],
    ["an empty pattern", (m: Handoff) => withTarget(m, { permissions: { bash: [""] } })],
    ["a whitespace-only pattern", (m: Handoff) => withTarget(m, { permissions: { bash: ["  "] } })],
    ["an unknown target key", (m: Handoff) => withTarget(m, { scope: "elsewhere" })],
    ["version 2, the manifest's", (m: Handoff) => ({ ...m, version: 2 })],
    [
      "another target's image",
      (m: Handoff) => withTarget(m, { image: "b4-factory-devkit:6a59e00aed46-0123456789ab" }),
    ],
    [
      "its own target's image at another pin",
      (m: Handoff) => withTarget(m, { image: "b4-factory-cli-flags:bfaf0c2b3030-0123456789ab" }),
    ],
    ["no workspace", (m: Handoff) => ({ ...m, workspace: undefined })],
    ["a workspace digest that is not one", (m: Handoff) => withWorkspace(m, { sourceDigest: "x" })],
    ["a baseline other than git", (m: Handoff) => withWorkspace(m, { baseline: "none" })],
    ["an unknown workspace key", (m: Handoff) => withWorkspace(m, { files: [] })],
    [
      "a link with an unknown key",
      (m: Handoff) =>
        withWorkspace(m, { environmentLinks: [{ path: "a", target: "/b", mode: 1 }] }),
    ],
  ])("refuses %s", (_name, edit) => {
    expect(() => BuilderHandoffSchema.parse(edit(good()))).toThrow()
    expect(() => TheBuildersHandoffSchema.parse(edit(good()))).toThrow()
  })
})

describe("the builder's copy of the schemas", () => {
  it("is identical, both schemas and the catalog-id rule they name", () => {
    const here = readFileSync(new URL("../src/lib/builder-handoff.ts", import.meta.url), "utf8")
    const there = readFileSync(
      new URL("../../server/src/builder-handoff.ts", import.meta.url),
      "utf8",
    )
    const schemas = (text: string) =>
      text.slice(
        text.indexOf("export const BuilderHandoffSchema"),
        text.indexOf("export type BuilderHandoff ="),
      )
    const block = schemas(here)
    expect(block).toContain("export const BuilderHandoffSchema")
    expect(block).toContain("target: z")
    expect(block).toContain("workspace: z")
    expect(schemas(there)).toBe(block)
    const rule = (text: string, name: string) =>
      text.match(new RegExp(`^const ${name} = (.*)$`, "m"))?.[1]
    for (const name of ["CATALOG_ID", "FACTORY_IMAGE"]) {
      expect(rule(here, name)).toBeDefined()
      expect(rule(there, name)).toBe(rule(here, name))
    }
  })
})
