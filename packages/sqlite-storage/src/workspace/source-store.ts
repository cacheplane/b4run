import type { DatabaseSync } from "node:sqlite"
import { type SourceBundle, verifySourceBundle } from "@b4run/workspace/node"

export interface WorkspaceSourceStore {
  put(bundle: SourceBundle): void
  get(digest: string): SourceBundle | undefined
}

const MAX_PAYLOAD_BYTES = 96 * 1024 * 1024
let nextSavepoint = 0

function requireFullSync(db: DatabaseSync): void {
  if (db.prepare("PRAGMA synchronous").get()?.synchronous !== 2) {
    throw new Error("Workspace source storage requires synchronous FULL")
  }
}

function savepoint<T>(db: DatabaseSync, operation: () => T): T {
  const name = `b4_workspace_source_${++nextSavepoint}`
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
      throw new AggregateError([error, rollbackError], "Workspace source rollback failed")
    }
    throw error
  }
}

function initialize(db: DatabaseSync): void {
  savepoint(db, () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_sources','workspace_source_schema')",
      )
      .all()
    if (tables.length === 0) {
      db.exec(`
        CREATE TABLE workspace_source_schema(version INTEGER PRIMARY KEY);
        INSERT INTO workspace_source_schema(version) VALUES (1);
        CREATE TABLE workspace_sources(
          digest TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL
        );
      `)
    } else if (tables.length !== 2) {
      throw new Error("Incomplete workspace source schema version")
    }
    const versions = db.prepare("SELECT version FROM workspace_source_schema").all()
    if (versions.length !== 1 || versions[0]?.version !== 1) {
      throw new Error("Unsupported workspace source schema version")
    }
  })
}

/** Connection-level component; caller owns connection lifetime and admission. */
export function makeWorkspaceSourceStore(db: DatabaseSync): WorkspaceSourceStore {
  requireFullSync(db)
  initialize(db)
  // SQL excludes oversized payloads before the driver transfers them into JS.
  const select = db.prepare(`
    SELECT length(CAST(payload AS BLOB)) AS size,
      CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) <= ?
        THEN payload ELSE NULL END AS payload
    FROM workspace_sources WHERE digest = ?
  `)
  const insert = db.prepare("INSERT INTO workspace_sources(digest,payload) VALUES (?,?)")

  function get(digest: string): SourceBundle | undefined {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error("Invalid workspace source digest")
    }
    const row = select.get(MAX_PAYLOAD_BYTES, digest)
    if (!row) return undefined
    if (typeof row.size !== "number" || row.size > MAX_PAYLOAD_BYTES) {
      throw new Error("Stored workspace source exceeds payload size limit")
    }
    if (typeof row.payload !== "string") throw new Error("Invalid stored workspace source payload")
    const bundle = verifySourceBundle(JSON.parse(row.payload))
    if (JSON.stringify(bundle) !== row.payload) {
      throw new Error("Noncanonical stored workspace source encoding")
    }
    if (bundle.digest !== digest)
      throw new Error("Stored workspace source digest does not match key")
    return bundle
  }

  return {
    get,
    put(input) {
      const bundle = verifySourceBundle(input)
      const payload = JSON.stringify(bundle)
      if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new Error("Workspace source exceeds payload size limit")
      }
      requireFullSync(db)
      savepoint(db, () => {
        const existing = get(bundle.digest)
        if (existing) {
          if (JSON.stringify(existing) !== payload)
            throw new Error("Workspace source digest conflict")
          return
        }
        insert.run(bundle.digest, payload)
      })
    },
  }
}
