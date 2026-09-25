import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { openWorkspaceInstallation, type WorkspaceInstallation } from "@b4run/sqlite-storage"
import type { CapturedWorkspaceDefinition } from "@b4run/workspace"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { ManagedWorkspaceManager } from "../src/lib/runtime/managed-workspace-manager.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const roots: string[] = []
const managers: ManagedWorkspaceManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.releaseAll()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const bundle = (text: string) =>
  createSourceBundle([
    { path: "main.txt", bytes: new TextEncoder().encode(text), executable: false },
  ])
const HOUR = 60 * 60 * 1000
const signal = () => new AbortController().signal

async function setup(
  options: {
    readonly staged?: boolean
    readonly maxStagedBytes?: number
    /** `captureDefinition` (a `sandbox.workspace` resolver) instead of `resolveThread` (`sandbox.thread`). */
    readonly mode?: "thread" | "workspace"
  } = {},
) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-staged-manager-"))
  roots.push(appRoot)
  let now = 1_000_000
  const seen: { threadId: string; staged: CapturedWorkspaceDefinition | undefined }[] = []
  // One remote-service model for every manager of this app root, as one process after another.
  const physical = managedProviderFixture()
  const open = (staged = options.staged ?? true) => {
    const installation: WorkspaceInstallation = openWorkspaceInstallation(appRoot)
    const decide = async (thread: {
      readonly threadId: string
      readonly staged?: CapturedWorkspaceDefinition
    }) => {
      seen.push({ threadId: thread.threadId, staged: thread.staged })
      if (!thread.staged) throw new Error("no staged workspace")
      return thread.staged
    }
    const manager = new ManagedWorkspaceManager({
      installation,
      provider: physical.workspaces,
      policy: { network: { mode: "deny" } },
      idleTimeoutMs: 60_000,
      clock: () => now,
      ...(staged
        ? {
            staged: {
              retentionMs: HOUR,
              maxStagedBytes: options.maxStagedBytes ?? 64 * 1024 * 1024,
            },
          }
        : {}),
      ...(options.mode === "workspace"
        ? { captureDefinition: decide }
        : { resolveThread: async (thread) => ({ definition: await decide(thread) }) }),
    })
    managers.push(manager)
    return { manager, installation }
  }
  const close = async (manager: ManagedWorkspaceManager) => {
    await manager.releaseAll()
    managers.splice(managers.indexOf(manager), 1)
  }
  return { open, close, seen, physical, advance: (ms: number) => (now += ms) }
}

describe("staged workspaces in the manager", () => {
  it("stages an upload once, refuses one whose bytes are not its digest, and a malformed one", async () => {
    const { open } = await setup()
    const { manager, installation } = open()
    const a = bundle("a")
    expect(manager.stageSource(a, a.digest)).toEqual({ ok: true, status: "created" })
    expect(manager.stageSource(a, a.digest)).toEqual({ ok: true, status: "held" })
    // A body whose own digest is another's: never kept under the path's digest.
    const b = bundle("b")
    expect(manager.stageSource(b, a.digest)).toMatchObject({ ok: false, code: "digest_mismatch" })
    expect(installation.staged.holds(b.digest)).toBe(false)
    // A body that claims a digest its files do not have.
    expect(manager.stageSource({ ...b, digest: a.digest }, a.digest)).toMatchObject({
      ok: false,
      code: "workspace_source_invalid",
    })
    expect(
      manager.stageSource({ version: 1, digest: a.digest, files: "x" }, a.digest),
    ).toMatchObject({
      ok: false,
      code: "workspace_source_invalid",
    })
    expect(installation.sources.get(a.digest)).toEqual(a)
  })

  it("checks a reference before any thread exists, and serves it as thread.staged at first admission", async () => {
    const { open, seen } = await setup()
    const { manager, installation } = open()
    const a = bundle("a")
    expect(manager.checkStagedWorkspace({ sourceDigest: a.digest })).toMatchObject({
      ok: false,
      code: "workspace_source_not_held",
    })
    expect(manager.checkStagedWorkspace({ sourceDigest: "nope" })).toMatchObject({
      ok: false,
      code: "workspace_invalid",
    })
    manager.stageSource(a, a.digest)
    expect(
      manager.checkStagedWorkspace({
        sourceDigest: a.digest,
        environmentLinks: [{ path: "main.txt", target: "/x" }],
      }),
    ).toMatchObject({ ok: false, code: "workspace_invalid" })
    expect(manager.checkStagedWorkspace({ sourceDigest: a.digest, baseline: "git" })).toMatchObject(
      { ok: true, reference: { sourceDigest: a.digest, baseline: "git" } },
    )
    const checked = manager.checkStagedWorkspace({
      sourceDigest: a.digest,
      environmentLinks: [{ path: "deps", target: "/opt/deps" }],
    })
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(manager.attachStagedWorkspace("t-1", checked.reference)).toEqual({ ok: true })
    await manager.getForThread("t-1", signal())
    expect(seen.map((s) => s.staged?.source.digest)).toEqual([a.digest])
    expect(seen[0]?.staged?.environmentLinks).toEqual([{ path: "deps", target: "/opt/deps" }])
    const association = installation.associations.get("t-1")
    expect(association?.intent.sourceDigest).toBe(a.digest)
    expect(association?.intent.environmentLinks).toEqual([{ path: "deps", target: "/opt/deps" }])
    // Thread mode keeps its per-thread record (#832 D11): staging does not bypass it.
    expect(installation.threadSandboxes.get("t-1")).toEqual({ version: 1 })
    expect(manager.attachStagedWorkspace("t-1", checked.reference)).toMatchObject({
      ok: false,
      code: "already_staged",
    })
  })

  it("serves thread.staged to a workspace resolver too", async () => {
    const { open, seen } = await setup({ mode: "workspace" })
    const { manager, installation } = open()
    const a = bundle("a")
    manager.stageSource(a, a.digest)
    manager.attachStagedWorkspace("t-1", { sourceDigest: a.digest })
    await manager.getForThread("t-1", signal())
    expect(seen.map((s) => s.staged?.source.digest)).toEqual([a.digest])
    expect(installation.associations.get("t-1")?.intent.sourceDigest).toBe(a.digest)
    expect(installation.threadSandboxes.get("t-1")).toBeUndefined()
  })

  it("hands a thread without a staged workspace none", async () => {
    const { open, seen } = await setup()
    const { manager } = open()
    await expect(manager.getForThread("t-none", signal())).rejects.toThrow(/no staged workspace/)
    expect(seen).toEqual([{ threadId: "t-none", staged: undefined }])
  })

  it("never re-resolves: a restarted manager reads the record", async () => {
    const { open, close, seen } = await setup()
    const first = open()
    const a = bundle("a")
    first.manager.stageSource(a, a.digest)
    first.manager.attachStagedWorkspace("t-1", { sourceDigest: a.digest })
    await first.manager.getForThread("t-1", signal())
    await close(first.manager)
    const second = open()
    await second.manager.getForThread("t-1", signal())
    expect(seen).toHaveLength(1)
  })

  it("does not hand a staged workspace to a resolver once the option is off", async () => {
    const { open, close, seen } = await setup()
    const on = open()
    const a = bundle("a")
    on.manager.stageSource(a, a.digest)
    on.manager.attachStagedWorkspace("t-1", { sourceDigest: a.digest })
    await close(on.manager)
    const off = open(false)
    await expect(off.manager.getForThread("t-1", signal())).rejects.toThrow(/no staged workspace/)
    expect(seen.at(-1)?.staged).toBeUndefined()
    // Uploads and attaches are refused while off; cleanup still works.
    expect(() => off.manager.stageSource(a, a.digest)).toThrow(/sandbox.stagedWorkspaces/)
    expect(() => off.manager.attachStagedWorkspace("t-2", { sourceDigest: a.digest })).toThrow(
      /sandbox.stagedWorkspaces/,
    )
    off.manager.forgetStagedWorkspace("t-1")
    expect(off.installation.staged.get("t-1")).toBeUndefined()
    expect(off.manager.reclaimStagedSources()).toEqual([])
  })

  it("reclaims an unreferenced upload after the window, keeps a staged or admitted one, and forgets a deleted thread's", async () => {
    const { open, advance } = await setup()
    const { manager, installation } = open()
    const [unused, staged, admitted] = [bundle("unused"), bundle("staged"), bundle("admitted")]
    for (const b of [unused, staged, admitted]) manager.stageSource(b, b.digest)
    manager.attachStagedWorkspace("t-staged", { sourceDigest: staged.digest })
    manager.attachStagedWorkspace("t-admitted", { sourceDigest: admitted.digest })
    await manager.getForThread("t-admitted", signal())
    expect(manager.reclaimStagedSources()).toEqual([])
    advance(2 * HOUR)
    expect(manager.reclaimStagedSources()).toEqual([unused.digest])
    await manager.destroyThread("t-staged")
    manager.completeDelete("t-staged")
    expect(installation.staged.get("t-staged")).toBeUndefined()
    expect(manager.reclaimStagedSources()).toEqual([staged.digest])
    expect(installation.staged.holds(admitted.digest)).toBe(true)
    // The admitted thread's reference goes with it; then only its association kept the source.
    manager.forgetStagedWorkspace("t-admitted")
    expect(manager.reclaimStagedSources()).toEqual([])
    await manager.destroyThread("t-admitted")
    manager.completeDelete("t-admitted")
    expect(manager.reclaimStagedSources()).toEqual([admitted.digest])
  })

  it("reclaims at construction, and before each upload so expired uploads free the quota", async () => {
    const first = bundle("x".repeat(100))
    const second = bundle("y".repeat(100))
    const { open, close, advance } = await setup({
      maxStagedBytes: JSON.stringify(first).length + 10,
    })
    const one = open()
    one.manager.stageSource(first, first.digest)
    expect(one.manager.stageSource(second, second.digest)).toMatchObject({
      ok: false,
      code: "staged_quota_exceeded",
    })
    advance(2 * HOUR)
    expect(one.manager.stageSource(second, second.digest)).toEqual({
      ok: true,
      status: "created",
    })
    expect(one.installation.staged.holds(first.digest)).toBe(false)
    await close(one.manager)
    advance(2 * HOUR)
    const two = open()
    expect(two.installation.staged.holds(second.digest)).toBe(false)
  })

  it("forgets a thread's staged workspace on request, and sweeps threads whose rows are gone", async () => {
    const { open } = await setup()
    const { manager, installation } = open()
    const a = bundle("a")
    manager.stageSource(a, a.digest)
    for (const id of ["t-kept", "t-gone", "t-forgotten"])
      manager.attachStagedWorkspace(id, { sourceDigest: a.digest })
    manager.forgetStagedWorkspace("t-forgotten")
    expect(await manager.sweepStagedThreads(async (id) => id === "t-kept")).toEqual(["t-gone"])
    expect(installation.staged.threads()).toEqual(["t-kept"])
  })

  it("refuses an upload past the staged quota", async () => {
    const first = bundle("x".repeat(100))
    const second = bundle("y".repeat(100))
    const { open } = await setup({ maxStagedBytes: JSON.stringify(first).length + 10 })
    const { manager } = open()
    expect(manager.stageSource(first, first.digest)).toMatchObject({
      ok: true,
      status: "created",
    })
    expect(manager.stageSource(second, second.digest)).toMatchObject({
      ok: false,
      code: "staged_quota_exceeded",
    })
    expect(manager.stageSource(first, first.digest)).toMatchObject({ ok: true, status: "held" })
  })

  it("keeps the source write and the association write synchronous: nothing can reclaim between them", () => {
    // `reclaimStagedSources` is synchronous SQLite; it can run between two statements only if
    // an `await` separates them. This pins that `sources.put` and `associations.create` in
    // `getForThread` stay back to back with no `await` between.
    const text = readFileSync(
      fileURLToPath(new URL("../src/lib/runtime/managed-workspace-manager.ts", import.meta.url)),
      "utf8",
    )
    const from = text.indexOf("installation.sources.put(definition.source)")
    const to = text.indexOf("installation.associations.create(", from)
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    expect(text.slice(from, to)).not.toMatch(/\bawait\b/)
  })
})
