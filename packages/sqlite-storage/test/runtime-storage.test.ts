import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { declareRuntimeStorageContract } from "../../../test/agent-protocol/runtime-storage-contract.ts"

const roots: string[] = []
const cleanup: (() => void)[] = []
function root() {
  const path = mkdtempSync(join(tmpdir(), "b4-runtime-"))
  roots.push(path)
  return path
}
async function runtime() {
  expect(
    existsSync(new URL("../src/runtime/index.ts", import.meta.url)),
    "fresh runtime storage factory must exist",
  ).toBe(true)
  return import("../src/runtime/index.ts")
}
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
it("installs only a fresh namespace with a stable marker, WAL, FULL, and foreign keys", async () => {
  const { openRuntimeInstallation } = await runtime()
  const path = root()
  mkdirSync(join(path, ".b4"))
  const legacy = [
    "memory.sqlite",
    "threads.sqlite",
    "checkpoints.sqlite",
    "interrupt-grants.sqlite",
    "client-tool-calls.sqlite",
    "permissions.json",
  ]
  for (const name of legacy) writeFileSync(join(path, ".b4", name), `legacy:${name}`)
  const owner = openRuntimeInstallation(path)
  cleanup.push(() => owner.close())
  expect(owner.path).toBe(join(realpathSync(path), ".b4/agent-protocol/v1/runtime.sqlite"))
  expect(owner.installationId).toMatch(/^[a-f0-9-]{36}$/)
  const db = new DatabaseSync(owner.path, { readOnly: true })
  expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal")
  expect(db.prepare("SELECT version,installation_id FROM runtime_installation").get()).toEqual({
    version: 1,
    installation_id: owner.installationId,
  })
  db.close()
  expect(owner.settings).toEqual({ journalMode: "wal", synchronous: 2, foreignKeys: 1 })
  owner.close()
  const next = openRuntimeInstallation(path)
  cleanup.push(() => next.close())
  expect(next.installationId).toBe(owner.installationId)
  for (const name of legacy)
    expect(readFileSync(join(path, ".b4", name), "utf8")).toBe(`legacy:${name}`)
})
it.each(["version", "installation", "unmarked", "format"])(
  "rejects incompatible %s before changing any existing namespace bytes",
  async (mode) => {
    const { openRuntimeInstallation } = await runtime()
    const path = root()
    const directory = join(path, ".b4/agent-protocol/v1")
    mkdirSync(directory, { recursive: true })
    const file = join(directory, "runtime.sqlite")
    const seed = openRuntimeInstallation(root())
    seed.close()
    copyFileSync(seed.path, file)
    const db = new DatabaseSync(file)
    if (mode === "unmarked") db.exec("DELETE FROM runtime_installation")
    else if (mode === "version") db.exec("UPDATE runtime_installation SET version=2")
    else if (mode === "format") db.exec("UPDATE runtime_installation SET format='other-runtime'")
    else db.exec("UPDATE runtime_installation SET installation_id='not-a-uuid'")
    db.close()
    const before = readFileSync(file)
    expect(() => openRuntimeInstallation(path)).toThrow(/incompatible|marker|installation/i)
    expect(readFileSync(file)).toEqual(before)
    for (const name of [
      "runtime-owner.sqlite",
      "runtime.sqlite-wal",
      "runtime.sqlite-shm",
      "runtime.sqlite-journal",
      "runtime-owner.sqlite-journal",
    ])
      expect(existsSync(join(directory, name))).toBe(false)
  },
)

const ids = {
  thread: "00000000-0000-4000-8000-000000000001",
  generation: "00000000-0000-4000-8000-000000000002",
  pausedGeneration: "00000000-0000-4000-8000-000000000003",
  predecessor: "00000000-0000-4000-8000-000000000004",
  continuation: "00000000-0000-4000-8000-000000000005",
  firstGrant: "00000000-0000-4000-8000-000000000006",
  secondGrant: "00000000-0000-4000-8000-000000000007",
  firstInput: "00000000-0000-4000-8000-000000000008",
  secondInput: "00000000-0000-4000-8000-000000000009",
  submission: "00000000-0000-4000-8000-00000000000a",
}
declareRuntimeStorageContract({
  ids,
  now: () => "2026-11-06T00:00:00.000Z",
  createBackend: async ({ ids, now }) => {
    const { openRuntimeInstallation } = await runtime()
    const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
    const owner = openRuntimeInstallation(root())
    const store = bindRuntimeStore(
      owner,
      createRuntimeBinding(owner, { threadId: ids.thread, generation: ids.generation, fence: 1 }),
      now,
    )
    return {
      store,
      observer: store.committedReader(),
      advanceFence: () => store.advanceFence(),
      close: async () => owner.close(),
    }
  },
})

it("rejects forged bindings, escaped transaction contexts, and cross-scope IDs in records or ancestry", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  expect(() => bindRuntimeStore(owner, {})).toThrow(/binding/)
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope))
  let escaped: import("@b4run/sdk/agent-protocol").RuntimeTransaction | undefined
  await store.transaction(async (tx) => {
    escaped = tx
    await tx.runs.put(data.run)
    await tx.checkpoints.put(data.checkpoint)
    await tx.thread.put(data.thread)
  })
  await expect(escaped?.snapshot()).rejects.toMatchObject({ code: "closed_transaction" })
  const other = bindRuntimeStore(
    owner,
    createRuntimeBinding(owner, {
      ...data.scope,
      threadId: "20000000-0000-4000-8000-000000000001",
      generation: "20000000-0000-4000-8000-000000000002",
    }),
  )
  await expect(other.transaction((tx) => tx.runs.get(data.runId))).rejects.toMatchObject({
    code: "scope_mismatch",
  })
  await expect(other.transaction((tx) => tx.runs.put(data.run))).rejects.toMatchObject({
    code: "scope_mismatch",
  })
  const sourceLineage = data.checkpoint.lineage[0]
  if (!sourceLineage) throw new Error("Missing fixture lineage")
  await expect(
    store.transaction((tx) =>
      tx.checkpoints.put({
        ...data.checkpoint,
        lineage: [{ ...sourceLineage, threadId: "unvalidated-source" }],
      }),
    ),
  ).rejects.toMatchObject({ code: "scope_mismatch" })
  const returned = await store.snapshot()
  ;(returned.thread?.thread.metadata as Record<string, unknown>).mutated = true
  expect((await store.snapshot()).thread?.thread.metadata).toEqual({})
})
it("holds a durable read lease until rejection settles and releases it before queued writes", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope))
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const rejected = new Error("lease callback rejected")
  const lease = store.withReadLease(async ({ leaseId }) => {
    const db = new DatabaseSync(owner.path, { readOnly: true })
    expect(db.prepare("SELECT id FROM leases").get()?.id).toBe(leaseId)
    db.close()
    entered()
    await released
    throw rejected
  })
  await started
  let wrote = false
  const write = store.transaction(async (tx) => {
    await tx.runs.put(data.run)
    wrote = true
  })
  await Promise.resolve()
  expect(wrote).toBe(false)
  release()
  await expect(lease).rejects.toBe(rejected)
  await write
  const db = new DatabaseSync(owner.path, { readOnly: true })
  expect(db.prepare("SELECT count(*) AS n FROM leases").get()?.n).toBe(0)
  db.close()
})
it("rejects not-yet-qualified state and maintenance operations before mutation", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope))
  const before = await store.snapshot()
  await expect(store.transaction((tx) => tx.deleteThread("job"))).rejects.toMatchObject({
    code: "unsupported_operation",
  })
  await expect(
    store.transaction((tx) =>
      tx.rollback({
        runId: data.runId,
        preRunCheckpointId: null,
        expectedRevision: 1,
        maintenanceJobId: "job",
      }),
    ),
  ).rejects.toMatchObject({ code: "unsupported_operation" })
  await expect(
    store.transaction((tx) =>
      tx.copy({
        destinationThreadId: "target",
        destinationGeneration: "generation",
        sourceRevision: 1,
        throughSeq: 0,
        checkpoints: [],
      }),
    ),
  ).rejects.toMatchObject({ code: "unsupported_operation" })
  expect(await store.snapshot()).toEqual(before)
})

it("rejects a structurally incompatible marked database without changing its schema or durable owner", async () => {
  const { openRuntimeInstallation } = await runtime()
  const path = root()
  const owner = openRuntimeInstallation(path)
  owner.close()
  const db = new DatabaseSync(owner.path)
  db.exec("ALTER TABLE runs RENAME COLUMN owner_run_id TO incompatible_owner")
  db.close()
  const before = readFileSync(owner.path)
  expect(() => openRuntimeInstallation(path)).toThrow(/incompatible/i)
  expect(readFileSync(owner.path)).toEqual(before)
})
it("inspects an incompatible committed WAL without changing main, WAL, SHM, or owner sidecar bytes", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { createHash } = await import("node:crypto")
  const { readdirSync } = await import("node:fs")
  const path = root()
  const owner = openRuntimeInstallation(path)
  owner.close()
  const db = new DatabaseSync(owner.path)
  db.exec("PRAGMA wal_autocheckpoint=0; UPDATE runtime_installation SET version=2")
  const directory = join(realpathSync(path), ".b4/agent-protocol/v1")
  function checksums() {
    return Object.fromEntries(
      readdirSync(directory)
        .sort()
        .map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(join(directory, name)))
            .digest("hex"),
        ]),
    )
  }
  const before = checksums()
  expect(Object.keys(before)).toEqual(
    expect.arrayContaining([
      "runtime.sqlite",
      "runtime.sqlite-wal",
      "runtime.sqlite-shm",
      "runtime-owner.sqlite",
    ]),
  )
  try {
    expect(() => openRuntimeInstallation(path)).toThrow(/incompatible/i)
    expect(checksums()).toEqual(before)
  } finally {
    db.close()
  }
})

it("allows an unrelated Thread to commit while another Thread holds a durable read lease", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope))
  const otherScope = {
    ...data.scope,
    threadId: "30000000-0000-4000-8000-000000000001",
    generation: "30000000-0000-4000-8000-000000000002",
  }
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const lease = store.withReadLease(async () => {
    entered()
    await released
  })
  await started
  let wrote = false
  let write: Promise<void> = Promise.resolve()
  try {
    const other = bindRuntimeStore(owner, createRuntimeBinding(owner, otherScope))
    write = other.transaction(async (tx) => {
      await tx.runs.put({
        ...data.run,
        run: {
          ...data.run.run,
          run_id: "30000000-0000-4000-8000-000000000003",
          thread_id: otherScope.threadId,
        },
        metadata: {
          ...data.run.metadata,
          generation: otherScope.generation,
          turnId: "30000000-0000-4000-8000-000000000003",
        },
      })
      wrote = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(wrote, "a read lease must not retain the installation-wide writer queue").toBe(true)
    const db = new DatabaseSync(owner.path, { readOnly: true })
    expect(db.prepare("SELECT count(*) AS n FROM leases").get()?.n).toBe(1)
    db.close()
  } finally {
    release()
    await lease
    await write
  }
})

it("refuses orphan canonical references at commit and keeps canonical ownership after deleting a Run result", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope))
  await expect(store.transaction((tx) => tx.checkpoints.put(data.checkpoint))).rejects.toThrow(
    /foreign key|canonical/i,
  )
  expect((await store.snapshot()).checkpoints).toEqual([])
  await store.transaction(async (tx) => {
    await tx.runs.put(data.run)
    await tx.checkpoints.put(data.checkpoint)
    await tx.thread.put(data.thread)
    await tx.receipts.put(data.receipt)
  })
  await store.transaction((tx) => tx.runs.delete(data.runId))
  const snapshot = await store.snapshot()
  expect(snapshot.runs).toEqual([])
  expect(snapshot.checkpoints).toEqual([data.checkpoint])
  expect(snapshot.receipts).toEqual([data.receipt])
  const other = bindRuntimeStore(
    owner,
    createRuntimeBinding(owner, {
      ...data.scope,
      threadId: "40000000-0000-4000-8000-000000000001",
      generation: "40000000-0000-4000-8000-000000000002",
    }),
  )
  await expect(other.transaction((tx) => tx.runs.get(data.runId))).rejects.toMatchObject({
    code: "scope_mismatch",
  })
  const db = new DatabaseSync(owner.path, { readOnly: true })
  expect(
    db.prepare("SELECT id,thread_id,generation FROM run_identities WHERE id=?").get(data.runId),
  ).toEqual({ id: data.runId, thread_id: data.scope.threadId, generation: data.scope.generation })
  expect(
    db
      .prepare(
        "SELECT checkpoint_id,ancestor_checkpoint_id,ancestor_run_id FROM checkpoint_lineage",
      )
      .get(),
  ).toEqual({
    checkpoint_id: data.checkpointId,
    ancestor_checkpoint_id: data.checkpointId,
    ancestor_run_id: data.runId,
  })
  db.close()
})
it("rejects a result whose canonical Run or Thread belongs to a different scope", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope))
  await expect(
    store.transaction((tx) =>
      tx.runs.put({ ...data.run, result: { run: { ...data.run.run, thread_id: "other-thread" } } }),
    ),
  ).rejects.toMatchObject({ code: "scope_mismatch" })
  expect((await store.snapshot()).runs).toEqual([])
})

it("persists explicit owners and immutable ordered journal facts with inbox and maintenance records", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope))
  const inbox = {
    entryId: "inbox",
    kind: "control" as const,
    runId: data.runId,
    namespace: [],
    status: "accepted" as const,
    payload: { stop: true },
    createdAt: data.now,
  }
  const maintenance = {
    jobId: "maintenance",
    kind: "retention" as const,
    runId: data.runId,
    status: "pending" as const,
    payload: { retained: true },
  }
  const event = {
    eventId: data.eventId,
    namespace: [],
    ownerRunId: data.runId,
    event: {
      type: "event" as const,
      method: "lifecycle" as const,
      params: {
        namespace: [],
        timestamp: Date.parse(data.now),
        data: { event: "completed" as const },
      },
    },
  }
  await store.transaction(async (tx) => {
    await tx.runs.put(data.run)
    await tx.inbox.put(inbox)
    await tx.maintenance.put(maintenance)
    expect((await tx.journal.append(event)).seq).toBe(1)
  })
  await expect(store.transaction((tx) => tx.journal.append(event))).rejects.toThrow(/unique/i)
  const snapshot = await store.snapshot()
  expect(snapshot).toMatchObject({ throughSeq: 1, inbox: [inbox], maintenance: [maintenance] })
  await store.transaction(async (tx) => {
    expect(await tx.inbox.get("inbox")).toEqual(inbox)
    expect(await tx.maintenance.get("maintenance")).toEqual(maintenance)
    expect(await tx.journal.read(0)).toEqual([{ ...event, seq: 1 }])
  })
  const db = new DatabaseSync(owner.path, { readOnly: true })
  expect(db.prepare("SELECT thread_id,generation,owner_run_id FROM inbox").get()).toEqual({
    thread_id: data.scope.threadId,
    generation: data.scope.generation,
    owner_run_id: data.runId,
  })
  expect(db.prepare("SELECT through_seq FROM projections").get()?.through_seq).toBe(1)
  db.close()
})
it("rejects nested transactions and closes escaped contexts after asynchronous rejection", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope))
  let escaped: import("@b4run/sdk/agent-protocol").RuntimeTransaction | undefined
  await expect(
    store.transaction(async (tx) => {
      escaped = tx
      await tx.runs.put(data.run)
      await store.transaction(async () => undefined)
    }),
  ).rejects.toThrow(/nested/i)
  await expect(escaped?.runs.put(data.run)).rejects.toMatchObject({ code: "closed_transaction" })
  expect((await store.snapshot()).runs).toEqual([])
  await store.withReadLease(async () => {
    await expect(store.transaction(async () => undefined)).rejects.toThrow(/nested/i)
  })
})

it.each(
  ["runtime.sqlite", "runtime-owner.sqlite"].flatMap((name) =>
    ["-wal", "-shm", "-journal"].map((suffix) => [name, suffix] as const),
  ),
)("rejects an orphan %s %s sidecar before creating its database or owner", async (name, suffix) => {
  const { openRuntimeInstallation } = await runtime()
  const path = root()
  const directory = join(path, ".b4/agent-protocol/v1")
  mkdirSync(directory, { recursive: true })
  const sidecar = join(directory, `${name}${suffix}`)
  writeFileSync(sidecar, "unrecognized prior runtime bytes")
  expect(() => openRuntimeInstallation(path)).toThrow(/orphan|incompatible/i)
  expect(readFileSync(sidecar, "utf8")).toBe("unrecognized prior runtime bytes")
  expect(existsSync(join(directory, "runtime.sqlite"))).toBe(false)
  expect(existsSync(join(directory, "runtime-owner.sqlite"))).toBe(false)
})

it("serves concurrent committed snapshots on independent read transactions", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope))
  await store.transaction((tx) => tx.runs.put(data.run))
  const observer = store.committedReader()
  const [first, second] = await Promise.all([observer.snapshot(), observer.snapshot()])
  expect(first).toEqual(second)
  expect(first.runs).toEqual([data.run])
})
