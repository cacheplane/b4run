import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

export const FORMAT = "b4.agent-protocol.runtime"
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const RECORD_TABLES = [
  "runs",
  "checkpoints",
  "pending",
  "grants",
  "receipts",
  "inbox",
  "maintenance",
] as const

const schemaStatements = [
  ...`CREATE TABLE runtime_installation(singleton INTEGER PRIMARY KEY CHECK(singleton=1), format TEXT NOT NULL, version INTEGER NOT NULL, installation_id TEXT NOT NULL);
CREATE TABLE runtime_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, process_start TEXT NOT NULL, boot_identity TEXT NOT NULL, nonce TEXT NOT NULL);
CREATE TABLE scopes(thread_id TEXT NOT NULL, generation TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence>0), execution_owner TEXT, execution_nonce TEXT, deleted INTEGER NOT NULL DEFAULT 0, through_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(thread_id,generation));
CREATE UNIQUE INDEX current_generation ON scopes(thread_id) WHERE deleted=0;
CREATE TABLE run_identities(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, UNIQUE(thread_id,generation,id), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation));
CREATE TABLE checkpoint_identities(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, UNIQUE(thread_id,generation,id), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation));
CREATE TABLE threads(thread_id TEXT NOT NULL, generation TEXT NOT NULL, revision INTEGER NOT NULL, head_checkpoint_id TEXT, current_run_id TEXT, paused_generation TEXT, payload TEXT NOT NULL, PRIMARY KEY(thread_id,generation), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation), FOREIGN KEY(thread_id,generation,head_checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,current_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE checkpoint_lineage(thread_id TEXT NOT NULL, generation TEXT NOT NULL, checkpoint_id TEXT NOT NULL, position INTEGER NOT NULL, ancestor_thread_id TEXT NOT NULL, ancestor_generation TEXT NOT NULL, ancestor_checkpoint_id TEXT NOT NULL, ancestor_run_id TEXT, namespace TEXT NOT NULL, protected_metadata TEXT NOT NULL, PRIMARY KEY(thread_id,generation,checkpoint_id,position), FOREIGN KEY(thread_id,generation,checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(ancestor_thread_id,ancestor_generation,ancestor_checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(ancestor_thread_id,ancestor_generation,ancestor_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE journal(thread_id TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL, owner_run_id TEXT, namespace TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(thread_id,generation,seq), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation), FOREIGN KEY(thread_id,generation,owner_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE leases(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, fence INTEGER NOT NULL, revision INTEGER NOT NULL, through_seq INTEGER NOT NULL, owner_nonce TEXT NOT NULL, FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation));
CREATE TABLE aliases(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, run_id TEXT, namespace TEXT NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation), FOREIGN KEY(thread_id,generation,run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE checkpoint_writes(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, checkpoint_id TEXT NOT NULL, owner_run_id TEXT, namespace TEXT NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation), FOREIGN KEY(thread_id,generation,checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,owner_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE projections(thread_id TEXT NOT NULL, generation TEXT NOT NULL, through_seq INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(thread_id,generation), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation));`
    .split(";")
    .map((sql) => sql.trim())
    .filter(Boolean),
  ...RECORD_TABLES.flatMap((name) =>
    `CREATE TABLE ${name}(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, owner_run_id TEXT, namespace TEXT NOT NULL, parent_checkpoint_id TEXT, input_id TEXT, paused_generation TEXT, consumed_by_run_id TEXT, turn_id TEXT, previous_run_id TEXT, pre_run_checkpoint_id TEXT, status TEXT, payload TEXT NOT NULL, UNIQUE(thread_id,generation,id), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation), FOREIGN KEY(thread_id,generation,owner_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,parent_checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,consumed_by_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,input_id) REFERENCES pending(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,turn_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,previous_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,pre_run_checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED); CREATE INDEX ${name}_scope ON ${name}(thread_id,generation); CREATE INDEX ${name}_owner ON ${name}(thread_id,generation,owner_run_id)`
      .split(";")
      .map((sql) => sql.trim()),
  ),
  "CREATE INDEX receipts_operation ON receipts(json_extract(payload,'$.operation.scopeKey'),json_extract(payload,'$.receipt.submissionId'),json_extract(payload,'$.receipt.submissionKind'),json_extract(payload,'$.operation.operationThreadId'),json_extract(payload,'$.operation.targetRunId'))",
]
function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase()
}
const expectedObjects = schemaStatements.map(normalize).sort()

export function validateSchema(db: DatabaseSync): string {
  try {
    const markers = db
      .prepare("SELECT format,version,installation_id FROM runtime_installation")
      .all()
    const marker = markers[0]
    if (
      markers.length !== 1 ||
      marker?.format !== FORMAT ||
      marker.version !== 1 ||
      typeof marker.installation_id !== "string" ||
      !uuid.test(marker.installation_id)
    )
      throw new Error("marker")
    const objects = db
      .prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
      .all()
      .map((row) => normalize(String(row.sql)))
      .sort()
    if (JSON.stringify(objects) !== JSON.stringify(expectedObjects))
      throw new Error("schema objects")
    const violations = db.prepare("PRAGMA foreign_key_check").all()
    if (violations.length) throw new Error("foreign keys")
    return marker.installation_id
  } catch (cause) {
    throw new Error("Incompatible runtime schema or installation marker; use a fresh namespace", {
      cause,
    })
  }
}

export function installSchema(db: DatabaseSync): string {
  const id = randomUUID()
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const statement of schemaStatements) db.exec(statement)
    db.prepare("INSERT INTO runtime_installation VALUES (1,?,?,?)").run(FORMAT, 1, id)
    db.exec("COMMIT")
    return id
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK")
    throw error
  }
}
