import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { makeManifest } from "./support/recovery/manifest.ts"
import { RecoveryStore } from "./support/recovery/store.ts"
import type { WorkspaceRecord } from "./support/recovery/types.ts"

const dirs: string[] = []
const stores: RecoveryStore[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), "recovery-store-"))
  dirs.push(path)
  return path
}
function open(path: string) {
  const store = RecoveryStore.open(path)
  stores.push(store)
  return store
}
function record(store: RecoveryStore): WorkspaceRecord {
  const generationId = randomUUID()
  return {
    logicalId: "workspace",
    imageId: "sha256:image",
    source: makeManifest(
      [{ path: "a", content: "original", executable: false }],
      "/opt/fixtures/cli-flags/node_modules",
    ),
    status: "preparing",
    attempt: {
      installationId: store.installationId,
      logicalId: "workspace",
      generationId,
      imageId: "sha256:image",
      volumeName: `volume-${generationId}`,
      preparerName: `preparer-${generationId}`,
      sessionName: `session-${generationId}`,
    },
  }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it("rejects competing connections including canonical symlink aliases and allows reentry after close", () => {
  const dir = directory()
  const store = open(dir)
  expect(() => RecoveryStore.open(dir)).toThrow(/busy/i)
  const alias = join(directory(), "alias")
  symlinkSync(dir, alias)
  expect(() => RecoveryStore.open(alias)).toThrow(/busy/i)
  const id = store.installationId
  store.close()
  expect(open(alias).installationId).toBe(id)
})
it("rejects an independent process before it can provision", () => {
  const dir = directory()
  open(dir)
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { RecoveryStore } from ${JSON.stringify(new URL("./support/recovery/store.ts", import.meta.url).href)}; try { RecoveryStore.open(process.argv[1]); process.exitCode=2 } catch(error) { if (!/busy/i.test(error.message)) throw error }`,
      dir,
    ],
    { encoding: "utf8" },
  )
  expect(child.status, child.stderr).toBe(0)
})
it("commits full immutable provenance and atomic expected-state updates across restart", () => {
  const dir = directory()
  const store = open(dir)
  const initial = record(store)
  store.insert(initial)
  expect(() => store.insert(initial)).toThrow()
  expect(() =>
    store.update(
      { ...initial, status: "ready" },
      { status: "ready", generationId: initial.attempt.generationId },
    ),
  ).toThrow(/conflict/i)
  expect(store.get(initial.logicalId)).toEqual(initial)
  store.update(
    { ...initial, status: "ready" },
    { status: "preparing", generationId: initial.attempt.generationId },
  )
  store.close()
  expect(open(dir).get(initial.logicalId)).toEqual({
    ...initial,
    status: "ready",
  })
})
it("rejects corrupt manifests and intent mutation without changing committed state", () => {
  const store = open(directory())
  const initial = record(store)
  expect(() => store.insert({ ...initial, source: { ...initial.source, digest: "bad" } })).toThrow(
    /manifest/i,
  )
  expect(store.get(initial.logicalId)).toBeUndefined()
  store.insert(initial)
  expect(() =>
    store.update(
      { ...initial, imageId: "different" },
      { status: "preparing", generationId: initial.attempt.generationId },
    ),
  ).toThrow()
  expect(store.get(initial.logicalId)).toEqual(initial)
})
it("does not leak admission when metadata initialization fails", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs")
  const dir = directory()
  const original = open(dir)
  const installationId = original.installationId
  original.close()
  const bytes = readFileSync(join(dir, "state.sqlite"))
  writeFileSync(join(dir, "state.sqlite"), "not sqlite")
  expect(() => RecoveryStore.open(dir)).toThrow()
  writeFileSync(join(dir, "state.sqlite"), bytes)
  expect(open(dir).installationId).toBe(installationId)
})
it("cannot rewrite selected physical names or previously pinned container identities", () => {
  const store = open(directory())
  const initial = record(store)
  store.insert(initial)
  const pinned = {
    ...initial,
    attempt: { ...initial.attempt, preparerId: "immutable" },
  }
  store.update(pinned, {
    status: "preparing",
    generationId: initial.attempt.generationId,
  })
  expect(() =>
    store.update(
      { ...pinned, attempt: { ...pinned.attempt, volumeName: "foreign" } },
      { status: "preparing", generationId: initial.attempt.generationId },
    ),
  ).toThrow(/identity/i)
  expect(() =>
    store.update(
      { ...pinned, attempt: { ...pinned.attempt, preparerId: "replacement" } },
      { status: "preparing", generationId: initial.attempt.generationId },
    ),
  ).toThrow(/identity/i)
  expect(store.get(initial.logicalId)).toEqual(pinned)
})
it("refuses missing state metadata after installation bootstrap", async () => {
  const { unlinkSync, existsSync } = await import("node:fs")
  const dir = directory()
  open(dir).close()
  unlinkSync(join(dir, "state.sqlite"))
  expect(() => RecoveryStore.open(dir)).toThrow(/missing.*metadata/i)
  expect(existsSync(join(dir, "state.sqlite"))).toBe(false)
})
it("refuses to replace a missing persisted installation identity", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const dir = directory()
  open(dir).close()
  const database = new DatabaseSync(join(dir, "state.sqlite"))
  try {
    database.exec("DELETE FROM metadata WHERE key='installation'")
    expect(() => RecoveryStore.open(dir)).toThrow(/missing.*metadata/i)
    expect(
      database.prepare("SELECT value FROM metadata WHERE key='installation'").get(),
    ).toBeUndefined()
  } finally {
    database.close()
  }
})
