import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { BuilderManifestSchema as TheBuildersManifestSchema } from "../../server/src/builder-manifest.ts"
import { BuilderManifestSchema, writeBuilderManifest } from "../src/lib/builder-manifest.ts"
import { imageTag, loadTask } from "../src/lib/targets/catalog.ts"
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

describe("builder manifest", () => {
  it("is named by the work order and carries the workspace, the task and the target, no prompt", async () => {
    const dir = tempDir("factory-manifest-")
    const app = tempDir("factory-manifest-app-")
    const task = loadTask("cli-flags")
    const written = await writeBuilderManifest(task, dir, {
      workOrderId: "wo-0123456789abcdef",
      captureRoot: app,
    })
    // The resolver reads `<dir>/<metadata.factoryWorkOrderId>.json`, so the file name is the
    // work order's, not the task's: two work orders of one task are two manifests.
    expect(written.path).toBe(join(dir, "wo-0123456789abcdef.json"))
    const raw = JSON.parse(readFileSync(written.path, "utf8"))
    // The prompt is the run's user message; the manifest does not carry a second copy.
    expect(Object.keys(raw).sort()).toEqual([
      "target",
      "targetId",
      "taskId",
      "version",
      "workOrderId",
      "workspace",
    ])
    // The manifest carries the target whole: the image the task is verified in, the pin it was
    // prepared at, the sandbox policy and the allow-list, which the builder records as the
    // thread's sandbox at its first admission.
    expect(raw.version).toBe(2)
    expect(raw.target).toEqual({
      image: imageTag(task.target),
      pin: task.target.pin,
      policy: targetSandboxPolicy(task.target),
      permissions: builderPermissions(task.target),
    })
    const manifest = BuilderManifestSchema.parse(raw)
    expect(TheBuildersManifestSchema.parse(raw)).toEqual(manifest)
    expect(manifest).toMatchObject({
      workOrderId: "wo-0123456789abcdef",
      taskId: "cli-flags",
      targetId: task.target.id,
    })
    const workspace = verifyCapturedWorkspaceDefinition(manifest.workspace)
    expect(written.sourceDigest).toBe(workspace.source.digest)
    expect(workspace.source.files.some((f) => f.path === "TASK.md")).toBe(true)
    // The capture carries the target's dependency-tree links, not just its files: a builder
    // handed a bundle without them cannot run the target's commands.
    expect(workspace.environmentLinks.map((link) => link.path)).toEqual(
      task.target.environmentLinks.map((link) => link.path).sort(),
    )
    expect(workspace.baseline).toBe("git")
    // The staging directory was the call's own, and is gone: nothing of the target is left
    // under the capture root beside the manifest.
    expect(readdirSync(join(app, "captures", "builder"))).toEqual([])
  })

  it("defaults the work order to the task, and two work orders of one task share the bytes", async () => {
    const dir = tempDir("factory-manifest-")
    const app = tempDir("factory-manifest-app-")
    const task = loadTask("cli-flags")
    const [first, second, third] = await Promise.all([
      writeBuilderManifest(task, dir, { captureRoot: app }),
      writeBuilderManifest(task, dir, { workOrderId: "wo-a", captureRoot: app }),
      writeBuilderManifest(task, dir, { workOrderId: "wo-b", captureRoot: app }),
    ])
    expect(first?.path).toBe(join(dir, "cli-flags.json"))
    expect(readdirSync(dir).sort()).toEqual(["cli-flags.json", "wo-a.json", "wo-b.json"])
    // Concurrent captures of one task each staged in their own directory, so each read the
    // same pinned bytes rather than a directory another was renaming into place.
    expect(new Set([first, second, third].map((w) => w?.sourceDigest)).size).toBe(1)
  })

  it("refuses a work order id that is not a catalog id", async () => {
    const dir = tempDir("factory-manifest-")
    await expect(
      writeBuilderManifest(loadTask("cli-flags"), dir, {
        workOrderId: "../escape",
        captureRoot: tempDir("factory-manifest-app-"),
      }),
    ).rejects.toThrow(/catalog id/)
    expect(readdirSync(dir)).toEqual([])
  })

  it("replaces a manifest atomically, leaving no temporary file beside it", async () => {
    const dir = tempDir("factory-manifest-")
    const app = tempDir("factory-manifest-app-")
    const task = loadTask("cli-flags")
    await writeBuilderManifest(task, dir, { workOrderId: "wo-a", captureRoot: app })
    // A second write of the same work order (a redispatch) renames over the first: a
    // resolver reading at that moment sees one whole file or the other.
    await writeBuilderManifest(task, dir, { workOrderId: "wo-a", captureRoot: app })
    expect(readdirSync(dir)).toEqual(["wo-a.json"])
    expect(existsSync(join(dir, "wo-a.json"))).toBe(true)
  })
})

describe("the manifest's target block", () => {
  const good = () => ({
    version: 2,
    workOrderId: "wo-a",
    taskId: "cli-flags",
    targetId: "cli-flags",
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
    workspace: {},
  })
  type Manifest = ReturnType<typeof good>
  const withTarget = (m: Manifest, target: Record<string, unknown>) => ({
    ...m,
    target: { ...m.target, ...target },
  })
  const withPolicy = (m: Manifest, policy: Record<string, unknown>) =>
    withTarget(m, { policy: { ...m.target.policy, ...policy } })

  it("parses what the controller writes", () => {
    expect(() => BuilderManifestSchema.parse(good())).not.toThrow()
    expect(() => TheBuildersManifestSchema.parse(good())).not.toThrow()
  })
  it.each([
    ["an open network", (m: Manifest) => withPolicy(m, { network: { mode: "allow" } })],
    [
      "a network list",
      (m: Manifest) => withPolicy(m, { network: { mode: "deny", allowlist: ["10.0.0.0/8"] } }),
    ],
    [
      "an image that is not the factory's",
      (m: Manifest) => withTarget(m, { image: "alpine:latest" }),
    ],
    [
      "a factory-named image under a floating tag",
      (m: Manifest) => withTarget(m, { image: "b4-factory-cli-flags:latest" }),
    ],
    ["a security key", (m: Manifest) => withPolicy(m, { security: {} })],
    [
      "a disk size",
      (m: Manifest) => withPolicy(m, { resources: { ...m.target.policy.resources, diskGb: 10 } }),
    ],
    ["an empty pattern", (m: Manifest) => withTarget(m, { permissions: { bash: [""] } })],
    [
      "a whitespace-only pattern",
      (m: Manifest) => withTarget(m, { permissions: { bash: ["  "] } }),
    ],
    ["an unknown target key", (m: Manifest) => withTarget(m, { scope: "elsewhere" })],
    ["version 1", (m: Manifest) => ({ ...m, version: 1 })],
    [
      "another target's image",
      (m: Manifest) => withTarget(m, { image: "b4-factory-devkit:6a59e00aed46-0123456789ab" }),
    ],
    [
      "its own target's image at another pin",
      (m: Manifest) => withTarget(m, { image: "b4-factory-cli-flags:bfaf0c2b3030-0123456789ab" }),
    ],
  ])("refuses %s", (_name, edit) => {
    expect(() => BuilderManifestSchema.parse(edit(good()))).toThrow()
    expect(() => TheBuildersManifestSchema.parse(edit(good()))).toThrow()
  })
})

describe("the builder's copy of the schemas", () => {
  it("is identical, both schemas and the catalog-id rule they name", () => {
    const here = readFileSync(new URL("../src/lib/builder-manifest.ts", import.meta.url), "utf8")
    const there = readFileSync(
      new URL("../../server/src/builder-manifest.ts", import.meta.url),
      "utf8",
    )
    const schemas = (text: string) =>
      text.slice(
        text.indexOf("export const BuilderManifestSchema"),
        text.indexOf("export type BuilderManifest ="),
      )
    const block = schemas(here)
    expect(block).toContain("export const BuilderManifestSchema")
    expect(block).toContain("target: z")
    expect(schemas(there)).toBe(block)
    const rule = (text: string, name: string) =>
      text.match(new RegExp(`^const ${name} = (.*)$`, "m"))?.[1]
    for (const name of ["CATALOG_ID", "FACTORY_IMAGE"]) {
      expect(rule(here, name)).toBeDefined()
      expect(rule(there, name)).toBe(rule(here, name))
    }
  })
})
