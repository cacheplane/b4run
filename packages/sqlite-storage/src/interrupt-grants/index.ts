import { openDb } from "../internal/db.js"
import { runMigrations } from "../internal/migrate.js"
import { INTERRUPT_GRANTS_MIGRATIONS } from "./schema.js"
import { makeInterruptGrantStore } from "./store.js"
import type { InterruptGrantStore } from "./types.js"

export interface InterruptGrantStoreOptions {
  /**
   * Path to the SQLite file. Own file, own `schema_version` — the same shape
   * as `createThreadsStore` and `sqliteCheckpointer`, and the reason this
   * package's migration sets can each start at version 1 without colliding.
   */
  readonly path: string
}

/**
 * Open (creating if needed) the durable approval-grant store for one app.
 *
 * SQLite is the local-dev default, so this is the store `b4 dev` binds when
 * `approvals.grants` is anything but `"off"`.
 */
export function createInterruptGrantStore(
  options: InterruptGrantStoreOptions,
): InterruptGrantStore {
  const db = openDb(options.path)
  runMigrations(db, INTERRUPT_GRANTS_MIGRATIONS)
  return makeInterruptGrantStore(db)
}
