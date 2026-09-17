import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

export const SCHEMA_VERSION = 1

export interface Registry {
  readonly db: DatabaseSync
  close(): void
}

export class RegistryVersionError extends Error {
  constructor(readonly found: number) {
    super(
      `Registry schema version ${found} is newer than this factory supports (${SCHEMA_VERSION}); upgrade the factory`,
    )
    this.name = "RegistryVersionError"
  }
}

interface Migration {
  readonly version: number
  readonly up: string
}

/** Spec: "Registry schema". active_started_at is the open interval the budget ticker measures. */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE work_orders (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        task_id TEXT NOT NULL,
        worker_route TEXT NOT NULL,
        worker_thread_id TEXT,
        interrupt_id TEXT,
        candidate_digest TEXT,
        candidate_verified INTEGER,
        blocked_reason TEXT,
        failure_reason TEXT,
        max_candidate_attempts INTEGER NOT NULL,
        max_active_ms INTEGER NOT NULL,
        active_ms INTEGER NOT NULL DEFAULT 0,
        active_started_at TEXT,
        awaiting_since TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        work_order_id TEXT NOT NULL REFERENCES work_orders(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX events_by_work_order ON events(work_order_id, seq);
      CREATE TABLE commands (
        operation_key TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL,
        command TEXT NOT NULL,
        intent TEXT NOT NULL,
        outcome TEXT,
        at TEXT NOT NULL
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL REFERENCES work_orders(id),
        interrupt_id TEXT NOT NULL,
        candidate_digest TEXT NOT NULL,
        decision TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE deliveries (
        work_order_id TEXT PRIMARY KEY REFERENCES work_orders(id),
        candidate_digest TEXT NOT NULL,
        receipt_path TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `,
  },
]

/** Open (creating if needed) the factory registry. Refuses a newer on-disk schema. */
export function openRegistry(path: string): Registry {
  const isMemory = path === ":memory:"
  if (!isMemory) mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  if (!isMemory) db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)")
  const row = db.prepare("SELECT max(version) AS v FROM schema_version").get() as {
    v: number | null
  }
  const current = row.v ?? 0
  if (current > SCHEMA_VERSION) {
    db.close()
    throw new RegistryVersionError(current)
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec("BEGIN")
    try {
      db.exec(migration.up)
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(migration.version)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
  return { db, close: () => db.close() }
}
