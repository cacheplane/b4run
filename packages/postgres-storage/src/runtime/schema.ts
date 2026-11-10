import { lockSchema, type TableNaming } from "../schema.js"
import type { SqlClient, SqlPool } from "../sql.js"
export const FORMAT = "b4.agent-protocol.runtime"
export const DEFAULT_RUNTIME_PREFIX = "b4_ap_v1"
export { RECORD_TABLES, table, validateNaming } from "./schema-v1.js"

import { recoverySchemaStatements } from "@b4run/sdk/internal/runtime-schema"
import { readRuntimeCatalog, runtimeCatalogMatchesSource } from "./schema-catalog.js"
import {
  installRecoverySchema,
  validateRecoveryKey,
  validateWatermarks,
} from "./schema-recovery.js"
import { postgresV1Statements, table } from "./schema-v1.js"

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
  const legacyDDL = postgresV1Statements(n)
  const layoutFor = (version: 1 | 2) =>
    JSON.stringify([
      ...legacyDDL,
      ...(version === 2 ? recoverySchemaStatements("postgres", n) : []),
    ])
  // Installation never enlists in a caller transaction: every probe, DDL,
  // seed and marker update uses this one raw checkout and commit boundary.
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    // Catalog deparsing must not depend on the caller connection search path.
    await client.query("SET LOCAL search_path = pg_catalog")
    // A schema-level lock precedes all probes/DDL, avoiding independent cold
    // boot schema creation races. Installation is one atomic transaction.
    await lockSchema(client, n.schema)
    const existing = await client.query<{ relname: string }>(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname=$1 AND left(c.relname,length($2)+1)=$2||'_' ORDER BY c.relname",
      [n.schema, n.prefix],
    )
    let id: string
    let physicalVersion: 1 | 2
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
          (marker.version !== 1 && marker.version !== 2) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            marker.installation_id,
          ) ||
          marker.schema_name !== n.schema ||
          marker.table_prefix !== n.prefix ||
          marker.layout !== layoutFor(marker.version) ||
          marker.catalog !== (await catalog(client, n))
        )
          throw incompatible()
        if (!runtimeCatalogMatchesSource(await readRuntimeCatalog(client, n), n, marker.version))
          throw incompatible()
        await validateWatermarks(client, n)
        if (marker.version === 2) await validateRecoveryKey(client, n)
        id = marker.installation_id
        physicalVersion = marker.version
      } catch (cause) {
        throw new Error(incompatible().message, { cause })
      }
    } else {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${n.schema}`)
      for (const sql of legacyDDL) await client.query(sql)
      if (!runtimeCatalogMatchesSource(await readRuntimeCatalog(client, n), n, 1))
        throw incompatible()
      id = uuid()
      physicalVersion = 1
      await client.query(
        `INSERT INTO ${table(n, "runtime_installation")}(singleton,format,version,installation_id,schema_name,table_prefix,layout,catalog) VALUES (1,$1,1,$2,$3,$4,$5,$6)`,
        [FORMAT, id, n.schema, n.prefix, layoutFor(1), await catalog(client, n)],
      )
    }
    if (physicalVersion === 1) {
      await installRecoverySchema(client, n)
      await client.query(
        `UPDATE ${table(n, "runtime_installation")} SET version=2,layout=$1,catalog=$2 WHERE singleton=1`,
        [layoutFor(2), await catalog(client, n)],
      )
    }
    if (!runtimeCatalogMatchesSource(await readRuntimeCatalog(client, n), n, 2))
      throw incompatible()
    await validateRecoveryKey(client, n)
    const final = await client.query<{
      version: number
      installation_id: string
      layout: string
      catalog: string
    }>(`SELECT version,installation_id,layout,catalog FROM ${table(n, "runtime_installation")}`)
    if (
      final.rows.length !== 1 ||
      final.rows[0]?.version !== 2 ||
      final.rows[0].installation_id !== id ||
      final.rows[0].layout !== layoutFor(2) ||
      final.rows[0].catalog !== (await catalog(client, n))
    )
      throw incompatible()
    await client.query("COMMIT")
    return id
  } catch (error) {
    try {
      await client.query("ROLLBACK")
    } catch (rollback) {
      throw new AggregateError([error, rollback], "Runtime installation and rollback failed")
    }
    throw error
  } finally {
    client.release()
  }
}
