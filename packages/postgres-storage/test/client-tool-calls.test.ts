import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { ClientToolCallRecord } from "../src/client-tool-calls.js"
import { createPostgresClientToolCallStore } from "../src/node.js"
import { CLIENT_TOOL_CALLS_MIGRATIONS, runMigrations } from "../src/schema.js"

const enabled = process.env.B4_TEST_PGSTORAGE === "1"
let container: StartedPostgreSqlContainer
let url: string

/** Fresh, never-migrated table set per store — no truncation, no teardown. */
const freshPrefix = () => `t_${Math.random().toString(36).slice(2)}`

const call = (over: Partial<ClientToolCallRecord> = {}): ClientToolCallRecord => ({
  threadId: "t-1",
  toolCallId: "c-1",
  interruptId: "client-c-1",
  toolName: "pick_color",
  runId: "run-1",
  routeId: "/park#agent",
  issuedAt: "2026-09-18T10:00:00.000Z",
  expiresAt: null,
  answeredAt: null,
  result: null,
  voidedAt: null,
  kind: "client",
  settledAt: null,
  parentToolCallId: null,
  ...over,
})

const AT = "2026-09-18T11:00:00.000Z"

describe.skipIf(!enabled)("postgres client tool call store against real Postgres", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
    url = container.getConnectionUri()
  }, 240_000)

  afterAll(async () => {
    await container?.stop()
  })

  const makeStore = () =>
    createPostgresClientToolCallStore({ connectionString: url, tablePrefix: freshPrefix() })

  const withStore = async (fn: (store: ReturnType<typeof makeStore>) => Promise<void>) => {
    const store = makeStore()
    try {
      await fn(store)
    } finally {
      await store.close()
    }
  }

  test("issue then get round-trips every column, nulls included", async () => {
    await withStore(async (store) => {
      const record = call({ expiresAt: "2026-09-19T10:00:00.000Z" })
      await store.issue(record)
      expect(await store.get("t-1", "c-1")).toEqual(record)
      expect(await store.get("t-nope", "c-1")).toBeUndefined()
    })
  }, 60_000)

  test("a replayed issue is a no-op that leaves the existing row untouched", async () => {
    await withStore(async (store) => {
      await store.issue(call())
      await store.issue(call({ runId: "run-2", toolName: "other" }))
      expect(await store.get("t-1", "c-1")).toEqual(call())
    })
  }, 60_000)

  test("answer succeeds once, then reports already_answered with the first result", async () => {
    await withStore(async (store) => {
      await store.issue(call())
      const first = await store.answer({
        threadId: "t-1",
        toolCallId: "c-1",
        result: "red",
        at: AT,
      })
      expect(first).toEqual({
        outcome: "answered",
        record: call({ answeredAt: AT, result: "red" }),
      })
      const second = await store.answer({
        threadId: "t-1",
        toolCallId: "c-1",
        result: "blue",
        at: "2026-09-18T12:00:00.000Z",
      })
      expect(second).toEqual({
        outcome: "already_answered",
        record: call({ answeredAt: AT, result: "red" }),
      })
    })
  }, 60_000)

  test("answer is missing for an unknown call or another thread's call", async () => {
    await withStore(async (store) => {
      await store.issue(call())
      expect(
        await store.answer({ threadId: "t-1", toolCallId: "nope", result: "x", at: AT }),
      ).toEqual({ outcome: "missing" })
      expect(
        await store.answer({ threadId: "t-2", toolCallId: "c-1", result: "x", at: AT }),
      ).toEqual({ outcome: "missing" })
      expect((await store.get("t-1", "c-1"))?.answeredAt).toBeNull()
    })
  }, 60_000)

  test("answering a voided call reports voided and records nothing", async () => {
    await withStore(async (store) => {
      await store.issue(call())
      expect(await store.voidOutstanding({ threadId: "t-1", at: AT })).toBe(1)
      const res = await store.answer({ threadId: "t-1", toolCallId: "c-1", result: "x", at: AT })
      expect(res).toEqual({ outcome: "voided", record: call({ voidedAt: AT }) })
    })
  }, 60_000)

  test("selective void touches only named outstanding ids; listOutstanding follows", async () => {
    await withStore(async (store) => {
      await store.issue(call({ toolCallId: "c-1", issuedAt: "2026-09-18T10:00:00.000Z" }))
      await store.issue(call({ toolCallId: "c-2", issuedAt: "2026-09-18T10:00:01.000Z" }))
      await store.issue(call({ toolCallId: "c-3", issuedAt: "2026-09-18T10:00:02.000Z" }))
      expect(
        await store.voidOutstanding({ threadId: "t-1", toolCallIds: ["c-2", "c-unknown"], at: AT }),
      ).toBe(1)
      expect((await store.listOutstanding("t-1")).map((r) => r.toolCallId)).toEqual(["c-1", "c-3"])
    })
  }, 60_000)

  test("an empty id list voids nothing", async () => {
    await withStore(async (store) => {
      await store.issue(call())
      expect(await store.voidOutstanding({ threadId: "t-1", toolCallIds: [], at: AT })).toBe(0)
      expect((await store.get("t-1", "c-1"))?.voidedAt).toBeNull()
    })
  }, 60_000)

  test("void-all skips answered rows and a second void counts 0", async () => {
    await withStore(async (store) => {
      await store.issue(call({ toolCallId: "c-1" }))
      await store.issue(call({ toolCallId: "c-2", issuedAt: "2026-09-18T10:00:01.000Z" }))
      await store.answer({ threadId: "t-1", toolCallId: "c-1", result: "done", at: AT })
      expect(await store.voidOutstanding({ threadId: "t-1", at: AT })).toBe(1)
      expect((await store.get("t-1", "c-1"))?.voidedAt).toBeNull()
      expect((await store.get("t-1", "c-2"))?.voidedAt).toBe(AT)
      expect(await store.voidOutstanding({ threadId: "t-1", at: AT })).toBe(0)
    })
  }, 60_000)

  test("listForThread includes answered and voided rows with results, in issue order", async () => {
    await withStore(async (store) => {
      await store.issue(call({ toolCallId: "c-b", issuedAt: "2026-09-18T10:00:01.000Z" }))
      await store.issue(call({ toolCallId: "c-a", issuedAt: "2026-09-18T10:00:00.000Z" }))
      await store.issue(call({ toolCallId: "c-c", issuedAt: "2026-09-18T10:00:02.000Z" }))
      await store.answer({ threadId: "t-1", toolCallId: "c-a", result: "yes", at: AT })
      await store.voidOutstanding({ threadId: "t-1", toolCallIds: ["c-b"], at: AT })
      const rows = await store.listForThread("t-1")
      expect(rows.map((r) => r.toolCallId)).toEqual(["c-a", "c-b", "c-c"])
      expect(rows[0]).toMatchObject({ answeredAt: AT, result: "yes" })
      expect(rows[1]).toMatchObject({ voidedAt: AT, result: null })
      expect(await store.listForThread("t-none")).toEqual([])
    })
  }, 60_000)

  const parts = [
    { type: "text", text: "panel opened" },
    { type: "image", source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" } },
  ] as const

  test("a parts answer round-trips through get and listForThread (spec §3.2 envelope)", async () => {
    await withStore(async (store) => {
      await store.issue(call())
      const answered = await store.answer({
        threadId: "t-1",
        toolCallId: "c-1",
        result: parts,
        at: AT,
      })
      expect(answered.outcome === "answered" && answered.record.result).toEqual(parts)
      expect(await store.get("t-1", "c-1")).toMatchObject({ answeredAt: AT, result: parts })
      expect((await store.listForThread("t-1"))[0]?.result).toEqual(parts)
    })
  }, 60_000)

  test("an issued record carrying parts round-trips", async () => {
    await withStore(async (store) => {
      const record = call({ answeredAt: AT, result: parts })
      await store.issue(record)
      expect(await store.get("t-1", "c-1")).toEqual(record)
    })
  }, 60_000)

  test("a text answer still reads back as text", async () => {
    await withStore(async (store) => {
      await store.issue(call())
      await store.answer({ threadId: "t-1", toolCallId: "c-1", result: "red", at: AT })
      expect((await store.get("t-1", "c-1"))?.result).toBe("red")
    })
  }, 60_000)

  test("text that looks like the envelope but is not a valid part list reads back as that text", async () => {
    await withStore(async (store) => {
      const lookalikes = [
        '{"$b4":"content-parts","parts":[{"type":"image"}]}',
        '{"$b4":"content-parts","parts":"nope"}',
        '{"$b4":"other","parts":[]}',
        '{"$b4": not json',
      ]
      for (const [i, text] of lookalikes.entries()) {
        await store.issue(call({ toolCallId: `look-${i}` }))
        await store.answer({ threadId: "t-1", toolCallId: `look-${i}`, result: text, at: AT })
        expect((await store.get("t-1", `look-${i}`))?.result).toBe(text)
      }
    })
  }, 60_000)

  test("the same tool call id on another thread is unaffected", async () => {
    await withStore(async (store) => {
      await store.issue(call({ threadId: "t-1" }))
      await store.issue(call({ threadId: "t-2" }))
      await store.answer({ threadId: "t-1", toolCallId: "c-1", result: "x", at: AT })
      await store.voidOutstanding({ threadId: "t-1", at: AT })
      expect(await store.get("t-2", "c-1")).toEqual(call({ threadId: "t-2" }))
      expect((await store.listOutstanding("t-2")).length).toBe(1)
    })
  }, 60_000)

  test("12 concurrent answers of one call yield exactly one winner", async () => {
    // Separate stores are separate pools, so these are genuinely concurrent
    // sessions racing one conditional UPDATE.
    const prefix = freshPrefix()
    const stores = Array.from({ length: 12 }, () =>
      createPostgresClientToolCallStore({ connectionString: url, tablePrefix: prefix }),
    )
    try {
      await stores[0]?.issue(call())
      await Promise.all(stores.map((s) => s.ready()))
      const results = await Promise.all(
        stores.map((s, i) =>
          s.answer({ threadId: "t-1", toolCallId: "c-1", result: `result-${i}`, at: AT }),
        ),
      )
      const winners = results.flatMap((r, i) => (r.outcome === "answered" ? [i] : []))
      expect(winners).toHaveLength(1)
      expect(results.filter((r) => r.outcome === "already_answered")).toHaveLength(11)
      expect((await stores[0]?.get("t-1", "c-1"))?.result).toBe(`result-${winners[0]}`)
    } finally {
      await Promise.all(stores.map((s) => s.close()))
    }
  }, 120_000)

  test("answer raced against void across two pools never leaves both set", async () => {
    const prefix = freshPrefix()
    const storeA = createPostgresClientToolCallStore({ connectionString: url, tablePrefix: prefix })
    const storeB = createPostgresClientToolCallStore({ connectionString: url, tablePrefix: prefix })
    try {
      await storeA.ready()
      await storeB.ready()
      for (let i = 0; i < 5; i++) {
        const toolCallId = `race-${i}`
        await storeA.issue(call({ toolCallId, interruptId: `client-${toolCallId}` }))
        const [answer, voided] = await Promise.all([
          storeA.answer({ threadId: "t-1", toolCallId, result: "r", at: AT }),
          storeB.voidOutstanding({ threadId: "t-1", toolCallIds: [toolCallId], at: AT }),
        ])
        const row = await storeA.get("t-1", toolCallId)
        expect(row).toBeDefined()
        expect(row?.answeredAt !== null && row?.voidedAt !== null).toBe(false)
        if (answer.outcome === "answered") {
          expect(row?.answeredAt).toBe(AT)
          expect(row?.voidedAt).toBeNull()
          expect(voided).toBe(0)
        } else {
          expect(answer.outcome).toBe("voided")
          expect(row?.voidedAt).toBe(AT)
          expect(row?.answeredAt).toBeNull()
          expect(voided).toBe(1)
        }
      }
    } finally {
      await Promise.all([storeA.close(), storeB.close()])
    }
  }, 120_000)

  test("concurrent cold-start migrations against a virgin database all succeed", async () => {
    const prefix = freshPrefix()
    const stores = Array.from({ length: 8 }, () =>
      createPostgresClientToolCallStore({ connectionString: url, tablePrefix: prefix }),
    )
    try {
      const results = await Promise.allSettled(stores.map((s) => s.ready()))
      expect(results.filter((r) => r.status === "rejected")).toEqual([])
    } finally {
      await Promise.all(stores.map((s) => s.close()))
    }
  }, 120_000)

  test("an injected pool is shared, not owned: close() leaves it usable", async () => {
    const { createPostgresPool } = await import("../src/node.js")
    const pool = createPostgresPool({ connectionString: url })
    try {
      const store = createPostgresClientToolCallStore({ pool, tablePrefix: freshPrefix() })
      await store.issue(call())
      await store.close()
      const res = await pool.query("SELECT 1 AS ok")
      expect(res.rows[0]).toEqual({ ok: 1 })
    } finally {
      await pool.end()
    }
  }, 60_000)

  test("settles a server row once; prune deletes settled server rows older than before and keeps open ones", async () => {
    await withStore(async (store) => {
      const server = (id: string, settledAt: string | null) =>
        call({ toolCallId: id, kind: "server", interruptId: "", toolName: "readFile", settledAt })
      await store.issue(server("s-open", null))
      await store.issue(server("s-old", "2026-09-01T00:00:00.000Z"))
      await store.issue(server("s-new", "2026-09-20T00:00:00.000Z"))
      await store.issue(call({ toolCallId: "c-old", voidedAt: "2026-09-01T00:00:00.000Z" }))
      await store.issue(
        call({ toolCallId: "c-answered", answeredAt: "2026-09-02T00:00:00.000Z", result: "red" }),
      )
      await store.issue(call({ toolCallId: "c-boundary", voidedAt: "2026-09-10T00:00:00.000Z" }))
      await store.issue(call({ toolCallId: "c-open", issuedAt: "2020-01-01T00:00:00.000Z" }))
      await store.issue({ ...server("s-stale", null), issuedAt: "2020-01-01T00:00:00.000Z" })
      await store.issue(
        call({ threadId: "t-2", toolCallId: "other", voidedAt: "2020-01-01T00:00:00.000Z" }),
      )
      expect(await store.settle({ threadId: "t-1", toolCallId: "s-open", at: AT })).toBe("settled")
      expect(await store.settle({ threadId: "t-1", toolCallId: "s-open", at: AT })).toBe(
        "already_settled",
      )
      expect(await store.settle({ threadId: "t-1", toolCallId: "c-open", at: AT })).toBe("missing")
      expect((await store.listOutstanding("t-1")).map((r) => r.toolCallId)).toEqual(["c-open"])
      expect(
        (await store.answer({ threadId: "t-1", toolCallId: "s-open", result: "x", at: AT }))
          .outcome,
      ).toBe("missing")
      // Global: the other thread's voided row goes too.
      expect(await store.prune({ before: "2026-09-10T00:00:00.000Z" })).toBe(4)
      expect((await store.listForThread("t-1")).map((r) => r.toolCallId).sort()).toEqual([
        "c-boundary",
        "c-open",
        "s-new",
        "s-open",
        "s-stale",
      ])
      expect(await store.listForThread("t-2")).toEqual([])
      await expect(
        store.issue(call({ toolCallId: "bad", kind: "other" as never })),
      ).rejects.toThrow()
    })
  }, 60_000)

  test("migration 2 backfills version-1 rows as client", async () => {
    const prefix = freshPrefix()
    const { Pool } = await import("pg")
    const pool = new Pool({ connectionString: url })
    try {
      // Seed version 1 as a real deployment would: recorded in the migrations table.
      const v1 = CLIENT_TOOL_CALLS_MIGRATIONS.find((m) => m.version === 1)
      if (!v1) throw new Error("migration 1 missing")
      await runMigrations(pool, [v1], {
        schema: "public",
        prefix,
        component: "client_tool_calls",
      })
      await pool.query(
        `INSERT INTO public.${prefix}_client_tool_calls (thread_id, tool_call_id, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at)
         VALUES ('t-1', 'legacy', 'client-legacy', 'pick', 'r0', '/park#agent', '2026-09-18T00:00:00.000Z', NULL, NULL, NULL, NULL)`,
      )
    } finally {
      await pool.end()
    }
    const store = createPostgresClientToolCallStore({ connectionString: url, tablePrefix: prefix })
    try {
      // The store's own migration pass: version 1 is already recorded, so only version 2 runs.
      const row = await store.get("t-1", "legacy")
      expect(row?.kind).toBe("client")
      expect(row?.settledAt).toBeNull()
      expect((await store.listOutstanding("t-1")).map((r) => r.toolCallId)).toEqual(["legacy"])
    } finally {
      await store.close()
    }
  }, 60_000)

  test("prune deletes settled and expired rows before the cutoff and keeps the rest, across threads", async () => {
    await withStore(async (store) => {
      const BEFORE = "2026-09-18T12:00:00.000Z"
      await store.issue(
        call({ toolCallId: "old_answered", answeredAt: "2026-09-18T10:30:00.000Z", result: "ok" }),
      )
      await store.issue(call({ toolCallId: "new_answered", answeredAt: BEFORE, result: "ok" }))
      await store.issue(call({ toolCallId: "old_voided", voidedAt: "2026-09-18T10:30:00.000Z" }))
      await store.issue(
        call({
          toolCallId: "answered_then_voided",
          answeredAt: "2026-09-18T10:30:00.000Z",
          result: "ok",
          voidedAt: "2026-09-18T13:00:00.000Z",
        }),
      )
      await store.issue(call({ toolCallId: "expired_old", expiresAt: "2026-09-18T10:10:00.000Z" }))
      await store.issue(call({ toolCallId: "expires_at_cutoff", expiresAt: BEFORE }))
      await store.issue(call({ toolCallId: "never_expires", expiresAt: null }))
      await store.issue(
        call({ threadId: "t-2", toolCallId: "other_thread", voidedAt: "2026-09-18T10:30:00.000Z" }),
      )

      expect(await store.prune({ before: BEFORE })).toBe(4)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect((await store.listForThread("t-1")).map((row) => row.toolCallId).sort()).toEqual([
        "answered_then_voided",
        "expires_at_cutoff",
        "never_expires",
        "new_answered",
      ])
      expect(await store.listForThread("t-2")).toEqual([])
    })
  }, 60_000)

  test("round-trips the parent task link; a root row reads null", async () => {
    await withStore(async (store) => {
      await store.issue(
        call({
          toolCallId: "child",
          kind: "server",
          interruptId: "",
          parentToolCallId: "call_task_1",
        }),
      )
      expect((await store.get("t-1", "child"))?.parentToolCallId).toBe("call_task_1")
      await store.issue(call({ toolCallId: "root", kind: "server", interruptId: "" }))
      expect((await store.get("t-1", "root"))?.parentToolCallId).toBeNull()
    })
  }, 60_000)
})
