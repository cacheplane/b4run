import { describe, expect, it } from "vitest"
import { createMemoryInterruptGrantStore, type InterruptGrantRecord } from "../src/index.js"

function grant(over: Partial<InterruptGrantRecord> = {}): InterruptGrantRecord {
  return {
    threadId: "t1",
    interruptId: "i1",
    checkpointNs: "",
    tokenHash: "0".repeat(64),
    issuedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: null,
    consumedAt: null,
    consumedDecision: null,
    consumedBy: null,
    voidedAt: null,
    ...over,
  }
}

describe("createMemoryInterruptGrantStore", () => {
  it("refuses a duplicate issue for the same (threadId, interruptId)", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(grant())
    await expect(store.issue(grant())).rejects.toThrow(
      "interrupt-grants: a grant already exists for (t1, i1)",
    )
  })

  it("consumes once, then reports already_consumed", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(grant())
    const args = {
      threadId: "t1",
      interruptId: "i1",
      decision: "once",
      at: "2026-09-30T00:01:00.000Z",
    }
    expect((await store.consume(args)).outcome).toBe("consumed")
    expect((await store.consume(args)).outcome).toBe("already_consumed")
  })

  it("records who answered as consumedBy, and null for an anonymous answer", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(grant())
    await store.issue(grant({ interruptId: "i2" }))
    const at = "2026-09-30T00:01:00.000Z"
    const byAda = await store.consume({
      threadId: "t1",
      interruptId: "i1",
      decision: "once",
      at,
      by: "ada",
    })
    expect(byAda.outcome === "consumed" && byAda.record.consumedBy).toBe("ada")
    const anonymous = await store.consume({
      threadId: "t1",
      interruptId: "i2",
      decision: "deny",
      at,
    })
    expect(anonymous.outcome === "consumed" && anonymous.record.consumedBy).toBeNull()
    // A replay never rewrites who answered.
    const replay = await store.consume({
      threadId: "t1",
      interruptId: "i1",
      decision: "deny",
      at,
      by: "bob",
    })
    expect(replay.outcome === "already_consumed" && replay.record.consumedBy).toBe("ada")
  })

  it("returns copies, so a caller cannot mutate the stored row", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(grant())
    const row = (await store.get("t1", "i1")) as { consumedAt: string | null }
    row.consumedAt = "tampered"
    expect((await store.get("t1", "i1"))?.consumedAt).toBeNull()
  })

  it("voids the thread's grants outside keepInterruptIds, consumed ones included", async () => {
    const store = createMemoryInterruptGrantStore()
    const at = "2026-09-30T00:02:00.000Z"
    await store.issue(grant({ interruptId: "keep" }))
    await store.issue(grant({ interruptId: "stale" }))
    await store.issue(grant({ interruptId: "done", consumedAt: at, consumedDecision: "once" }))
    await store.issue(grant({ threadId: "t2", interruptId: "other" }))
    expect(
      await store.voidOutstanding({
        threadId: "t1",
        keepInterruptIds: ["keep"],
        at,
      }),
    ).toBe(2)
    expect((await store.get("t1", "stale"))?.voidedAt).toBe(at)
    // The consumed row is voided too — its resumed turn completed — and keeps
    // its consumption record.
    expect(await store.get("t1", "done")).toMatchObject({
      voidedAt: at,
      consumedAt: at,
      consumedDecision: "once",
      consumedBy: null,
    })
    expect((await store.get("t1", "keep"))?.voidedAt).toBeNull()
    expect((await store.get("t2", "other"))?.voidedAt).toBeNull()
    expect((await store.listForThread("t1")).map((row) => row.interruptId).sort()).toEqual([
      "done",
      "keep",
      "stale",
    ])
  })

  it("voidOutstanding is idempotent: an already-voided row keeps its timestamp and is not counted", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(grant({ interruptId: "a" }))
    await store.issue(grant({ interruptId: "b", consumedAt: "2026-09-30T00:01:00.000Z" }))
    const first = "2026-09-30T00:02:00.000Z"
    const second = "2026-09-30T00:03:00.000Z"
    expect(
      await store.voidOutstanding({
        threadId: "t1",
        keepInterruptIds: [],
        at: first,
      }),
    ).toBe(2)
    expect(
      await store.voidOutstanding({
        threadId: "t1",
        keepInterruptIds: [],
        at: second,
      }),
    ).toBe(0)
    expect((await store.get("t1", "a"))?.voidedAt).toBe(first)
    expect((await store.get("t1", "b"))?.voidedAt).toBe(first)
  })

  // The store used to key a flat Map on `${threadId}\0${interruptId}`, so a
  // separator inside either id let two distinct pairs share one row.
  it.each([" ", "\0"])("never lets distinct pairs joined by %j collide", async (sep) => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(grant({ threadId: "a", interruptId: `b${sep}c` }))
    expect(await store.get(`a${sep}b`, "c")).toBeUndefined()
    const consumed = await store.consume({
      threadId: `a${sep}b`,
      interruptId: "c",
      decision: "once",
      at: "2026-09-30T00:01:00.000Z",
    })
    expect(consumed.outcome).toBe("missing")
    expect((await store.get("a", `b${sep}c`))?.consumedAt).toBeNull()
    await expect(
      store.issue(grant({ threadId: `a${sep}b`, interruptId: "c" })),
    ).resolves.toBeUndefined()
  })

  describe("prune", () => {
    const BEFORE = "2026-09-30T12:00:00.000Z"
    const OLD = "2026-09-30T01:00:00.000Z"
    const RECENT = "2026-09-30T13:00:00.000Z"

    it("deletes voided rows before the cutoff; keeps a recent void and one exactly at the cutoff", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(grant({ interruptId: "old_voided", voidedAt: OLD }))
      await store.issue(grant({ interruptId: "new_voided", voidedAt: RECENT }))
      await store.issue(grant({ interruptId: "at_cutoff", voidedAt: BEFORE }))
      expect(await store.prune({ before: BEFORE })).toBe(1)
      expect((await store.listForThread("t1")).map((row) => row.interruptId).sort()).toEqual([
        "at_cutoff",
        "new_voided",
      ])
    })

    it("a consumed grant whose prompt is still parked is never pruned", async () => {
      // A resume consumes the row BEFORE the resumed run executes. If that run
      // fails the prompt stays parked with a consumed, unvoided row; deleting
      // it would let the prompt resume ungated under approvals.grants "optional".
      const store = createMemoryInterruptGrantStore()
      await store.issue(
        grant({
          interruptId: "stuck",
          consumedAt: OLD,
          consumedDecision: "once",
          consumedBy: null,
          voidedAt: null,
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.get("t1", "stuck")).toMatchObject({
        consumedAt: OLD,
        voidedAt: null,
      })
    })

    it("deletes a consumed grant once it has been voided before the cutoff", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(
        grant({
          interruptId: "consumed_then_voided",
          consumedAt: OLD,
          consumedDecision: "once",
          consumedBy: null,
          voidedAt: OLD,
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(1)
      expect(await store.get("t1", "consumed_then_voided")).toBeUndefined()
    })

    it("never deletes an outstanding row, expired or not", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(
        grant({
          interruptId: "expired_long_ago",
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
      )
      await store.issue(grant({ interruptId: "never_expires", expiresAt: null }))
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect((await store.listForThread("t1")).map((row) => row.interruptId).sort()).toEqual([
        "expired_long_ago",
        "never_expires",
      ])
    })

    it("sweeps every thread and is idempotent", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(grant({ threadId: "t1", interruptId: "a", voidedAt: OLD }))
      await store.issue(grant({ threadId: "t2", interruptId: "b", voidedAt: OLD }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.listForThread("t1")).toEqual([])
      expect(await store.listForThread("t2")).toEqual([])
    })
  })
})
