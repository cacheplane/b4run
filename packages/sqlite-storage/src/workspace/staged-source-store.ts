import type { DatabaseSync } from "node:sqlite"
import type { StagedWorkspaceReference } from "@b4run/workspace"
import { type SourceBundle, verifyStagedWorkspaceReference } from "@b4run/workspace/node"
import type { WorkspaceSourceStore } from "./source-store.js"

/** A staging request the store refuses: the source is not uploaded, the thread already has one, or a bound is reached. */
export class WorkspaceStagedSourceError extends Error {
  readonly code: "not_held" | "already_staged" | "quota_exceeded" | "uploader_invalid"
  constructor(
    code: "not_held" | "already_staged" | "quota_exceeded" | "uploader_invalid",
    message: string,
  ) {
    super(message)
    this.name = "WorkspaceStagedSourceError"
    this.code = code
  }
}

/**
 * Uploaded sources and the workspace each thread was created with
 * (`sandbox.stagedWorkspaces`). The bundles themselves live in the content
 * store (`workspace_sources`), beside every source an admission stored; this
 * keeps which of them were UPLOADED (when, their size and file paths, and who
 * uploaded them) and which thread names which, in the same database, so a
 * reclaim sees every reference at once. Only an uploaded source is stageable:
 * a source an admission stored for another thread is never offered to a create,
 * though its digest is public.
 */
export interface WorkspaceStagedSourceStore {
  /**
   * Keep an uploaded bundle the caller verified (`verifySourceBundle`), with the
   * paths of its files, its stored size, and optionally the principal that
   * uploaded it (the stamp the policy returned). `held` when these bytes were
   * uploaded already: the digest covers every path, byte and mode, so nothing is
   * rewritten or re-parsed then. New bytes are verified again by the content
   * store before they are written, so what is stored is always what its key
   * names. A first upload of bytes the content store keeps for another reason (an
   * admission) is a new upload: counted against the quota, and only then
   * stageable. Refreshes the upload time either way. Refuses (`quota_exceeded`)
   * an upload that would take the uploaded sources past `maxStagedBytes`, and a
   * 65th distinct uploader of one source.
   */
  upload(
    bundle: SourceBundle,
    now: number,
    maxStagedBytes: number,
    uploader?: Readonly<Record<string, unknown>>,
  ): "created" | "held"
  /** Every thread with a staged reference, in id order, for the boot sweep of deleted threads. */
  threads(): readonly string[]
  /** Whether this digest was uploaded and is kept (cheap: no payload is read). */
  holds(digest: string): boolean
  /** The file paths of an uploaded source, recorded when it was verified; undefined when not uploaded. */
  files(digest: string): readonly string[] | undefined
  /**
   * The principals whose uploads of this source were allowed with a stamp, in the
   * order they first uploaded it: frozen copies of the stamps. Empty when none was.
   */
  uploaders(digest: string): readonly Readonly<Record<string, unknown>>[]
  /** Record the workspace a new thread was created with. Refuses a source not uploaded, and a second record. */
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
/** One uploader's stamp, as JSON. */
const MAX_UPLOADER_BYTES = 16 * 1024
/** Distinct uploaders kept per source: bounds what a create hands its policy. */
const MAX_UPLOADERS = 64
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
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_staged_schema','workspace_source_uploads','workspace_source_uploaders','workspace_thread_staged')",
    )
    .all()
  if (tables.length === 0) {
    savepoint(db, () =>
      db.exec(`CREATE TABLE workspace_staged_schema(version INTEGER PRIMARY KEY);
   INSERT INTO workspace_staged_schema VALUES (1);
   CREATE TABLE workspace_source_uploads(digest TEXT PRIMARY KEY NOT NULL, uploaded_at INTEGER NOT NULL, size INTEGER NOT NULL, files TEXT NOT NULL);
   CREATE TABLE workspace_source_uploaders(digest TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY(digest, principal));
   CREATE TABLE workspace_thread_staged(thread_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);`),
    )
  } else if (tables.length !== 4) throw new Error("Incomplete workspace staged source schema")
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

function digestOf(digest: string): string {
  if (typeof digest !== "string" || !DIGEST.test(digest))
    throw new Error("Invalid workspace source digest")
  return digest
}

/** Plain objects with their keys sorted, recursively; arrays keep their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort())
      sorted[key] = canonical((value as Record<string, unknown>)[key])
    return sorted
  }
  return value
}

/**
 * A stamp as canonical JSON (keys sorted at every depth), so two uploads by one
 * principal compare equal whatever order the policy built its stamp in: a JSON
 * object of at most 16 KiB (`uploader_invalid` otherwise).
 */
function principalOf(value: Readonly<Record<string, unknown>>): string {
  let text: string | undefined
  try {
    text = JSON.stringify(canonical(value))
  } catch (error) {
    throw new WorkspaceStagedSourceError(
      "uploader_invalid",
      `Invalid staged workspace uploader: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof text !== "string" || !text.startsWith("{"))
    throw new WorkspaceStagedSourceError(
      "uploader_invalid",
      "Invalid staged workspace uploader: not a JSON object",
    )
  if (Buffer.byteLength(text) > MAX_UPLOADER_BYTES)
    throw new WorkspaceStagedSourceError(
      "uploader_invalid",
      `Staged workspace uploader exceeds ${MAX_UPLOADER_BYTES} bytes`,
    )
  return text
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** Connection-level component; the installation owns the connection and admission. */
export function makeWorkspaceStagedSourceStore(
  db: DatabaseSync,
  sources: WorkspaceSourceStore,
): WorkspaceStagedSourceStore {
  const inContentStore = db.prepare("SELECT 1 AS one FROM workspace_sources WHERE digest=?")
  const uploadedRow = db.prepare(
    "SELECT u.files AS files FROM workspace_source_uploads u JOIN workspace_sources s ON s.digest=u.digest WHERE u.digest=?",
  )
  const stagedBytes = db.prepare(
    "SELECT COALESCE(SUM(size), 0) AS bytes FROM workspace_source_uploads",
  )
  const refreshUpload = db.prepare(
    "UPDATE workspace_source_uploads SET uploaded_at=? WHERE digest=?",
  )
  const insertUpload = db.prepare(
    "INSERT INTO workspace_source_uploads(digest, uploaded_at, size, files) VALUES (?,?,?,?)",
  )
  const selectUploaders = db.prepare(
    "SELECT principal FROM workspace_source_uploaders WHERE digest=? ORDER BY rowid",
  )
  const hasUploader = db.prepare(
    "SELECT 1 AS one FROM workspace_source_uploaders WHERE digest=? AND principal=?",
  )
  const countUploaders = db.prepare(
    "SELECT COUNT(*) AS n FROM workspace_source_uploaders WHERE digest=?",
  )
  const insertUploader = db.prepare(
    "INSERT INTO workspace_source_uploaders(digest, principal) VALUES (?,?)",
  )
  const everyStagedThread = db.prepare(
    "SELECT thread_id FROM workspace_thread_staged ORDER BY thread_id",
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
  const deleteUploaders = db.prepare("DELETE FROM workspace_source_uploaders WHERE digest=?")
  const deleteOrphanUploads = db.prepare(
    "DELETE FROM workspace_source_uploads WHERE digest NOT IN (SELECT digest FROM workspace_sources)",
  )
  const deleteOrphanUploaders = db.prepare(
    "DELETE FROM workspace_source_uploaders WHERE digest NOT IN (SELECT digest FROM workspace_source_uploads)",
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
    return uploadedRow.get(digestOf(digest)) !== undefined
  }
  function files(digest: string): readonly string[] | undefined {
    const row = uploadedRow.get(digestOf(digest))
    if (!row) return undefined
    const parsed: unknown = typeof row.files === "string" ? JSON.parse(row.files) : undefined
    if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== "string"))
      throw new Error("Corrupt staged workspace file list")
    return Object.freeze(parsed as string[])
  }
  function bind(digest: string, principal: string | undefined): void {
    if (principal === undefined || hasUploader.get(digest, principal)) return
    if (Number(countUploaders.get(digest)?.n ?? 0) >= MAX_UPLOADERS)
      throw new WorkspaceStagedSourceError(
        "quota_exceeded",
        `Workspace source ${digest} already has ${MAX_UPLOADERS} uploaders`,
      )
    insertUploader.run(digest, principal)
  }
  return {
    upload(bundle, now, maxStagedBytes, uploader) {
      const at = timeOf(now)
      const quota = bytesOf(maxStagedBytes)
      const digest = digestOf(bundle.digest)
      const principal = uploader === undefined ? undefined : principalOf(uploader)
      return savepoint(db, () => {
        if (holds(digest)) {
          // Uploaded before, and equal digests are equal bundles: bind the uploader,
          // refresh the window, and rewrite nothing.
          bind(digest, principal)
          refreshUpload.run(at, digest)
          return "held"
        }
        const size = Buffer.byteLength(JSON.stringify(bundle), "utf8")
        const current = Number(stagedBytes.get()?.bytes ?? 0)
        if (current + size > quota)
          throw new WorkspaceStagedSourceError(
            "quota_exceeded",
            `Staging ${size} bytes would exceed the ${quota}-byte staged quota (${current} held)`,
          )
        // Verifies the bundle against its digest and stores its canonical JSON. Bytes an
        // admission already stored are these bytes (equal digests), kept once.
        if (inContentStore.get(digest) === undefined) sources.put(bundle)
        insertUpload.run(digest, at, size, JSON.stringify(bundle.files.map((file) => file.path)))
        bind(digest, principal)
        return "created"
      })
    },
    threads() {
      return everyStagedThread.all().map((row) => String(row.thread_id))
    },
    holds,
    files,
    uploaders(digest) {
      return Object.freeze(
        selectUploaders
          .all(digestOf(digest))
          .map((row) => deepFreeze(JSON.parse(String(row.principal)) as Record<string, unknown>)),
      )
    },
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
            `Workspace source ${reference.sourceDigest} is not uploaded: upload it first`,
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
          deleteUploaders.run(digest)
          removed.push(digest)
        }
        deleteOrphanUploads.run()
        deleteOrphanUploaders.run()
        return removed
      })
    },
  }
}
