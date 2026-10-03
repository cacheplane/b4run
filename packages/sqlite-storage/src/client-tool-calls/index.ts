import { openDb } from "../internal/db.js"
import { runMigrations } from "../internal/migrate.js"
import { CLIENT_TOOL_CALLS_MIGRATIONS } from "./schema.js"
import { makeClientToolCallStore } from "./store.js"
import type { ClientToolCallStore } from "./types.js"

export interface ClientToolCallStoreOptions {
  /** Path to the SQLite file. Own file, own `schema_version`. */
  readonly path: string
}

/**
 * Open (creating if needed) the durable client tool call store for one app.
 * SQLite is the local-dev default, so this is what `b4 dev` binds.
 */
export function createClientToolCallStore(
  options: ClientToolCallStoreOptions,
): ClientToolCallStore {
  const db = openDb(options.path)
  runMigrations(db, CLIENT_TOOL_CALLS_MIGRATIONS)
  return makeClientToolCallStore(db)
}
