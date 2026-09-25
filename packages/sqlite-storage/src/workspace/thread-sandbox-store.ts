import type { DatabaseSync } from "node:sqlite"
import type { ThreadSandboxRecord } from "@b4run/workspace"
import { MAX_THREAD_SANDBOX_RECORD_BYTES, verifyThreadSandboxRecord } from "@b4run/workspace/node"

/** A thread's sandbox record: written once, with its association, and read on every admission. */
export interface WorkspaceThreadSandboxStore {
  get(threadId: string): ThreadSandboxRecord | undefined
  /** The thread's recorded "Always" grants, by tool, in the order they were granted. */
  grants(threadId: string): Readonly<Record<string, readonly string[]>>
  /** Record an "Always" grant. Only for a thread whose record carries its own permissions. */
  addGrant(threadId: string, tool: string, pattern: string): void
}
/** Internal: rows change only inside the association store's own transactions. */
export interface WorkspaceThreadSandboxWriter extends WorkspaceThreadSandboxStore {
  insert(threadId: string, record: ThreadSandboxRecord): void
  remove(threadId: string): void
}

const MAX_RECORD_BYTES = MAX_THREAD_SANDBOX_RECORD_BYTES

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
  // Additive, beside the record: a lost table loses grants (the thread asks again), never widens.
  db.exec(
    "CREATE TABLE IF NOT EXISTS workspace_thread_permission_grants(thread_id TEXT NOT NULL, tool TEXT NOT NULL, pattern TEXT NOT NULL, PRIMARY KEY(thread_id, tool, pattern))",
  )
}

export function makeWorkspaceThreadSandboxStore(db: DatabaseSync): WorkspaceThreadSandboxWriter {
  const select = db.prepare("SELECT payload FROM workspace_thread_sandboxes WHERE thread_id=?")
  const insert = db.prepare("INSERT INTO workspace_thread_sandboxes VALUES (?,?)")
  const remove = db.prepare("DELETE FROM workspace_thread_sandboxes WHERE thread_id=?")
  const selectGrants = db.prepare(
    "SELECT tool, pattern FROM workspace_thread_permission_grants WHERE thread_id=? ORDER BY tool, rowid",
  )
  const insertGrant = db.prepare(
    "INSERT OR IGNORE INTO workspace_thread_permission_grants VALUES (?,?,?)",
  )
  const removeGrants = db.prepare(
    "DELETE FROM workspace_thread_permission_grants WHERE thread_id=?",
  )
  const text = (value: unknown, what: string): string => {
    if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\u0000"))
      throw new Error(`Invalid workspace thread grant ${what}`)
    return value
  }
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
    grants(threadId) {
      const out: Record<string, string[]> = Object.create(null)
      for (const row of selectGrants.all(threadId)) {
        const tool = text(row.tool, "tool")
        const list = out[tool] ?? []
        list.push(text(row.pattern, "pattern"))
        out[tool] = list
      }
      return out
    },
    addGrant(threadId, tool, pattern) {
      if (!get(threadId)?.permissions)
        throw new Error(`Thread ${threadId} has no permissions of its own to grant into`)
      insertGrant.run(threadId, text(tool, "tool"), text(pattern, "pattern"))
    },
    remove(threadId) {
      remove.run(threadId)
      removeGrants.run(threadId)
    },
  }
}
