import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { recoverySchemaStatements } from "@b4run/sdk/internal/runtime-schema"
import { compareRuntimeSchemaSQL } from "./schema-compare.js"
import {
  installRecoverySchema,
  validateRecoveryKey,
  validateWatermarks,
} from "./schema-recovery.js"
import { sqliteV1Statements } from "./schema-v1.js"

export const FORMAT = "b4.agent-protocol.runtime"
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export { RECORD_TABLES } from "./schema-v1.js"

/** Independent object recognition; marker validation remains a separate requirement. */
export function validateSchemaObjects(db: DatabaseSync, version: 1 | 2): void {
  const expected = [
    ...sqliteV1Statements,
    ...(version === 2 ? recoverySchemaStatements("sqlite") : []),
  ]
  const actual = db
    .prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
    .all()
  if (actual.length !== expected.length) throw new Error("schema objects")
  const remaining = [...expected]
  for (const row of actual) {
    if (typeof row.sql !== "string") throw new Error("schema object representation")
    const index = remaining.findIndex((source) =>
      compareRuntimeSchemaSQL(source, row.sql as string),
    )
    if (index === -1) throw new Error("schema objects")
    remaining.splice(index, 1)
  }
  if (remaining.length || db.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("foreign keys")
}

export interface ValidatedRuntimeSchema {
  readonly physicalVersion: 1 | 2
  readonly installationId: string
  readonly structure: readonly {
    readonly name: string
    readonly type: string
    readonly table: string
    readonly sql: string
  }[]
}

export function validateSchema(db: DatabaseSync): ValidatedRuntimeSchema {
  try {
    const markers = db
      .prepare("SELECT format,version,installation_id FROM runtime_installation")
      .all()
    const marker = markers[0]
    if (
      markers.length !== 1 ||
      marker?.format !== FORMAT ||
      (marker.version !== 1 && marker.version !== 2) ||
      typeof marker.installation_id !== "string" ||
      !uuid.test(marker.installation_id)
    )
      throw new Error("marker")
    validateSchemaObjects(db, marker.version)
    validateWatermarks(db)
    if (marker.version === 2) validateRecoveryKey(db)
    const structure = db
      .prepare(
        "SELECT name,type,tbl_name AS 'table',sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
      )
      .all()
      .map((row) => {
        if (
          typeof row.name !== "string" ||
          typeof row.type !== "string" ||
          typeof row.table !== "string" ||
          typeof row.sql !== "string"
        )
          throw new Error("schema structure")
        return { name: row.name, type: row.type, table: row.table, sql: row.sql }
      })
    return { physicalVersion: marker.version, installationId: marker.installation_id, structure }
  } catch (cause) {
    throw new Error("Incompatible runtime schema or installation marker; use a fresh namespace", {
      cause,
    })
  }
}

export function installSchema(db: DatabaseSync, expected?: ValidatedRuntimeSchema): string {
  db.exec("BEGIN IMMEDIATE")
  try {
    let current: ValidatedRuntimeSchema | undefined
    if (expected !== undefined) {
      current = validateSchema(db)
      if (JSON.stringify(current) !== JSON.stringify(expected))
        throw new Error("Runtime installation changed before migration")
    }
    const id = current?.installationId ?? randomUUID()
    if (current === undefined) {
      for (const statement of sqliteV1Statements) db.exec(statement)
      db.prepare("INSERT INTO runtime_installation VALUES (1,?,?,?)").run(FORMAT, 1, id)
    }
    if (current?.physicalVersion !== 2) {
      installRecoverySchema(db)
      db.prepare("UPDATE runtime_installation SET version=2 WHERE singleton=1").run()
    }
    const final = validateSchema(db)
    if (final.physicalVersion !== 2 || final.installationId !== id)
      throw new Error("schema installation")
    db.exec("COMMIT")
    return id
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK")
    throw error
  }
}
