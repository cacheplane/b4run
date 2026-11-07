import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import type {
  RuntimeExecutionLease,
  RuntimeRecords,
  RuntimeSnapshot,
  RuntimeStorageScope,
  RuntimeStore,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
import { checkpointSpec } from "./checkpoints.js"
import { inboxSpec } from "./inbox.js"
import { installationContext, type RuntimeInstallation } from "./index.js"
import { makeJournal } from "./journal.js"
import { maintenanceSpec } from "./maintenance.js"
import { grantSpec, pendingSpec, receiptSpec } from "./receipts.js"
import { runSpec } from "./runs.js"
import { makeThread } from "./threads.js"

export interface RecordFields {
  readonly id: string
  readonly ownerRunId?: string | null
  readonly namespace?: readonly string[]
  readonly parentCheckpointId?: string | null
  readonly inputId?: string
  readonly pausedGeneration?: string
  readonly consumedByRunId?: string | null
  readonly turnId?: string | null
  readonly previousRunId?: string | null
  readonly preRunCheckpointId?: string | null
  readonly status?: string
}
export interface RecordSpec<Row> {
  readonly table: string
  fields(row: Row, access: Access): RecordFields
  afterPut?(row: Row, access: Access): void
}
export interface Access {
  readonly db: DatabaseSync
  readonly scope: RuntimeStorageScope
  readonly now: () => string
  check(): void
  reference(table: string, id: string | null): void
}
export function diagnostic(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
export function requireSame(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw diagnostic("scope_mismatch", "Runtime record belongs to a different scope")
}
export function makeRecords<Row>(access: Access, spec: RecordSpec<Row>): RuntimeRecords<Row> {
  const { db, scope } = access
  return {
    async get(id) {
      access.check()
      access.reference(spec.table, id)
      const row = db
        .prepare(`SELECT payload FROM ${spec.table} WHERE id=? AND thread_id=? AND generation=?`)
        .get(id, scope.threadId, scope.generation)
      return row ? (JSON.parse(String(row.payload)) as Row) : undefined
    },
    async list() {
      access.check()
      return db
        .prepare(`SELECT payload FROM ${spec.table} WHERE thread_id=? AND generation=? ORDER BY id`)
        .all(scope.threadId, scope.generation)
        .map((row) => JSON.parse(String(row.payload)) as Row)
    },
    async put(record) {
      access.check()
      const fields = spec.fields(record, access)
      access.reference(spec.table, fields.id)
      const payload = JSON.stringify(record)
      if (payload === undefined) throw new Error("Runtime record must be serializable")
      db.prepare(
        `INSERT INTO ${spec.table}(id,thread_id,generation,owner_run_id,namespace,parent_checkpoint_id,input_id,paused_generation,consumed_by_run_id,turn_id,previous_run_id,pre_run_checkpoint_id,status,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_run_id=excluded.owner_run_id,namespace=excluded.namespace,parent_checkpoint_id=excluded.parent_checkpoint_id,input_id=excluded.input_id,paused_generation=excluded.paused_generation,consumed_by_run_id=excluded.consumed_by_run_id,turn_id=excluded.turn_id,previous_run_id=excluded.previous_run_id,pre_run_checkpoint_id=excluded.pre_run_checkpoint_id,status=excluded.status,payload=excluded.payload`,
      ).run(
        fields.id,
        scope.threadId,
        scope.generation,
        fields.ownerRunId ?? null,
        JSON.stringify(fields.namespace ?? []),
        fields.parentCheckpointId ?? null,
        fields.inputId ?? null,
        fields.pausedGeneration ?? null,
        fields.consumedByRunId ?? null,
        fields.turnId ?? null,
        fields.previousRunId ?? null,
        fields.preRunCheckpointId ?? null,
        fields.status ?? null,
        payload,
      )
      spec.afterPut?.(record, access)
    },
  }
}

function makeAccess(
  installation: RuntimeInstallation,
  db: DatabaseSync,
  scope: RuntimeStorageScope,
  now: () => string,
  alive: () => boolean,
): Access {
  const check = () => {
    if (!alive())
      throw diagnostic("closed_transaction", "Runtime transaction context is no longer active")
    const context = installationContext(installation)
    const owner = db.prepare("SELECT nonce FROM runtime_owner WHERE singleton=1").get()
    if (owner?.nonce !== context.lock.identity.nonce)
      throw diagnostic("stale_fence", "Runtime execution owner changed")
    const row = db
      .prepare("SELECT fence,deleted FROM scopes WHERE thread_id=? AND generation=?")
      .get(scope.threadId, scope.generation)
    if (row?.fence !== scope.fence || row?.deleted !== 0)
      throw diagnostic("stale_fence", "Runtime generation or ownership fence changed")
  }
  return {
    db,
    scope,
    now,
    check,
    reference(table, id) {
      check()
      if (id === null) return
      if (typeof id !== "string" || !id) throw new Error("Runtime record identity is required")
      const identityTable =
        table === "runs"
          ? "run_identities"
          : table === "checkpoints"
            ? "checkpoint_identities"
            : table
      const row = db.prepare(`SELECT thread_id,generation FROM ${identityTable} WHERE id=?`).get(id)
      if (row && (row.thread_id !== scope.threadId || row.generation !== scope.generation))
        throw diagnostic("scope_mismatch", "Runtime reference belongs to a different scope")
    },
  }
}
function makeTransaction(access: Access): RuntimeTransaction {
  const { db, scope } = access
  const runs = makeRecords(access, runSpec)
  const grants = makeRecords(access, grantSpec)
  const thread = makeThread(access)
  const tx: RuntimeTransaction = {
    scope,
    thread,
    runs: {
      ...runs,
      async delete(id) {
        access.check()
        access.reference("runs", id)
        db.prepare("DELETE FROM runs WHERE id=? AND thread_id=? AND generation=?").run(
          id,
          scope.threadId,
          scope.generation,
        )
      },
    },
    checkpoints: makeRecords(access, checkpointSpec),
    pending: makeRecords(access, pendingSpec),
    grants: {
      ...grants,
      async consume(id, continuationRunId) {
        access.check()
        access.reference("runs", continuationRunId)
        const grant = await grants.get(id)
        if (!grant || grant.consumedByRunId !== null) return false
        const current = await thread.get()
        const pending = await tx.pending.get(grant.inputId)
        if (
          !current ||
          current.pausedGeneration !== grant.pausedGeneration ||
          current.currentRunId !== grant.ownerRunId ||
          !pending ||
          pending.disposition !== "pending" ||
          pending.ownerRunId !== grant.ownerRunId ||
          pending.input.data.b4?.pausedGeneration !== grant.pausedGeneration ||
          pending.input.data.b4?.proposalHash !== grant.proposalHash ||
          JSON.stringify(pending.namespace) !== JSON.stringify(grant.namespace) ||
          (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.parse(access.now()))
        )
          return false
        access.check()
        // Awaited reads can interleave even inside this single transaction.
        // Compare the validated records again in the same statement that wins
        // consumption, and keep its canonical column and payload inseparable.
        const result = db
          .prepare(`
          UPDATE grants SET consumed_by_run_id=?,payload=?
          WHERE id=? AND thread_id=? AND generation=?
            AND consumed_by_run_id IS NULL AND payload=?
            AND EXISTS (
              SELECT 1 FROM threads WHERE thread_id=? AND generation=?
                AND current_run_id=? AND paused_generation=? AND payload=?
            )
            AND EXISTS (
              SELECT 1 FROM pending WHERE id=? AND thread_id=? AND generation=?
                AND owner_run_id=? AND status='pending' AND namespace=? AND payload=?
            )
        `)
          .run(
            continuationRunId,
            JSON.stringify({ ...grant, consumedByRunId: continuationRunId }),
            id,
            scope.threadId,
            scope.generation,
            JSON.stringify(grant),
            scope.threadId,
            scope.generation,
            grant.ownerRunId,
            grant.pausedGeneration,
            JSON.stringify(current),
            grant.inputId,
            scope.threadId,
            scope.generation,
            grant.ownerRunId,
            JSON.stringify(grant.namespace),
            JSON.stringify(pending),
          )
        return result.changes === 1
      },
    },
    receipts: makeRecords(access, receiptSpec),
    journal: makeJournal(access),
    inbox: makeRecords(access, inboxSpec),
    maintenance: makeRecords(access, maintenanceSpec),
    async snapshot() {
      access.check()
      const row = db
        .prepare("SELECT through_seq FROM scopes WHERE thread_id=? AND generation=?")
        .get(scope.threadId, scope.generation)
      const record = await thread.get()
      return {
        scope,
        revision: record?.revision ?? 0,
        throughSeq: Number(row?.through_seq ?? 0),
        thread: record,
        recovery: undefined,
        runs: await tx.runs.list(),
        checkpoints: await tx.checkpoints.list(),
        pending: await tx.pending.list(),
        grants: await tx.grants.list(),
        receipts: await tx.receipts.list(),
        inbox: await tx.inbox.list(),
        maintenance: await tx.maintenance.list(),
      }
    },
    async copy() {
      access.check()
      throw diagnostic(
        "unsupported_operation",
        "Runtime copy requires the coordinated state service and validated destination binding",
      )
    },
    async rollback() {
      access.check()
      throw diagnostic(
        "unsupported_operation",
        "Runtime rollback requires the coordinated state service",
      )
    },
    async deleteThread() {
      access.check()
      throw diagnostic(
        "unsupported_operation",
        "Runtime deletion requires the coordinated maintenance service",
      )
    },
  }
  return tx
}

/** Check callback reentry before any host or store waits on a writer/scope
 * queue. This is the established queue policy, not a global busy check. */
export function assertRuntimeQueueEntry(
  installation: RuntimeInstallation,
  scopeKey?: string,
): void {
  const context = installationContext(installation)
  const current = context.activity.getStore()
  if (
    current?.kind === "transaction" ||
    (current?.kind === "lease" && current.scopeKey === scopeKey)
  )
    throw new Error("Nested runtime transaction or lease would deadlock")
  if (
    current?.kind === "lease" &&
    scopeKey !== undefined &&
    (context.leaseRequests.get(scopeKey)?.count ?? 0) > 0
  )
    throw new Error("Lease callback cannot wait behind another scoped lease")
}

export interface BoundRuntimeStore extends RuntimeStore {
  committedReader(): Pick<RuntimeStore, "snapshot">
  advanceFence(): Promise<BoundRuntimeStore>
  claimExecution(
    ownerId: string,
    callback: (tx: RuntimeTransaction) => Promise<void>,
  ): Promise<RuntimeExecutionLease | undefined>
  releaseExecution(ownerId: string): Promise<void>
}
/** Called only by the internal capability binder, never from public config. */
export function makeRuntimeStore(
  installation: RuntimeInstallation,
  inputScope: RuntimeStorageScope,
  now: () => string,
): BoundRuntimeStore {
  const scope = Object.freeze({ ...inputScope })
  const context = installationContext(installation)
  const scopeKey = JSON.stringify([scope.threadId, scope.generation])
  async function scopeExclusive<T>(callback: () => Promise<T>): Promise<T> {
    assertRuntimeQueueEntry(installation, scopeKey)
    const previous = context.scopeTails.get(scopeKey) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    context.scopeTails.set(scopeKey, tail)
    await previous
    try {
      return await callback()
    } finally {
      if (context.scopeTails.get(scopeKey) === tail) context.scopeTails.delete(scopeKey)
      release()
    }
  }
  async function exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const previous = context.tail
    let release!: () => void
    context.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    context.pending++
    await previous
    try {
      installationContext(installation)
      context.busy = true
      return await context.activity.run({ kind: "transaction", scopeKey }, callback)
    } finally {
      context.busy = false
      context.pending--
      release()
    }
  }
  async function transaction<T>(callback: (tx: RuntimeTransaction) => Promise<T>): Promise<T> {
    return scopeExclusive(() =>
      exclusive(async () => {
        let active = true
        context.db.exec("BEGIN IMMEDIATE")
        try {
          const access = makeAccess(installation, context.db, scope, now, () => active)
          access.check()
          const result = await callback(makeTransaction(access))
          access.check()
          active = false
          context.db.exec("COMMIT")
          return result
        } catch (error) {
          active = false
          if (context.db.isTransaction) context.db.exec("ROLLBACK")
          throw error
        }
      }),
    )
  }
  // All fence transitions, including execution claim/release, share the same
  // scoped writer queue and physical transaction as ordinary runtime writes.
  async function transitionFence(
    claim?: { ownerId: string; callback: (tx: RuntimeTransaction) => Promise<void> },
    releaseOwner?: string,
  ): Promise<BoundRuntimeStore | undefined> {
    const changed = await scopeExclusive(() =>
      exclusive(async () => {
        const db = context.db
        let active = true
        db.exec("BEGIN IMMEDIATE")
        try {
          makeAccess(installation, db, scope, now, () => active).check()
          const row = db
            .prepare(
              "SELECT execution_owner,execution_nonce FROM scopes WHERE thread_id=? AND generation=?",
            )
            .get(scope.threadId, scope.generation)
          if (
            claim &&
            row?.execution_owner &&
            row.execution_nonce === context.lock.identity.nonce
          ) {
            db.exec("ROLLBACK")
            return false
          }
          if (
            releaseOwner &&
            (row?.execution_owner !== releaseOwner ||
              row.execution_nonce !== context.lock.identity.nonce)
          )
            throw diagnostic("stale_fence", "Execution owner changed")
          const result = db
            .prepare(
              "UPDATE scopes SET fence=fence+1,execution_owner=?,execution_nonce=? WHERE thread_id=? AND generation=? AND fence=? AND fence<9007199254740991",
            )
            .run(
              claim?.ownerId ?? (releaseOwner ? null : (row?.execution_owner ?? null)),
              claim
                ? context.lock.identity.nonce
                : releaseOwner
                  ? null
                  : (row?.execution_nonce ?? null),
              scope.threadId,
              scope.generation,
              scope.fence,
            )
          if (result.changes !== 1) throw diagnostic("stale_fence", "Cannot advance runtime fence")
          const access = makeAccess(
            installation,
            db,
            { ...scope, fence: scope.fence + 1 },
            now,
            () => active,
          )
          if (claim) await claim.callback(makeTransaction(access))
          access.check()
          active = false
          db.exec("COMMIT")
          return true
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK")
          throw error
        } finally {
          active = false
        }
      }),
    )
    return changed
      ? makeRuntimeStore(installation, { ...scope, fence: scope.fence + 1 }, now)
      : undefined
  }
  const store: BoundRuntimeStore = {
    profile: "coordinated",
    transaction,
    snapshot: () => transaction((tx) => tx.snapshot()),
    committedReader() {
      installationContext(installation)
      return {
        async snapshot(): Promise<RuntimeSnapshot> {
          installationContext(installation)
          const db = new DatabaseSync(installation.path, { readOnly: true })
          context.readers.add(db)
          let active = true
          try {
            db.exec("BEGIN")
            const tx = makeTransaction(makeAccess(installation, db, scope, now, () => active))
            const result = await tx.snapshot()
            active = false
            db.exec("COMMIT")
            return result
          } catch (error) {
            active = false
            if (db.isTransaction) db.exec("ROLLBACK")
            throw error
          } finally {
            active = false
            context.readers.delete(db)
            db.close()
          }
        },
      }
    },
    async advanceFence() {
      const next = await transitionFence()
      if (!next) throw new Error("Runtime fence did not advance")
      return next
    },
    async releaseExecution(ownerId) {
      await transitionFence(undefined, ownerId)
    },
    async claimExecution(ownerId, callback) {
      if (!ownerId) throw new Error("Execution owner identity is required")
      const claimed = await transitionFence({ ownerId, callback })
      if (!claimed) return undefined
      const nextScope = { ...scope, fence: scope.fence + 1 }
      let released = false
      return {
        store: claimed,
        async heartbeat() {
          if (released) throw diagnostic("stale_fence", "Execution lease released")
          await claimed.transaction(async () => {
            const row = context.db
              .prepare(
                "SELECT execution_owner,execution_nonce FROM scopes WHERE thread_id=? AND generation=?",
              )
              .get(scope.threadId, scope.generation)
            if (
              row?.execution_owner !== ownerId ||
              row.execution_nonce !== context.lock.identity.nonce
            )
              throw diagnostic("stale_fence", "Execution owner changed")
          })
        },
        async release() {
          if (released) return
          // Use the same transition algorithm at the newly claimed fence.
          await makeRuntimeStore(installation, nextScope, now).releaseExecution(ownerId)
          released = true
        },
      }
    },
    withReadLease: async (callback) => {
      installationContext(installation)
      // Lease nesting is unsupported. Cross-Thread transactions are allowed
      // only when they cannot wait behind a held or queued scoped lease.
      if (context.activity.getStore())
        throw new Error("Nested runtime read lease acquisition is not supported")
      const requests = context.leaseRequests.get(scopeKey) ?? { count: 0 }
      requests.count++
      context.leaseRequests.set(scopeKey, requests)
      try {
        return await scopeExclusive(async () => {
          const lease = await exclusive(async () => {
            const db = context.db
            let active = true
            db.exec("BEGIN IMMEDIATE")
            try {
              const tx = makeTransaction(makeAccess(installation, db, scope, now, () => active))
              const snapshot = await tx.snapshot()
              const leaseId = randomUUID()
              db.prepare("INSERT INTO leases VALUES (?,?,?,?,?,?,?)").run(
                leaseId,
                scope.threadId,
                scope.generation,
                scope.fence,
                snapshot.revision,
                snapshot.throughSeq,
                context.lock.identity.nonce,
              )
              db.exec("COMMIT")
              return { leaseId, snapshot }
            } finally {
              active = false
              if (db.isTransaction) db.exec("ROLLBACK")
            }
          })
          // Only this generation is excluded during provider/unwind work. The
          // installation writer queue and SQLite transaction have been released.
          try {
            return await context.activity.run({ kind: "lease", scopeKey }, () => callback(lease))
          } finally {
            await exclusive(async () => {
              const access = makeAccess(installation, context.db, scope, now, () => true)
              context.db.exec("BEGIN IMMEDIATE")
              try {
                access.check()
                context.db
                  .prepare("DELETE FROM leases WHERE id=? AND owner_nonce=?")
                  .run(lease.leaseId, context.lock.identity.nonce)
                context.db.exec("COMMIT")
              } finally {
                if (context.db.isTransaction) context.db.exec("ROLLBACK")
              }
            })
          }
        })
      } finally {
        // Count queued and active requests independently: completing one lease
        // must not erase another request's protection against wait cycles.
        requests.count--
        if (requests.count === 0) context.leaseRequests.delete(scopeKey)
      }
    },
  }
  return store
}
