import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { InterruptGrantRecord } from "../src/interrupt-grants.js"
import { createPostgresInterruptGrantStore } from "../src/node.js"

const enabled = process.env.B4_TEST_PGSTORAGE === "1"
let container: StartedPostgreSqlContainer
let url: string

/** Fresh, never-migrated table set per store — no truncation, no teardown. */
const freshPrefix = () => `t_${Math.random().toString(36).slice(2)}`

const grant = (over: Partial<InterruptGrantRecord> = {}): InterruptGrantRecord => ({
  threadId: "t-1",
  interruptId: "i-1",
  checkpointNs: "tools:abc",
  tokenHash: "a".repeat(64),
  issuedAt: "2026-09-18T10:00:00.000Z",
  expiresAt: null,
  consumedAt: null,
  consumedDecision: null,
  voidedAt: null,
  ...over,
})

describe.skipIf(!enabled)("postgres interrupt grant store against real Postgres", () => {
  beforeAll(async () => {
    // A loaded CI runner can take minutes to pull postgres:16 and accept the
    // first connection; Testcontainers' 60s default is the honest lever here,
    // not a blanket test retry that would hide a genuine failure.
    container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
    url = container.getConnectionUri()
  }, 240_000)

  afterAll(async () => {
    await container?.stop()
  })

  /** One store per test, on its own never-migrated prefix. */
  const makeStore = () =>
    createPostgresInterruptGrantStore({ connectionString: url, tablePrefix: freshPrefix() })

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
      const record = grant({ expiresAt: "2026-09-19T10:00:00.000Z" })
      await store.issue(record)
      // Equality, not toMatchObject: a column silently defaulted by the
      // database instead of bound by the INSERT would show up right here.
      expect(await store.get("t-1", "i-1")).toEqual(record)
    })
  }, 60_000)

  test("get of an unknown grant is undefined, not a throw", async () => {
    await withStore(async (store) => {
      expect(await store.get("t-nope", "i-nope")).toBeUndefined()
    })
  }, 60_000)

  test("a second issue for the same (thread, interrupt) is rejected", async () => {
    await withStore(async (store) => {
      await store.issue(grant())
      // Rejected, not silently ignored: a second grant for one parked call
      // would leave a client holding a plaintext whose hash is not stored.
      await expect(store.issue(grant({ tokenHash: "b".repeat(64) }))).rejects.toThrow(
        /already exists/,
      )
      expect((await store.get("t-1", "i-1"))?.tokenHash).toBe("a".repeat(64))
    })
  }, 60_000)

  test("consume once returns consumed and records the decision", async () => {
    await withStore(async (store) => {
      await store.issue(grant())
      const result = await store.consume({
        threadId: "t-1",
        interruptId: "i-1",
        decision: "once",
        at: "2026-09-18T11:00:00.000Z",
      })
      expect(result.outcome).toBe("consumed")
      expect(result).toMatchObject({
        record: { consumedAt: "2026-09-18T11:00:00.000Z", consumedDecision: "once" },
      })
      expect(await store.get("t-1", "i-1")).toMatchObject({ consumedDecision: "once" })
    })
  }, 60_000)

  test("a second consume returns already_consumed with the FIRST decision", async () => {
    await withStore(async (store) => {
      await store.issue(grant())
      await store.consume({
        threadId: "t-1",
        interruptId: "i-1",
        decision: "always",
        at: "2026-09-18T11:00:00.000Z",
      })
      const replay = await store.consume({
        threadId: "t-1",
        interruptId: "i-1",
        decision: "deny",
        at: "2026-09-18T12:00:00.000Z",
      })
      expect(replay.outcome).toBe("already_consumed")
      // The replay must not overwrite the answer — this is the whole point:
      // the decision a double-submitting UI renders is the one that ran.
      expect(replay).toMatchObject({
        record: { consumedDecision: "always", consumedAt: "2026-09-18T11:00:00.000Z" },
      })
    })
  }, 60_000)

  test("consume of a voided grant returns voided", async () => {
    await withStore(async (store) => {
      await store.issue(grant())
      await store.voidOutstanding({
        threadId: "t-1",
        keepInterruptIds: [],
        at: "2026-09-18T11:30:00.000Z",
      })
      const result = await store.consume({
        threadId: "t-1",
        interruptId: "i-1",
        decision: "once",
        at: "2026-09-18T12:00:00.000Z",
      })
      expect(result.outcome).toBe("voided")
      expect(result).toMatchObject({
        record: { voidedAt: "2026-09-18T11:30:00.000Z", consumedAt: null },
      })
    })
  }, 60_000)

  test("consume of a missing grant returns missing and carries no record", async () => {
    await withStore(async (store) => {
      const result = await store.consume({
        threadId: "t-ghost",
        interruptId: "i-ghost",
        decision: "once",
        at: "2026-09-18T12:00:00.000Z",
      })
      expect(result).toEqual({ outcome: "missing" })
    })
  }, 60_000)

  test("N concurrent consumes of one grant yield exactly one winner", async () => {
    // The reason this store exists rather than the in-process one: single-use
    // has to be decided by the database, so that it holds across connections,
    // across processes and across a restart. Separate stores means separate
    // pools, so these are genuinely concurrent sessions.
    const prefix = freshPrefix()
    const stores = Array.from({ length: 12 }, () =>
      createPostgresInterruptGrantStore({ connectionString: url, tablePrefix: prefix }),
    )
    try {
      const [first, ...rest] = stores
      if (!first) throw new Error("unreachable")
      await first.issue(grant())
      const results = await Promise.all(
        [first, ...rest].map((store, i) =>
          store.consume({
            threadId: "t-1",
            interruptId: "i-1",
            decision: `d-${i}`,
            at: "2026-09-18T11:00:00.000Z",
          }),
        ),
      )
      const outcomes = results.map((r) => r.outcome)
      expect(outcomes.filter((o) => o === "consumed")).toHaveLength(1)
      expect(outcomes.filter((o) => o === "already_consumed")).toHaveLength(stores.length - 1)

      // Every loser must have been told the WINNER's decision, not its own.
      const winner = results.find((r) => r.outcome === "consumed")
      const winningDecision =
        winner && "record" in winner ? winner.record.consumedDecision : undefined
      for (const loser of results) {
        if (loser.outcome !== "already_consumed") continue
        expect(loser.record.consumedDecision).toBe(winningDecision)
      }
    } finally {
      await Promise.all(stores.map((s) => s.close()))
    }
  }, 120_000)

  test("voidOutstanding voids everything except the keep-list", async () => {
    await withStore(async (store) => {
      await store.issue(grant({ interruptId: "i-keep" }))
      await store.issue(grant({ interruptId: "i-stale-1" }))
      await store.issue(grant({ interruptId: "i-stale-2" }))
      await store.issue(grant({ threadId: "t-other", interruptId: "i-other" }))
      await store.consume({
        threadId: "t-1",
        interruptId: "i-stale-2",
        decision: "once",
        at: "2026-09-18T11:00:00.000Z",
      })

      const voided = await store.voidOutstanding({
        threadId: "t-1",
        keepInterruptIds: ["i-keep"],
        at: "2026-09-18T12:00:00.000Z",
      })
      // Only i-stale-1: i-keep is kept, i-stale-2 is already consumed (a
      // consumption record is evidence and is never overwritten), and
      // i-other belongs to another thread.
      expect(voided).toBe(1)
      expect(await store.get("t-1", "i-stale-1")).toMatchObject({
        voidedAt: "2026-09-18T12:00:00.000Z",
      })
      expect(await store.get("t-1", "i-keep")).toMatchObject({ voidedAt: null })
      expect(await store.get("t-1", "i-stale-2")).toMatchObject({
        voidedAt: null,
        consumedDecision: "once",
      })
      expect(await store.get("t-other", "i-other")).toMatchObject({ voidedAt: null })
    })
  }, 60_000)

  test("an EMPTY keep-list voids everything outstanding for the thread", async () => {
    // `= ANY('{}')` is false for every row, so `NOT (…)` is true: the empty
    // list must mean "nothing is pending any more", not "keep everything".
    // An IN-list would have degenerated to `IN ()` and failed to parse.
    await withStore(async (store) => {
      await store.issue(grant({ interruptId: "i-1" }))
      await store.issue(grant({ interruptId: "i-2" }))
      await store.issue(grant({ threadId: "t-other", interruptId: "i-3" }))

      const voided = await store.voidOutstanding({
        threadId: "t-1",
        keepInterruptIds: [],
        at: "2026-09-18T12:00:00.000Z",
      })
      expect(voided).toBe(2)
      for (const id of ["i-1", "i-2"]) {
        expect(await store.get("t-1", id)).toMatchObject({
          voidedAt: "2026-09-18T12:00:00.000Z",
        })
      }
      expect(await store.get("t-other", "i-3")).toMatchObject({ voidedAt: null })
    })
  }, 60_000)

  test("voidOutstanding is idempotent — a second pass voids nothing", async () => {
    await withStore(async (store) => {
      await store.issue(grant())
      const args = {
        threadId: "t-1",
        keepInterruptIds: [] as readonly string[],
        at: "2026-09-18T12:00:00.000Z",
      }
      expect(await store.voidOutstanding(args)).toBe(1)
      expect(await store.voidOutstanding({ ...args, at: "2026-09-18T13:00:00.000Z" })).toBe(0)
      // The first void's timestamp stands: `voided_at IS NULL` in the WHERE is
      // what keeps the record of WHEN the thread moved on accurate.
      expect(await store.get("t-1", "i-1")).toMatchObject({
        voidedAt: "2026-09-18T12:00:00.000Z",
      })
    })
  }, 60_000)

  test("listForThread returns consumed and voided rows, scoped to the thread", async () => {
    await withStore(async (store) => {
      await store.issue(grant({ interruptId: "i-1", issuedAt: "2026-09-18T10:00:00.000Z" }))
      await store.issue(grant({ interruptId: "i-2", issuedAt: "2026-09-18T10:00:01.000Z" }))
      await store.issue(grant({ interruptId: "i-3", issuedAt: "2026-09-18T10:00:02.000Z" }))
      await store.issue(grant({ threadId: "t-other", interruptId: "i-4" }))
      await store.consume({
        threadId: "t-1",
        interruptId: "i-1",
        decision: "once",
        at: "2026-09-18T11:00:00.000Z",
      })
      await store.voidOutstanding({
        threadId: "t-1",
        keepInterruptIds: ["i-3"],
        at: "2026-09-18T12:00:00.000Z",
      })

      const rows = await store.listForThread("t-1")
      expect(rows.map((r) => r.interruptId)).toEqual(["i-1", "i-2", "i-3"])
      expect(rows[0]).toMatchObject({ consumedDecision: "once", voidedAt: null })
      expect(rows[1]).toMatchObject({ voidedAt: "2026-09-18T12:00:00.000Z" })
      expect(rows[2]).toMatchObject({ consumedAt: null, voidedAt: null })
      expect(await store.listForThread("t-none")).toEqual([])
    })
  }, 60_000)

  test("concurrent cold-start migrations against a virgin database all succeed", async () => {
    // Separate stores means separate pools and separate memoized ready()s, so
    // only the advisory lock inside runMigrations prevents 23505 here.
    const prefix = freshPrefix()
    const stores = Array.from({ length: 8 }, () =>
      createPostgresInterruptGrantStore({ connectionString: url, tablePrefix: prefix }),
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
      const store = createPostgresInterruptGrantStore({ pool, tablePrefix: freshPrefix() })
      await store.issue(grant())
      await store.close()
      const res = await pool.query("SELECT 1 AS ok")
      expect(res.rows[0]).toEqual({ ok: 1 })
    } finally {
      await pool.end()
    }
  }, 60_000)
})
