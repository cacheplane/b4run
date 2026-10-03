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

  it("returns copies, so a caller cannot mutate the stored row", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(grant())
    const row = (await store.get("t1", "i1")) as { consumedAt: string | null }
    row.consumedAt = "tampered"
    expect((await store.get("t1", "i1"))?.consumedAt).toBeNull()
  })

  it("voids only the thread's outstanding grants outside keepInterruptIds", async () => {
    const store = createMemoryInterruptGrantStore()
    const at = "2026-09-30T00:02:00.000Z"
    await store.issue(grant({ interruptId: "keep" }))
    await store.issue(grant({ interruptId: "stale" }))
    await store.issue(grant({ interruptId: "done", consumedAt: at, consumedDecision: "once" }))
    await store.issue(grant({ threadId: "t2", interruptId: "other" }))
    expect(await store.voidOutstanding({ threadId: "t1", keepInterruptIds: ["keep"], at })).toBe(1)
    expect((await store.get("t1", "stale"))?.voidedAt).toBe(at)
    expect((await store.get("t1", "keep"))?.voidedAt).toBeNull()
    expect((await store.get("t2", "other"))?.voidedAt).toBeNull()
    expect((await store.listForThread("t1")).map((row) => row.interruptId).sort()).toEqual([
      "done",
      "keep",
      "stale",
    ])
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

    it("deletes consumed and voided rows settled before the cutoff and keeps later ones", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(
        grant({
          interruptId: "old_consumed",
          consumedAt: "2026-09-30T01:00:00.000Z",
          consumedDecision: "once",
        }),
      )
      await store.issue(
        grant({ interruptId: "new_consumed", consumedAt: BEFORE, consumedDecision: "once" }),
      )
      await store.issue(grant({ interruptId: "old_voided", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(grant({ interruptId: "new_voided", voidedAt: "2026-09-30T13:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect((await store.listForThread("t1")).map((row) => row.interruptId).sort()).toEqual([
        "new_consumed",
        "new_voided",
      ])
    })

    it("a void is the settle time: an old consume with a recent void is kept", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(
        grant({
          interruptId: "consumed_then_voided",
          consumedAt: "2026-09-30T01:00:00.000Z",
          consumedDecision: "once",
          voidedAt: "2026-09-30T13:00:00.000Z",
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.get("t1", "consumed_then_voided")).toBeDefined()
    })

    it("never deletes an outstanding row, expired or not", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(
        grant({ interruptId: "expired_long_ago", expiresAt: "2020-01-01T00:00:00.000Z" }),
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
      await store.issue(
        grant({ threadId: "t1", interruptId: "a", voidedAt: "2026-09-30T01:00:00.000Z" }),
      )
      await store.issue(
        grant({ threadId: "t2", interruptId: "b", voidedAt: "2026-09-30T01:00:00.000Z" }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.listForThread("t1")).toEqual([])
      expect(await store.listForThread("t2")).toEqual([])
    })
  })
})
