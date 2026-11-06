import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import type { PostgresRuntimeOptions } from "../options.js"
import { DEFAULT_SCHEMA } from "../schema.js"
import {
  type Activity,
  type InstallationContext,
  type PostgresRuntimeInstallation,
  registerInstallation,
} from "./index.js"
import { DEFAULT_RUNTIME_PREFIX, installSchema, validateNaming } from "./schema.js"
import { diagnostic } from "./transaction.js"

const activity = new AsyncLocalStorage<Activity>()
// Resource reservations are process-local and shared by all installation
// handles using this actual driver pool. Durable ownership remains in SQL.
const reservations = new WeakMap<Pool, { leases: number }>()
/** Install/validate the Node Postgres persistence domain. Scope authority is
 * minted only by internal host plumbing after C5; no handlers are activated. */
export async function openPostgresRuntimeInstallation(
  options: PostgresRuntimeOptions,
): Promise<PostgresRuntimeInstallation> {
  const naming = validateNaming(
    options.schema ?? DEFAULT_SCHEMA,
    options.tablePrefix ?? DEFAULT_RUNTIME_PREFIX,
  )
  const installationId = await installSchema(options.pool, naming, randomUUID)
  const capacity = (required: number): Pool => {
    if (!(options.pool instanceof Pool))
      throw diagnostic(
        "pool_capacity",
        "Read lease capacity is unverified for this structural pool",
      )
    const pool = options.pool
    const available = pool.options.max - pool.totalCount + pool.idleCount - pool.waitingCount
    if (
      !Number.isSafeInteger(pool.options.max) ||
      pool.options.max < 1 ||
      pool.ending ||
      pool.ended ||
      available < required
    )
      throw diagnostic("pool_capacity", "Runtime pool has no safe read-lease work capacity")
    return pool
  }
  const context: InstallationContext = {
    pool: options.pool,
    naming,
    host: {
      uuid: randomUUID,
      activity,
      assertWorkCapacity() {
        capacity(1)
      },
      reserveReadLease() {
        const pool = capacity(2)
        const state = reservations.get(pool) ?? { leases: 0 }
        // pg queues idle-client checkout until nextTick. Reserve synchronously,
        // before calling connect, so two idle-pool callers cannot both count
        // the same work slot. Always retain one slot or reject before callback.
        if (state.leases >= pool.options.max - 1)
          throw diagnostic("pool_capacity", "Runtime pool work slot is reserved")
        state.leases++
        reservations.set(pool, state)
        let released = false
        return () => {
          if (released) return
          released = true
          state.leases--
          if (state.leases === 0) reservations.delete(pool)
        }
      },
    },
    closed: false,
    closing: false,
    pending: 0,
    handles: new Set(),
  }
  const owner: PostgresRuntimeInstallation = {
    installationId,
    schema: naming.schema,
    tablePrefix: naming.prefix,
    async close() {
      if (context.closed) return
      if (context.pending || context.handles.size)
        throw new Error("Cannot close runtime installation with active or queued work")
      context.closing = true
      try {
        if (options.ownsPool) await options.pool.end()
        context.closed = true
      } finally {
        context.closing = false
      }
    },
  }
  registerInstallation(owner, context)
  return owner
}
