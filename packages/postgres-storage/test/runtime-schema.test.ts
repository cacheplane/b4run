import { lstatSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { recoverySchemaStatements } from "@b4run/sdk/internal/runtime-schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  expectedRuntimeRelations,
  readRuntimeCatalog,
  runtimeCatalogMatchesSource,
} from "../src/runtime/schema-catalog.ts"
import { postgresV1Relations, postgresV1Statements } from "../src/runtime/schema-v1.ts"
import type { migrationBackend } from "./fixtures/runtime-migration-backend.ts"

const naming = { schema: "r9_v1", prefix: "b4_ap_v1" }
it("keeps independent known-v1 source inventory, not marker-derived facts", () => {
  expect(postgresV1Relations).toHaveLength(22)
  expect(postgresV1Relations.reduce((n, r) => n + r.columns.length, 0)).toBe(199)
  expect(postgresV1Relations.reduce((n, r) => n + r.foreignKeys.length, 0)).toBe(81)
  expect(postgresV1Statements(naming)).toHaveLength(119)
  expect(expectedRuntimeRelations(naming, 2)).toHaveLength(34)
})

describe.skipIf(process.env.B4_TEST_PGSTORAGE !== "1")(
  "native source-owned catalog validation",
  () => {
    let backend: ReturnType<typeof migrationBackend> | undefined
    beforeAll(async () => {
      const { migrationBackend } = await import("./fixtures/runtime-migration-backend.ts")
      backend = migrationBackend()
      await backend.start()
    }, 240_000)
    afterAll(async () => {
      await backend?.finish()
    }, 90_000)
    it("recognizes native qualified known1 and additive known2 constructors in one native TX", async () => {
      if (!backend) throw new Error("Native structural backend not initialized")
      await backend.withCopy(async (pool) => {
        const { recordingPool } = await import("./fixtures/runtime-migration-backend.ts")
        const client = await recordingPool(pool, []).connect()
        try {
          await client.query("BEGIN")
          await client.query("SET LOCAL search_path=pg_catalog")
          const known1Catalog = await readRuntimeCatalog(client, naming)
          const evidenceDirectory = process.env.B4_PROTOCOL_MIGRATION_EVIDENCE
          if (evidenceDirectory !== undefined) {
            const directory = lstatSync(evidenceDirectory)
            const uid = process.getuid?.()
            if (
              !isAbsolute(evidenceDirectory) ||
              !directory.isDirectory() ||
              directory.isSymbolicLink() ||
              (directory.mode & 0o777) !== 0o700 ||
              uid === undefined ||
              directory.uid !== uid
            )
              throw new Error("Owned private schema evidence directory required")
            writeFileSync(
              join(evidenceDirectory, "known1-structural-catalog.private.json"),
              `${JSON.stringify({ naming, actual: known1Catalog, expected: expectedRuntimeRelations(naming, 1) }, null, 2)}\n`,
              { mode: 0o600, flag: "wx" },
            )
          }
          expect(runtimeCatalogMatchesSource(known1Catalog, naming, 1)).toBe(true)
          for (const sql of recoverySchemaStatements("postgres", naming)) await client.query(sql)
          expect(
            runtimeCatalogMatchesSource(await readRuntimeCatalog(client, naming), naming, 2),
          ).toBe(true)
          // Only structural source recognition: no marker2/migration/seed is installed.
        } finally {
          try {
            await client.query("ROLLBACK")
          } finally {
            client.release()
          }
        }
      })
    }, 30_000)
    it("rejects changed FK/index/trigger/default/check and extra index facts", async () => {
      if (!backend) throw new Error("Native structural backend not initialized")
      await backend.withCopy(async (pool) => {
        const { recordingPool } = await import("./fixtures/runtime-migration-backend.ts")
        const client = await recordingPool(pool, []).connect()
        try {
          await client.query("BEGIN")
          await client.query("SET LOCAL search_path=pg_catalog")
          for (const sql of recoverySchemaStatements("postgres", naming)) await client.query(sql)
          const source = expectedRuntimeRelations(naming, 2)
          const strict = source
            .find((r) => r.qualifiedTable.endsWith("_recovery_versions"))!
            .checks.find((check) => check.expression.includes("previous_version_seq<version_seq"))!
          const strictCut = source
            .find((r) => r.qualifiedTable.endsWith("_recovery_cuts"))!
            .checks.find((check) => check.expression.includes("previous_cut_seq<through_seq"))!
          const kindCheck = source
            .find((r) => r.qualifiedTable.endsWith("_recovery_entities"))!
            .checks.find((check) => check.expression.includes("entity_kind='namespace'"))!
          const mutations = [
            "ALTER TABLE r9_v1.b4_ap_v1_scopes ALTER COLUMN through_seq SET DEFAULT 1",
            "ALTER TABLE r9_v1.b4_ap_v1_journal DROP CONSTRAINT b4_ap_v1_journal_id_key",
            "ALTER TABLE r9_v1.b4_ap_v1_receipts DROP CONSTRAINT owner_run_id_fkey; ALTER TABLE r9_v1.b4_ap_v1_receipts ADD CONSTRAINT owner_run_id_fkey FOREIGN KEY(thread_id,generation,owner_run_id) REFERENCES r9_v1.b4_ap_v1_run_identities(thread_id,generation,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED",
            "DROP INDEX r9_v1.b4_ap_v1_current_generation; CREATE UNIQUE INDEX b4_ap_v1_current_generation ON r9_v1.b4_ap_v1_scopes(thread_id text_pattern_ops) WHERE deleted=0",
            "ALTER TABLE r9_v1.b4_ap_v1_receipts DISABLE TRIGGER ALL",
            `ALTER TABLE r9_v1.b4_ap_v1_recovery_versions DROP CONSTRAINT ${strict.name}; ALTER TABLE r9_v1.b4_ap_v1_recovery_versions ADD CONSTRAINT ${strict.name} CHECK(previous_version_seq IS NULL OR previous_version_seq<=version_seq)`,
            `ALTER TABLE r9_v1.b4_ap_v1_recovery_cuts DROP CONSTRAINT ${strictCut.name}; ALTER TABLE r9_v1.b4_ap_v1_recovery_cuts ADD CONSTRAINT ${strictCut.name} CHECK(previous_cut_seq IS NULL OR previous_cut_seq<=through_seq)`,
            `ALTER TABLE r9_v1.b4_ap_v1_recovery_entities DROP CONSTRAINT ${kindCheck.name}; ALTER TABLE r9_v1.b4_ap_v1_recovery_entities ADD CONSTRAINT ${kindCheck.name} CHECK(${kindCheck.expression.replace("entity_kind='namespace'", "entity_kind='namespaces'")})`,
            "CREATE TABLE r9_v1.unowned_reference(thread_id TEXT,generation TEXT,FOREIGN KEY(thread_id,generation) REFERENCES r9_v1.b4_ap_v1_scopes(thread_id,generation))",
            "CREATE SCHEMA r9_unowned_child; CREATE TABLE r9_unowned_child.unowned_child () INHERITS (r9_v1.b4_ap_v1_threads)",
            "CREATE INDEX b4_ap_v1_unexpected ON r9_v1.b4_ap_v1_receipts(thread_id)",
          ]
          for (const sql of mutations) {
            await client.query("SAVEPOINT native_guard")
            await client.query(sql)
            expect(
              runtimeCatalogMatchesSource(await readRuntimeCatalog(client, naming), naming, 2),
            ).toBe(false)
            await client.query("ROLLBACK TO SAVEPOINT native_guard")
            await client.query("RELEASE SAVEPOINT native_guard")
            expect(
              runtimeCatalogMatchesSource(await readRuntimeCatalog(client, naming), naming, 2),
            ).toBe(true)
          }
        } finally {
          try {
            await client.query("ROLLBACK")
          } finally {
            client.release()
          }
        }
      })
    }, 30_000)
    it("rejects native type/collation/composite-key/FK-order and deferred-state mutations", async () => {
      if (!backend) throw new Error("Native structural backend not initialized")
      await backend.withCopy(async (pool) => {
        const { recordingPool } = await import("./fixtures/runtime-migration-backend.ts")
        const client = await recordingPool(pool, []).connect()
        try {
          await client.query("BEGIN")
          await client.query("SET LOCAL search_path=pg_catalog")
          for (const sql of recoverySchemaStatements("postgres", naming)) await client.query(sql)
          const source = expectedRuntimeRelations(naming, 2)
          const anchors = source.find((r) => r.qualifiedTable === "r9_v1.b4_ap_v1_recovery_anchors")
          const primary = anchors?.indexes.find((index) => index.constraintKind === "p")?.name
          const scopeFK = source
            .find((r) => r.qualifiedTable === "r9_v1.b4_ap_v1_recovery_scopes")
            ?.foreignKeys.find((fk) => fk.target === "r9_v1.b4_ap_v1_scopes")?.name
          const branchFK = source
            .find((r) => r.qualifiedTable === "r9_v1.b4_ap_v1_recovery_generations")
            ?.foreignKeys.find((fk) => fk.target === "r9_v1.b4_ap_v1_recovery_branches")?.name
          if (
            [primary, scopeFK, branchFK].some(
              (name) => typeof name !== "string" || !/^[a-z_][a-z0-9_]*$/.test(name),
            )
          )
            throw new Error("Exact source-owned native constraint names required")
          expect(
            runtimeCatalogMatchesSource(await readRuntimeCatalog(client, naming), naming, 2),
          ).toBe(true)
          const mutations = [
            // An unindexed marker field has no CHECK/FK/index dependency: the
            // first two variants isolate native column type and collation.
            {
              kind: "type",
              sql: "ALTER TABLE r9_v1.b4_ap_v1_runtime_installation ALTER COLUMN format TYPE pg_catalog.varchar",
            },
            {
              kind: "collation",
              sql: 'ALTER TABLE r9_v1.b4_ap_v1_runtime_installation ALTER COLUMN format TYPE pg_catalog.text COLLATE pg_catalog."C"',
            },
            // Nothing references the anchors PK, so this reorders its native
            // constraint/index without dropping or weakening any incoming FK.
            {
              kind: "composite-key",
              sql: `ALTER TABLE r9_v1.b4_ap_v1_recovery_anchors DROP CONSTRAINT ${primary}; ALTER TABLE r9_v1.b4_ap_v1_recovery_anchors ADD CONSTRAINT ${primary} PRIMARY KEY(scope_key,fragment_id,branch_id)`,
            },
            // Reversing both lists keeps the mapping/data valid while changing
            // their physical order. The existing scopes PK supports this set.
            {
              kind: "fk-order",
              sql: `ALTER TABLE r9_v1.b4_ap_v1_recovery_scopes DROP CONSTRAINT ${scopeFK}; ALTER TABLE r9_v1.b4_ap_v1_recovery_scopes ADD CONSTRAINT ${scopeFK} FOREIGN KEY(generation,thread_id) REFERENCES r9_v1.b4_ap_v1_scopes(generation,thread_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE`,
            },
            {
              kind: "initially-immediate",
              sql: `ALTER TABLE r9_v1.b4_ap_v1_recovery_generations ALTER CONSTRAINT ${branchFK} DEFERRABLE INITIALLY IMMEDIATE`,
            },
            {
              kind: "not-deferrable",
              sql: `ALTER TABLE r9_v1.b4_ap_v1_recovery_generations ALTER CONSTRAINT ${branchFK} NOT DEFERRABLE INITIALLY IMMEDIATE`,
            },
          ] as const
          for (const mutation of mutations) {
            await client.query("SAVEPOINT native_catalog_dimension")
            await client.query(mutation.sql)
            const actual = await readRuntimeCatalog(client, naming)
            if (mutation.kind === "type" || mutation.kind === "collation") {
              const column = actual
                .find((r) => r.qualifiedTable === "r9_v1.b4_ap_v1_runtime_installation")
                ?.columns.find((column) => column.name === "format")
              if (mutation.kind === "type") {
                expect(column?.type).toEqual({ schema: "pg_catalog", name: "varchar" })
                expect(column?.typmod).toBe(-1)
                expect(column?.collation).toEqual({ schema: "pg_catalog", name: "default" })
              } else {
                expect(column?.type).toEqual({ schema: "pg_catalog", name: "text" })
                expect(column?.collation).toEqual({ schema: "pg_catalog", name: "C" })
              }
            } else if (mutation.kind === "composite-key") {
              const relation = actual.find(
                (r) => r.qualifiedTable === "r9_v1.b4_ap_v1_recovery_anchors",
              )
              expect(relation?.primary).toEqual(["scope_key", "fragment_id", "branch_id"])
              expect(
                relation?.indexes
                  .find((index) => index.constraintKind === "p")
                  ?.keys.map((key) => key.expression),
              ).toEqual(["scope_key", "fragment_id", "branch_id"])
            } else if (mutation.kind === "fk-order") {
              const fk = actual
                .find((r) => r.qualifiedTable === "r9_v1.b4_ap_v1_recovery_scopes")
                ?.foreignKeys.find((fk) => fk.name === scopeFK)
              expect(fk?.columns).toEqual(["generation", "thread_id"])
              expect(fk?.targetColumns).toEqual(["generation", "thread_id"])
            } else {
              const fk = actual
                .find((r) => r.qualifiedTable === "r9_v1.b4_ap_v1_recovery_generations")
                ?.foreignKeys.find((fk) => fk.name === branchFK)
              expect(fk?.deferrable).toBe(mutation.kind === "initially-immediate")
              expect(fk?.initiallyDeferred).toBe(false)
            }
            expect(runtimeCatalogMatchesSource(actual, naming, 2), mutation.kind).toBe(false)
            await client.query("ROLLBACK TO SAVEPOINT native_catalog_dimension")
            await client.query("RELEASE SAVEPOINT native_catalog_dimension")
            expect(
              runtimeCatalogMatchesSource(await readRuntimeCatalog(client, naming), naming, 2),
              `${mutation.kind} native rollback restores the positive source contract`,
            ).toBe(true)
          }
        } finally {
          try {
            await client.query("ROLLBACK")
          } finally {
            client.release()
          }
        }
      })
    }, 30_000)
  },
)

it("refuses coherent near-neighbor catalogs against independent source facts", () => {
  const source = expectedRuntimeRelations(naming, 1)
  expect(runtimeCatalogMatchesSource(source, naming, 1)).toBe(true)
  const mutate = (change: (rows: typeof source) => void) => {
    const rows = structuredClone(source)
    change(rows)
    expect(runtimeCatalogMatchesSource(rows, naming, 1)).toBe(false)
  }
  mutate((rows) => {
    rows[0]!.persistence = "u"
  })
  mutate((rows) => {
    rows[0]!.columns[0]!.type.name = "int8"
  })
  mutate((rows) => {
    rows.find((r) => r.foreignKeys.length)!.foreignKeys[0]!.deleteAction = "c"
  })
  mutate((rows) => {
    rows.find((r) => r.foreignKeys.length)!.foreignKeys[0]!.targetColumns.reverse()
  })
  mutate((rows) => {
    rows.find((r) => r.indexes.length)!.indexes[0]!.keys[0]!.opclass.name = "text_pattern_ops"
  })
  mutate((rows) => {
    rows.find((r) => r.checks.length)!.checks[0]!.expression += " OR true"
  })
  mutate((rows) => {
    rows[0]!.columns[0]!.notNull = false
  })
  mutate((rows) => {
    rows[0]!.invalidNotNullConstraints = 1
  })
  mutate((rows) => {
    rows.find((r) => r.foreignKeys.length)!.foreignKeys[0]!.enforced = false
  })
  mutate((rows) => {
    rows.find((r) => r.foreignKeys.length)!.foreignKeys[0]!.temporal = true
  })
  mutate((rows) => {
    rows.find((r) => r.foreignKeys.length)!.foreignKeys[0]!.triggers[0]!.enabled = "D"
  })
  mutate((rows) => {
    rows[0]!.indexes[0]!.nullsNotDistinct = true
  })
  mutate((rows) => {
    rows[0]!.indexes[0]!.ready = false
  })
  mutate((rows) => {
    rows[0]!.unsupportedInternalTriggers = 1
  })
  mutate((rows) => {
    rows[0]!.inherits = 1
  })
  mutate((rows) => {
    rows[0]!.policies.push("unexpected")
  })
  mutate((rows) => {
    rows.push(structuredClone(rows[0]!))
  })
})
