import { describe, expect, it } from "vitest"
import { createPostgresClientToolCallStore } from "../src/client-tool-calls.js"
import { CLIENT_TOOL_CALLS_MIGRATIONS, type TableNaming } from "../src/schema.js"
import type { SqlClient, SqlPool } from "../src/sql.js"

const NAMING: TableNaming = { schema: "public", prefix: "b4" }

/** Collapse runs of whitespace so the pin is about SQL, not about indentation. */
const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ")

/** A pool that answers nothing and records every statement. */
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
 * Migration 1 is pinned verbatim after whitespace normalization: a shipped
 * migration is FROZEN (a database that recorded `version = 1` never re-runs
 * it). A shape change belongs in a `version: 2` `ALTER TABLE` instead.
 */
describe("CLIENT_TOOL_CALLS_MIGRATIONS", () => {
  it("pins migration 1's SQL exactly", () => {
    const migration = CLIENT_TOOL_CALLS_MIGRATIONS.find((m) => m.version === 1)
    expect(migration).toBeDefined()
    expect(normalize(migration?.up(NAMING) ?? "")).toBe(
      "CREATE TABLE IF NOT EXISTS public.b4_client_tool_calls ( " +
        "thread_id text NOT NULL, " +
        "tool_call_id text NOT NULL, " +
        "interrupt_id text NOT NULL, " +
        "tool_name text NOT NULL, " +
        "run_id text NOT NULL, " +
        "route_id text NOT NULL, " +
        "issued_at text NOT NULL, " +
        "expires_at text, " +
        "answered_at text, " +
        "result text, " +
        "voided_at text, " +
        "PRIMARY KEY (thread_id, tool_call_id) " +
        "); " +
        "CREATE INDEX IF NOT EXISTS b4_client_tool_calls_thread_idx " +
        "ON public.b4_client_tool_calls (thread_id);",
    )
  })

  it("honours the prefix and schema it is given", () => {
    const sql = CLIENT_TOOL_CALLS_MIGRATIONS[0]?.up({ schema: "app", prefix: "t_1" }) ?? ""
    expect(sql).toContain("app.t_1_client_tool_calls")
    expect(sql).toContain("t_1_client_tool_calls_thread_idx")
  })

  it("declares no column DEFAULT anywhere", () => {
    for (const migration of CLIENT_TOOL_CALLS_MIGRATIONS) {
      expect(migration.up(NAMING)).not.toMatch(/\bDEFAULT\b/i)
    }
  })

  it("keeps every version distinct and forward-only", () => {
    const versions = CLIENT_TOOL_CALLS_MIGRATIONS.map((m) => m.version)
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(versions[0]).toBe(1)
  })
})

describe("the statements the store issues", () => {
  it("names all eleven columns in every INSERT", async () => {
    const { pool, sql } = recordingPool()
    const store = createPostgresClientToolCallStore({ pool, assumeMigrated: true })
    await store.issue({
      threadId: "t-1",
      toolCallId: "c-1",
      interruptId: "client-c-1",
      toolName: "pick",
      runId: "r-1",
      routeId: "/pick#agent",
      issuedAt: "2026-09-18T00:00:00.000Z",
      expiresAt: null,
      answeredAt: null,
      result: null,
      voidedAt: null,
    })

    const inserts = sql.filter((text) => /\bINSERT INTO\b/i.test(text))
    expect(inserts).toHaveLength(1)
    for (const insert of inserts) {
      const columns = insert.match(/INSERT INTO\s+\S+\s*\(([^)]*)\)/i)?.[1] ?? ""
      expect(columns.split(",").map((c) => c.trim())).toEqual([
        "thread_id",
        "tool_call_id",
        "interrupt_id",
        "tool_name",
        "run_id",
        "route_id",
        "issued_at",
        "expires_at",
        "answered_at",
        "result",
        "voided_at",
      ])
      expect(insert.match(/\$\d+/g)).toHaveLength(11)
      expect(insert).toMatch(/ON CONFLICT \(thread_id, tool_call_id\) DO NOTHING/)
    }
  })

  it("binds every value — only identifier-checked naming is interpolated", async () => {
    const { pool, sql } = recordingPool()
    const store = createPostgresClientToolCallStore({
      pool,
      assumeMigrated: true,
      tablePrefix: "t_1",
    })
    await store.get("t-1", "c-1")
    await store.listForThread("t-1")
    await store.listOutstanding("t-1")
    await store.answer({ threadId: "t-1", toolCallId: "c-1", result: "r", at: "2026-09-18" })
    await store.voidOutstanding({ threadId: "t-1", toolCallIds: ["c-1"], at: "2026-09-18" })
    expect(sql).not.toHaveLength(0)
    for (const text of sql) {
      expect(text).not.toContain("t-1")
      expect(text).not.toContain("c-1")
      expect(text).toContain("t_1_client_tool_calls")
    }
  })

  it("voids nothing, and runs no SQL, when an empty id list is named", async () => {
    const { pool, sql } = recordingPool()
    const store = createPostgresClientToolCallStore({ pool, assumeMigrated: true })
    expect(await store.voidOutstanding({ threadId: "t-1", toolCallIds: [], at: "x" })).toBe(0)
    expect(sql).toEqual([])
  })

  it("rejects an unsafe schema or table prefix before any connection is made", () => {
    expect(() => createPostgresClientToolCallStore({ schema: "public; DROP TABLE x" })).toThrow(
      /schema/,
    )
    expect(() => createPostgresClientToolCallStore({ tablePrefix: "bad-prefix" })).toThrow(
      /tablePrefix/,
    )
  })

  it("skips the migration pass entirely under assumeMigrated", async () => {
    const { pool, sql } = recordingPool()
    await createPostgresClientToolCallStore({ pool, assumeMigrated: true }).ready()
    expect(sql).toEqual([])
  })

  it("migrates under its own component lock when assumeMigrated is unset", async () => {
    const { pool, sql } = recordingPool()
    await createPostgresClientToolCallStore({ pool }).ready()
    const componentBegin = sql.lastIndexOf("BEGIN")
    expect(componentBegin).toBeGreaterThanOrEqual(0)
    expect(sql[componentBegin + 1]).toContain("pg_advisory_xact_lock")
    expect(sql.some((text) => text.includes("b4_client_tool_calls_migrations"))).toBe(true)
    expect(sql.at(-1)).toBe("COMMIT")
  })
})

describe("createPostgresClientToolCallStore prune", () => {
  it("is one DELETE whose predicate carries the settle-time and expiry rules", async () => {
    const { pool, sql } = recordingPool()
    const store = createPostgresClientToolCallStore({ pool, assumeMigrated: true })
    expect(await store.prune({ before: "2026-09-18T12:00:00.000Z" })).toBe(0)
    const statement = sql.find((text) => /DELETE FROM/i.test(text))
    expect(statement).toBeDefined()
    expect(normalize(statement ?? "")).toBe(
      "DELETE FROM public.b4_client_tool_calls " +
        'WHERE (voided_at IS NOT NULL AND voided_at COLLATE "C" < $1) ' +
        'OR (voided_at IS NULL AND answered_at IS NOT NULL AND answered_at COLLATE "C" < $1) ' +
        'OR (voided_at IS NULL AND answered_at IS NULL AND expires_at IS NOT NULL AND expires_at COLLATE "C" < $1) ' +
        "RETURNING tool_call_id",
    )
  })
})
