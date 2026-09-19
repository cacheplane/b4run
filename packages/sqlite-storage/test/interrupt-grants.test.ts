import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createInterruptGrantStore } from "../src/interrupt-grants/index.js"
import type { InterruptGrantRecord } from "../src/interrupt-grants/types.js"

describe("createInterruptGrantStore", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "b4-grants-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function storePath() {
    return join(dir, "interrupt-grants.sqlite")
  }

  function newStore() {
    return createInterruptGrantStore({ path: storePath() })
  }

  function record(overrides: Partial<InterruptGrantRecord> = {}): InterruptGrantRecord {
    return {
      threadId: "t-1",
      interruptId: "int-1",
      checkpointNs: "agent:1234",
      tokenHash: "a".repeat(64),
      issuedAt: "2026-09-18T00:00:00.000Z",
      expiresAt: null,
      consumedAt: null,
      consumedDecision: null,
      voidedAt: null,
      ...overrides,
    }
  }

  it("issue + get round-trips every column, including the nullable ones", async () => {
    const store = newStore()
    const row = record({ expiresAt: "2026-09-19T00:00:00.000Z" })
    await store.issue(row)
    expect(await store.get("t-1", "int-1")).toEqual(row)
  })

  it("get returns undefined for an unknown (threadId, interruptId)", async () => {
    const store = newStore()
    await store.issue(record())
    expect(await store.get("t-1", "int-missing")).toBeUndefined()
    expect(await store.get("t-missing", "int-1")).toBeUndefined()
  })

  it("issue rejects a duplicate (threadId, interruptId)", async () => {
    const store = newStore()
    await store.issue(record())
    await expect(store.issue(record({ tokenHash: "b".repeat(64) }))).rejects.toThrow()
    // The loser must not have overwritten the winner's hash.
    expect((await store.get("t-1", "int-1"))?.tokenHash).toBe("a".repeat(64))
  })

  it("issue allows the same interruptId on a different thread", async () => {
    const store = newStore()
    await store.issue(record())
    await store.issue(record({ threadId: "t-2" }))
    expect((await store.get("t-2", "int-1"))?.threadId).toBe("t-2")
  })

  it("consume stamps the decision once and refuses the replay", async () => {
    const store = newStore()
    await store.issue(record())

    const first = await store.consume({
      threadId: "t-1",
      interruptId: "int-1",
      decision: "once",
      at: "2026-09-18T01:00:00.000Z",
    })
    expect(first.outcome).toBe("consumed")
    expect(first.outcome === "consumed" && first.record.consumedAt).toBe("2026-09-18T01:00:00.000Z")
    expect(first.outcome === "consumed" && first.record.consumedDecision).toBe("once")

    const second = await store.consume({
      threadId: "t-1",
      interruptId: "int-1",
      decision: "deny",
      at: "2026-09-18T02:00:00.000Z",
    })
    expect(second.outcome).toBe("already_consumed")
    // The replay must echo what was RECORDED, not what it asked for.
    expect(second.outcome === "already_consumed" && second.record.consumedDecision).toBe("once")
    expect(second.outcome === "already_consumed" && second.record.consumedAt).toBe(
      "2026-09-18T01:00:00.000Z",
    )
  })

  it("consume of a voided grant reports voided and leaves it unconsumed", async () => {
    const store = newStore()
    await store.issue(record())
    await store.voidOutstanding({
      threadId: "t-1",
      keepInterruptIds: [],
      at: "2026-09-18T00:30:00.000Z",
    })

    const result = await store.consume({
      threadId: "t-1",
      interruptId: "int-1",
      decision: "once",
      at: "2026-09-18T01:00:00.000Z",
    })
    expect(result.outcome).toBe("voided")
    expect(result.outcome === "voided" && result.record.voidedAt).toBe("2026-09-18T00:30:00.000Z")
    expect((await store.get("t-1", "int-1"))?.consumedAt).toBeNull()
  })

  it("consume of a missing grant reports missing", async () => {
    const store = newStore()
    const result = await store.consume({
      threadId: "t-1",
      interruptId: "int-nope",
      decision: "once",
      at: "2026-09-18T01:00:00.000Z",
    })
    expect(result).toEqual({ outcome: "missing" })
  })

  it("voidOutstanding keeps the listed interrupts and voids the rest", async () => {
    const store = newStore()
    await store.issue(record({ interruptId: "int-keep" }))
    await store.issue(record({ interruptId: "int-stale-a" }))
    await store.issue(record({ interruptId: "int-stale-b" }))
    await store.issue(record({ threadId: "t-other", interruptId: "int-other" }))

    const voided = await store.voidOutstanding({
      threadId: "t-1",
      keepInterruptIds: ["int-keep"],
      at: "2026-09-18T03:00:00.000Z",
    })
    expect(voided).toBe(2)
    expect((await store.get("t-1", "int-keep"))?.voidedAt).toBeNull()
    expect((await store.get("t-1", "int-stale-a"))?.voidedAt).toBe("2026-09-18T03:00:00.000Z")
    expect((await store.get("t-1", "int-stale-b"))?.voidedAt).toBe("2026-09-18T03:00:00.000Z")
    // Another thread's outstanding grants are none of this thread's business.
    expect((await store.get("t-other", "int-other"))?.voidedAt).toBeNull()
  })

  it("voidOutstanding with an empty keep-list voids everything outstanding", async () => {
    const store = newStore()
    await store.issue(record({ interruptId: "int-a" }))
    await store.issue(record({ interruptId: "int-b" }))

    const voided = await store.voidOutstanding({
      threadId: "t-1",
      keepInterruptIds: [],
      at: "2026-09-18T03:00:00.000Z",
    })
    expect(voided).toBe(2)
    expect((await store.get("t-1", "int-a"))?.voidedAt).toBe("2026-09-18T03:00:00.000Z")
    expect((await store.get("t-1", "int-b"))?.voidedAt).toBe("2026-09-18T03:00:00.000Z")
  })

  it("voidOutstanding skips already-consumed and already-voided grants", async () => {
    const store = newStore()
    await store.issue(record({ interruptId: "int-consumed" }))
    await store.issue(record({ interruptId: "int-voided" }))
    await store.issue(record({ interruptId: "int-open" }))
    await store.consume({
      threadId: "t-1",
      interruptId: "int-consumed",
      decision: "always",
      at: "2026-09-18T01:00:00.000Z",
    })
    await store.voidOutstanding({
      threadId: "t-1",
      keepInterruptIds: ["int-open"],
      at: "2026-09-18T02:00:00.000Z",
    })

    const voided = await store.voidOutstanding({
      threadId: "t-1",
      keepInterruptIds: [],
      at: "2026-09-18T03:00:00.000Z",
    })
    expect(voided).toBe(1)
    // The earlier void keeps its own timestamp; re-voiding must not restamp it.
    expect((await store.get("t-1", "int-voided"))?.voidedAt).toBe("2026-09-18T02:00:00.000Z")
    expect((await store.get("t-1", "int-consumed"))?.voidedAt).toBeNull()
    expect((await store.get("t-1", "int-open"))?.voidedAt).toBe("2026-09-18T03:00:00.000Z")
  })

  it("listForThread returns every row for the thread, consumed and voided included", async () => {
    const store = newStore()
    await store.issue(record({ interruptId: "int-a" }))
    await store.issue(record({ interruptId: "int-b" }))
    await store.issue(record({ interruptId: "int-c" }))
    await store.issue(record({ threadId: "t-2", interruptId: "int-d" }))
    await store.consume({
      threadId: "t-1",
      interruptId: "int-a",
      decision: "once",
      at: "2026-09-18T01:00:00.000Z",
    })
    await store.voidOutstanding({
      threadId: "t-1",
      keepInterruptIds: ["int-c"],
      at: "2026-09-18T02:00:00.000Z",
    })

    const rows = await store.listForThread("t-1")
    expect(rows.map((r) => r.interruptId).sort()).toEqual(["int-a", "int-b", "int-c"])
    expect(await store.listForThread("t-unknown")).toEqual([])
  })

  it("a store reopened on the same file sees the consumption", async () => {
    const path = storePath()
    const first = createInterruptGrantStore({ path })
    await first.issue(record())
    await first.consume({
      threadId: "t-1",
      interruptId: "int-1",
      decision: "always",
      at: "2026-09-18T01:00:00.000Z",
    })

    // Re-open from disk: the whole point of the durable store is that a
    // process restart cannot launder a replay into a fresh approval.
    const second = createInterruptGrantStore({ path })
    const replay = await second.consume({
      threadId: "t-1",
      interruptId: "int-1",
      decision: "once",
      at: "2026-09-18T02:00:00.000Z",
    })
    expect(replay.outcome).toBe("already_consumed")
    expect(replay.outcome === "already_consumed" && replay.record.consumedDecision).toBe("always")
  })
})
