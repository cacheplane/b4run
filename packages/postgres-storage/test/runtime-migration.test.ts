import {
  asciiJsonV1,
  encodeRecoveryIdentityTuple,
  recoveryTables,
  recoveryTableTag,
} from "@b4run/sdk/internal/runtime-schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bindRuntimeStore, createRuntimeBinding } from "../src/runtime/binding.ts"
import type { PostgresRuntimeInstallation } from "../src/runtime/index.ts"
import { openPostgresRuntimeInstallation } from "../src/runtime/node.ts"
import {
  postgresV1Statements,
  table as sourceTable,
  validateNaming,
} from "../src/runtime/schema-v1.ts"
import {
  canonical,
  expected,
  identifier,
  legacyCatalogSQL,
  migrationBackend,
  naming,
  readCopy,
  recordingPool,
  sha,
  table,
} from "./fixtures/runtime-migration-backend.ts"
import * as cleanupData from "./fixtures/runtime-migration-data.ts"

const expectedRecords = Object.fromEntries(
  Object.entries(expected.preservedRecords).map(([name, value]) => [
    name,
    { count: value.count, canonicalRowSHA256: value.canonicalRowSHA256 },
  ]),
)

describe.skipIf(process.env.B4_TEST_PGSTORAGE !== "1")("real PostgreSQL known-v1 migration", () => {
  let backend: ReturnType<typeof migrationBackend> | undefined
  beforeAll(() => {
    backend = migrationBackend()
    return backend.start()
  }, 240_000)
  afterAll(() => backend?.finish(), 90_000)

  it("preserves an undefined callback rejection after native pool and database cleanup", async () => {
    if (!backend) throw new Error("Gated migration backend not initialized")
    let rejectedDatabase: string | undefined
    let rejectedApps: string[] = []
    let rejected = false
    let rejection: unknown
    try {
      await backend.withCopy(async (first, second) => {
        const [firstIdentity, secondIdentity] = await Promise.all([
          first.query<{ database: string; app_name: string }>(
            "SELECT current_database() AS database,current_setting('application_name') AS app_name",
          ),
          second.query<{ database: string; app_name: string }>(
            "SELECT current_database() AS database,current_setting('application_name') AS app_name",
          ),
        ])
        const a = firstIdentity.rows[0],
          b = secondIdentity.rows[0]
        if (!a || !b || a.database !== b.database || a.app_name === b.app_name)
          throw new Error("Native callback rejection identity prerequisite failed")
        rejectedDatabase = a.database
        rejectedApps = [a.app_name, b.app_name]
        return Promise.reject(undefined)
      })
    } catch (error) {
      rejected = true
      rejection = error
    }
    if (!rejectedDatabase || rejectedApps.length !== 2)
      throw new Error("Native callback rejection identities were not captured")
    let cleanupFacts: { database_exists: boolean; backend_count: string } | undefined
    const resolved = await backend.withCopy(async (first) => {
      cleanupFacts = (
        await first.query<{ database_exists: boolean; backend_count: string }>(
          "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS database_exists,(SELECT count(*)::text FROM pg_stat_activity WHERE datname=$1 OR application_name=ANY($2::text[])) AS backend_count",
          [rejectedDatabase, rejectedApps],
        )
      ).rows[0]
      return undefined
    })
    if (!cleanupFacts) throw new Error("Independent native callback cleanup facts were not read")
    // Both copies normally close before the rejection assertion, including the RED run.
    expect(cleanupFacts.database_exists).toBe(false)
    expect(cleanupFacts.backend_count).toBe("0")
    expect(resolved).toBeUndefined()
    expect(rejected, "withCopy must retain a callback rejection whose reason is undefined").toBe(
      true,
    )
    expect(rejection).toBeInstanceOf(AggregateError)
    const reasons = (rejection as AggregateError).errors
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toBeUndefined()
  }, 30_000)

  it("migrates the qualified actual native-v1 dump while retaining original installation and journal/private bytes", async () => {
    if (!backend) throw new Error("Gated migration backend not initialized")
    const facts = await backend.withCopy(async (first) => {
      const before = await readCopy(first)
      const catalogKnown = canonical(before.catalog) === canonical(expected.catalog.objects)
      const oldMarkerKnown =
        before.marker.version === 1 &&
        before.marker.installation_id === expected.identity.installationId
      const originalRecordsKnown = canonical(before.records) === canonical(expectedRecords)
      const oldJournalKnown = canonical(before.journal) === canonical(expected.journal)
      expect(catalogKnown, "actual old native catalog prerequisite").toBe(true)
      expect(oldMarkerKnown, "qualified old marker prerequisite").toBe(true)
      expect(originalRecordsKnown, "all old native/private row prerequisites").toBe(true)
      expect(oldJournalKnown, "all nine physical journal byte prerequisites").toBe(true)
      let owner: PostgresRuntimeInstallation | undefined
      let failure: unknown
      let after: Awaited<ReturnType<typeof readCopy>> | undefined
      const cleanup: unknown[] = []
      try {
        owner = await openPostgresRuntimeInstallation({ pool: first, ...naming })
        after = await readCopy(first)
      } catch (error) {
        failure = error
      } finally {
        try {
          await owner?.close()
        } catch (error) {
          cleanup.push(error)
        }
      }
      if (failure !== undefined || cleanup.length)
        throw new AggregateError(
          [...(failure !== undefined ? [failure] : []), ...cleanup],
          "Migration factory read or normal close failed",
        )
      if (!after || !owner) throw new Error("Missing actual migration observations")
      return {
        version: after.marker.version as number,
        installationPreserved:
          owner.installationId === expected.identity.installationId &&
          after.marker.installation_id === expected.identity.installationId,
        allOriginalRecordsPreserved: canonical(after.records) === canonical(expectedRecords),
        journalBytesPreserved: canonical(after.journal) === canonical(expected.journal),
      }
    })
    // All owned pools/DBs are normally closed before any behavioral assertion.
    expect(facts.installationPreserved).toBe(true)
    expect(facts.allOriginalRecordsPreserved).toBe(true)
    expect(facts.journalBytesPreserved).toBe(true)
    expect(facts.version, "known physical-v1 installation advances atomically to physical2").toBe(2)
  }, 30_000)

  it("rejects an altered ownership FK even when its old marker catalog matches the actual changed catalog", async () => {
    if (!backend) throw new Error("Gated migration backend not initialized")
    const facts = await backend.withCopy(async (first, second) => {
      const original = await readCopy(first)
      expect(
        canonical(original.catalog) === canonical(expected.catalog.objects),
        "qualified old catalog prerequisite",
      ).toBe(true)
      expect(
        canonical(original.records) === canonical(expectedRecords),
        "qualified private rows prerequisite",
      ).toBe(true)
      await first.query(`ALTER TABLE ${table("runs")} DROP CONSTRAINT owner_run_id_fkey`)
      // Reproduce the exact old query/search_path; this is genuine observed corruption, not a forged fixture.
      const modified = await readCopy(first)
      await first.query(`UPDATE ${table("runtime_installation")} SET catalog=$1`, [
        JSON.stringify(modified.catalog),
      ])
      const before = await readCopy(second)
      const markerAndLiveMatch = before.marker.catalog === JSON.stringify(before.catalog)
      const knownCatalogChanged = canonical(before.catalog) !== canonical(expected.catalog.objects)
      expect(
        markerAndLiveMatch && knownCatalogChanged,
        "coherently re-marked actual incompatible catalog prerequisite",
      ).toBe(true)
      const writes: string[] = []
      let owner: PostgresRuntimeInstallation | undefined
      let rejected = false
      let unexpected: unknown
      const cleanup: unknown[] = []
      try {
        owner = await openPostgresRuntimeInstallation({
          pool: recordingPool(second, writes),
          ...naming,
        })
      } catch (error) {
        if (error instanceof Error && /incompatible|marker|namespace/i.test(error.message))
          rejected = true
        else unexpected = error
      } finally {
        try {
          await owner?.close()
        } catch (error) {
          cleanup.push(error)
        }
      }
      if (unexpected !== undefined || cleanup.length)
        throw new AggregateError(
          [...(unexpected !== undefined ? [unexpected] : []), ...cleanup],
          "Unexpected factory/setup or cleanup failure",
        )
      const after = await readCopy(first)
      return {
        rejected,
        writeCount: writes.length,
        allTamperedPreopenFactsUnchanged: sha(canonical(before)) === sha(canonical(after)),
      }
    })
    expect(
      facts.allTamperedPreopenFactsUnchanged,
      "pre-open copy catalog/marker/raw rows remain exact",
    ).toBe(true)
    expect(facts.writeCount, "incompatible old schema rejected before any DDL/runtime DML").toBe(0)
    // Baseline old factory accepts the marker/live pair; this is the intended behavioral RED.
    expect(
      facts.rejected,
      "known-source structural catalog validation must reject the changed ownership key",
    ).toBe(true)
  }, 30_000)

  async function recoveryFacts(pool: import("pg").Pool) {
    const result: Record<string, unknown[]> = {}
    for (const name of [
      "runtime_recovery_keys",
      "recovery_scopes",
      "recovery_entities",
      "recovery_generations",
      "recovery_branches",
      "recovery_objects",
      "recovery_current",
      "recovery_versions",
      "recovery_cuts",
      "recovery_checkpoints",
      "recovery_fragments",
      "recovery_anchors",
    ])
      result[name] = (await pool.query(`SELECT * FROM ${table(name)} ORDER BY 1,2`)).rows
    return result
  }

  it("seeds truthful unknown legacy descriptors once and normally reopens without changing marker, key or IDs", async () => {
    if (!backend) throw new Error("Gated migration backend not initialized")
    await backend.withCopy(async (first, second) => {
      const owner = await openPostgresRuntimeInstallation({ pool: first, ...naming })
      let initial: Awaited<ReturnType<typeof recoveryFacts>>
      let marker: unknown
      try {
        initial = await recoveryFacts(second)
        marker = (await second.query(`SELECT * FROM ${table("runtime_installation")}`)).rows
        expect(initial.runtime_recovery_keys).toHaveLength(1)
        expect(initial.recovery_scopes).toEqual([
          expect.objectContaining({
            scope_identity_json: JSON.stringify([
              1,
              expected.identity.threadId,
              expected.identity.generation,
            ]),
          }),
        ])
        expect(initial.recovery_generations).toEqual([
          expect.objectContaining({
            baseline_kind: "legacy_unknown",
            legacy_through_seq: String(expected.identity.throughSeq),
            replay_after_seq: String(expected.identity.throughSeq),
            current_cut_seq: null,
            history_epoch: "0",
            accounting_status: "unknown",
            open_bytes: null,
            pending_bytes: null,
            pending_count: null,
            recent_bytes: null,
            recent_count: null,
          }),
        ])
        expect(initial.recovery_branches).toEqual([
          expect.objectContaining({
            born_seq: String(expected.identity.throughSeq),
            root_checkpoint_id: null,
            parent_branch_id: null,
            invalidated_seq: null,
          }),
        ])
        for (const [name, rows] of Object.entries(initial))
          if (
            ![
              "runtime_recovery_keys",
              "recovery_scopes",
              "recovery_generations",
              "recovery_branches",
            ].includes(name)
          )
            expect(rows, name).toEqual([])
      } finally {
        await owner.close()
      }
      const reopened = await openPostgresRuntimeInstallation({ pool: second, ...naming })
      try {
        expect(reopened.installationId).toBe(expected.identity.installationId)
        expect(await recoveryFacts(first)).toEqual(initial)
        expect((await first.query(`SELECT * FROM ${table("runtime_installation")}`)).rows).toEqual(
          marker,
        )
      } finally {
        await reopened.close()
      }
    })
  }, 30_000)

  it.each(["zero", "deleted", "missing-thread"])(
    "migrates legacy %s without inventing a public cut",
    async (kind) => {
      if (!backend) throw new Error("Gated migration backend not initialized")
      await backend.withCopy(async (first) => {
        if (kind === "zero") {
          await first.query(`DELETE FROM ${table("journal")}`)
          await first.query(`UPDATE ${table("scopes")} SET through_seq=0`)
        } else if (kind === "deleted") await first.query(`UPDATE ${table("scopes")} SET deleted=1`)
        else await first.query(`DELETE FROM ${table("threads")}`)
        const owner = await openPostgresRuntimeInstallation({ pool: first, ...naming })
        try {
          expect((await first.query(`SELECT * FROM ${table("recovery_cuts")}`)).rows).toEqual([])
          const rows = (
            await first.query(
              `SELECT baseline_kind,legacy_through_seq,replay_after_seq,current_cut_seq FROM ${table("recovery_generations")}`,
            )
          ).rows
          expect(rows).toEqual(
            kind === "zero"
              ? [
                  {
                    baseline_kind: "legacy_unknown",
                    legacy_through_seq: "0",
                    replay_after_seq: "0",
                    current_cut_seq: null,
                  },
                ]
              : [],
          )
        } finally {
          await owner.close()
        }
      })
    },
    30_000,
  )

  it.each(["negative", "unsafe", "ahead"])(
    "refuses legacy %s watermark before any migration DDL or DML",
    async (kind) => {
      if (!backend) throw new Error("Gated migration backend not initialized")
      await backend.withCopy(async (first, second) => {
        await first.query(`UPDATE ${table("scopes")} SET through_seq=$1`, [
          kind === "negative" ? "-1" : kind === "unsafe" ? "9007199254740992" : "8",
        ])
        const before = await readCopy(first)
        const writes: string[] = []
        await expect(
          openPostgresRuntimeInstallation({ pool: recordingPool(second, writes), ...naming }),
        ).rejects.toThrow(/incompatible|watermark/i)
        expect(writes).toEqual([])
        expect(await readCopy(first)).toEqual(before)
      })
    },
    30_000,
  )

  it.each(["first-ddl", "seeded-before-marker"])(
    "rolls back real PostgreSQL %s failure with exact old facts and no key",
    async (stage) => {
      if (!backend) throw new Error("Gated migration backend not initialized")
      await backend.withCopy(async (first, second) => {
        const before = await readCopy(first)
        let intercepted = false
        const delegated: import("../src/sql.ts").SqlPool = {
          async query<R>(sql: string, values?: readonly unknown[]) {
            return { rows: (await second.query(sql, values ? [...values] : undefined)).rows as R[] }
          },
          async connect() {
            const client = await second.connect()
            return {
              async query<R>(sql: string, values?: readonly unknown[]) {
                if (
                  stage === "seeded-before-marker" &&
                  /^UPDATE .*runtime_installation/i.test(sql)
                ) {
                  const seeded = (
                    await client.query(
                      `SELECT (SELECT count(*) FROM ${table("runtime_recovery_keys")}) AS keys,(SELECT count(*) FROM ${table("recovery_generations")}) AS descriptors`,
                    )
                  ).rows[0]
                  if (seeded.keys !== "1" || seeded.descriptors !== "1")
                    throw new Error("Real seeded SQL interception prerequisite failed")
                  intercepted = true
                  throw new Error("Injected real SQL migration failure")
                }
                const result = await client.query(sql, values ? [...values] : undefined)
                if (stage === "first-ddl" && /^CREATE TABLE .*runtime_recovery_keys/i.test(sql)) {
                  if (
                    !(
                      await client.query("SELECT to_regclass($1) AS relation", [
                        `${naming.schema}.${naming.tablePrefix}_runtime_recovery_keys`,
                      ])
                    ).rows[0].relation
                  )
                    throw new Error("Real additive DDL interception prerequisite failed")
                  intercepted = true
                  throw new Error("Injected real SQL migration failure")
                }
                return { rows: result.rows as R[] }
              },
              release() {
                client.release()
              },
            }
          },
          async end() {},
        }
        await expect(
          openPostgresRuntimeInstallation({ pool: delegated, ...naming }),
        ).rejects.toThrow()
        expect(intercepted, "actual SQL delegation reached the precise rollback stage").toBe(true)
        expect(await readCopy(first)).toEqual(before)
        expect(
          (
            await first.query("SELECT to_regclass($1) AS relation", [
              `${naming.schema}.${naming.tablePrefix}_runtime_recovery_keys`,
            ])
          ).rows[0].relation,
        ).toBeNull()
      })
    },
    30_000,
  )

  it("makes two default10 pools contend on the actual sameDB schema advisory lock and join one migration", async () => {
    if (!backend) throw new Error("Gated migration backend not initialized")
    await backend.withCopy(async (first, second) => {
      expect(first.options.max).toBe(10)
      expect(second.options.max).toBe(10)
      let release!: () => void, held!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const locked = new Promise<void>((resolve) => {
        held = resolve
      })
      let firstPID = 0,
        secondPID = 0,
        lockWasObserved = false
      const wrap = (pool: import("pg").Pool, pause: boolean): import("../src/sql.ts").SqlPool => ({
        async query<R>(sql: string, values?: readonly unknown[]) {
          return { rows: (await pool.query(sql, values ? [...values] : undefined)).rows as R[] }
        },
        async connect() {
          const client = await pool.connect()
          const identity = (
            await client.query("SELECT pg_backend_pid() AS pid,current_database() AS database")
          ).rows[0]
          if (pause) firstPID = identity.pid as number
          else secondPID = identity.pid as number
          return {
            async query<R>(sql: string, values?: readonly unknown[]) {
              const result = await client.query(sql, values ? [...values] : undefined)
              if (pause && sql === "SELECT pg_advisory_xact_lock($1, $2)") {
                held()
                await gate
              }
              return { rows: result.rows as R[] }
            },
            release() {
              client.release()
            },
          }
        },
        async end() {},
      })
      const opening = openPostgresRuntimeInstallation({ pool: wrap(first, true), ...naming })
      void opening.catch(() => {})
      let joining: Promise<PostgresRuntimeInstallation> | undefined
      let failure: unknown
      let failed = false
      try {
        await Promise.race([
          locked,
          opening.then(() => {
            throw new Error("Factory returned before schema lock interception")
          }),
        ])
        joining = openPostgresRuntimeInstallation({ pool: wrap(second, false), ...naming })
        void joining.catch(() => {})
        for (let attempt = 0; attempt < 100 && !lockWasObserved; attempt++) {
          lockWasObserved =
            (
              await first.query<{ blocked: boolean }>(
                `SELECT EXISTS(SELECT 1 FROM pg_locks waiting JOIN pg_locks holder ON holder.locktype=waiting.locktype AND holder.database=waiting.database AND holder.classid=waiting.classid AND holder.objid=waiting.objid AND holder.objsubid=waiting.objsubid WHERE waiting.locktype='advisory' AND NOT waiting.granted AND waiting.pid=$1 AND holder.granted AND holder.pid=$2 AND waiting.database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS blocked`,
                [secondPID, firstPID],
              )
            ).rows[0]?.blocked === true
          if (!lockWasObserved) await new Promise((resolve) => setTimeout(resolve, 10))
        }
      } catch (error) {
        failure = error
        failed = true
      } finally {
        release()
      }
      const joined = await Promise.allSettled([opening, ...(joining ? [joining] : [])])
      const owners = joined.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []))
      const failures: unknown[] = []
      try {
        if (failed) throw failure
        expect(joined).toHaveLength(2)
        expect(joined.every((item) => item.status === "fulfilled")).toBe(true)
        expect(firstPID !== secondPID && firstPID > 0 && secondPID > 0).toBe(true)
        expect(
          lockWasObserved,
          "actual pg_locks sameDB advisory wait, not a timing-only assertion",
        ).toBe(true)
        expect(owners.map((owner) => owner.installationId)).toEqual([
          expected.identity.installationId,
          expected.identity.installationId,
        ])
        expect(
          (await first.query(`SELECT version FROM ${table("runtime_installation")}`)).rows,
        ).toEqual([{ version: 2 }])
        expect(
          (await first.query(`SELECT count(*) AS n FROM ${table("runtime_recovery_keys")}`)).rows[0]
            .n,
        ).toBe("1")
        expect(
          (await first.query(`SELECT count(*) AS n FROM ${table("recovery_generations")}`)).rows[0]
            .n,
        ).toBe("1")
      } catch (error) {
        failures.push(error)
      }
      const closed = await Promise.allSettled(owners.map((owner) => owner.close()))
      for (const result of closed) {
        if (result.status === "rejected") failures.push(result.reason)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Advisory lock migration assertion or owner cleanup failed",
        )
    })
  }, 30_000)

  it("migrates and reopens an empty old-source namespace at the preserved prefix38 maximum", async () => {
    if (!backend) throw new Error("Gated migration backend not initialized")
    await backend.withCopy(async (first) => {
      const n = validateNaming("r9_maxprefix", "p".repeat(38))
      const old = postgresV1Statements(n)
      const id = "90000000-0000-4000-8000-000000000001"
      const client = await first.connect()
      try {
        await client.query("BEGIN")
        await client.query("SET LOCAL search_path=pg_catalog")
        await client.query(`CREATE SCHEMA ${identifier(n.schema)}`)
        for (const sql of old) await client.query(sql)
        const catalog = JSON.stringify(
          (await client.query(legacyCatalogSQL, [n.schema, n.prefix])).rows,
        )
        await client.query(
          `INSERT INTO ${sourceTable(n, "runtime_installation")} VALUES (1,$1,1,$2,$3,$4,$5,$6)`,
          ["b4.agent-protocol.runtime", id, n.schema, n.prefix, JSON.stringify(old), catalog],
        )
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
      const namesSQL =
        "SELECT relname::text AS name FROM pg_class WHERE relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$1)"
      const legacyNames = new Set(
        (await first.query(namesSQL, [n.schema])).rows.map((row) => row.name),
      )
      const legacyCatalogBefore = (await first.query(legacyCatalogSQL, [n.schema, n.prefix])).rows
      let owner: PostgresRuntimeInstallation | undefined
      try {
        owner = await openPostgresRuntimeInstallation({
          pool: first,
          schema: n.schema,
          tablePrefix: n.prefix,
        })
        const key = (
          await first.query(`SELECT key_hex FROM ${sourceTable(n, "runtime_recovery_keys")}`)
        ).rows
        expect(owner.installationId).toBe(id)
        expect(
          (await first.query(`SELECT count(*) AS n FROM ${sourceTable(n, "recovery_cuts")}`))
            .rows[0].n,
        ).toBe("0")
        expect(
          (await first.query(`SELECT count(*) AS n FROM ${sourceTable(n, "recovery_generations")}`))
            .rows[0].n,
        ).toBe("0")
        const names = (await first.query(namesSQL, [n.schema])).rows
        const authoredTables = recoveryTables.map((table) => `${n.prefix}_${table.name}`)
        const authoredIndexes = recoveryTables.flatMap((table) =>
          table.indexes.map((index) => `${n.prefix}_${index.name}`),
        )
        expect(authoredTables).toHaveLength(12)
        expect(authoredIndexes).toHaveLength(10)
        const authoredConstraintIndexes = recoveryTables.flatMap((table) => {
          const tag = recoveryTableTag(table.name)
          return [
            `${n.prefix}_${tag}_p`,
            ...table.unique.map((_, index) => `${n.prefix}_${tag}_u${index}`),
          ]
        })
        const authoredNames = [...authoredTables, ...authoredIndexes, ...authoredConstraintIndexes]
        expect(
          authoredNames.every((name) => name.length <= 63 && name.startsWith(`${n.prefix}_`)),
          "source-authored native names fit without truncation",
        ).toBe(true)
        expect(new Set(authoredNames).size).toBe(authoredNames.length)
        expect(names.map((row) => row.name).sort()).toEqual(
          [...legacyNames, ...authoredNames].sort(),
        )
        expect(new Set(names.map((row) => row.name)).size).toBe(names.length)
        const legacyObjectNames = new Set(legacyCatalogBefore.map((row) => row.name))
        const catalogAfter = (await first.query(legacyCatalogSQL, [n.schema, n.prefix])).rows
        expect(catalogAfter.filter((row) => legacyObjectNames.has(row.name))).toEqual(
          legacyCatalogBefore,
        )
        await owner.close()
        owner = undefined
        owner = await openPostgresRuntimeInstallation({
          pool: first,
          schema: n.schema,
          tablePrefix: n.prefix,
        })
        expect(
          (await first.query(`SELECT key_hex FROM ${sourceTable(n, "runtime_recovery_keys")}`))
            .rows,
        ).toEqual(key)
      } finally {
        await owner?.close()
      }
    })
  }, 30_000)

  it("creates and reopens fresh physical2 atomically with one key and no Thread or H0", async () => {
    if (!backend) throw new Error("Gated migration backend not initialized")
    await backend.withCopy(async (first) => {
      const n = validateNaming("r9_fresh2", "r9_fresh2")
      let owner: PostgresRuntimeInstallation | undefined
      try {
        owner = await openPostgresRuntimeInstallation({
          pool: first,
          schema: n.schema,
          tablePrefix: n.prefix,
        })
        const firstId = owner.installationId
        const key = (
          await first.query(`SELECT key_hex FROM ${sourceTable(n, "runtime_recovery_keys")}`)
        ).rows
        expect(key).toHaveLength(1)
        expect(
          (await first.query(`SELECT version FROM ${sourceTable(n, "runtime_installation")}`)).rows,
        ).toEqual([{ version: 2 }])
        for (const name of ["threads", "recovery_scopes", "recovery_generations", "recovery_cuts"])
          expect(
            (await first.query(`SELECT count(*) AS n FROM ${sourceTable(n, name)}`)).rows[0].n,
            name,
          ).toBe("0")
        await owner.close()
        owner = undefined
        owner = await openPostgresRuntimeInstallation({
          pool: first,
          schema: n.schema,
          tablePrefix: n.prefix,
        })
        expect(owner.installationId).toBe(firstId)
        expect(
          (await first.query(`SELECT key_hex FROM ${sourceTable(n, "runtime_recovery_keys")}`))
            .rows,
        ).toEqual(key)
      } finally {
        await owner?.close()
      }
    })
  }, 30_000)

  it.each([
    "target",
    "wrong-generation",
    "wrong-intent",
    "wrong-fence",
    "active-owner",
    "mapping",
    "rollback",
  ])(
    "temporary cleanup %s preserves other generation and key in the same native transaction",
    async (kind) => {
      if (!backend) throw new Error("Gated migration backend not initialized")
      await backend.withCopy(async (first, second) => {
        const n = validateNaming("r9_cleanup2", "r9_cleanup2")
        const name = (value: string) => sourceTable(n, value)
        let reached = false
        let inject = false
        let deleteAttempts = 0
        const delegated: import("../src/sql.ts").SqlPool = {
          async query<R>(sql: string, values?: readonly unknown[]) {
            return { rows: (await first.query(sql, values ? [...values] : undefined)).rows as R[] }
          },
          async connect() {
            const client = await first.connect()
            return {
              async query<R>(sql: string, values?: readonly unknown[]) {
                if (kind === "mapping" && /^DELETE FROM .*recovery_/i.test(sql)) deleteAttempts++
                if (inject && sql.startsWith(`DELETE FROM ${name("aliases")}`)) {
                  if (
                    (
                      await client.query(
                        `SELECT count(*) AS n FROM ${name("recovery_scopes")} WHERE generation=$1`,
                        [cleanupData.scope.generation],
                      )
                    ).rows[0].n !== "0"
                  )
                    throw new Error("Cleanup interception missed recovery deletes")
                  reached = true
                  throw new Error("Injected native cleanup failure")
                }
                return {
                  rows: (await client.query(sql, values ? [...values] : undefined)).rows as R[],
                }
              },
              release() {
                client.release()
              },
            }
          },
          async end() {},
        }
        let owner: PostgresRuntimeInstallation | undefined
        try {
          owner = await openPostgresRuntimeInstallation({
            pool: delegated,
            schema: n.schema,
            tablePrefix: n.prefix,
          })
          const data = cleanupData
          const store = await bindRuntimeStore(
            owner,
            createRuntimeBinding(owner, data.scope),
            () => data.now,
          )
          const otherGeneration = "90000000-0000-4000-8000-000000000002",
            otherCheckpoint = "90000000-0000-4000-8000-000000000003"
          await store.transaction(async (tx) => {
            await tx.runs.put({ ...data.run, unwoundAt: data.now })
            await tx.checkpoints.put(data.checkpoint)
            await tx.thread.put({
              ...data.thread,
              cleanupIntent: { intentId: "cleanup-exact", onCompletion: "delete" },
            })
          })
          const client = await first.connect()
          try {
            await client.query("BEGIN")
            await client.query(
              `INSERT INTO ${name("scopes")}(thread_id,generation,fence,deleted,lease_expires_at) VALUES ($1,$2,1,1,clock_timestamp())`,
              [data.scope.threadId, otherGeneration],
            )
            await client.query(`INSERT INTO ${name("checkpoint_identities")} VALUES ($1,$2,$3)`, [
              otherCheckpoint,
              data.scope.threadId,
              otherGeneration,
            ])
            for (const [tableName, row] of [
              ...cleanupRecoveryRows(
                data.scope.threadId,
                data.scope.generation,
                "b".repeat(32),
                "90000000-0000-4000-8000-000000000004",
                data.checkpointId,
              ),
              ...cleanupRecoveryRows(
                data.scope.threadId,
                otherGeneration,
                "a".repeat(32),
                "90000000-0000-4000-8000-000000000006",
                otherCheckpoint,
              ),
            ]) {
              const columns = Object.keys(row)
              await client.query(
                `INSERT INTO ${name(tableName)}(${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
                Object.values(row),
              )
            }
            await client.query("COMMIT")
          } catch (error) {
            await client.query("ROLLBACK")
            throw error
          } finally {
            client.release()
          }
          const facts = async () => {
            const result: Record<string, unknown[]> = {}
            for (const tableName of [
              "runtime_recovery_keys",
              ...new Set(
                cleanupRecoveryRows(
                  data.scope.threadId,
                  data.scope.generation,
                  "b".repeat(32),
                  "90000000-0000-4000-8000-000000000004",
                  data.checkpointId,
                ).map(([tableName]) => tableName),
              ),
            ])
              result[tableName] = (
                await second.query(`SELECT * FROM ${name(tableName)} ORDER BY 1,2`)
              ).rows
            return result
          }
          const plan = {
            threadId: data.scope.threadId,
            generation: data.scope.generation,
            runId: data.runId,
            headCheckpointId: data.checkpointId,
            cleanupIntentId: "cleanup-exact",
            provider: {
              kind: "none" as const,
              installationId: owner.installationId,
              threadId: data.scope.threadId,
              generation: data.scope.generation,
            },
          }
          if (kind === "active-owner")
            await first.query(
              `UPDATE ${name("scopes")} SET execution_owner='active' WHERE generation=$1`,
              [data.scope.generation],
            )
          if (kind === "wrong-fence")
            await first.query(`UPDATE ${name("scopes")} SET fence=fence+1 WHERE generation=$1`, [
              data.scope.generation,
            ])
          if (kind === "mapping")
            await first.query(
              `UPDATE ${name("recovery_current")} SET generation=$1 WHERE scope_key=$2`,
              [otherGeneration, "b".repeat(32)],
            )
          if (kind === "target") {
            const native = await first.connect()
            try {
              await native.query("BEGIN")
              for (const [tableName, source] of cleanupRecoveryRows(
                data.scope.threadId,
                data.scope.generation,
                "b".repeat(32),
                "90000000-0000-4000-8000-000000000004",
                data.checkpointId,
              )) {
                if (tableName !== "recovery_cuts" && tableName !== "recovery_versions") continue
                const row =
                  tableName === "recovery_cuts"
                    ? { ...source, through_seq: 1, previous_cut_seq: 0 }
                    : { ...source, version_seq: 1, previous_version_seq: 0 }
                const columns = Object.keys(row)
                await native.query(
                  `INSERT INTO ${name(tableName)}(${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
                  Object.values(row),
                )
              }
              await native.query("COMMIT")
            } catch (error) {
              await native.query("ROLLBACK")
              throw error
            } finally {
              native.release()
            }
            await expect(
              first.query(
                `UPDATE ${name("recovery_versions")} SET previous_version_seq=version_seq WHERE scope_key=$1`,
                ["b".repeat(32)],
              ),
            ).rejects.toMatchObject({ code: "23514" })
            await expect(
              first.query(
                `UPDATE ${name("recovery_cuts")} SET previous_cut_seq=through_seq WHERE scope_key=$1`,
                ["b".repeat(32)],
              ),
            ).rejects.toMatchObject({ code: "23514" })
          }
          const beforeRecovery = await facts()
          const beforeOld = (await second.query(`SELECT * FROM ${name("threads")} ORDER BY 1,2`))
            .rows
          const beforePrivate = (await second.query(`SELECT * FROM ${name("retained_subjects")}`))
            .rows
          inject = kind === "rollback"
          const attempted = {
            ...plan,
            ...(kind === "wrong-generation" ? { generation: otherGeneration } : {}),
            ...(kind === "wrong-intent" ? { cleanupIntentId: "wrong" } : {}),
          }
          if (["wrong-fence", "mapping", "rollback"].includes(kind))
            await expect(store.finalizeTemporary(attempted)).rejects.toThrow()
          else expect(await store.finalizeTemporary(attempted)).toBe(kind === "target")
          inject = false
          if (kind === "target") {
            for (const [tableName, rows] of Object.entries(await facts())) {
              if (tableName === "runtime_recovery_keys")
                expect(rows).toEqual(beforeRecovery[tableName])
              else {
                expect(
                  (rows as Record<string, unknown>[]).some(
                    (row) => row.generation === data.scope.generation,
                  ),
                  tableName,
                ).toBe(false)
                expect(rows, tableName).toEqual(
                  (beforeRecovery[tableName] as Record<string, unknown>[]).filter(
                    (row) => row.generation === otherGeneration,
                  ),
                )
              }
            }
            expect((await second.query(`SELECT * FROM ${name("threads")}`)).rows).toEqual([])
            expect(
              (await second.query(`SELECT count(*) AS n FROM ${name("retained_subjects")}`)).rows[0]
                .n,
            ).toBe("1")
            const installationId = owner.installationId
            await owner.close()
            owner = undefined
            owner = await openPostgresRuntimeInstallation({
              pool: second,
              schema: n.schema,
              tablePrefix: n.prefix,
            })
            expect(owner.installationId).toBe(installationId)
            expect(
              (
                await second.query(
                  `SELECT count(*) AS n FROM ${name("recovery_scopes")} WHERE generation=$1`,
                  [data.scope.generation],
                )
              ).rows[0].n,
            ).toBe("0")
            await expect(
              bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope)),
            ).rejects.toThrow(/stale|fence/i)
          } else {
            expect(await facts()).toEqual(beforeRecovery)
            expect(
              (await second.query(`SELECT * FROM ${name("threads")} ORDER BY 1,2`)).rows,
            ).toEqual(beforeOld)
            expect((await second.query(`SELECT * FROM ${name("retained_subjects")}`)).rows).toEqual(
              beforePrivate,
            )
            if (kind === "rollback")
              expect(reached, "real failure between new and old deletes").toBe(true)
            if (kind === "mapping")
              expect(deleteAttempts, "mapping corruption refuses before recovery deletes").toBe(0)
          }
        } finally {
          inject = false
          await owner?.close()
        }
      })
    },
    30_000,
  )

  it("stores escaped Unicode and long identity TEXT under bounded registry keys and normally reopens", async () => {
    if (!backend) throw new Error("Gated migration backend not initialized")
    await backend.withCopy(async (first, second) => {
      let owner: PostgresRuntimeInstallation | undefined
      try {
        owner = await openPostgresRuntimeInstallation({ pool: first, ...naming })
        const scope = (await first.query(`SELECT scope_key FROM ${table("recovery_scopes")}`))
          .rows[0].scope_key as string
        const components = [
          "\0",
          "\\u0000",
          "\ud800",
          "\udc00",
          "\ud83d\ude00",
          "\ufffd",
          "e\u0301",
          "\u00e9",
          '"\\/',
          "",
          "n".repeat(65_537),
        ]
        const publicId = `message:${components.join("|")}${"m".repeat(65_537)}`
        const rows = (["message", "namespace"] as const).map((kind, index) => {
          const id = kind === "namespace" ? null : publicId
          const identity = encodeRecoveryIdentityTuple([
            1,
            expected.identity.threadId,
            expected.identity.generation,
            components,
            kind,
            id,
          ])
          return {
            key: String(index + 1).repeat(32),
            kind,
            identity,
            hash: sha(identity),
            namespace: asciiJsonV1(components),
            publicId: asciiJsonV1(id),
          }
        })
        for (const row of rows)
          await first.query(
            `INSERT INTO ${table("recovery_entities")} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              expected.identity.threadId,
              expected.identity.generation,
              scope,
              row.key,
              row.kind,
              row.hash,
              row.identity,
              row.namespace,
              row.publicId,
            ],
          )
        const before = (
          await second.query(`SELECT * FROM ${table("recovery_entities")} ORDER BY entity_key`)
        ).rows
        expect(before.map((row) => sha(row.identity_json as string))).toEqual(
          rows.map((row) => row.hash),
        )
        expect(before.map((row) => JSON.parse(row.namespace_json as string))).toEqual(
          rows.map(() => components),
        )
        expect(JSON.parse(before[0].public_id_json as string)).toBe(publicId)
        expect(
          before.every(
            (row) =>
              (row.entity_key as string).length === 32 && (row.scope_key as string).length === 32,
          ),
        ).toBe(true)
        await expect(
          first.query(`UPDATE ${table("recovery_entities")} SET entity_kind='namespaces'`),
        ).rejects.toMatchObject({ code: "23514" })
        await owner.close()
        owner = undefined
        owner = await openPostgresRuntimeInstallation({ pool: second, ...naming })
        expect(
          (await first.query(`SELECT * FROM ${table("recovery_entities")} ORDER BY entity_key`))
            .rows,
        ).toEqual(before)
      } finally {
        await owner?.close()
      }
    })
  }, 30_000)

  it("retains the maximum exact safe int8 watermark as native decimal text without Number conversion", async () => {
    if (!backend) throw new Error("Gated migration backend not initialized")
    await backend.withCopy(async (first) => {
      await first.query(`UPDATE ${table("scopes")} SET through_seq=9007199254740991`)
      const owner = await openPostgresRuntimeInstallation({ pool: first, ...naming })
      try {
        expect(
          (
            await first.query(
              `SELECT legacy_through_seq,replay_after_seq,current_cut_seq FROM ${table("recovery_generations")}`,
            )
          ).rows,
        ).toEqual([
          {
            legacy_through_seq: "9007199254740991",
            replay_after_seq: "9007199254740991",
            current_cut_seq: null,
          },
        ])
      } finally {
        await owner.close()
      }
    })
  }, 30_000)

  it("seeds multiple live legacy scopes with isolated exact identities and floors and reopens without duplicates", async () => {
    if (!backend) throw new Error("Gated migration backend not initialized")
    await backend.withCopy(async (first, second) => {
      const additions = [
        {
          threadId: "81000000-0000-4000-8000-000000000001",
          generation: "81000000-0000-4000-8000-000000000011",
          throughSeq: "0",
        },
        {
          threadId: "81000000-0000-4000-8000-000000000002",
          generation: "81000000-0000-4000-8000-000000000011",
          throughSeq: "4",
        },
        {
          threadId: "81000000-0000-4000-8000-000000000003",
          generation: "81000000-0000-4000-8000-000000000013",
          throughSeq: "9007199254740991",
        },
      ]
      const client = await first.connect()
      try {
        await client.query("BEGIN")
        for (const scope of additions) {
          await client.query(
            `INSERT INTO ${table("scopes")}(thread_id,generation,fence,lease_expires_at,through_seq) VALUES ($1,$2,1,clock_timestamp(),$3)`,
            [scope.threadId, scope.generation, scope.throughSeq],
          )
          const payload = {
            thread: { ...cleanupData.thread.thread, thread_id: scope.threadId },
            generation: scope.generation,
            revision: 1,
            headCheckpointId: null,
            currentRunId: null,
            pausedGeneration: null,
            protectedMetadata: {},
          }
          await client.query(
            `INSERT INTO ${table("threads")}(thread_id,generation,revision,payload) VALUES ($1,$2,1,$3)`,
            [scope.threadId, scope.generation, JSON.stringify(payload)],
          )
        }
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
      const before = await readCopy(first)
      let owner: PostgresRuntimeInstallation | undefined
      try {
        owner = await openPostgresRuntimeInstallation({ pool: first, ...naming })
        const after = await readCopy(second)
        expect(after.records).toEqual(before.records)
        expect(after.journal).toEqual(before.journal)
        const initial = await recoveryFacts(second)
        const registry = initial.recovery_scopes as Record<string, unknown>[]
        const generations = initial.recovery_generations as Record<string, unknown>[]
        const branches = initial.recovery_branches as Record<string, unknown>[]
        const sources = [
          {
            threadId: expected.identity.threadId,
            generation: expected.identity.generation,
            throughSeq: String(expected.identity.throughSeq),
          },
          ...additions,
        ]
        expect(initial.runtime_recovery_keys).toHaveLength(1)
        expect(registry).toHaveLength(sources.length)
        expect(generations).toHaveLength(sources.length)
        expect(branches).toHaveLength(sources.length)
        expect(new Set(registry.map((row) => row.scope_key)).size).toBe(sources.length)
        expect(new Set(branches.map((row) => row.branch_id)).size).toBe(sources.length)
        for (const source of sources) {
          const matches = registry.filter(
            (row) => row.thread_id === source.threadId && row.generation === source.generation,
          )
          expect(matches).toHaveLength(1)
          const scope = matches[0]!
          const identity = encodeRecoveryIdentityTuple([1, source.threadId, source.generation])
          expect(scope.scope_key).toMatch(/^[0-9a-f]{32}$/)
          expect(scope.scope_identity_json).toBe(identity)
          expect(scope.scope_hash).toBe(sha(identity))
          const descriptor = generations.filter((row) => row.scope_key === scope.scope_key)
          expect(descriptor).toEqual([
            expect.objectContaining({
              thread_id: source.threadId,
              generation: source.generation,
              baseline_kind: "legacy_unknown",
              legacy_through_seq: source.throughSeq,
              replay_after_seq: source.throughSeq,
              current_cut_seq: null,
              accounting_status: "unknown",
            }),
          ])
          expect(branches.filter((row) => row.scope_key === scope.scope_key)).toEqual([
            expect.objectContaining({
              thread_id: source.threadId,
              generation: source.generation,
              branch_id: descriptor[0]?.branch_id,
              born_seq: source.throughSeq,
              root_checkpoint_id: null,
            }),
          ])
        }
        for (const [name, rows] of Object.entries(initial))
          if (
            ![
              "runtime_recovery_keys",
              "recovery_scopes",
              "recovery_generations",
              "recovery_branches",
            ].includes(name)
          )
            expect(rows, name).toEqual([])
        await owner.close()
        owner = undefined
        owner = await openPostgresRuntimeInstallation({ pool: second, ...naming })
        expect(await recoveryFacts(first)).toEqual(initial)
        const reopened = await readCopy(first)
        expect(reopened.marker).toEqual(after.marker)
        expect(reopened.records).toEqual(before.records)
        expect(reopened.journal).toEqual(before.journal)
      } finally {
        await owner?.close()
      }
    })
  }, 30_000)
})

// Raw schema-domain/cleanup fixture only. These rows do not qualify a
// canonical cut, reducer, finalizer, or fresh-Thread H0 initialization.
function cleanupRecoveryRows(
  threadId: string,
  generation: string,
  key: string,
  branch: string,
  checkpointId: string,
) {
  const base = { thread_id: threadId, generation, scope_key: key }
  const identity = encodeRecoveryIdentityTuple([1, threadId, generation])
  const checkpointKey = "c".repeat(32),
    messageKey = "d".repeat(32),
    object = "e".repeat(64)
  const fragment = "90000000-0000-4000-8000-000000000005"
  const unknown = {
    open_bytes: null,
    pending_bytes: null,
    pending_count: null,
    recent_bytes: null,
    recent_count: null,
    accounting_status: "unknown",
  }
  const entity = (kind: "message" | "checkpoint", id: string, entityKey: string) => {
    const encoded = encodeRecoveryIdentityTuple([1, threadId, generation, [], kind, id])
    return {
      ...base,
      entity_key: entityKey,
      entity_kind: kind,
      identity_hash: sha(encoded),
      identity_json: encoded,
      namespace_json: "[]",
      public_id_json: asciiJsonV1(id),
    }
  }
  const rows: [string, Record<string, string | number | null>][] = [
    ["recovery_scopes", { ...base, scope_hash: sha(identity), scope_identity_json: identity }],
    [
      "recovery_branches",
      {
        ...base,
        branch_id: branch,
        parent_branch_id: null,
        born_seq: 0,
        invalidated_seq: null,
        root_checkpoint_id: null,
      },
    ],
    [
      "recovery_generations",
      {
        ...base,
        baseline_kind: "legacy_unknown",
        legacy_through_seq: 0,
        replay_after_seq: 0,
        branch_id: branch,
        current_cut_seq: null,
        history_epoch: 0,
        ...unknown,
      },
    ],
    [
      "recovery_objects",
      { ...base, object_id: object, kind: "history_fragment", payload: "{}", payload_bytes: 2 },
    ],
    ["recovery_entities", entity("checkpoint", checkpointId, checkpointKey)],
    ["recovery_entities", entity("message", "cleanup-message", messageKey)],
    [
      "recovery_cuts",
      {
        ...base,
        through_seq: 0,
        public_revision_json: '"raw-cleanup-fixture"',
        branch_id: branch,
        history_epoch: 0,
        previous_cut_seq: null,
        selected_checkpoint_key: null,
        selected_checkpoint_version_seq: null,
        values_object_id: null,
        state_status: "unknown",
        activity_status: "unknown",
        public_fingerprint: "f".repeat(64),
        ...unknown,
      },
    ],
    [
      "recovery_checkpoints",
      {
        ...base,
        checkpoint_key: checkpointKey,
        checkpoint_id: checkpointId,
        version_seq: 0,
        source_seq: 0,
        namespace_json: "[]",
        owner_run_id: null,
        turn_id: null,
        parent_checkpoint_id: null,
        state_status: "unknown",
        values_object_id: null,
        messages_supported: 0,
        authority_alias_id: null,
      },
    ],
    [
      "recovery_versions",
      {
        ...base,
        entity_kind: "message",
        entity_key: messageKey,
        version_seq: 0,
        source_seq: 0,
        namespace_json: "[]",
        owner_run_id: null,
        turn_id: null,
        checkpoint_id: null,
        object_id: object,
        is_open: 0,
        is_deleted: 0,
        authority_alias_id: null,
        previous_version_seq: null,
      },
    ],
    [
      "recovery_current",
      {
        ...base,
        entity_kind: "message",
        entity_key: messageKey,
        version_seq: 0,
        namespace_json: "[]",
        is_open: 0,
        wire_bytes: 2,
      },
    ],
    [
      "recovery_fragments",
      {
        ...base,
        branch_id: branch,
        fragment_id: fragment,
        item_key: messageKey,
        fragment_index: 0,
        source_seq: 0,
        commit_seq: 0,
        namespace_json: "[]",
        owner_run_id: null,
        turn_id: null,
        kind: "message",
        operation: "append",
        object_id: object,
        authority_alias_id: null,
      },
    ],
    [
      "recovery_anchors",
      {
        ...base,
        branch_id: branch,
        fragment_id: fragment,
        link_seq: 0,
        checkpoint_key: checkpointKey,
        checkpoint_version_seq: 0,
        checkpoint_fragment_index: 0,
      },
    ],
  ]
  return rows
}
