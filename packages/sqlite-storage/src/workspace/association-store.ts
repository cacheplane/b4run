import type { DatabaseSync } from "node:sqlite"
import type { ReadyWorkspace, WorkspaceCreateIntent } from "@b4run/workspace"
import { verifyReadyWorkspace, verifyWorkspaceIntent } from "@b4run/workspace/node"
import type { WorkspaceSourceStore } from "./source-store.js"
export interface WorkspaceAssociation {
  readonly revision: number
  readonly state: "creating" | "ready" | "deleting" | "deleted"
  readonly intent: WorkspaceCreateIntent
  readonly ready?: ReadyWorkspace
}
export interface WorkspaceAssociationStore {
  list(): readonly WorkspaceAssociation[]
  get(threadId: string): WorkspaceAssociation | undefined
  create(intent: WorkspaceCreateIntent): WorkspaceAssociation
  markReady(threadId: string, revision: number, ready: ReadyWorkspace): WorkspaceAssociation
  beginDelete(threadId: string): WorkspaceAssociation | undefined
  completeDelete(threadId: string, revision: number): WorkspaceAssociation
}

const MAX_RECORD_BYTES = 1024 * 1024
/** Internal transactional records; connection lifetime belongs to the installation. */
export function makeWorkspaceAssociationStore(
  db: DatabaseSync,
  sources: WorkspaceSourceStore,
): WorkspaceAssociationStore {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_association_schema','workspace_associations')",
    )
    .all()
  if (tables.length === 0) {
    db.exec("SAVEPOINT workspace_association_init")
    try {
      db.exec(`CREATE TABLE workspace_association_schema(version INTEGER PRIMARY KEY);
   INSERT INTO workspace_association_schema VALUES (1);
   CREATE TABLE workspace_associations(thread_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL);`)
      db.exec("RELEASE workspace_association_init")
    } catch (error) {
      db.exec("ROLLBACK TO workspace_association_init; RELEASE workspace_association_init")
      throw error
    }
  } else if (tables.length !== 2) throw new Error("Incomplete workspace association schema")
  const versions = db.prepare("SELECT version FROM workspace_association_schema").all()
  if (versions.length !== 1 || versions[0]?.version !== 1)
    throw new Error("Unsupported workspace association schema version")
  const select = db.prepare(
    `SELECT revision,state, CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB))<=? THEN payload ELSE NULL END AS payload FROM workspace_associations WHERE thread_id=?`,
  )
  function get(threadId: string): WorkspaceAssociation | undefined {
    if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 1024)
      throw new Error("Invalid workspace thread identity")
    const row = select.get(MAX_RECORD_BYTES, threadId)
    if (!row) return undefined
    if (
      typeof row.revision !== "number" ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      typeof row.payload !== "string" ||
      !["creating", "ready", "deleting", "deleted"].includes(String(row.state))
    )
      throw new Error("Corrupt workspace association")
    const parsed: unknown = JSON.parse(row.payload)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Corrupt workspace association payload")
    const body = parsed as Record<string, unknown>
    if (Object.keys(body).some((key) => key !== "intent" && key !== "ready"))
      throw new Error("Unexpected workspace association fields")
    const intent = verifyWorkspaceIntent(body.intent)
    if (intent.threadId !== threadId) throw new Error("Workspace association thread mismatch")
    const ready = "ready" in body ? verifyReadyWorkspace(body.ready, intent) : undefined
    if ((row.state === "ready" && !ready) || (row.state === "creating" && ready))
      throw new Error("Invalid workspace association readiness")
    const normalized = { intent, ...(ready ? { ready } : {}) }
    if (JSON.stringify(normalized) !== row.payload)
      throw new Error("Noncanonical workspace association payload")
    return Object.freeze({
      revision: row.revision,
      state: row.state as WorkspaceAssociation["state"],
      ...normalized,
    })
  }
  function transaction<T>(operation: () => T): T {
    if (db.prepare("PRAGMA synchronous").get()?.synchronous !== 2)
      throw new Error("Workspace association storage requires synchronous FULL")
    db.exec("SAVEPOINT workspace_association_write")
    try {
      const result = operation()
      db.exec("RELEASE workspace_association_write")
      return result
    } catch (error) {
      try {
        db.exec("ROLLBACK TO workspace_association_write; RELEASE workspace_association_write")
      } catch (rollback) {
        throw new AggregateError([error, rollback], "Workspace association rollback failed")
      }
      throw error
    }
  }
  function payload(record: Pick<WorkspaceAssociation, "intent" | "ready">): string {
    const value = JSON.stringify({
      intent: record.intent,
      ...(record.ready ? { ready: record.ready } : {}),
    })
    if (Buffer.byteLength(value) > MAX_RECORD_BYTES)
      throw new Error("Workspace association exceeds size limit")
    return value
  }
  function update(
    record: WorkspaceAssociation,
    state: WorkspaceAssociation["state"],
    ready = record.ready,
  ): WorkspaceAssociation {
    if (record.revision === Number.MAX_SAFE_INTEGER)
      throw new Error("Workspace association revision exhausted")
    const result = db
      .prepare(
        "UPDATE workspace_associations SET revision=revision+1,state=?,payload=? WHERE thread_id=? AND revision=? AND state=?",
      )
      .run(
        state,
        payload({ intent: record.intent, ...(ready ? { ready } : {}) }),
        record.intent.threadId,
        record.revision,
        record.state,
      )
    if (result.changes !== 1) throw new Error("Workspace association revision conflict")
    const next = get(record.intent.threadId)
    if (!next) throw new Error("Workspace association disappeared")
    return next
  }
  return {
    list() {
      return db
        .prepare("SELECT thread_id FROM workspace_associations ORDER BY thread_id")
        .all()
        .map((row) => get(String(row.thread_id)) as WorkspaceAssociation)
    },
    get,
    create(input) {
      return transaction(() => {
        const intent = verifyWorkspaceIntent(input)
        const existing = get(intent.threadId)
        if (existing) {
          if (JSON.stringify(existing.intent) !== JSON.stringify(intent))
            throw new Error("Workspace creation intent conflict")
          return existing
        }
        if (!sources.get(intent.sourceDigest))
          throw new Error("Workspace creation requires retained source")
        db.prepare("INSERT INTO workspace_associations VALUES (?,1,'creating',?)").run(
          intent.threadId,
          payload({ intent }),
        )
        return get(intent.threadId) as WorkspaceAssociation
      })
    },
    markReady(threadId, revision, input) {
      return transaction(() => {
        const record = get(threadId)
        if (!record || record.state !== "creating" || record.revision !== revision)
          throw new Error("Workspace publication state/revision conflict")
        return update(record, "ready", verifyReadyWorkspace(input, record.intent))
      })
    },
    beginDelete(threadId) {
      return transaction(() => {
        const record = get(threadId)
        if (!record || record.state === "deleting" || record.state === "deleted") return record
        return update(record, "deleting")
      })
    },
    completeDelete(threadId, revision) {
      return transaction(() => {
        const record = get(threadId)
        if (!record || record.state !== "deleting" || record.revision !== revision)
          throw new Error("Workspace deletion state/revision conflict")
        return update(record, "deleted")
      })
    },
  }
}
