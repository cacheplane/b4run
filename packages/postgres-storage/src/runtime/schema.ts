import { withTransaction } from "../internal/tx.js"
import { assertIdentifier, lockSchema, type TableNaming } from "../schema.js"
import type { SqlClient, SqlPool } from "../sql.js"
export const FORMAT = "b4.agent-protocol.runtime"
export const DEFAULT_RUNTIME_PREFIX = "b4_ap_v1"
export const RECORD_TABLES = [
  "runs",
  "checkpoints",
  "pending",
  "grants",
  "receipts",
  "inbox",
  "maintenance",
] as const
const logicalStatements = [
  ...`CREATE TABLE runtime_installation(singleton INTEGER PRIMARY KEY CHECK(singleton=1), format TEXT NOT NULL, version INTEGER NOT NULL, installation_id TEXT NOT NULL, schema_name TEXT NOT NULL, table_prefix TEXT NOT NULL, layout TEXT NOT NULL, catalog TEXT NOT NULL);

CREATE TABLE scopes(thread_id TEXT NOT NULL, generation TEXT NOT NULL, fence BIGINT NOT NULL CHECK(fence>0), lease_expires_at TIMESTAMPTZ NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, through_seq BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(thread_id,generation));
CREATE UNIQUE INDEX current_generation ON scopes(thread_id) WHERE deleted=0;
CREATE TABLE run_identities(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, UNIQUE(thread_id,generation,id), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation));
CREATE TABLE checkpoint_identities(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, UNIQUE(thread_id,generation,id), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation));
CREATE TABLE threads(thread_id TEXT NOT NULL, generation TEXT NOT NULL, revision BIGINT NOT NULL, head_checkpoint_id TEXT, current_run_id TEXT, paused_generation TEXT, payload TEXT NOT NULL, PRIMARY KEY(thread_id,generation), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation), FOREIGN KEY(thread_id,generation,head_checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,current_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE checkpoint_lineage(thread_id TEXT NOT NULL, generation TEXT NOT NULL, checkpoint_id TEXT NOT NULL, position INTEGER NOT NULL, ancestor_thread_id TEXT NOT NULL, ancestor_generation TEXT NOT NULL, ancestor_checkpoint_id TEXT NOT NULL, ancestor_run_id TEXT, namespace TEXT NOT NULL, protected_metadata TEXT NOT NULL, PRIMARY KEY(thread_id,generation,checkpoint_id,position), FOREIGN KEY(thread_id,generation,checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(ancestor_thread_id,ancestor_generation,ancestor_checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(ancestor_thread_id,ancestor_generation,ancestor_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE journal(thread_id TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL UNIQUE, seq BIGINT NOT NULL, owner_run_id TEXT, namespace TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(thread_id,generation,seq), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation), CONSTRAINT owner_run_id_fkey FOREIGN KEY(thread_id,generation,owner_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE leases(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, fence BIGINT NOT NULL, revision BIGINT NOT NULL, through_seq BIGINT NOT NULL, owner_nonce TEXT NOT NULL, FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation));
CREATE TABLE aliases(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, run_id TEXT, namespace TEXT NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation), FOREIGN KEY(thread_id,generation,run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE checkpoint_writes(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, checkpoint_id TEXT NOT NULL, owner_run_id TEXT, namespace TEXT NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation), FOREIGN KEY(thread_id,generation,checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, CONSTRAINT owner_run_id_fkey FOREIGN KEY(thread_id,generation,owner_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE projections(thread_id TEXT NOT NULL, generation TEXT NOT NULL, through_seq BIGINT NOT NULL, revision BIGINT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(thread_id,generation), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation));`
    .split(";")
    .map((sql) => sql.trim())
    .filter(Boolean),
  ...RECORD_TABLES.flatMap((name) =>
    `CREATE TABLE ${name}(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, generation TEXT NOT NULL, owner_run_id TEXT, namespace TEXT NOT NULL, parent_checkpoint_id TEXT, input_id TEXT, paused_generation TEXT, consumed_by_run_id TEXT, turn_id TEXT, previous_run_id TEXT, pre_run_checkpoint_id TEXT, status TEXT, payload TEXT NOT NULL, UNIQUE(thread_id,generation,id), FOREIGN KEY(thread_id,generation) REFERENCES scopes(thread_id,generation), CONSTRAINT owner_run_id_fkey FOREIGN KEY(thread_id,generation,owner_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,parent_checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,consumed_by_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,input_id) REFERENCES pending(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,turn_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,previous_run_id) REFERENCES run_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(thread_id,generation,pre_run_checkpoint_id) REFERENCES checkpoint_identities(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED); CREATE INDEX ${name}_scope ON ${name}(thread_id,generation); CREATE INDEX ${name}_owner ON ${name}(thread_id,generation,owner_run_id)`
      .split(";")
      .map((sql) => sql.trim()),
  ),
  "CREATE INDEX receipts_operation ON receipts(((payload::jsonb)->'operation'->>'scopeKey'),((payload::jsonb)->'receipt'->>'submissionId'),((payload::jsonb)->'receipt'->>'submissionKind'),((payload::jsonb)->'operation'->>'operationThreadId'),((payload::jsonb)->'operation'->>'targetRunId'))",
]

const names = [
  "runtime_installation",
  "scopes",
  "run_identities",
  "checkpoint_identities",
  "threads",
  "checkpoint_lineage",
  "journal",
  "leases",
  "aliases",
  "checkpoint_writes",
  "projections",
  ...RECORD_TABLES,
  "native_checkpoints",
  "native_writes",
]
export function validateNaming(schema: string, prefix: string): TableNaming {
  assertIdentifier("schema", schema)
  assertIdentifier("tablePrefix", prefix)
  for (const value of [
    schema,
    ...names.map((name) => `${prefix}_${name}`),
    `${prefix}_checkpoint_lineage_scope`,
  ])
    if (value.length > 63)
      throw new Error("postgres-storage: runtime SQL identifier exceeds maximum length 63")
  return { schema, prefix }
}
export function table(naming: TableNaming, name: string): string {
  return `${naming.schema}.${naming.prefix}_${name}`
}
function statements(n: TableNaming): string[] {
  const identifiers = [
    ...names,
    "current_generation",
    "receipts_operation",
    ...RECORD_TABLES.flatMap((name) => [`${name}_scope`, `${name}_owner`]),
  ].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`\\b(${identifiers.join("|")})\\b`, "g")
  const portable = logicalStatements.map((sql) => sql.replace(pattern, (name) => table(n, name)))
  // Index names cannot be schema-qualified; the indexed table determines schema.
  const ddl = portable.map((sql) =>
    sql.replace(/(CREATE (?:UNIQUE )?INDEX) ([a-z_][a-z0-9_]*)\./g, "$1 "),
  )
  const native = (name: string) => table(n, `native_${name}`)
  const runtimeDefaults = `generation TEXT NOT NULL DEFAULT current_setting('b4.runtime_generation'), fence BIGINT NOT NULL DEFAULT current_setting('b4.runtime_fence')::bigint, owner_run_id TEXT NOT NULL DEFAULT current_setting('b4.runtime_run'), CHECK(thread_id=current_setting('b4.runtime_thread')), FOREIGN KEY(thread_id,generation) REFERENCES ${table(n, "scopes")}(thread_id,generation), FOREIGN KEY(thread_id,generation,owner_run_id) REFERENCES ${table(n, "run_identities")}(thread_id,generation,id) DEFERRABLE INITIALLY DEFERRED`
  ddl.push(
    `CREATE TABLE ${native("checkpoints")} (thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL, parent_checkpoint_id TEXT, type TEXT, checkpoint BYTEA NOT NULL, metadata BYTEA NOT NULL, ${runtimeDefaults}, PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id), UNIQUE(thread_id,generation,checkpoint_ns,checkpoint_id), FOREIGN KEY(thread_id,generation,checkpoint_ns,parent_checkpoint_id) REFERENCES ${native("checkpoints")}(thread_id,generation,checkpoint_ns,checkpoint_id) DEFERRABLE INITIALLY DEFERRED)`,
  )
  ddl.push(
    `CREATE TABLE ${native("writes")} (thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, value BYTEA, ${runtimeDefaults}, PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,idx), FOREIGN KEY(thread_id,generation,checkpoint_ns,checkpoint_id) REFERENCES ${native("checkpoints")}(thread_id,generation,checkpoint_ns,checkpoint_id) DEFERRABLE INITIALLY DEFERRED)`,
  )
  // PostgreSQL resolves foreign targets at DDL time. Create every relation
  // before adding the cyclic, initially deferred canonical ownership keys.
  const foreign: string[] = []
  const created = ddl.map((sql) => {
    const match = /^CREATE TABLE ([a-z0-9_.]+)\s*\((.*)\)$/s.exec(sql)
    if (!match) return sql
    const fields: string[] = []
    let depth = 0,
      start = 0
    const body = match[2] ?? ""
    for (let i = 0; i <= body.length; i++) {
      if (body[i] === "(") depth++
      else if (body[i] === ")") depth--
      if (i === body.length || (body[i] === "," && depth === 0)) {
        const field = body.slice(start, i).trim()
        start = i + 1
        if (/^(?:CONSTRAINT \w+ )?FOREIGN KEY/i.test(field))
          foreign.push(`ALTER TABLE ${match[1]} ADD ${field}`)
        else fields.push(field)
      }
    }
    return `CREATE TABLE ${match[1]} (${fields.join(",")})`
  })
  return [...created, ...foreign]
}
/** Complete committed namespace shape, including columns/defaults, constraints,
 * indexes, triggers and policies. A missing or altered object never migrates. */
async function catalog(client: SqlClient, n: TableNaming): Promise<string> {
  const result = await client.query(
    `
    SELECT c.relname AS name,c.relkind AS kind,c.relrowsecurity AS rls,
      (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',NOT a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints,
      (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid) AS indexes,
      (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY pg_get_triggerdef(t.oid)) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers,
      (SELECT jsonb_agg(p.polname ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
    FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname=$1 AND left(c.relname,length($2)+1)=$2||'_' ORDER BY c.relname`,
    [n.schema, n.prefix],
  )
  return JSON.stringify(result.rows)
}
const incompatible = () =>
  new Error("Incompatible runtime schema or installation marker; use a fresh namespace")
export async function installSchema(
  pool: SqlPool,
  n: TableNaming,
  uuid: () => string,
): Promise<string> {
  const ddl = statements(n)
  const layout = JSON.stringify(ddl)
  return withTransaction(pool, async (client) => {
    // Catalog deparsing must not depend on the caller connection search path.
    await client.query("SET LOCAL search_path = pg_catalog")
    // A schema-level lock precedes all probes/DDL, avoiding independent cold
    // boot schema creation races. Installation is one atomic transaction.
    await lockSchema(client, n.schema)
    const existing = await client.query<{ relname: string }>(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname=$1 AND left(c.relname,length($2)+1)=$2||'_' ORDER BY c.relname",
      [n.schema, n.prefix],
    )
    if (existing.rows.length) {
      if (!existing.rows.some((row) => row.relname === `${n.prefix}_runtime_installation`))
        throw incompatible()
      try {
        const markers = await client.query<{
          format: string
          version: number
          installation_id: string
          schema_name: string
          table_prefix: string
          layout: string
          catalog: string
        }>(`SELECT * FROM ${table(n, "runtime_installation")}`)
        const marker = markers.rows[0]
        if (
          markers.rows.length !== 1 ||
          !marker ||
          marker.format !== FORMAT ||
          marker.version !== 1 ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            marker.installation_id,
          ) ||
          marker.schema_name !== n.schema ||
          marker.table_prefix !== n.prefix ||
          marker.layout !== layout ||
          marker.catalog !== (await catalog(client, n))
        )
          throw incompatible()
        return marker.installation_id
      } catch (cause) {
        throw new Error(incompatible().message, { cause })
      }
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${n.schema}`)
    for (const sql of ddl) await client.query(sql)
    const id = uuid()
    await client.query(
      `INSERT INTO ${table(n, "runtime_installation")}(singleton,format,version,installation_id,schema_name,table_prefix,layout,catalog) VALUES (1,$1,1,$2,$3,$4,$5,$6)`,
      [FORMAT, id, n.schema, n.prefix, layout, await catalog(client, n)],
    )
    return id
  })
}
