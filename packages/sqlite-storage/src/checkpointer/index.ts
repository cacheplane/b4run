import { openDb } from "../internal/db.js"
import { runMigrations } from "../internal/migrate.js"
import { B4SqliteSaver } from "./saver.js"
import { CHECKPOINTER_MIGRATIONS } from "./schema.js"

export interface SqliteCheckpointerOptions {
  readonly path: string
}

export function sqliteCheckpointer(options: SqliteCheckpointerOptions): B4SqliteSaver {
  const db = openDb(options.path)
  runMigrations(db, CHECKPOINTER_MIGRATIONS)
  return new B4SqliteSaver(db)
}

export { B4SqliteSaver } from "./saver.js"
