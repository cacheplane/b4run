import type { DatabaseSync } from "node:sqlite"
import type { ThreadSandboxRecord } from "@b4run/workspace"
import { verifyThreadSandboxRecord } from "@b4run/workspace/node"

/** A thread's sandbox record: written once, with its association, and read on every admission. */
export interface WorkspaceThreadSandboxStore {
  get(threadId: string): ThreadSandboxRecord | undefined
}
/** Internal: rows change only inside the association store's own transactions. */
export interface WorkspaceThreadSandboxWriter extends WorkspaceThreadSandboxStore {
  insert(threadId: string, record: ThreadSandboxRecord): void
  remove(threadId: string): void
}

const MAX_RECORD_BYTES = 256 * 1024

/**
 * Create the record's tables if the installation predates them. Owner-only: it
 * runs under the admission lock, so no other writer races it; a reader never
 * calls it and never needs the tables.
 */
export function ensureWorkspaceThreadSandboxSchema(db: DatabaseSync): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_thread_sandbox_schema','workspace_thread_sandboxes')",
    )
    .all()
  if (tables.length === 0) {
    db.exec("SAVEPOINT workspace_thread_sandbox_init")
    try {
      db.exec(`CREATE TABLE workspace_thread_sandbox_schema(version INTEGER PRIMARY KEY);
   INSERT INTO workspace_thread_sandbox_schema VALUES (1);
   CREATE TABLE workspace_thread_sandboxes(thread_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);`)
      db.exec("RELEASE workspace_thread_sandbox_init")
    } catch (error) {
      db.exec("ROLLBACK TO workspace_thread_sandbox_init; RELEASE workspace_thread_sandbox_init")
      throw error
    }
  } else if (tables.length !== 2) throw new Error("Incomplete workspace thread sandbox schema")
  const versions = db.prepare("SELECT version FROM workspace_thread_sandbox_schema").all()
  if (versions.length !== 1 || versions[0]?.version !== 1)
    throw new Error("Unsupported workspace thread sandbox schema version")
}

export function makeWorkspaceThreadSandboxStore(db: DatabaseSync): WorkspaceThreadSandboxWriter {
  const select = db.prepare("SELECT payload FROM workspace_thread_sandboxes WHERE thread_id=?")
  const insert = db.prepare("INSERT INTO workspace_thread_sandboxes VALUES (?,?)")
  const remove = db.prepare("DELETE FROM workspace_thread_sandboxes WHERE thread_id=?")
  function get(threadId: string): ThreadSandboxRecord | undefined {
    const row = select.get(threadId)
    if (!row) return undefined
    if (typeof row.payload !== "string" || Buffer.byteLength(row.payload) > MAX_RECORD_BYTES)
      throw new Error("Corrupt workspace thread sandbox")
    const record = verifyThreadSandboxRecord(JSON.parse(row.payload))
    if (JSON.stringify(record) !== row.payload)
      throw new Error("Noncanonical workspace thread sandbox")
    return record
  }
  return {
    get,
    insert(threadId, input) {
      const payload = JSON.stringify(verifyThreadSandboxRecord(input))
      if (Buffer.byteLength(payload) > MAX_RECORD_BYTES)
        throw new Error("Workspace thread sandbox exceeds size limit")
      insert.run(threadId, payload)
    },
    remove(threadId) {
      remove.run(threadId)
    },
  }
}
