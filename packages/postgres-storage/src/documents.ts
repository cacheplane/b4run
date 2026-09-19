import { ConflictError, type Document, type DocumentStore } from "@b4run/sdk"
import type { PostgresStoreOptions } from "./options.js"
import {
  assertIdentifier,
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  DOCUMENTS_MIGRATIONS,
  qualify,
  runMigrations,
} from "./schema.js"
import { throwNoPool } from "./sql.js"

export interface PostgresDocumentStoreOptions extends PostgresStoreOptions {
  /**
   * Which collection this store reads and writes.
   *
   * A bound value, not an identifier: it is never interpolated into SQL, so it
   * may be any non-empty string and cannot collide with a B4.run table. Two
   * stores with different names in one database are independent; two with the
   * same name are the same collection, which is how a second process reattaches
   * to it.
   */
  readonly name: string
}

/** A document store that also owns Postgres lifecycle. */
export interface PostgresDocumentStore<T> extends DocumentStore<T> {
  /** Apply migrations. Idempotent and memoized; call at boot to migrate eagerly. */
  ready(): Promise<void>
  /** Close the pool if this store owns it (`ownsPool`); otherwise a no-op. */
  close(): Promise<void>
}

/** `value` arrives already parsed — `pg` decodes jsonb for us. */
interface DocumentRow<T> {
  version: number
  value: T
}

/**
 * A Postgres-backed application document store.
 *
 * Every write is ONE statement guarded by the version the caller read, and the
 * row count reports whether it matched. No read-modify-write, no transaction,
 * no lock: two instances racing on the same document produce exactly one
 * winner and one {@link ConflictError}, and the loser decides what to do about
 * it. That is the whole reason this is not a `SELECT` followed by an `UPDATE`.
 *
 * `schema` and `tablePrefix` behave as they do for the other three stores in
 * this package, so `B4_PG_SCHEMA` / `B4_PG_TABLE_PREFIX` separate an app's
 * documents per environment the same way they separate its threads — see
 * {@link documentStoreNamingFromEnv} in `./naming.js` for reading them.
 */
export function createPostgresDocumentStore<T>(
  options: PostgresDocumentStoreOptions,
): PostgresDocumentStore<T> {
  const schema = options.schema ?? DEFAULT_SCHEMA
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX
  assertIdentifier("schema", schema)
  assertIdentifier("tablePrefix", prefix)
  if (!options.name)
    throw new Error("postgres-storage: `name` is required and must be a non-empty string")
  const storeName = options.name
  const table = qualify({ schema, prefix }, "documents")
  const ownsPool = options.ownsPool ?? false
  const pool = options.pool ?? throwNoPool()

  const assumeMigrated = options.assumeMigrated ?? false

  let initP: Promise<void> | undefined
  const ready = (): Promise<void> => {
    // See `assumeMigrated` in options.ts: a resolved promise, not a cheaper
    // migration — `runMigrations` costs a transaction plus an advisory lock
    // even when there is nothing left to apply.
    initP ??= assumeMigrated
      ? Promise.resolve()
      : runMigrations(pool, DOCUMENTS_MIGRATIONS, { schema, prefix, component: "documents" })
    return initP
  }

  // Every INSERT names every column and supplies every value. The DDL declares
  // no defaults precisely so that none of this can depend on one — see the
  // `DOCUMENTS_MIGRATIONS` comment in schema.ts for the bug that rule prevents.
  const INSERT = `INSERT INTO ${table} (store_name, doc_key, version, value, created_at, updated_at)
     VALUES ($1, $2, 0, $3::jsonb, $4, $4)`

  return {
    ready,
    async close() {
      if (ownsPool) await pool.end()
    },

    async create(value) {
      await ready()
      const key = crypto.randomUUID()
      const now = new Date().toISOString()
      await pool.query(INSERT, [storeName, key, JSON.stringify(value), now])
      return key
    },

    async load(key) {
      await ready()
      const res = await pool.query<DocumentRow<T>>(
        `SELECT version, value FROM ${table} WHERE store_name = $1 AND doc_key = $2`,
        [storeName, key],
      )
      const row = res.rows[0]
      return row ? ({ version: row.version, value: row.value } satisfies Document<T>) : undefined
    },

    async commit(key, expectedVersion, value) {
      await ready()
      const now = new Date().toISOString()
      if (expectedVersion === null) {
        // `DO NOTHING` plus `RETURNING` is the claim: the row count, not a
        // prior SELECT, says who got there first. A check-then-insert would
        // let two instances both see "absent" and both proceed.
        const res = await pool.query(
          `${INSERT} ON CONFLICT (store_name, doc_key) DO NOTHING RETURNING doc_key`,
          [storeName, key, JSON.stringify(value), now],
        )
        if (res.rows.length !== 1) throw new ConflictError(key, null)
        return
      }
      const res = await pool.query(
        `UPDATE ${table} SET version = version + 1, value = $3::jsonb, updated_at = $4
         WHERE store_name = $1 AND doc_key = $2 AND version = $5
         RETURNING doc_key`,
        [storeName, key, JSON.stringify(value), now, expectedVersion],
      )
      // No row matched, which is a missing document or a moved one. The caller
      // cannot tell them apart and does not need to: reload and re-apply.
      if (res.rows.length !== 1) throw new ConflictError(key, expectedVersion)
    },

    async delete(key) {
      await ready()
      await pool.query(`DELETE FROM ${table} WHERE store_name = $1 AND doc_key = $2`, [
        storeName,
        key,
      ])
    },
  }
}
