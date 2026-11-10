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
import { assertPendingGrantIdentities } from "../../../test/agent-protocol/runtime-pending-identities.ts"
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
    version: 2,
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
it.each(["version", "version-zero", "installation", "unmarked", "format"])(
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
    if (mode === "unmarked") {
      const retainedKey = db.prepare("SELECT * FROM runtime_recovery_keys").all()
      expect(retainedKey).toHaveLength(1)
      // This disposable raw copy intentionally lacks its marker; retain its key.
      db.exec("PRAGMA foreign_keys=OFF")
      expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(0)
      db.exec("DELETE FROM runtime_installation")
      expect(db.prepare("SELECT * FROM runtime_installation").all()).toEqual([])
      expect(db.prepare("SELECT * FROM runtime_recovery_keys").all()).toEqual(retainedKey)
    } else if (mode === "version") db.exec("UPDATE runtime_installation SET version=999")
    else if (mode === "version-zero") db.exec("UPDATE runtime_installation SET version=0")
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
  await expect(
    other.transaction((tx) =>
      tx.pending.get({
        ownerRunId: data.runId,
        pausedGeneration: "pause",
        namespace: [],
        inputId: "public-input",
        proposalHash: "proposal",
      }),
    ),
  ).rejects.toMatchObject({ code: "scope_mismatch" })
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
  db.exec("PRAGMA wal_autocheckpoint=0; UPDATE runtime_installation SET version=999")
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

async function leasePair() {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const first = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope))
  const otherScope = {
    ...data.scope,
    threadId: "50000000-0000-4000-8000-000000000001",
    generation: "50000000-0000-4000-8000-000000000002",
  }
  const second = bindRuntimeStore(owner, createRuntimeBinding(owner, otherScope))
  return { owner, first, second, data, otherScope }
}
function acquisitionOutcome(promise: Promise<unknown>) {
  // All lease bookkeeping uses synchronous SQLite plus promise microtasks. A
  // queued acquisition still pending on the next turn must fail this assertion;
  // the outer callbacks then unwind so the RED case can clean up normally.
  return Promise.race([
    promise.then(
      () => ({ status: "fulfilled" }),
      (reason: unknown) => ({ status: "rejected", reason }),
    ),
    new Promise<{ status: string }>((resolve) => setImmediate(() => resolve({ status: "queued" }))),
  ])
}
async function registeredRuntime() {
  const { sqliteRuntimeStorage } = await import("../src/runtime/host.ts")
  let registration!: import("@b4run/sdk/agent-protocol").RuntimeStorageRegistrationOptions
  await sqliteRuntimeStorage(root())((value) => {
    registration = value
    return { installationId: value.installationId }
  })
  cleanup.push(() => {
    void registration.close()
  })
  const store = await registration.openThread("host-queue-first", true)
  if (!store || !registration.execution) throw new Error("Missing registered SQLite runtime")
  return { registration, store, execution: registration.execution }
}
it.each(["claim", "open existing", "open missing"] as const)(
  "rejects registered host %s before waiting on its active outer transaction",
  async (operation) => {
    const { registration, store, execution } = await registeredRuntime()
    let nested: Promise<unknown> | undefined
    let active = false,
      claimCallbacks = 0
    try {
      await store.transaction(async () => {
        active = true
        nested =
          operation === "claim"
            ? execution.claim("host-queue-first", "nested-owner", async () => {
                claimCallbacks++
              })
            : registration.openThread(
                operation === "open existing" ? "host-queue-first" : "host-queue-new",
                operation === "open missing",
              )
        const outcome = await acquisitionOutcome(nested)
        expect(active, "rejection must precede the outer transaction's unwind").toBe(true)
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({
            message: expect.stringMatching(/nested.*transaction|transaction.*deadlock/i),
          }),
        })
        active = false
      })
    } finally {
      active = false
      await nested?.catch(() => undefined)
    }
    expect(claimCallbacks).toBe(0)
    expect((await store.snapshot()).scope.fence).toBe(1)
    const lease = await execution.claim("host-queue-first", "normal-owner", async () => {})
    expect(lease).toBeDefined()
    await lease?.heartbeat()
    await lease?.release()
    const current = await registration.openThread("host-queue-first", false)
    expect(current).toBeDefined()
    await current?.transaction(async () => {})
    await registration.close()
  },
)
it.each(["claim", "open"] as const)(
  "allows an unrelated registered host %s to queue behind a normal active writer",
  async (operation) => {
    const { registration, store, execution } = await registeredRuntime()
    await registration.openThread("host-queue-second", true)
    let entered!: () => void, release!: () => void
    const enteredWriter = new Promise<void>((resolve) => {
      entered = resolve
    })
    const releaseWriter = new Promise<void>((resolve) => {
      release = resolve
    })
    const writer = store.transaction(async () => {
      entered()
      await releaseWriter
    })
    await enteredWriter
    const waiting =
      operation === "claim"
        ? execution.claim("host-queue-second", "queued-owner", async () => {})
        : registration.openThread("host-queue-second", false)
    try {
      expect(await acquisitionOutcome(waiting)).toEqual({ status: "queued" })
    } finally {
      release()
      await writer
    }
    const result = await waiting
    expect(result).toBeDefined()
    if (result && "release" in result) await result.release()
    await store.transaction(async () => {})
    await registration.close()
  },
)
it("allows registered host opening and claiming a free foreign scope inside an inspection callback", async () => {
  const { registration, store, execution } = await registeredRuntime()
  await registration.openThread("host-queue-second", true)
  await store.withReadLease(async () => {
    const other = await registration.openThread("host-queue-second", false)
    expect(other).toBeDefined()
    const lease = await execution.claim("host-queue-second", "foreign-owner", async () => {})
    expect(lease).toBeDefined()
    await lease?.heartbeat()
    await lease?.release()
  })
  await store.transaction(async () => {})
  await registration.close()
})
it.each(["claim", "open"] as const)(
  "rejects registered host %s for its held scope before an unrelated writer can delay the lease guard",
  async (operation) => {
    const { registration, store, execution } = await registeredRuntime()
    const other = await registration.openThread("host-queue-second", true)
    if (!other) throw new Error("Missing foreign scope")
    await store.withReadLease(async () => {
      let entered!: () => void, release!: () => void
      const enteredWriter = new Promise<void>((resolve) => {
        entered = resolve
      })
      const releaseWriter = new Promise<void>((resolve) => {
        release = resolve
      })
      const writer = other.transaction(async () => {
        entered()
        await releaseWriter
      })
      await enteredWriter
      const nested =
        operation === "claim"
          ? execution.claim("host-queue-first", "inspection-owner", async () => {})
          : registration.openThread("host-queue-first", false)
      try {
        expect(await acquisitionOutcome(nested)).toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({ message: expect.stringMatching(/nested.*lease/i) }),
        })
      } finally {
        release()
        await writer
        await nested.catch(() => undefined)
      }
    })
    await store.transaction(async () => {})
    await registration.close()
  },
)
function assertNoLeases(owner: { readonly path: string; close(): void }) {
  const db = new DatabaseSync(owner.path, { readOnly: true })
  try {
    expect(db.prepare("SELECT count(*) AS n FROM leases").get()?.n).toBe(0)
  } finally {
    db.close()
  }
  expect(() => owner.close()).not.toThrow()
}
it("rejects a nested lease before ancestor scope reacquisition can queue", async () => {
  const { owner, first, second } = await leasePair()
  let nested: Promise<unknown> | undefined
  try {
    await first.withReadLease(async () => {
      nested = second.withReadLease(() => first.transaction((tx) => tx.snapshot()))
      expect(await acquisitionOutcome(nested)).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: expect.stringMatching(/nested.*lease/i) }),
      })
    })
  } finally {
    await nested?.catch(() => undefined)
  }
  assertNoLeases(owner)
})
it("rejects opposing cross-scope nested lease acquisitions without retaining either lease", async () => {
  const { owner, first, second } = await leasePair()
  let enteredFirst!: () => void
  let enteredSecond!: () => void
  const firstEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve
  })
  const secondEntered = new Promise<void>((resolve) => {
    enteredSecond = resolve
  })
  const nested: Promise<unknown>[] = []
  const run = async (
    held: typeof first,
    next: typeof second,
    entered: () => void,
    otherEntered: Promise<void>,
  ) =>
    held.withReadLease(async () => {
      entered()
      await otherEntered
      const acquisition = next.withReadLease(async () => undefined)
      nested.push(acquisition)
      expect(await acquisitionOutcome(acquisition)).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: expect.stringMatching(/nested.*lease/i) }),
      })
    })
  const outer = [
    run(first, second, enteredFirst, secondEntered),
    run(second, first, enteredSecond, firstEntered),
  ]
  try {
    await Promise.all(outer)
  } finally {
    await Promise.allSettled(outer)
    await Promise.allSettled(nested)
  }
  assertNoLeases(owner)
})
it("allows another Thread transaction inside a lease callback", async () => {
  const { owner, first, second, otherScope, data } = await leasePair()
  const otherRun = {
    ...data.run,
    run: {
      ...data.run.run,
      run_id: "50000000-0000-4000-8000-000000000003",
      thread_id: otherScope.threadId,
    },
    metadata: {
      ...data.run.metadata,
      generation: otherScope.generation,
      turnId: "50000000-0000-4000-8000-000000000003",
    },
  }
  await first.withReadLease(async () => {
    await second.transaction((tx) => tx.runs.put(otherRun))
    expect((await second.committedReader().snapshot()).runs).toEqual([otherRun])
    const db = new DatabaseSync(owner.path, { readOnly: true })
    try {
      expect(db.prepare("SELECT count(*) AS n FROM leases").get()?.n).toBe(1)
    } finally {
      db.close()
    }
  })
  assertNoLeases(owner)
})

async function grantFixture() {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope), () => data.now)
  const first = "60000000-0000-4000-8000-000000000001"
  const second = "60000000-0000-4000-8000-000000000002"
  const grant: import("@b4run/sdk/agent-protocol").RuntimeGrantRecord = {
    grantId: "grant",
    tokenHash: "token-hash",
    proposalHash: "proposal-hash",
    inputId: "input",
    ownerRunId: data.runId,
    pausedGeneration: "pause",
    namespace: [],
    expiresAt: null,
    consumedByRunId: null,
  }
  const pending: import("@b4run/sdk/agent-protocol").RuntimePendingRecord = {
    input: {
      namespace: [],
      runId: data.runId,
      turnId: data.runId,
      data: {
        interruptId: grant.inputId,
        payload: {},
        b4: {
          v: 1,
          pausedGeneration: grant.pausedGeneration,
          proposalHash: grant.proposalHash,
          status: "waiting",
        },
      },
    },
    ownerRunId: data.runId,
    namespace: [],
    disposition: "pending",
    decision: null,
  }
  const paused = {
    ...data.thread,
    headCheckpointId: null,
    currentRunId: data.runId,
    pausedGeneration: grant.pausedGeneration,
  }
  await store.transaction(async (tx) => {
    await tx.runs.put(data.run)
    for (const id of [first, second])
      await tx.runs.put({
        ...data.run,
        run: { ...data.run.run, run_id: id },
        metadata: { ...data.run.metadata, previousRunId: data.runId },
      })
    await tx.thread.put(paused)
    await tx.pending.put(pending)
    await tx.grants.put(grant)
  })
  return { owner, store, data, grant, pending, paused, first, second }
}
it("has exactly one durable winner for concurrent grant consumes in one transaction", async () => {
  const { owner, store, grant, first, second } = await grantFixture()
  const result = await store.transaction((tx) =>
    Promise.all([
      tx.grants.consume(grant.grantId, first),
      tx.grants.consume(grant.grantId, second),
    ]),
  )
  expect(result.filter(Boolean)).toHaveLength(1)
  const winner = result[0] ? first : second
  const loser = result[0] ? second : first
  const expected = { ...grant, consumedByRunId: winner }
  expect((await store.snapshot()).grants).toEqual([expected])
  const db = new DatabaseSync(owner.path, { readOnly: true })
  try {
    const row = db
      .prepare("SELECT consumed_by_run_id,payload FROM grants WHERE id=?")
      .get(grant.grantId)
    expect(row?.consumed_by_run_id).toBe(winner)
    expect(JSON.parse(String(row?.payload))).toEqual(expected)
  } finally {
    db.close()
  }
  await expect(store.transaction((tx) => tx.grants.consume(grant.grantId, loser))).resolves.toBe(
    false,
  )
  expect((await store.snapshot()).grants).toEqual([expected])
})
it.each([
  "thread pause",
  "current owner",
  "input pause",
  "proposal",
  "namespace",
  "expiry",
  "input owner",
  "answered",
])("does not consume a grant after invalid %s", async (invalid) => {
  const { store, grant, pending, paused, first, data } = await grantFixture()
  await store.transaction(async (tx) => {
    // Different immutable identities coexist; simulating replacement retires
    // the old prompt rather than deleting or overwriting its history.
    if (["namespace", "input owner", "input pause", "proposal"].includes(invalid))
      await tx.pending.put({ ...pending, disposition: "retired" })
    if (invalid === "thread pause")
      await tx.thread.put({ ...paused, pausedGeneration: "other-pause" })
    else if (invalid === "current owner") await tx.thread.put({ ...paused, currentRunId: first })
    else if (invalid === "expiry")
      await tx.grants.put({ ...grant, expiresAt: "2026-11-05T23:59:59.000Z" })
    else if (invalid === "namespace")
      await tx.pending.put({
        ...pending,
        namespace: ["other"],
        input: { ...pending.input, namespace: ["other"] },
      })
    else if (invalid === "input owner")
      await tx.pending.put({
        ...pending,
        ownerRunId: first,
        input: { ...pending.input, runId: first },
      })
    else if (invalid === "answered") await tx.pending.put({ ...pending, disposition: "answered" })
    else
      await tx.pending.put({
        ...pending,
        input: {
          ...pending.input,
          data: {
            ...pending.input.data,
            b4: {
              ...pending.input.data.b4,
              ...(invalid === "input pause"
                ? { pausedGeneration: "other-pause" }
                : { proposalHash: "other-proposal" }),
            },
          },
        },
      })
    expect(tx.scope.threadId).toBe(data.scope.threadId)
  })
  const before = (await store.snapshot()).grants
  await expect(store.transaction((tx) => tx.grants.consume(grant.grantId, first))).resolves.toBe(
    false,
  )
  expect((await store.snapshot()).grants).toEqual(before)
})

it("rejects opposing cross-Thread transactions from top-level lease callbacks before they queue", async () => {
  const { owner, first, second } = await leasePair()
  let enteredFirst!: () => void
  let enteredSecond!: () => void
  const firstEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve
  })
  const secondEntered = new Promise<void>((resolve) => {
    enteredSecond = resolve
  })
  const transactions: Promise<unknown>[] = []
  const run = (
    held: typeof first,
    next: typeof second,
    entered: () => void,
    otherEntered: Promise<void>,
  ) =>
    held.withReadLease(async () => {
      entered()
      await otherEntered
      const transaction = next.transaction((tx) => tx.snapshot())
      transactions.push(transaction)
      expect(await acquisitionOutcome(transaction)).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringMatching(/lease.*wait|wait.*lease/i),
        }),
      })
    })
  const outer = [
    run(first, second, enteredFirst, secondEntered),
    run(second, first, enteredSecond, firstEntered),
  ]
  try {
    await Promise.all(outer)
  } finally {
    await Promise.allSettled(outer)
    await Promise.allSettled(transactions)
  }
  assertNoLeases(owner)
})
it("retains queued lease protection after an earlier same-scope lease completes", async () => {
  const { owner, first, second } = await leasePair()
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  let enteredFirst!: () => void
  let enteredSecond!: () => void
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const secondRelease = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const firstEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve
  })
  const secondEntered = new Promise<void>((resolve) => {
    enteredSecond = resolve
  })
  const firstLease = second.withReadLease(async () => {
    enteredFirst()
    await firstRelease
  })
  await firstEntered
  const queuedLease = second.withReadLease(async () => {
    enteredSecond()
    await secondRelease
  })
  let transaction: Promise<unknown> | undefined
  try {
    await first.withReadLease(async () => {
      releaseFirst()
      await firstLease
      await secondEntered
      transaction = second.transaction((tx) => tx.snapshot())
      expect(await acquisitionOutcome(transaction)).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringMatching(/lease.*wait|wait.*lease/i),
        }),
      })
    })
  } finally {
    releaseFirst()
    releaseSecond()
    await Promise.allSettled([firstLease, queuedLease])
    await transaction?.catch(() => undefined)
  }
  assertNoLeases(owner)
})

it("keeps exact compound pending identities and immutable historical grants", async () => {
  const { openRuntimeInstallation } = await runtime()
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const data = await import("./fixtures/runtime-data.ts")
  const owner = openRuntimeInstallation(root())
  cleanup.push(() => owner.close())
  const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope), () => data.now)
  await assertPendingGrantIdentities(store, data.run, data.thread)
})
