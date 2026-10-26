import type { RequestRunAdmission } from "@b4run/sdk"
import { createFencedPool } from "./internal/fenced-pool.js"
import { withTransaction } from "./internal/tx.js"
import type { PostgresStoreOptions } from "./options.js"
import {
  assertIdentifier,
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  qualify,
  runMigrations,
} from "./schema.js"
import type { SqlClient, SqlPool } from "./sql.js"
import { throwNoPool } from "./sql.js"

/** Postgres admission settings. Durations are measured against the database clock. */
export interface PostgresRunAdmissionOptions extends PostgresStoreOptions {
  /** Lease lifetime in milliseconds; defaults to 30 seconds. */
  readonly leaseDurationMs?: number
  /** Renewal interval in milliseconds; defaults to one third of the lease. */
  readonly heartbeatIntervalMs?: number
}

/** A single request's lease and the pool used by its runtime stores. */
export interface PostgresRunAdmission extends RequestRunAdmission {
  /** Pool fencing all writes after acquisition; idle initialization is permitted. */
  readonly pool: SqlPool
  /** Migrate admission storage before accepting requests. */
  ready(): Promise<void>
  /** Release ownership and close an owned underlying pool. */
  close(): Promise<void>
}

/** Create request-scoped shared run ownership and a fenced runtime-store pool. */
export function createPostgresRunAdmission(
  options: PostgresRunAdmissionOptions,
): PostgresRunAdmission {
  const raw = options.pool ?? throwNoPool()
  const schema = options.schema ?? DEFAULT_SCHEMA
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX
  assertIdentifier("schema", schema)
  assertIdentifier("tablePrefix", prefix)
  const duration = options.leaseDurationMs ?? 30_000
  const interval = options.heartbeatIntervalMs ?? Math.max(1, Math.floor(duration / 3))
  if (
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    !Number.isSafeInteger(interval) ||
    interval <= 0 ||
    interval >= duration
  ) {
    throw new Error(
      "postgres-storage: heartbeatIntervalMs must be positive and less than leaseDurationMs",
    )
  }
  const table = qualify({ schema, prefix }, "run_admissions")
  const controller = new AbortController()
  const owner = crypto.randomUUID()
  let state: "idle" | "active" | "terminal" = "idle"
  let thread: string | undefined
  let migration: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let operations: Promise<unknown> = Promise.resolve()
  let released: Promise<void> | undefined
  let closed: Promise<void> | undefined
  const ready = () =>
    (migration ??= options.assumeMigrated
      ? Promise.resolve()
      : runMigrations(
          raw,
          [
            {
              version: 1,
              up: () =>
                `CREATE TABLE ${table} (thread_id text PRIMARY KEY, owner_token text NOT NULL, expires_at timestamptz NOT NULL)`,
            },
          ],
          { schema, prefix, component: "run_admissions" },
        ))
  const fail = (reason: unknown) => {
    state = "terminal"
    clearTimeout(timer)
    controller.abort(reason)
  }
  const assertUsable = () => {
    if (state === "terminal")
      throw new Error("postgres-storage: run admission ownership lost or released", {
        cause: controller.signal.reason,
      })
  }
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const pending = operations.then(fn)
    operations = pending.catch(() => {})
    return pending
  }
  const heartbeat = () => {
    if (state !== "active") return
    timer = setTimeout(() => {
      void serialize(async () => {
        if (state !== "active") return
        try {
          await withTransaction(raw, async (client) => {
            // Lock first, then evaluate expiry in a fresh statement. A predicate
            // evaluated before waiting for another transaction is not a lease check.
            await client.query(
              `SELECT thread_id FROM ${table} WHERE thread_id = $1 AND owner_token = $2 FOR UPDATE`,
              [thread, owner],
            )
            const result = await client.query(
              `UPDATE ${table} SET expires_at = clock_timestamp() + $3 * interval '1 millisecond' WHERE thread_id = $1 AND owner_token = $2 AND expires_at > clock_timestamp() RETURNING thread_id`,
              [thread, owner, duration],
            )
            if (!result.rows.length)
              throw new Error("postgres-storage: run admission lease expired")
          })
          heartbeat()
        } catch (error) {
          fail(error)
        }
      })
    }, interval)
    timer.unref?.()
  }
  const validate = async (client: SqlClient) => {
    assertUsable()
    if (state !== "active") return
    try {
      await client.query(
        `SELECT thread_id FROM ${table} WHERE thread_id = $1 AND owner_token = $2 FOR UPDATE`,
        [thread, owner],
      )
      const result = await client.query(
        `SELECT thread_id FROM ${table} WHERE thread_id = $1 AND owner_token = $2 AND expires_at > clock_timestamp()`,
        [thread, owner],
      )
      if (!result.rows.length)
        throw new Error("postgres-storage: run admission lease expired or replaced")
      assertUsable()
    } catch (error) {
      fail(error)
      throw error
    }
  }
  const pool = createFencedPool(raw, { assertUsable, active: () => state === "active", validate })
  const release = () => {
    if (released) return released
    fail(new Error("postgres-storage: run admission released"))
    released = serialize(async () => {
      if (thread !== undefined)
        await raw.query(`DELETE FROM ${table} WHERE thread_id = $1 AND owner_token = $2`, [
          thread,
          owner,
        ])
    })
    return released
  }
  return {
    pool,
    signal: controller.signal,
    ready,
    tryAcquire(threadId) {
      return serialize(async () => {
        assertUsable()
        if (thread !== undefined && thread !== threadId)
          throw new Error("postgres-storage: run admission belongs to another thread")
        if (state === "active") return true
        await ready()
        assertUsable()
        try {
          const result = await raw.query(
            `INSERT INTO ${table} (thread_id, owner_token, expires_at) VALUES ($1, $2, clock_timestamp() + $3 * interval '1 millisecond') ON CONFLICT (thread_id) DO UPDATE SET owner_token = EXCLUDED.owner_token, expires_at = clock_timestamp() + $3 * interval '1 millisecond' WHERE ${table}.expires_at <= clock_timestamp() RETURNING thread_id`,
            [threadId, owner, duration],
          )
          if (!result.rows.length) return false
          thread = threadId
          assertUsable()
          state = "active"
          heartbeat()
          return true
        } catch (error) {
          fail(error)
          throw error
        }
      })
    },
    release,
    close() {
      closed ??= (async () => {
        try {
          await release()
        } finally {
          if (options.ownsPool) await raw.end()
        }
      })()
      return closed
    },
  }
}
