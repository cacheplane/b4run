import type { DatabaseSync } from "node:sqlite"
import type { StagedWorkspaceReference } from "@b4run/workspace"
import { type SourceBundle, verifyStagedWorkspaceReference } from "@b4run/workspace/node"
import type { WorkspaceSourceStore } from "./source-store.js"

/** A staging request the store refuses: the source is not held, the thread already has one, or the quota is full. */
export class WorkspaceStagedSourceError extends Error {
  readonly code: "not_held" | "already_staged" | "quota_exceeded"
  constructor(code: "not_held" | "already_staged" | "quota_exceeded", message: string) {
    super(message)
    this.name = "WorkspaceStagedSourceError"
    this.code = code
  }
}

/**
 * Uploaded sources and the workspace each thread was created with
 * (`sandbox.stagedWorkspaces`). The bundles themselves live in the content
 * store (`workspace_sources`); this keeps when each was uploaded and which
 * thread names which, in the same database, so a reclaim sees every reference
 * at once.
 */
export interface WorkspaceStagedSourceStore {
  /**
   * Keep a bundle the caller verified (`verifySourceBundle`); `held` when a
   * source with its digest is kept already. The digest covers every path, byte
   * and mode, so nothing is rewritten or re-parsed then. New bytes are verified
   * again by the content store before they are written, so what is stored is
   * always what its key names. Refreshes the upload time either way. Refuses
   * (`quota_exceeded`) new bytes that would take the uploaded sources past
   * `maxStagedBytes` of stored payload.
   */
  upload(bundle: SourceBundle, now: number, maxStagedBytes: number): "created" | "held"
  /** Every thread with a staged reference, in id order, for the boot sweep of deleted threads. */
  threads(): readonly string[]
  /** Whether the content store holds this digest (cheap: no payload is read). */
  holds(digest: string): boolean
  /** Record the workspace a new thread was created with. Refuses a source not held, and a second record. */
  attach(threadId: string, reference: StagedWorkspaceReference): void
  get(threadId: string): StagedWorkspaceReference | undefined
  /** Forget a thread's staged reference. Idempotent. */
  detach(threadId: string): void
  /**
   * Delete every held source nothing references: not in `referenced` (the
   * caller's associations and static definition), not named by a thread here,
   * and not uploaded at or after `uploadedBefore`. A source never uploaded (an
   * orphan admission row) has no upload time, so it goes at once when
   * unreferenced. Returns the digests removed.
   */
  reclaim(uploadedBefore: number, referenced: ReadonlySet<string>): readonly string[]
}

const MAX_REFERENCE_BYTES = 256 * 1024
const DIGEST = /^[0-9a-f]{64}$/
let nextSavepoint = 0

function savepoint<T>(db: DatabaseSync, operation: () => T): T {
  const name = `b4_workspace_staged_${++nextSavepoint}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = operation()
    db.exec(`RELEASE ${name}`)
    return result
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${name}`)
      db.exec(`RELEASE ${name}`)
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Workspace staged source rollback failed")
    }
    throw error
  }
}

/**
 * Create the staged tables if the installation predates them. Owner-only and
 * additive, like the thread sandbox tables: it runs under the admission lock,
 * and a read-only reader never calls it and never needs the tables.
 */
export function ensureWorkspaceStagedSourceSchema(db: DatabaseSync): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_staged_schema','workspace_source_uploads','workspace_thread_staged')",
    )
    .all()
  if (tables.length === 0) {
    savepoint(db, () =>
      db.exec(`CREATE TABLE workspace_staged_schema(version INTEGER PRIMARY KEY);
   INSERT INTO workspace_staged_schema VALUES (1);
   CREATE TABLE workspace_source_uploads(digest TEXT PRIMARY KEY NOT NULL, uploaded_at INTEGER NOT NULL);
   CREATE TABLE workspace_thread_staged(thread_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);`),
    )
  } else if (tables.length !== 3) throw new Error("Incomplete workspace staged source schema")
  const versions = db.prepare("SELECT version FROM workspace_staged_schema").all()
  if (versions.length !== 1 || versions[0]?.version !== 1)
    throw new Error("Unsupported workspace staged source schema version")
}

function threadIdOf(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("Invalid staged workspace thread id")
  return value
}

function timeOf(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid staged workspace time")
  return value
}

function bytesOf(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid staged workspace quota")
  return value
}

/** Connection-level component; the installation owns the connection and admission. */
export function makeWorkspaceStagedSourceStore(
  db: DatabaseSync,
  sources: WorkspaceSourceStore,
): WorkspaceStagedSourceStore {
  const held = db.prepare("SELECT 1 AS one FROM workspace_sources WHERE digest=?")
  const stagedBytes = db.prepare(
    "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes FROM workspace_sources WHERE digest IN (SELECT digest FROM workspace_source_uploads)",
  )
  const everyStagedThread = db.prepare(
    "SELECT thread_id FROM workspace_thread_staged ORDER BY thread_id",
  )
  const upsertUpload = db.prepare(
    "INSERT INTO workspace_source_uploads(digest, uploaded_at) VALUES (?,?) ON CONFLICT(digest) DO UPDATE SET uploaded_at=excluded.uploaded_at",
  )
  const selectStaged = db.prepare("SELECT payload FROM workspace_thread_staged WHERE thread_id=?")
  const insertStaged = db.prepare(
    "INSERT INTO workspace_thread_staged(thread_id, payload) VALUES (?,?)",
  )
  const deleteStaged = db.prepare("DELETE FROM workspace_thread_staged WHERE thread_id=?")
  const everyStaged = db.prepare("SELECT payload FROM workspace_thread_staged")
  const everySource = db.prepare("SELECT digest FROM workspace_sources ORDER BY digest")
  const freshUploads = db.prepare(
    "SELECT digest FROM workspace_source_uploads WHERE uploaded_at >= ?",
  )
  const deleteSource = db.prepare("DELETE FROM workspace_sources WHERE digest=?")
  const deleteUpload = db.prepare("DELETE FROM workspace_source_uploads WHERE digest=?")
  const deleteOrphanUploads = db.prepare(
    "DELETE FROM workspace_source_uploads WHERE digest NOT IN (SELECT digest FROM workspace_sources)",
  )
  function parse(payload: unknown): StagedWorkspaceReference {
    if (typeof payload !== "string" || Buffer.byteLength(payload) > MAX_REFERENCE_BYTES)
      throw new Error("Corrupt staged workspace reference")
    const reference = verifyStagedWorkspaceReference(JSON.parse(payload))
    if (JSON.stringify(reference) !== payload)
      throw new Error("Noncanonical staged workspace reference")
    return reference
  }
  function holds(digest: string): boolean {
    if (typeof digest !== "string" || !DIGEST.test(digest))
      throw new Error("Invalid workspace source digest")
    return held.get(digest) !== undefined
  }
  return {
    upload(bundle, now, maxStagedBytes) {
      const at = timeOf(now)
      const quota = bytesOf(maxStagedBytes)
      return savepoint(db, () => {
        if (holds(bundle.digest)) {
          // Equal digests are equal bundles: refresh the window and rewrite nothing.
          upsertUpload.run(bundle.digest, at)
          return "held"
        }
        const size = Buffer.byteLength(JSON.stringify(bundle), "utf8")
        const current = Number(stagedBytes.get()?.bytes ?? 0)
        if (current + size > quota)
          throw new WorkspaceStagedSourceError(
            "quota_exceeded",
            `Staging ${size} bytes would exceed the ${quota}-byte staged quota (${current} held)`,
          )
        // Verifies the bundle against its digest and stores its canonical JSON.
        sources.put(bundle)
        upsertUpload.run(bundle.digest, at)
        return "created"
      })
    },
    threads() {
      return everyStagedThread.all().map((row) => String(row.thread_id))
    },
    holds,
    attach(threadId, input) {
      const id = threadIdOf(threadId)
      const reference = verifyStagedWorkspaceReference(input)
      const payload = JSON.stringify(reference)
      if (Buffer.byteLength(payload) > MAX_REFERENCE_BYTES)
        throw new Error("Staged workspace reference is too large")
      savepoint(db, () => {
        if (!holds(reference.sourceDigest))
          throw new WorkspaceStagedSourceError(
            "not_held",
            `Workspace source ${reference.sourceDigest} is not held: upload it first`,
          )
        if (selectStaged.get(id))
          throw new WorkspaceStagedSourceError(
            "already_staged",
            `Thread ${id} already has a staged workspace`,
          )
        insertStaged.run(id, payload)
      })
    },
    get(threadId) {
      const row = selectStaged.get(threadIdOf(threadId))
      return row ? parse(row.payload) : undefined
    },
    detach(threadId) {
      deleteStaged.run(threadIdOf(threadId))
    },
    reclaim(uploadedBefore, referenced) {
      const cutoff = timeOf(uploadedBefore)
      return savepoint(db, () => {
        const keep = new Set(referenced)
        for (const row of everyStaged.all()) keep.add(parse(row.payload).sourceDigest)
        for (const row of freshUploads.all(cutoff)) keep.add(String(row.digest))
        const removed: string[] = []
        for (const row of everySource.all()) {
          const digest = String(row.digest)
          if (keep.has(digest)) continue
          deleteSource.run(digest)
          deleteUpload.run(digest)
          removed.push(digest)
        }
        deleteOrphanUploads.run()
        return removed
      })
    },
  }
}
