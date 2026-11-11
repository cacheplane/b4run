import { recoverySchemaStatements } from "@b4run/sdk/internal/runtime-schema"
import { describe, expect, it } from "vitest"
import { compareRuntimeSchemaSQL } from "../src/runtime/schema-compare.ts"
import { sqliteV1Statements } from "../src/runtime/schema-v1.ts"

describe("literal-safe SQLite source contract", () => {
  it("compares every old/new source statement without rewriting quoted tokens", () => {
    for (const sql of [...sqliteV1Statements, ...recoverySchemaStatements("sqlite")]) {
      expect(compareRuntimeSchemaSQL(sql, sql)).toBe(true)
      expect(compareRuntimeSchemaSQL(sql, `  ${sql.replace(/CREATE/g, "create")}  `)).toBe(true)
    }
  })
  it("rejects changed literal case/space, quote roles, grouping, comments and extra statements", () => {
    const source =
      "CREATE INDEX receipts_operation ON receipts(json_extract(payload,'$.operation.scopeKey'))"
    for (const other of [
      source.replace("scopeKey", "scopekey"),
      source.replace("scopeKey", "scope Key"),
      `${source}; DROP TABLE receipts`,
      `${source} --x`,
      `${source} /*x*/`,
      source.replace("'$.operation.scopeKey'", '"$.operation.scopeKey"'),
    ])
      expect(compareRuntimeSchemaSQL(source, other)).toBe(false)
    expect(
      compareRuntimeSchemaSQL(
        'CREATE INDEX "scopeKey" ON receipts(payload)',
        'CREATE INDEX "scopeKey" ON receipts(payload)',
      ),
    ).toBe(true)
    expect(
      compareRuntimeSchemaSQL(
        'CREATE INDEX "scopeKey" ON receipts(payload)',
        'CREATE INDEX "scopekey" ON receipts(payload)',
      ),
    ).toBe(false)
    for (const invalid of [
      "CREATE INDEX `unterminated ON receipts(payload)",
      "CREATE INDEX [unterminated ON receipts(payload)",
      source.replace("scopeKey'", "scopeKey"),
      source.replace("receipts(", "receipts(("),
    ])
      expect(compareRuntimeSchemaSQL(source, invalid)).toBe(false)
  })
})

// Native in-memory structural guard; no installation marker or fixture mutation.
import { DatabaseSync } from "node:sqlite"
import { validateSchemaObjects } from "../src/runtime/schema.ts"

it("recognizes native old/new schema and refuses a literal-only change", () => {
  const db = new DatabaseSync(":memory:")
  try {
    db.exec("PRAGMA foreign_keys=ON")
    for (const sql of sqliteV1Statements) db.exec(sql)
    expect(() => validateSchemaObjects(db, 1)).not.toThrow()
    for (const sql of recoverySchemaStatements("sqlite")) db.exec(sql)
    expect(() => validateSchemaObjects(db, 2)).not.toThrow()
    db.exec("DROP INDEX receipts_operation")
    const source = sqliteV1Statements.find((sql) =>
      sql.startsWith("CREATE INDEX receipts_operation"),
    )!
    db.exec(source.replace("scopeKey", "scopekey"))
    expect(() => validateSchemaObjects(db, 2)).toThrow()
  } finally {
    db.close()
  }
})

it.each([
  ["recovery_versions", "previous_version_seq<version_seq", "previous_version_seq<=version_seq"],
  ["recovery_cuts", "previous_cut_seq<through_seq", "previous_cut_seq<=through_seq"],
  ["recovery_entities", "entity_kind='namespace'", "entity_kind='namespaces'"],
  ["recovery_scopes", "ON DELETE NO ACTION", "ON DELETE CASCADE"],
  ["recovery_scopes", 'PRIMARY KEY("scope_key")', 'PRIMARY KEY("scope_hash")'],
])("refuses native known2 %s constructor mutation %s", (name, before, after) => {
  const db = new DatabaseSync(":memory:")
  try {
    for (const sql of sqliteV1Statements) db.exec(sql)
    let changed = 0
    for (const sql of recoverySchemaStatements("sqlite")) {
      if (sql.startsWith(`CREATE TABLE "${name}"`) && sql.includes(before)) {
        changed++
        db.exec(sql.replace(before, after))
      } else db.exec(sql)
    }
    expect(changed, "exact native constructor mutation prerequisite").toBe(1)
    expect(() => validateSchemaObjects(db, 2)).toThrow()
  } finally {
    db.close()
  }
})
