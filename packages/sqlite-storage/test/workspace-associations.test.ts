import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import type { ReadyWorkspace } from "@b4run/workspace"
import { createSourceBundle, createWorkspaceIntent } from "@b4run/workspace/node"
import { afterEach, expect, it } from "vitest"
import { makeWorkspaceAssociationStore } from "../src/workspace/association-store.ts"
import { makeWorkspaceSourceStore } from "../src/workspace/source-store.ts"

const databases: DatabaseSync[] = []
const bundle = createSourceBundle([
  { path: "main.ts", bytes: new TextEncoder().encode("hello"), executable: false },
])
function fixture() {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  db.exec("PRAGMA synchronous=FULL")
  const sources = makeWorkspaceSourceStore(db)
  const store = makeWorkspaceAssociationStore(db, sources)
  const intent = createWorkspaceIntent({
    operationId: randomUUID(),
    installationId: randomUUID(),
    threadId: "thread-a",
    definition: { version: 1, source: bundle, environmentLinks: [] },
    environment: {
      binding: { provider: "fake", scope: "test", account: "local" },
      identity: "env-1",
    },
  })
  const ready: ReadyWorkspace = {
    reference: {
      version: 1,
      operationId: intent.operationId,
      installationId: intent.installationId,
      threadId: intent.threadId,
      intentDigest: intent.digest,
      resource: { id: "remote-1" },
    },
    provenance: {
      sourceDigest: bundle.digest,
      environment: intent.environment,
      retention: { filesystem: "until-destroy", memory: "discarded" },
    },
  }
  return { db, sources, store, intent, ready }
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
it("requires a retained source before persisting a creation intent", () => {
  const { store, intent, sources } = fixture()
  expect(() => store.create(intent)).toThrow(/source/i)
  expect(store.get(intent.threadId)).toBeUndefined()
  sources.put(bundle)
  expect(store.create(intent)).toMatchObject({ state: "creating", revision: 1, intent })
  expect(store.create(intent).revision).toBe(1)
})
it("rejects conflicting creation and stale publication", () => {
  const { store, intent, sources, ready } = fixture()
  sources.put(bundle)
  store.create(intent)
  const other = createWorkspaceIntent({
    operationId: randomUUID(),
    installationId: intent.installationId,
    threadId: intent.threadId,
    definition: { version: 1, source: bundle, environmentLinks: [] },
    environment: intent.environment,
  })
  expect(() => store.create(other)).toThrow(/conflict/i)
  expect(() => store.markReady(intent.threadId, 0, ready)).toThrow(/revision|conflict/i)
  expect(store.markReady(intent.threadId, 1, ready)).toMatchObject({
    state: "ready",
    revision: 2,
    ready,
  })
})
it("deletion wins over publication and leaves a non-recreatable tombstone", () => {
  const { store, intent, sources, ready } = fixture()
  sources.put(bundle)
  store.create(intent)
  expect(store.beginDelete(intent.threadId)).toMatchObject({ state: "deleting", revision: 2 })
  expect(() => store.markReady(intent.threadId, 1, ready)).toThrow()
  expect(store.beginDelete(intent.threadId)?.revision).toBe(2)
  expect(() => store.completeDelete(intent.threadId, 1)).toThrow()
  expect(store.completeDelete(intent.threadId, 2)).toMatchObject({ state: "deleted", revision: 3 })
  expect(store.create(intent).state).toBe("deleted")
  expect(store.beginDelete("missing")).toBeUndefined()
})
it("rejects mismatched ready provenance without changing the association", () => {
  const { store, intent, sources, ready } = fixture()
  sources.put(bundle)
  store.create(intent)
  expect(() =>
    store.markReady(intent.threadId, 1, {
      ...ready,
      reference: { ...ready.reference, operationId: randomUUID() },
    }),
  ).toThrow()
  expect(store.get(intent.threadId)?.state).toBe("creating")
})
it("fails closed on corrupt persisted data instead of repairing it", () => {
  const { db, store, intent, sources } = fixture()
  sources.put(bundle)
  store.create(intent)
  db.prepare("UPDATE workspace_associations SET payload=?").run("{}")
  expect(() => store.get(intent.threadId)).toThrow()
  expect(() => store.create(intent)).toThrow()
})
it("preserves ready provenance throughout resumable deletion", () => {
  const { store, intent, sources, ready } = fixture()
  sources.put(bundle)
  store.create(intent)
  store.markReady(intent.threadId, 1, ready)
  expect(store.beginDelete(intent.threadId)?.ready).toEqual(ready)
  expect(store.completeDelete(intent.threadId, 3).ready).toEqual(ready)
})
