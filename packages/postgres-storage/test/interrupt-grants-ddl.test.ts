import { describe, expect, it } from "vitest"
import { createPostgresInterruptGrantStore } from "../src/interrupt-grants.js"
import { INTERRUPT_GRANTS_MIGRATIONS, type TableNaming } from "../src/schema.js"
import type { SqlClient, SqlPool } from "../src/sql.js"

const NAMING: TableNaming = { schema: "public", prefix: "b4" }

/** Collapse runs of whitespace so the pin is about SQL, not about indentation. */
const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ")

/**
 * A pool that answers nothing and records every statement, exactly as
 * `assume-migrated.test.ts` does. The store's statements are fully determined
 * by its inputs, so "which columns does the INSERT name" needs no database.
 */
function recordingPool(): { pool: SqlPool; sql: string[] } {
  const sql: string[] = []
  const record = async <R>(text: string) => {
    sql.push(text)
    return { rows: [] as R[] }
  }
  const client: SqlClient = { query: record, release: () => {} }
  return {
    sql,
    pool: { connect: async () => client, end: async () => {}, query: record },
  }
}

/**
 * Migration 1 is pinned verbatim, character for character after whitespace
 * normalization, because a shipped migration is FROZEN: a database that has
 * already recorded `version = 1` will never re-run this statement, so editing
 * it changes the shape new databases get while leaving old ones behind, and
 * nothing at runtime would notice the divergence. Failing this test is the
 * intended way to find out that a shape change belongs in a `version: 2`
 * `ALTER TABLE` instead.
 */
describe("INTERRUPT_GRANTS_MIGRATIONS", () => {
  it("pins migration 1's SQL exactly", () => {
    const migration = INTERRUPT_GRANTS_MIGRATIONS.find((m) => m.version === 1)
    expect(migration).toBeDefined()
    expect(normalize(migration?.up(NAMING) ?? "")).toBe(
      "CREATE TABLE IF NOT EXISTS public.b4_interrupt_grants ( " +
        "thread_id text NOT NULL, " +
        "interrupt_id text NOT NULL, " +
        "checkpoint_ns text NOT NULL, " +
        "token_hash text NOT NULL, " +
        "issued_at text NOT NULL, " +
        "expires_at text, " +
        "consumed_at text, " +
        "consumed_decision text, " +
        "voided_at text, " +
        "PRIMARY KEY (thread_id, interrupt_id) " +
        "); " +
        "CREATE INDEX IF NOT EXISTS b4_interrupt_grants_thread_idx " +
        "ON public.b4_interrupt_grants (thread_id);",
    )
  })

  it("honours the prefix and schema it is given", () => {
    const sql = INTERRUPT_GRANTS_MIGRATIONS[0]?.up({ schema: "app", prefix: "t_1" }) ?? ""
    expect(sql).toContain("app.t_1_interrupt_grants")
    expect(sql).toContain("t_1_interrupt_grants_thread_idx")
  })

  it("declares no column DEFAULT anywhere", () => {
    // The repo rule (PR #742): a column default is a value the application did
    // not choose, written by the database, invisible in the INSERT that a
    // reader is looking at. Every INSERT here names every column and supplies
    // every value, so a default could only ever mask a wiring bug — and a
    // default added later silently changes the meaning of rows written before
    // it. Asserted across ALL versions, so a future `version: 2` cannot
    // reintroduce one by `ALTER TABLE … SET DEFAULT`.
    for (const migration of INTERRUPT_GRANTS_MIGRATIONS) {
      expect(migration.up(NAMING)).not.toMatch(/\bDEFAULT\b/i)
    }
  })

  it("keeps every version distinct and forward-only", () => {
    const versions = INTERRUPT_GRANTS_MIGRATIONS.map((m) => m.version)
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(versions[0]).toBe(1)
  })
})

describe("the statements the store issues", () => {
  it("names all nine columns in every INSERT", async () => {
    const { pool, sql } = recordingPool()
    const store = createPostgresInterruptGrantStore({ pool, assumeMigrated: true })
    await store.issue({
      threadId: "t-1",
      interruptId: "i-1",
      checkpointNs: "ns",
      tokenHash: "a".repeat(64),
      issuedAt: "2026-09-18T00:00:00.000Z",
      expiresAt: null,
      consumedAt: null,
      consumedDecision: null,
      voidedAt: null,
    })

    const inserts = sql.filter((text) => /\bINSERT INTO\b/i.test(text))
    expect(inserts).toHaveLength(1)
    for (const insert of inserts) {
      const columns = insert.match(/INSERT INTO\s+\S+\s*\(([^)]*)\)/i)?.[1] ?? ""
      expect(columns.split(",").map((c) => c.trim())).toEqual([
        "thread_id",
        "interrupt_id",
        "checkpoint_ns",
        "token_hash",
        "issued_at",
        "expires_at",
        "consumed_at",
        "consumed_decision",
        "voided_at",
      ])
      // Nine named columns, nine bound placeholders, nothing implicit.
      expect(insert.match(/\$\d+/g)).toHaveLength(9)
    }
  })

  it("binds every value — only identifier-checked naming is interpolated", async () => {
    const { pool, sql } = recordingPool()
    const store = createPostgresInterruptGrantStore({
      pool,
      assumeMigrated: true,
      tablePrefix: "t_1",
    })
    await store.get("t-1", "i-1")
    await store.listForThread("t-1")
    await store.voidOutstanding({ threadId: "t-1", keepInterruptIds: ["i-1"], at: "2026-09-18" })
    expect(sql).not.toHaveLength(0)
    for (const text of sql) {
      expect(text).not.toContain("t-1")
      expect(text).not.toContain("i-1")
      expect(text).toContain("t_1_interrupt_grants")
    }
  })

  it("rejects an unsafe schema or table prefix before any connection is made", () => {
    expect(() => createPostgresInterruptGrantStore({ schema: "public; DROP TABLE x" })).toThrow(
      /schema/,
    )
    expect(() => createPostgresInterruptGrantStore({ tablePrefix: "bad-prefix" })).toThrow(
      /tablePrefix/,
    )
  })

  it("skips the migration pass entirely under assumeMigrated", async () => {
    const { pool, sql } = recordingPool()
    await createPostgresInterruptGrantStore({ pool, assumeMigrated: true }).ready()
    expect(sql).toEqual([])
  })

  it("migrates under its own component lock when assumeMigrated is unset", async () => {
    const { pool, sql } = recordingPool()
    await createPostgresInterruptGrantStore({ pool }).ready()
    const componentBegin = sql.lastIndexOf("BEGIN")
    expect(componentBegin).toBeGreaterThanOrEqual(0)
    expect(sql[componentBegin + 1]).toContain("pg_advisory_xact_lock")
    // Its own component, so it versions independently of threads/permissions.
    expect(sql.some((text) => text.includes("b4_interrupt_grants_migrations"))).toBe(true)
    expect(sql.at(-1)).toBe("COMMIT")
  })
})
