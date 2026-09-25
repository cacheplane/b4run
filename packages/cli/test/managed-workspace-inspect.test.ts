import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallation } from "@b4run/sqlite-storage"
import {
  WorkspaceInspectionError,
  WorkspaceLifecycleError,
  WorkspaceReadLimitError,
} from "@b4run/workspace"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import {
  inspectFailure,
  ManagedWorkspaceManager,
} from "../src/lib/runtime/managed-workspace-manager.ts"
import type { ThreadWorkspaceInspectRequest } from "../src/lib/runtime/workspace-protocol.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const roots: string[] = []
const managers: ManagedWorkspaceManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.releaseAll()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const text = (value: string) => new TextEncoder().encode(value)
const request: ThreadWorkspaceInspectRequest = {
  excludeRootDirectories: [],
  expectedRootSymlinks: {},
  ignorePrefixes: [],
  maxEntries: 10_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
}

async function managerWith(options: { readonly runAsNonRoot?: boolean } = {}) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-inspect-"))
  roots.push(appRoot)
  const physical = managedProviderFixture()
  const source = createSourceBundle([
    { path: "main.txt", bytes: text("initial"), executable: false },
    { path: "draft/task.json", bytes: text("{}"), executable: false },
  ])
  const manager = new ManagedWorkspaceManager({
    installation: openWorkspaceInstallation(appRoot),
    definition: { version: 1, source, environmentLinks: [] },
    provider: physical.workspaces,
    policy: {
      network: { mode: "deny" },
      ...(options.runAsNonRoot === undefined
        ? {}
        : { security: { runAsNonRoot: options.runAsNonRoot } }),
    },
    idleTimeoutMs: 60_000,
  })
  managers.push(manager)
  return { manager, physical, source }
}

describe("ManagedWorkspaceManager.inspectThread", () => {
  it("answers the published workspace with its recorded digests", async () => {
    const { manager, physical, source } = await managerWith()
    await manager.getForThread("t-1", new AbortController().signal)
    const outcome = await manager.inspectThread("t-1", request, new AbortController().signal)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.sourceDigest).toBe(source.digest)
    expect(outcome.intentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(outcome.inspection.files).toEqual({ "draft/task.json": "{}", "main.txt": "initial" })
    expect(physical.calls.filter((call) => call === "read")).toHaveLength(1)
    expect(physical.calls.at(-1)).toBe("close")
  })

  it("starts at the requested root", async () => {
    const { manager } = await managerWith()
    await manager.getForThread("t-1", new AbortController().signal)
    const outcome = await manager.inspectThread(
      "t-1",
      { ...request, root: "draft" },
      new AbortController().signal,
    )
    expect(outcome.ok && outcome.inspection.files).toEqual({ "task.json": "{}" })
  })

  it("names a thread with no workspace yet, and a missing root", async () => {
    const { manager } = await managerWith()
    expect(
      await manager.inspectThread("never-run", request, new AbortController().signal),
    ).toMatchObject({
      ok: false,
      code: "workspace_not_found",
    })
    await manager.getForThread("t-1", new AbortController().signal)
    expect(
      await manager.inspectThread(
        "t-1",
        { ...request, root: "missing" },
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false, code: "workspace_root_missing", root: "missing", kind: "absent" })
  })

  it("refuses a thread being deleted", async () => {
    const { manager } = await managerWith()
    await manager.getForThread("t-1", new AbortController().signal)
    await manager.destroyThread("t-1")
    expect(await manager.inspectThread("t-1", request, new AbortController().signal)).toMatchObject(
      {
        ok: false,
        code: "workspace_lost",
      },
    )
  })
})

describe("inspectFailure", () => {
  const cases: [unknown, string][] = [
    [new WorkspaceInspectionError("changed", "x"), "workspace_changed"],
    [new WorkspaceInspectionError("refused", "x"), "workspace_inspection_refused"],
    [new WorkspaceInspectionError("invalid_options", "x"), "invalid_request"],
    [
      new WorkspaceInspectionError("root_missing", "x", { root: "d", kind: "absent" }),
      "workspace_root_missing",
    ],
    [new WorkspaceLifecycleError("lost", "x"), "workspace_lost"],
    [new WorkspaceLifecycleError("expired", "x"), "workspace_expired"],
    [new WorkspaceLifecycleError("conflict", "x"), "workspace_conflict"],
    [new WorkspaceLifecycleError("retryable", "x"), "workspace_unavailable"],
    [new WorkspaceLifecycleError("uncertain", "x"), "workspace_unavailable"],
  ]
  for (const [error, code] of cases)
    it(`maps ${(error as Error).name} ${(error as { code: string }).code} to ${code}`, () => {
      expect(inspectFailure(error)).toMatchObject({ ok: false, code })
    })

  it("leaves an unclassified error (a bare read-limit, an I/O failure) to the caller", () => {
    expect(inspectFailure(new Error("docker exec failed"))).toBeUndefined()
    expect(inspectFailure(new WorkspaceReadLimitError("x", "/p", 1))).toBeUndefined()
    expect(inspectFailure(new WorkspaceLifecycleError("unsupported", "x"))).toBeUndefined()
  })
})
