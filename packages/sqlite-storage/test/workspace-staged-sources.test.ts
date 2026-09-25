import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import {
  openWorkspaceInstallation,
  openWorkspaceInstallationReader,
  WorkspaceStagedSourceError,
} from "../src/index.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function installation() {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-staged-"))
  roots.push(appRoot)
  return { appRoot, installation: openWorkspaceInstallation(appRoot) }
}
const Q = 64 * 1024 * 1024
const bundle = (text: string) =>
  createSourceBundle([{ path: "a.txt", bytes: new TextEncoder().encode(text), executable: false }])
const thrown = (operation: () => unknown): unknown => {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error("expected a throw")
}

describe("the staged source store", () => {
  it("keeps an upload, answers held for the same bytes, and serves it from the content store", async () => {
    const { installation: i } = await installation()
    const a = bundle("a")
    expect(i.staged.holds(a.digest)).toBe(false)
    expect(i.staged.upload(a, 1_000, Q)).toBe("created")
    expect(i.staged.upload(a, 2_000, Q)).toBe("held")
    expect(i.staged.holds(a.digest)).toBe(true)
    expect(i.sources.get(a.digest)).toEqual(a)
    i.close()
  })

  it("refuses a bundle whose digest is not its content", async () => {
    const { installation: i } = await installation()
    const a = bundle("a")
    const forged = { ...a, digest: bundle("b").digest }
    expect(() => i.staged.upload(forged, 1_000, Q)).toThrow(/digest mismatch/)
    expect(i.staged.holds(forged.digest)).toBe(false)
    i.close()
  })

  it("attaches a held source to a thread once, and refuses one it does not hold", async () => {
    const { installation: i } = await installation()
    const a = bundle("a")
    expect(thrown(() => i.staged.attach("t-1", { sourceDigest: a.digest }))).toMatchObject({
      code: "not_held",
    })
    expect(thrown(() => i.staged.attach("t-1", { sourceDigest: a.digest }))).toBeInstanceOf(
      WorkspaceStagedSourceError,
    )
    i.staged.upload(a, 1_000, Q)
    i.staged.attach("t-1", { sourceDigest: a.digest, baseline: "git" })
    expect(i.staged.get("t-1")).toEqual({
      sourceDigest: a.digest,
      environmentLinks: [],
      baseline: "git",
    })
    expect(thrown(() => i.staged.attach("t-1", { sourceDigest: a.digest }))).toMatchObject({
      code: "already_staged",
    })
    i.staged.detach("t-1")
    expect(i.staged.get("t-1")).toBeUndefined()
    i.close()
  })

  it("reclaims an unreferenced upload only after the window, and never a referenced one", async () => {
    const { installation: i } = await installation()
    const [fresh, old, pinned, inUse, refreshed] = [
      bundle("fresh"),
      bundle("old"),
      bundle("pinned"),
      bundle("in use"),
      bundle("refreshed"),
    ]
    i.staged.upload(old, 1_000, Q)
    i.staged.upload(pinned, 1_000, Q)
    i.staged.upload(inUse, 1_000, Q)
    i.staged.upload(refreshed, 1_000, Q)
    i.staged.upload(fresh, 9_000, Q)
    // A re-upload of held bytes refreshes the window.
    expect(i.staged.upload(refreshed, 9_000, Q)).toBe("held")
    i.staged.attach("t-pinned", { sourceDigest: pinned.digest })
    const removed = i.staged.reclaim(5_000, new Set([inUse.digest]))
    expect(removed).toEqual([old.digest])
    expect(i.staged.holds(old.digest)).toBe(false)
    for (const kept of [fresh, pinned, inUse, refreshed])
      expect(i.staged.holds(kept.digest)).toBe(true)
    // Re-uploading a reclaimed source keeps it again.
    expect(i.staged.upload(old, 10_000, Q)).toBe("created")
    i.close()
  })

  it("refuses new bytes past the staged quota, but not a re-upload of held ones", async () => {
    const { installation: i } = await installation()
    const a = bundle("a")
    i.staged.upload(a, 1_000, Q)
    const size = JSON.stringify(a).length
    expect(thrown(() => i.staged.upload(bundle("b"), 1_000, size + 10))).toMatchObject({
      code: "quota_exceeded",
    })
    expect(i.staged.holds(bundle("b").digest)).toBe(false)
    expect(i.staged.upload(a, 2_000, size)).toBe("held")
    i.close()
  })

  it("counts only uploaded sources against the quota", async () => {
    const { installation: i } = await installation()
    const admitted = bundle("x".repeat(1000))
    i.sources.put(admitted)
    const a = bundle("a")
    expect(i.staged.upload(a, 1_000, JSON.stringify(a).length)).toBe("created")
    i.close()
  })

  it("lists the threads that have a staged reference", async () => {
    const { installation: i } = await installation()
    const a = bundle("a")
    i.staged.upload(a, 1_000, Q)
    i.staged.attach("t-2", { sourceDigest: a.digest })
    i.staged.attach("t-1", { sourceDigest: a.digest })
    expect(i.staged.threads()).toEqual(["t-1", "t-2"])
    i.close()
  })

  it("reclaims an unreferenced source that was never uploaded at once (an orphan row)", async () => {
    const { installation: i } = await installation()
    const orphan = bundle("orphan")
    i.sources.put(orphan)
    expect(i.staged.reclaim(0, new Set())).toEqual([orphan.digest])
    i.close()
  })

  it("persists across reopen, and adds its tables to an installation that predates them", async () => {
    const { appRoot, installation: first } = await installation()
    const a = bundle("a")
    first.staged.upload(a, 1_000, Q)
    first.staged.attach("t-1", { sourceDigest: a.digest })
    first.close()
    const reopened = openWorkspaceInstallation(appRoot)
    expect(reopened.staged.get("t-1")).toEqual({ sourceDigest: a.digest, environmentLinks: [] })
    reopened.close()
    const db = new DatabaseSync(join(appRoot, ".b4", "workspaces", "state.sqlite"))
    db.exec(
      "DROP TABLE workspace_staged_schema; DROP TABLE workspace_source_uploads; DROP TABLE workspace_thread_staged",
    )
    db.close()
    const upgraded = openWorkspaceInstallation(appRoot)
    expect(upgraded.staged.get("t-1")).toBeUndefined()
    upgraded.staged.upload(bundle("b"), 1_000, Q)
    upgraded.close()
    // A read-only reader neither needs nor creates the tables.
    const reader = openWorkspaceInstallationReader(appRoot)
    expect(reader.associations.list()).toEqual([])
    reader.close()
  })

  it("refuses to be used after close", async () => {
    const { installation: i } = await installation()
    i.close()
    expect(() => i.staged.holds(bundle("a").digest)).toThrow(/closed/)
  })
})
