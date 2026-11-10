import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  encodeRecoveryIdentityTuple,
  recoverySchemaStatements,
} from "@b4run/sdk/internal/runtime-schema"
import type { TableNaming } from "../schema.js"
import type { SqlClient } from "../sql.js"
import { table } from "./schema-v1.js"

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

export async function validateWatermarks(client: SqlClient, n: TableNaming): Promise<void> {
  const invalid = await client.query(
    `SELECT 1 FROM ${table(n, "scopes")} WHERE through_seq<0 OR through_seq>9007199254740991 LIMIT 1`,
  )
  const ahead = await client.query(
    `SELECT 1 FROM ${table(n, "journal")} j JOIN ${table(n, "scopes")} s ON s.thread_id=j.thread_id AND s.generation=j.generation WHERE j.seq<0 OR j.seq>9007199254740991 OR j.seq>s.through_seq LIMIT 1`,
  )
  if (invalid.rows.length || ahead.rows.length) throw new Error("Invalid runtime journal watermark")
}
interface ScopeRow {
  scope_key: string
  thread_id: string
  generation: string
  scope_hash: string
  scope_identity_json: string
}
async function retainedScope(
  client: SqlClient,
  n: TableNaming,
  threadId: string,
  generation: string,
): Promise<string | undefined> {
  const identity = encodeRecoveryIdentityTuple([1, threadId, generation])
  const hash = digest(identity)
  const bucket = await client.query<ScopeRow>(
    `SELECT * FROM ${table(n, "recovery_scopes")} WHERE scope_hash=$1 OR (thread_id=$2 AND generation=$3)`,
    [hash, threadId, generation],
  )
  let key: string | undefined
  for (const row of bucket.rows) {
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
 * native transaction under the schema lock. The validated scopes/threads PK
 * join emits each tuple once; known2 reopen never seeds a retained registry. */
async function allocateFreshMigrationScope(
  client: SqlClient,
  n: TableNaming,
  threadId: string,
  generation: string,
): Promise<string> {
  const identity = encodeRecoveryIdentityTuple([1, threadId, generation])
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = randomBytes(16).toString("hex")
    if (
      (await client.query(`SELECT 1 FROM ${table(n, "recovery_scopes")} WHERE scope_key=$1`, [key]))
        .rows.length
    )
      continue
    await client.query(
      `INSERT INTO ${table(n, "recovery_scopes")}(scope_key,thread_id,generation,scope_hash,scope_identity_json) VALUES ($1,$2,$3,$4,$5)`,
      [key, threadId, generation, digest(identity), identity],
    )
    return key
  }
  throw new Error("Unable to allocate recovery scope identity")
}

/** Caller owns the raw installation transaction and existing schema lock. */
export async function installRecoverySchema(client: SqlClient, n: TableNaming): Promise<void> {
  await validateWatermarks(client, n)
  for (const sql of recoverySchemaStatements("postgres", n)) await client.query(sql)
  await client.query(
    `INSERT INTO ${table(n, "runtime_recovery_keys")}(singleton,key_version,key_hex) VALUES (1,1,$1)`,
    [randomBytes(32).toString("hex")],
  )
  const live = await client.query<{ thread_id: string; generation: string; through_seq: string }>(
    `SELECT s.thread_id,s.generation,s.through_seq::text AS through_seq FROM ${table(n, "scopes")} s JOIN ${table(n, "threads")} t ON t.thread_id=s.thread_id AND t.generation=s.generation WHERE s.deleted=0`,
  )
  for (const row of live.rows) {
    // int8 remains exact native decimal text; never round through Number.
    if (
      typeof row.thread_id !== "string" ||
      typeof row.generation !== "string" ||
      typeof row.through_seq !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(row.through_seq) ||
      BigInt(row.through_seq) > 9007199254740991n
    )
      throw new Error("Invalid legacy recovery scope")
    const key = await allocateFreshMigrationScope(client, n, row.thread_id, row.generation)
    const branch = randomUUID()
    await client.query(
      `INSERT INTO ${table(n, "recovery_branches")}(thread_id,generation,scope_key,branch_id,parent_branch_id,born_seq,invalidated_seq,root_checkpoint_id) VALUES ($1,$2,$3,$4,NULL,$5,NULL,NULL)`,
      [row.thread_id, row.generation, key, branch, row.through_seq],
    )
    await client.query(
      `INSERT INTO ${table(n, "recovery_generations")}(thread_id,generation,scope_key,baseline_kind,legacy_through_seq,replay_after_seq,branch_id,current_cut_seq,history_epoch,open_bytes,pending_bytes,pending_count,recent_bytes,recent_count,accounting_status) VALUES ($1,$2,$3,'legacy_unknown',$4,$4,$5,NULL,0,NULL,NULL,NULL,NULL,NULL,'unknown')`,
      [row.thread_id, row.generation, key, row.through_seq, branch],
    )
  }
}

export async function validateRecoveryKey(client: SqlClient, n: TableNaming): Promise<void> {
  const result = await client.query<{ singleton: number; key_version: number; key_hex: string }>(
    `SELECT singleton,key_version,key_hex FROM ${table(n, "runtime_recovery_keys")}`,
  )
  const row = result.rows[0]
  if (
    result.rows.length !== 1 ||
    row?.singleton !== 1 ||
    row.key_version !== 1 ||
    typeof row.key_hex !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.key_hex)
  )
    throw new Error("Invalid recovery installation key")
}

/** Invoked after the existing exact Thread/fence/intent/ownership proofs. */
export async function deleteRecoveryScope(
  client: SqlClient,
  n: TableNaming,
  threadId: string,
  generation: string,
): Promise<void> {
  const key = await retainedScope(client, n, threadId, generation)
  for (const name of scopedTables) {
    if (
      (
        await client.query(
          `SELECT 1 FROM ${table(n, name)} WHERE (thread_id=$1 AND generation=$2 AND ($3::text IS NULL OR scope_key!=$3)) OR (scope_key=$3 AND (thread_id!=$1 OR generation!=$2)) LIMIT 1`,
          [threadId, generation, key ?? null],
        )
      ).rows.length
    )
      throw new Error("Corrupt recovery cleanup scope mapping")
  }
  if (key === undefined) return
  for (const name of scopedTables)
    await client.query(
      `DELETE FROM ${table(n, name)} WHERE scope_key=$1 AND thread_id=$2 AND generation=$3`,
      [key, threadId, generation],
    )
}
