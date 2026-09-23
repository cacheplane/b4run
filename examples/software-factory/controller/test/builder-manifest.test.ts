import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { BuilderManifestSchema, writeBuilderManifest } from "../src/lib/builder-manifest.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { builderPermissions } from "../src/lib/targets/permissions.ts"
import { builderSandboxScope, targetSandboxPolicy } from "../src/lib/targets/workspace.ts"

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe("builder manifest", () => {
  it("writes everything the builder's config needs, as data", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-manifest-"))
    const task = loadTask("cli-flags")
    const path = await writeBuilderManifest(task, dir)
    const manifest = BuilderManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    expect(manifest.taskId).toBe("cli-flags")
    expect(manifest.target.id).toBe(task.target.id)
    // `builderSandboxProvider` passes dockerSandbox exactly `scope` and `image` and nothing
    // else, so those two fields are the whole provider the builder must reconstruct. Asserted
    // against the same constructors the controller uses, so a third option added there
    // without a manifest field fails here rather than silently changing the builder's
    // SandboxConfig.
    expect(manifest.target.scope).toBe(builderSandboxScope)
    expect(manifest.target.image).toMatch(/^b4-factory-/)
    expect(manifest.target.policy).toEqual(targetSandboxPolicy(task.target))
    expect(manifest.target.permissions).toEqual(builderPermissions(task.target))
    expect(manifest.prompt).toContain("Read TASK.md")
    const workspace = verifyCapturedWorkspaceDefinition(manifest.workspace)
    expect(workspace.source.files.some((f) => f.path === "TASK.md")).toBe(true)
    // The capture carries the target's dependency-tree links, not just its files: a builder
    // handed a bundle without them cannot run the target's commands.
    expect(workspace.environmentLinks.map((link) => link.path)).toEqual(
      task.target.environmentLinks.map((link) => link.path).sort(),
    )
    expect(workspace.baseline).toBe("git")
  })

  it("refuses a drifted policy key rather than dropping it", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-manifest-"))
    const path = await writeBuilderManifest(loadTask("cli-flags"), dir)
    const good = JSON.parse(readFileSync(path, "utf8"))
    expect(good.target.policy.network.mode).toBe("deny")

    // A typo one level down. Without `.strict()` both of these parse, `network` (or its
    // `mode`) is absent from what reaches `b4.config.ts`, and the builder runs under the
    // provider's DEFAULT network instead of the denial the controller wrote: a fail-open on
    // a misspelling. Each must be an error instead.
    const drifted = (mutate: (policy: Record<string, unknown>) => void) => {
      const manifest = JSON.parse(JSON.stringify(good))
      mutate(manifest.target.policy)
      return () => BuilderManifestSchema.parse(manifest)
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

  it("keeps the builder's copy of the schema identical", () => {
    const here = readFileSync(new URL("../src/lib/builder-manifest.ts", import.meta.url), "utf8")
    const there = readFileSync(
      new URL("../../server/src/builder-manifest.ts", import.meta.url),
      "utf8",
    )
    const schema = (text: string) =>
      text.slice(
        text.indexOf("export const BuilderManifestSchema"),
        text.indexOf("export type BuilderManifest"),
      )
    expect(schema(here).length).toBeGreaterThan(0)
    expect(schema(there)).toBe(schema(here))
  })
})
