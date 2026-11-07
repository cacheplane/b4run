import type {
  RuntimeExecutionLease,
  RuntimeRecords,
  RuntimeSnapshot,
  RuntimeStorageScope,
  RuntimeStore,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
import { B4PostgresSaver } from "../checkpointer.js"
import { createFencedPool } from "../internal/fenced-pool.js"
import { rollbackQuietly, withTransaction } from "../internal/tx.js"
import type { SqlClient, SqlPool, SqlResult } from "../sql.js"
import { checkpointSpec } from "./checkpoints.js"
import { inboxSpec } from "./inbox.js"
import {
  type Activity,
  installationContext,
  type PostgresRuntimeInstallation,
  scopeKey,
} from "./index.js"
import { makeJournal } from "./journal.js"
import { maintenanceSpec } from "./maintenance.js"
import { grantSpec, pendingKey, pendingSpec, receiptSpec } from "./receipts.js"
import { runSpec } from "./runs.js"
import { table } from "./schema.js"
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
  fields(row: Row, access: Access): Promise<RecordFields>
  afterPut?(row: Row, access: Access): Promise<void>
}
export interface Access {
  readonly scope: RuntimeStorageScope
  readonly now: () => string
  check(): void
  query<R = unknown>(sql: string, values?: readonly unknown[]): Promise<SqlResult<R>>
  reference(table: string, id: string | null): Promise<void>
}
export function diagnostic(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
/** Discovery must not acquire a client before checking callback lifetime and
 * actual spare capacity. These checks establish resources, never authority. */
export function assertRuntimeHostEntry(owner: PostgresRuntimeInstallation): void {
  const context = installationContext(owner)
  const current = context.host.activity.getStore()
  if (current && !current.active)
    throw diagnostic("closed_transaction", "Runtime callback context is no longer active")
  if (current?.failure) throw current.failure.error
  if (current?.kind === "transaction") throw new Error("Nested runtime host access would deadlock")
  if (current?.kind === "lease") context.host.assertWorkCapacity()
}
/** Reject callback reentry/resource waits before a write acquires a client or
 * changes pending accounting. Internal resource validation, not authority. */
export function assertRuntimeWriteEntry(
  owner: PostgresRuntimeInstallation,
  scope: RuntimeStorageScope,
): void {
  const context = installationContext(owner)
  const current = context.host.activity.getStore()
  if (current?.kind === "transaction" || current?.scopeKey === scopeKey(owner, scope))
    throw new Error("Nested runtime transaction or lease would deadlock")
  assertRuntimeHostEntry(owner)
}
export function requireSame(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw diagnostic("scope_mismatch", "Runtime record belongs to a different scope")
}
export function makeRecords<Row>(access: Access, spec: RecordSpec<Row>): RuntimeRecords<Row> {
  const { scope } = access
  return {
    async get(id) {
      await access.reference(spec.table, id)
      const result = await access.query<{ payload: string }>(
        `SELECT payload FROM ${spec.table} WHERE id=? AND thread_id=? AND generation=?`,
        [id, scope.threadId, scope.generation],
      )
      return result.rows[0] ? (JSON.parse(result.rows[0].payload) as Row) : undefined
    },
    async list() {
      const result = await access.query<{ payload: string }>(
        `SELECT payload FROM ${spec.table} WHERE thread_id=? AND generation=? ORDER BY id COLLATE "C"`,
        [scope.threadId, scope.generation],
      )
      return result.rows.map((row) => JSON.parse(row.payload) as Row)
    },
    async put(record) {
      access.check()
      const f = await spec.fields(record, access)
      await access.reference(spec.table, f.id)
      const payload = JSON.stringify(record)
      if (payload === undefined) throw new Error("Runtime record must be serializable")
      const result = await access.query(
        `INSERT INTO ${spec.table} AS target(id,thread_id,generation,owner_run_id,namespace,parent_checkpoint_id,input_id,paused_generation,consumed_by_run_id,turn_id,previous_run_id,pre_run_checkpoint_id,status,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_run_id=excluded.owner_run_id,namespace=excluded.namespace,parent_checkpoint_id=excluded.parent_checkpoint_id,input_id=excluded.input_id,paused_generation=excluded.paused_generation,consumed_by_run_id=excluded.consumed_by_run_id,turn_id=excluded.turn_id,previous_run_id=excluded.previous_run_id,pre_run_checkpoint_id=excluded.pre_run_checkpoint_id,status=excluded.status,payload=excluded.payload WHERE target.thread_id=excluded.thread_id AND target.generation=excluded.generation RETURNING id`,
        [
          f.id,
          scope.threadId,
          scope.generation,
          f.ownerRunId ?? null,
          JSON.stringify(f.namespace ?? []),
          f.parentCheckpointId ?? null,
          f.inputId ?? null,
          f.pausedGeneration ?? null,
          f.consumedByRunId ?? null,
          f.turnId ?? null,
          f.previousRunId ?? null,
          f.preRunCheckpointId ?? null,
          f.status ?? null,
          payload,
        ],
      )
      if (result.rows.length !== 1)
        throw diagnostic(
          "scope_mismatch",
          "Runtime identity was concurrently claimed by a different scope",
        )
      await spec.afterPut?.(record, access)
    },
  }
}
function makeAccess(
  owner: PostgresRuntimeInstallation,
  client: SqlClient,
  scope: RuntimeStorageScope,
  now: () => string,
  alive: () => boolean,
): Access {
  const context = installationContext(owner)
  const check = () => {
    if (!alive())
      throw diagnostic("closed_transaction", "Runtime transaction context is no longer active")
    installationContext(owner)
  }
  const access: Access = {
    scope,
    now,
    check,
    async query<R>(sql: string, values?: readonly unknown[]) {
      check()
      let position = 0
      const qualified = sql
        .replace(
          /\b(FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)\b/g,
          (_match, verb: string, name: string) => `${verb} ${table(context.naming, name)}`,
        )
        .replace(/\?/g, () => `$${++position}`)
      return client.query<R>(qualified, values)
    },
    async reference(name, id) {
      check()
      if (id === null) return
      if (typeof id !== "string" || !id) throw new Error("Runtime record identity is required")
      const identity =
        name === "runs" ? "run_identities" : name === "checkpoints" ? "checkpoint_identities" : name
      const result = await access.query<{ thread_id: string; generation: string }>(
        `SELECT thread_id,generation FROM ${identity} WHERE id=?`,
        [id],
      )
      const row = result.rows[0]
      if (row && (row.thread_id !== scope.threadId || row.generation !== scope.generation))
        throw diagnostic("scope_mismatch", "Runtime reference belongs to a different scope")
    },
  }
  return access
}
function makeTransaction(access: Access): RuntimeTransaction {
  const { scope } = access
  const runs = makeRecords(access, runSpec),
    grants = makeRecords(access, grantSpec),
    thread = makeThread(access)
  const tx: RuntimeTransaction = {
    scope,
    thread,
    runs: {
      ...runs,
      async delete(id) {
        await access.reference("runs", id)
        await access.query("DELETE FROM runs WHERE id=? AND thread_id=? AND generation=?", [
          id,
          scope.threadId,
          scope.generation,
        ])
      },
    },
    checkpoints: makeRecords(access, checkpointSpec),
    pending: {
      ...makeRecords(access, pendingSpec),
      async get(identity) {
        access.check()
        await access.reference("runs", identity.ownerRunId)
        const row = await makeRecords(access, pendingSpec).get(pendingKey(scope, identity))
        // The bounded hash is an index key, not authority. Compare every
        // original identity field against the retained payload as well.
        return row &&
          row.ownerRunId === identity.ownerRunId &&
          row.input.data.b4.pausedGeneration === identity.pausedGeneration &&
          row.input.data.b4.proposalHash === identity.proposalHash &&
          row.input.data.interruptId === identity.inputId &&
          JSON.stringify(row.namespace) === JSON.stringify(identity.namespace)
          ? row
          : undefined
      },
    },
    grants: {
      ...grants,
      async consume(id, continuationRunId, negativeDecision) {
        await access.reference("runs", continuationRunId)
        const grant = await grants.get(id)
        if (!grant || grant.consumedByRunId !== null) return false
        const current = await thread.get(),
          pending = await tx.pending.get(grant)
        if (
          !current ||
          current.pausedGeneration !== grant.pausedGeneration ||
          current.currentRunId !== grant.ownerRunId ||
          !pending ||
          pending.disposition !== "pending" ||
          pending.ownerRunId !== grant.ownerRunId ||
          pending.input.data.interruptId !== grant.inputId ||
          pending.input.data.b4?.pausedGeneration !== grant.pausedGeneration ||
          pending.input.data.b4?.proposalHash !== grant.proposalHash ||
          JSON.stringify(pending.namespace) !== JSON.stringify(grant.namespace) ||
          (negativeDecision !== "deny" &&
            grant.expiresAt !== null &&
            Date.parse(grant.expiresAt) <= Date.parse(access.now()))
        )
          return false
        const result = await access.query(
          "UPDATE grants SET consumed_by_run_id=?,payload=? WHERE id=? AND thread_id=? AND generation=? AND consumed_by_run_id IS NULL AND payload=? AND EXISTS (SELECT 1 FROM threads WHERE thread_id=? AND generation=? AND current_run_id=? AND paused_generation=? AND payload=?) AND EXISTS (SELECT 1 FROM pending WHERE id=? AND thread_id=? AND generation=? AND owner_run_id=? AND status='pending' AND namespace=? AND payload=?) RETURNING id",
          [
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
            pendingKey(scope, grant),
            scope.threadId,
            scope.generation,
            grant.ownerRunId,
            JSON.stringify(grant.namespace),
            JSON.stringify(pending),
          ],
        )
        return result.rows.length === 1
      },
    },
    receipts: makeRecords(access, receiptSpec),
    journal: makeJournal(access),
    inbox: makeRecords(access, inboxSpec),
    maintenance: makeRecords(access, maintenanceSpec),
    async snapshot() {
      const row = (
        await access.query<{ through_seq: string }>(
          "SELECT through_seq FROM scopes WHERE thread_id=? AND generation=?",
          [scope.threadId, scope.generation],
        )
      ).rows[0]
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
export interface BoundRuntimeStore extends RuntimeStore {
  readonly pool: SqlPool
  checkpointer(ownerRunId: string, namespace?: string): B4PostgresSaver
  committedReader(): Pick<RuntimeStore, "snapshot">
  advanceFence(): Promise<BoundRuntimeStore>
  renewIdleScope(): Promise<BoundRuntimeStore>
  claimExecution(
    ownerId: string,
    callback: (tx: RuntimeTransaction) => Promise<void>,
  ): Promise<RuntimeExecutionLease | undefined>
  releaseExecution(ownerId: string): Promise<void>
}
/** Internal capability binder only. The coordinated label describes this
 * transaction domain, not activated host/protocol or deferred service support. */
export function makeRuntimeStore(
  owner: PostgresRuntimeInstallation,
  inputScope: RuntimeStorageScope,
  now: () => string,
): BoundRuntimeStore {
  const scope = Object.freeze({ ...inputScope }),
    context = installationContext(owner),
    key = scopeKey(owner, scope)
  const scopes = table(context.naming, "scopes")
  const usable = () => {
    installationContext(owner)
    const current = context.host.activity.getStore()
    if (current?.owner === owner && current.scopeKey === key) {
      if (!current.active)
        throw diagnostic("closed_transaction", "Runtime transaction context is no longer active")
      if (current.failure) throw current.failure.error
    }
  }
  const enlist = () => {
    const current = context.host.activity.getStore()
    if (
      current?.kind !== "transaction" ||
      current.owner !== owner ||
      current.scopeKey !== key ||
      !current.client
    )
      return undefined
    return {
      client: current.client,
      check: usable,
      fail(error: unknown) {
        current.failure ??= { error }
      },
    }
  }
  const lockScope = async (client: SqlClient, enlisted = false) => {
    const current = context.host.activity.getStore()
    if (
      current?.kind === "transaction" &&
      (!enlisted || current.owner !== owner || current.scopeKey !== key)
    )
      throw new Error("Nested runtime transaction would deadlock")
    if (current?.kind === "lease" && current.scopeKey === key)
      throw new Error("Nested runtime transaction or lease would deadlock")
    if (current) {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,1)) AS locked",
        [key],
      )
      if (!result.rows[0]?.locked)
        throw new Error("Lease callback cannot wait behind another scoped lease")
    } else await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [key])
  }
  const validate = async (
    client: SqlClient,
    lock = true,
    allowExpired = false,
    selectedScope = scope,
  ) => {
    usable()
    if (lock) await lockScope(client, true)
    const result = await client.query<{ fence: string; deleted: number; live: boolean }>(
      `SELECT fence,deleted,lease_expires_at>clock_timestamp() AS live FROM ${scopes} WHERE thread_id=$1 AND generation=$2${lock ? " FOR UPDATE" : ""}`,
      [selectedScope.threadId, selectedScope.generation],
    )
    const row = result.rows[0]
    if (
      !row ||
      Number(row.fence) !== selectedScope.fence ||
      row.deleted !== 0 ||
      (!allowExpired && !row.live)
    )
      throw diagnostic("stale_fence", "Runtime generation or ownership lease changed")
  }
  // Track both queued acquisitions and cached checked-out clients. Closing may
  // never end an owned pool while a child still holds or is awaiting a handle.
  const trackedPool: SqlPool = {
    query: context.pool.query.bind(context.pool),
    async end() {},
    async connect() {
      usable()
      if (context.host.activity.getStore()) context.host.assertWorkCapacity()
      context.pending++
      try {
        const client = await context.pool.connect()
        try {
          usable()
        } catch (error) {
          client.release()
          throw error
        }
        context.handles.add(client)
        let released = false
        return {
          query: client.query.bind(client),
          release() {
            if (released) return
            released = true
            context.handles.delete(client)
            client.release()
          },
        }
      } finally {
        context.pending--
      }
    },
  }
  const pool = createFencedPool(trackedPool, {
    assertUsable: usable,
    active: () => true,
    validate,
    enlist,
  })
  const transaction = async <T>(
    callback: (tx: RuntimeTransaction) => Promise<T>,
    transition?: { claimOwner?: string; releaseOwner?: string; renewIdle?: true },
  ): Promise<T> => {
    usable()
    assertRuntimeWriteEntry(owner, scope)
    context.pending++
    try {
      // Lock before scope validation, using the same connection that every
      // enlisted record and native saver mutation shares until COMMIT.
      return await withTransaction(context.pool, async (raw) => {
        await lockScope(raw)
        await validate(raw, true, transition !== undefined)
        let effectiveScope = scope
        if (transition) {
          const rows = await raw.query<{ execution_owner: string | null; live: boolean }>(
            `SELECT execution_owner,lease_expires_at>clock_timestamp() AS live FROM ${scopes} WHERE thread_id=$1 AND generation=$2 FOR UPDATE`,
            [scope.threadId, scope.generation],
          )
          const row = rows.rows[0]
          if (transition.renewIdle && (row?.execution_owner || row?.live))
            throw diagnostic("stale_fence", "Idle renewal requires an unowned expired scope")
          if (transition.claimOwner && row?.execution_owner && row.live)
            throw diagnostic("owner_busy", "Runtime Thread has a live execution owner")
          if (transition.releaseOwner && row?.execution_owner !== transition.releaseOwner)
            throw diagnostic("stale_fence", "Execution owner changed")
          const result = await raw.query(
            `UPDATE ${scopes} SET fence=fence+1,lease_expires_at=clock_timestamp()+interval '60 seconds',execution_owner=$4 WHERE thread_id=$1 AND generation=$2 AND fence=$3 AND fence<9007199254740991 RETURNING fence`,
            [
              scope.threadId,
              scope.generation,
              scope.fence,
              transition.claimOwner ??
                (transition.releaseOwner ? null : (row?.execution_owner ?? null)),
            ],
          )
          if (result.rows.length !== 1)
            throw diagnostic("stale_fence", "Cannot advance runtime fence")
          effectiveScope = { ...scope, fence: scope.fence + 1 }
        }
        const validateTransaction = (client: SqlClient) =>
          validate(client, true, false, effectiveScope)
        let active = true
        const activity: Activity = {
          owner,
          kind: "transaction",
          scopeKey: key,
          installationId: owner.installationId,
          active: true,
        }
        const checked = createFencedPool(context.pool, {
          assertUsable() {
            usable()
            if (!active)
              throw diagnostic(
                "closed_transaction",
                "Runtime transaction context is no longer active",
              )
          },
          active: () => true,
          validate: validateTransaction,
          enlist: () => ({
            client: raw,
            check() {
              if (!active)
                throw diagnostic(
                  "closed_transaction",
                  "Runtime transaction context is no longer active",
                )
            },
            fail(error) {
              activity.failure ??= { error }
            },
          }),
        })
        const client = await checked.connect()
        Object.assign(activity, { client })
        try {
          const result = await context.host.activity.run(activity, () =>
            callback(makeTransaction(makeAccess(owner, client, effectiveScope, now, () => active))),
          )
          if (activity.failure) throw activity.failure.error
          await validateTransaction(raw)
          return result
        } finally {
          active = false
          activity.active = false
          client.release()
        }
      })
    } finally {
      context.pending--
    }
  }
  const committedSnapshot = async (): Promise<RuntimeSnapshot> => {
    usable()
    if (context.host.activity.getStore()) context.host.assertWorkCapacity()
    context.pending++
    let acquired: SqlClient | undefined
    let active = true
    try {
      const client = await context.pool.connect()
      acquired = client
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
      await validate(client, false)
      const checked: SqlClient = {
        async query<R>(sql: string, values?: readonly unknown[]) {
          if (!active)
            throw diagnostic(
              "closed_transaction",
              "Runtime transaction context is no longer active",
            )
          await validate(client, false)
          return client.query<R>(sql, values)
        },
        release() {},
      }
      const result = await makeTransaction(
        makeAccess(owner, checked, scope, now, () => active),
      ).snapshot()
      await client.query("COMMIT")
      return result
    } catch (error) {
      if (acquired) await rollbackQuietly(acquired)
      throw error
    } finally {
      active = false
      acquired?.release()
      context.pending--
    }
  }
  const store: BoundRuntimeStore = {
    profile: "coordinated",
    pool,
    transaction,
    snapshot: () => transaction((tx) => tx.snapshot()),
    committedReader() {
      usable()
      return { snapshot: committedSnapshot }
    },
    checkpointer(ownerRunId, namespace = "") {
      if (!ownerRunId) throw new Error("Native saver requires an internally bound canonical Run")
      const validateNative = async (client: SqlClient, lock = false) => {
        await validate(client, lock)
        const result = await client.query<{ namespace: string }>(
          `SELECT r.namespace FROM ${table(context.naming, "runs")} r JOIN ${table(context.naming, "threads")} t ON t.thread_id=r.thread_id AND t.generation=r.generation AND t.current_run_id=r.id WHERE r.id=$1 AND r.thread_id=$2 AND r.generation=$3`,
          [ownerRunId, scope.threadId, scope.generation],
        )
        if (
          !result.rows[0] ||
          JSON.stringify(JSON.parse(result.rows[0].namespace)) !==
            JSON.stringify(namespace === "" ? [] : namespace.split("|"))
        )
          throw diagnostic(
            "scope_mismatch",
            "Native saver Run or namespace is outside the internal binding",
          )
        await client.query(
          "SELECT set_config('b4.runtime_thread',$1,true),set_config('b4.runtime_generation',$2,true),set_config('b4.runtime_fence',$3,true),set_config('b4.runtime_run',$4,true)",
          [scope.threadId, scope.generation, String(scope.fence), ownerRunId],
        )
      }
      const saverPool = createFencedPool(trackedPool, {
        assertUsable: usable,
        active: () => true,
        enlist,
        validate: (client) => validateNative(client),
        async authorize(client, sql, values) {
          if (/^\s*INSERT/i.test(sql)) await validateNative(client, true)
          if (values?.[0] !== scope.threadId || (values.length > 1 && values[1] !== namespace))
            throw diagnostic(
              "scope_mismatch",
              "Native saver graph configuration differs from its internal binding",
            )
          if (/^\s*DELETE/i.test(sql))
            throw diagnostic(
              "unsupported_operation",
              "Native deletion requires the coordinated maintenance service",
            )
          if (/^\s*INSERT/i.test(sql) && typeof values[2] === "string") {
            const result = await client.query<{ owner_run_id: string; generation: string }>(
              `SELECT owner_run_id,generation FROM ${table(context.naming, "native_checkpoints")} WHERE thread_id=$1 AND checkpoint_ns=$2 AND checkpoint_id=$3`,
              [scope.threadId, namespace, values[2]],
            )
            if (
              result.rows[0] &&
              (result.rows[0].owner_run_id !== ownerRunId ||
                result.rows[0].generation !== scope.generation)
            )
              throw diagnostic(
                "scope_mismatch",
                "Native checkpoint belongs to a different canonical owner",
              )
          }
        },
      })
      const saver = new B4PostgresSaver({
        pool: saverPool,
        schema: context.naming.schema,
        tablePrefix: `${context.naming.prefix}_native`,
        assumeMigrated: true,
      })
      const fail = (error: unknown) => {
        const current = context.host.activity.getStore()
        if (
          current?.kind === "transaction" &&
          current.active &&
          current.owner === owner &&
          current.scopeKey === key
        )
          current.failure ??= { error }
      }
      const protect =
        <Args extends unknown[], Value>(operation: (...args: Args) => Promise<Value>) =>
        async (...args: Args): Promise<Value> => {
          try {
            return await operation(...args)
          } catch (error) {
            fail(error)
            throw error
          }
        }
      const list = saver.list.bind(saver)
      // Cover preparation and deserialization as well as enlisted SQL. Keep
      // list lazy, forwarding next/return/throw through its complete lifetime.
      return Object.assign(saver, {
        ready: protect(saver.ready.bind(saver)),
        close: protect(saver.close.bind(saver)),
        get: protect(saver.get.bind(saver)),
        getTuple: protect(saver.getTuple.bind(saver)),
        listNamespaces: protect(saver.listNamespaces.bind(saver)),
        put: protect(saver.put.bind(saver)),
        putWrites: protect(saver.putWrites.bind(saver)),
        deleteThread: protect(saver.deleteThread.bind(saver)),
        async *list(...args: Parameters<B4PostgresSaver["list"]>) {
          try {
            yield* list(...args)
          } catch (error) {
            fail(error)
            throw error
          }
        },
      })
    },
    async advanceFence() {
      await transaction(async () => {}, {})
      return makeRuntimeStore(owner, { ...scope, fence: scope.fence + 1 }, now)
    },
    async renewIdleScope() {
      await transaction(async () => {}, { renewIdle: true })
      return makeRuntimeStore(owner, { ...scope, fence: scope.fence + 1 }, now)
    },
    async releaseExecution(ownerId) {
      await transaction(async () => {}, { releaseOwner: ownerId })
    },
    async claimExecution(ownerId, callback) {
      if (!ownerId) throw new Error("Execution owner identity is required")
      try {
        await transaction(callback, { claimOwner: ownerId })
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "owner_busy" || error.code === "stale_fence")
        )
          return undefined
        throw error
      }
      const claimed = makeRuntimeStore(owner, { ...scope, fence: scope.fence + 1 }, now)
      let released = false
      return {
        store: claimed,
        async heartbeat() {
          if (released) throw diagnostic("stale_fence", "Execution lease released")
          await claimed.transaction(async () => {
            const activity = context.host.activity.getStore()
            if (!activity?.client) throw new Error("Missing execution heartbeat transaction")
            const result = await activity.client.query(
              `UPDATE ${scopes} SET lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE thread_id=$1 AND generation=$2 AND fence=$3 AND execution_owner=$4 RETURNING fence`,
              [scope.threadId, scope.generation, scope.fence + 1, ownerId],
            )
            if (result.rows.length !== 1) throw diagnostic("stale_fence", "Execution owner changed")
          })
        },
        async release() {
          if (released) return
          await claimed.releaseExecution(ownerId)
          released = true
        },
      }
    },
    async withReadLease(callback) {
      usable()
      if (context.host.activity.getStore())
        throw new Error("Nested runtime read lease acquisition is not supported")
      const releaseCapacity = context.host.reserveReadLease()
      context.pending++
      let acquired: SqlClient | undefined
      const leaseId = context.host.uuid()
      let locked = false,
        inserted = false
      try {
        const client = await context.pool.connect()
        acquired = client
        context.handles.add(client)
        await client.query("SELECT pg_advisory_lock(hashtextextended($1,1))", [key])
        locked = true
        context.host.assertWorkCapacity()
        const snapshot = await committedSnapshot()
        // The session already holds this Thread's lease lock. Its short
        // metadata transaction must use that same session, never another
        // pooled connection that would wait behind our own session lock.
        const leasePool: SqlPool = {
          query: client.query.bind(client),
          async connect() {
            return { query: client.query.bind(client), release() {} }
          },
          async end() {},
        }
        await withTransaction(leasePool, async (writer) => {
          await validate(writer)
          await writer.query(
            `INSERT INTO ${table(context.naming, "leases")}(id,thread_id,generation,fence,revision,through_seq,owner_nonce) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              leaseId,
              scope.threadId,
              scope.generation,
              scope.fence,
              snapshot.revision,
              snapshot.throughSeq,
              leaseId,
            ],
          )
        })
        inserted = true
        const activity: Activity = {
          owner,
          kind: "lease",
          scopeKey: key,
          installationId: owner.installationId,
          active: true,
        }
        try {
          return await context.host.activity.run(activity, () => callback({ leaseId, snapshot }))
        } finally {
          activity.active = false
        }
      } finally {
        try {
          if (inserted && acquired)
            await acquired.query(
              `DELETE FROM ${table(context.naming, "leases")} WHERE id=$1 AND owner_nonce=$1`,
              [leaseId],
            )
        } finally {
          try {
            if (locked && acquired)
              await acquired.query("SELECT pg_advisory_unlock(hashtextextended($1,1))", [key])
          } finally {
            try {
              acquired?.release()
            } finally {
              if (acquired) context.handles.delete(acquired)
              context.pending--
              releaseCapacity()
            }
          }
        }
      }
    },
  }
  return store
}
