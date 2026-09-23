import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import {
  BuilderManifestSchema as TheBuildersManifestSchema,
  BuilderTargetSchema as TheBuildersTargetSchema,
} from "../../server/src/builder-manifest.ts"
import {
  BuilderManifestSchema,
  BuilderTargetSchema,
  removeBuilderManifestFile,
  writeBuilderManifest,
  writeBuilderTarget,
} from "../src/lib/builder-manifest.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { builderPermissions } from "../src/lib/targets/permissions.ts"
import { builderSandboxScope, targetSandboxPolicy } from "../src/lib/targets/workspace.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe("builder target", () => {
  it("writes the per-process half of the builder's config, as data", async () => {
    const dir = tempDir("factory-target-")
    const task = loadTask("cli-flags")
    const path = await writeBuilderTarget(task.target, dir)
    expect(path).toBe(join(dir, `${task.target.id}.target.json`))
    const file = BuilderTargetSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    expect(file.target.id).toBe(task.target.id)
    // `builderSandboxProvider` passes dockerSandbox exactly `scope` and `image` and nothing
    // else, so those two fields are the whole provider the builder must reconstruct. Asserted
    // against the same constructors the controller uses, so a third option added there
    // without a field here fails rather than silently changing the builder's SandboxConfig.
    expect(file.target.scope).toBe(builderSandboxScope)
    expect(file.target.image).toMatch(/^b4-factory-/)
    expect(file.target.policy).toEqual(targetSandboxPolicy(task.target))
    expect(file.target.permissions).toEqual(builderPermissions(task.target))
    // The builder's own copy of the schema accepts it: it is the file the builder boots from.
    expect(TheBuildersTargetSchema.parse(file)).toEqual(file)
  })

  it("refuses a drifted policy key rather than dropping it", async () => {
    const dir = tempDir("factory-target-")
    const path = await writeBuilderTarget(loadTask("cli-flags").target, dir)
    const good = JSON.parse(readFileSync(path, "utf8"))
    expect(good.target.policy.network.mode).toBe("deny")

    // A typo one level down. Without `.strict()` both of these parse, `network` (or its
    // `mode`) is absent from what reaches `b4.config.ts`, and the builder runs under the
    // provider's DEFAULT network instead of the denial the controller wrote: a fail-open on
    // a misspelling. Each must be an error instead.
    const drifted = (mutate: (policy: Record<string, unknown>) => void) => {
      const file = JSON.parse(JSON.stringify(good))
      mutate(file.target.policy)
      return () => BuilderTargetSchema.parse(file)
    }
    expect(
      drifted((policy) => {
        policy.netwrok = policy.network
        delete policy.network
      }),
    ).toThrow()
    expect(
      drifted((policy) => ((policy.network as Record<string, unknown>) = { modee: "deny" })),
    ).toThrow()
    // And an extra key BESIDE a correct one, which is the drift a new option would cause.
    expect(drifted((policy) => (policy.security = { runAsNonRoot: false }))).toThrow()
    // The union is discriminated on `mode` alone: an allowlist the builder was never meant
    // to be handed is refused rather than silently honoured.
    expect(
      drifted((policy) => ((policy.network as Record<string, unknown>).allowlist = ["npmjs.org"])),
    ).toThrow()
  })
})

describe("builder manifest", () => {
  it("is named by the work order and carries the workspace, the task and the target, no prompt", async () => {
    const dir = tempDir("factory-manifest-")
    const app = tempDir("factory-manifest-app-")
    const task = loadTask("cli-flags")
    const written = await writeBuilderManifest(task, dir, {
      workOrderId: "wo-0123456789abcdef",
      appRoot: app,
    })
    // The resolver reads `<dir>/<metadata.factoryWorkOrderId>.json`, so the file name is the
    // work order's, not the task's: two work orders of one task are two manifests.
    expect(written.path).toBe(join(dir, "wo-0123456789abcdef.json"))
    const raw = JSON.parse(readFileSync(written.path, "utf8"))
    // The prompt is the run's user message; the manifest does not carry a second copy.
    expect(Object.keys(raw).sort()).toEqual([
      "targetId",
      "taskId",
      "version",
      "workOrderId",
      "workspace",
    ])
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
    // under the app root beside the manifest.
    expect(readdirSync(join(app, ".factory", "captures", "builder"))).toEqual([])
  })

  it("defaults the work order to the task, and two work orders of one task share the bytes", async () => {
    const dir = tempDir("factory-manifest-")
    const app = tempDir("factory-manifest-app-")
    const task = loadTask("cli-flags")
    const [first, second, third] = await Promise.all([
      writeBuilderManifest(task, dir, { appRoot: app }),
      writeBuilderManifest(task, dir, { workOrderId: "wo-a", appRoot: app }),
      writeBuilderManifest(task, dir, { workOrderId: "wo-b", appRoot: app }),
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
      writeBuilderManifest(loadTask("cli-flags"), dir, { workOrderId: "../escape" }),
    ).rejects.toThrow(/catalog id/)
    expect(readdirSync(dir)).toEqual([])
  })

  it("removes a manifest by work order, and says whether there was one", async () => {
    const dir = tempDir("factory-manifest-")
    const { path } = await writeBuilderManifest(loadTask("cli-flags"), dir, {
      workOrderId: "wo-a",
      appRoot: tempDir("factory-manifest-app-"),
    })
    expect(removeBuilderManifestFile(dir, "wo-a")).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(removeBuilderManifestFile(dir, "wo-a")).toBe(false)
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
        text.indexOf("export const BuilderTargetSchema"),
        text.indexOf("export type BuilderManifest ="),
      )
    const block = schemas(here)
    expect(block).toContain("export const BuilderTargetSchema")
    expect(block).toContain("export const BuilderManifestSchema")
    expect(schemas(there)).toBe(block)
    const catalogId = (text: string) => text.match(/^const CATALOG_ID = (.*)$/m)?.[1]
    expect(catalogId(here)).toBeDefined()
    expect(catalogId(there)).toBe(catalogId(here))
  })
})
