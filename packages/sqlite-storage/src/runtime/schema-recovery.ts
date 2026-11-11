import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import {
  encodeRecoveryIdentityTuple,
  recoverySchemaStatements,
} from "@b4run/sdk/internal/runtime-schema"

const scopedTables = [
  "recovery_anchors",
  "recovery_fragments",
  "recovery_current",
  "recovery_versions",
  "recovery_checkpoints",
  "recovery_cuts",
  "recovery_objects",
  "recovery_entities",
  "recovery_generations",
  "recovery_branches",
  "recovery_scopes",
] as const
const digest = (source: string) => createHash("sha256").update(source, "ascii").digest("hex")
const sameBytes = (actual: unknown, expected: string) =>
  typeof actual === "string" && Buffer.from(actual, "utf8").equals(Buffer.from(expected, "ascii"))

/** Probe native integers before retrieving a SQLite integer as a JS number. */
export function validateWatermarks(db: DatabaseSync): void {
  if (
    db
      .prepare(
        "SELECT 1 FROM scopes WHERE typeof(through_seq)!='integer' OR through_seq<0 OR through_seq>9007199254740991 LIMIT 1",
      )
      .get() ||
    db
      .prepare(
        "SELECT 1 FROM journal j JOIN scopes s ON s.thread_id=j.thread_id AND s.generation=j.generation WHERE typeof(j.seq)!='integer' OR j.seq<0 OR j.seq>9007199254740991 OR j.seq>s.through_seq LIMIT 1",
      )
      .get()
  )
    throw new Error("Invalid runtime journal watermark")
}

function scopeIdentity(threadId: string, generation: string): string {
  return encodeRecoveryIdentityTuple([1, threadId, generation])
}
function retainedScope(db: DatabaseSync, threadId: string, generation: string): string | undefined {
  const identity = scopeIdentity(threadId, generation)
  const hash = digest(identity)
  const bucket = db
    .prepare("SELECT * FROM recovery_scopes WHERE scope_hash=? OR (thread_id=? AND generation=?)")
    .all(hash, threadId, generation)
  let key: string | undefined
  for (const row of bucket) {
    const exact = sameBytes(row.scope_identity_json, identity)
    const native = row.thread_id === threadId && row.generation === generation
    if (native !== exact || (native && row.scope_hash !== hash))
      throw new Error("Corrupt recovery scope identity")
    if (!exact) continue
    if (
      key !== undefined ||
      typeof row.scope_key !== "string" ||
      !/^[0-9a-f]{32}$/.test(row.scope_key)
    )
      throw new Error("Duplicate or invalid recovery scope identity")
    key = row.scope_key
  }
  return key
}
/** Migration only: the caller just created empty recovery tables in this
 * native transaction. The validated scopes/threads PK join emits each tuple
 * once, and known2 reopen never seeds. There is no retained mapping to audit. */
function allocateFreshMigrationScope(
  db: DatabaseSync,
  threadId: string,
  generation: string,
): string {
  const identity = scopeIdentity(threadId, generation)
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = randomBytes(16).toString("hex")
    if (db.prepare("SELECT 1 FROM recovery_scopes WHERE scope_key=?").get(key)) continue
    db.prepare(
      "INSERT INTO recovery_scopes(scope_key,thread_id,generation,scope_hash,scope_identity_json) VALUES (?,?,?,?,?)",
    ).run(key, threadId, generation, digest(identity), identity)
    return key
  }
  throw new Error("Unable to allocate recovery scope identity")
}

/** Caller owns the installation's native write transaction. */
export function installRecoverySchema(db: DatabaseSync): void {
  validateWatermarks(db)
  for (const sql of recoverySchemaStatements("sqlite")) db.exec(sql)
  db.prepare("INSERT INTO runtime_recovery_keys(singleton,key_version,key_hex) VALUES (1,1,?)").run(
    randomBytes(32).toString("hex"),
  )
  const live = db
    .prepare(
      "SELECT s.thread_id,s.generation,s.through_seq FROM scopes s JOIN threads t ON t.thread_id=s.thread_id AND t.generation=s.generation WHERE s.deleted=0",
    )
    .all()
  for (const row of live) {
    if (
      typeof row.thread_id !== "string" ||
      typeof row.generation !== "string" ||
      typeof row.through_seq !== "number" ||
      !Number.isSafeInteger(row.through_seq) ||
      row.through_seq < 0
    )
      throw new Error("Invalid legacy recovery scope")
    const key = allocateFreshMigrationScope(db, row.thread_id, row.generation)
    const branch = randomUUID()
    db.prepare(
      "INSERT INTO recovery_branches(thread_id,generation,scope_key,branch_id,parent_branch_id,born_seq,invalidated_seq,root_checkpoint_id) VALUES (?,?,?,?,NULL,?,NULL,NULL)",
    ).run(row.thread_id, row.generation, key, branch, row.through_seq)
    db.prepare(
      "INSERT INTO recovery_generations(thread_id,generation,scope_key,baseline_kind,legacy_through_seq,replay_after_seq,branch_id,current_cut_seq,history_epoch,open_bytes,pending_bytes,pending_count,recent_bytes,recent_count,accounting_status) VALUES (?,?,?,'legacy_unknown',?,?,?,NULL,0,NULL,NULL,NULL,NULL,NULL,'unknown')",
    ).run(row.thread_id, row.generation, key, row.through_seq, row.through_seq, branch)
  }
}

export function validateRecoveryKey(db: DatabaseSync): void {
  const rows = db.prepare("SELECT singleton,key_version,key_hex FROM runtime_recovery_keys").all()
  if (
    rows.length !== 1 ||
    rows[0]?.singleton !== 1 ||
    rows[0].key_version !== 1 ||
    typeof rows[0].key_hex !== "string" ||
    !/^[0-9a-f]{64}$/.test(rows[0].key_hex)
  )
    throw new Error("Invalid recovery installation key")
}

/** Only the existing proven temporary-cleanup transaction calls this helper. */
export function deleteRecoveryScope(db: DatabaseSync, threadId: string, generation: string): void {
  const key = retainedScope(db, threadId, generation)
  for (const name of scopedTables) {
    // Both native tuple and surrogate must agree. A FK to each independently
    // existing identity never authorizes deleting another generation's rows.
    if (
      db
        .prepare(
          `SELECT 1 FROM ${name} WHERE (thread_id=? AND generation=? AND (? IS NULL OR scope_key!=?)) OR (scope_key=? AND (thread_id!=? OR generation!=?)) LIMIT 1`,
        )
        .get(threadId, generation, key ?? null, key ?? null, key ?? null, threadId, generation)
    )
      throw new Error("Corrupt recovery cleanup scope mapping")
  }
  if (key === undefined) return
  for (const name of scopedTables)
    db.prepare(`DELETE FROM ${name} WHERE scope_key=? AND thread_id=? AND generation=?`).run(
      key,
      threadId,
      generation,
    )
}
