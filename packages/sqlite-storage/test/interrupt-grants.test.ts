import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createInterruptGrantStore } from "../src/interrupt-grants/index.js"
import { INTERRUPT_GRANTS_MIGRATIONS } from "../src/interrupt-grants/schema.js"
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
      consumedBy: null,
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

  it("consume records who answered as consumedBy, null when anonymous, and a replay keeps it", async () => {
    const store = newStore()
    await store.issue(record())
    await store.issue(record({ interruptId: "int-2" }))
    const at = "2026-09-18T01:00:00.000Z"
    const byAda = await store.consume({
      threadId: "t-1",
      interruptId: "int-1",
      decision: "once",
      at,
      by: "ada",
    })
    expect(byAda.outcome === "consumed" && byAda.record.consumedBy).toBe("ada")
    const anonymous = await store.consume({
      threadId: "t-1",
      interruptId: "int-2",
      decision: "deny",
      at,
    })
    expect(anonymous.outcome === "consumed" && anonymous.record.consumedBy).toBeNull()
    const replay = await store.consume({
      threadId: "t-1",
      interruptId: "int-1",
      decision: "deny",
      at,
      by: "bob",
    })
    expect(replay.outcome === "already_consumed" && replay.record.consumedBy).toBe("ada")
    // Durable: a fresh store over the same file reads it back.
    expect((await newStore().get("t-1", "int-1"))?.consumedBy).toBe("ada")
  })

  it("adds consumed_by to a database created before it, leaving old rows null", async () => {
    // A file migrated to version 1 only, with a row in it: what an existing
    // .b4/interrupt-grants.sqlite looks like on upgrade.
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(storePath())
    db.exec(INTERRUPT_GRANTS_MIGRATIONS[0]?.up ?? "")
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)")
    db.exec("INSERT INTO schema_version (version) VALUES (1)")
    db.prepare(
      "INSERT INTO interrupt_grants VALUES ('t-1', 'old', 'ns', ?, '2026-09-01T00:00:00.000Z', NULL, NULL, NULL, NULL)",
    ).run("b".repeat(64))
    db.close()

    const store = newStore()
    expect((await store.get("t-1", "old"))?.consumedBy).toBeNull()
    const result = await store.consume({
      threadId: "t-1",
      interruptId: "old",
      decision: "once",
      at: "2026-09-18T01:00:00.000Z",
      by: "ada",
    })
    expect(result.outcome === "consumed" && result.record.consumedBy).toBe("ada")
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

  it("voidOutstanding voids consumed grants too, and skips already-voided ones", async () => {
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
    // First pass: the thread still has int-open AND int-consumed parked, so
    // only int-voided is voided.
    expect(
      await store.voidOutstanding({
        threadId: "t-1",
        keepInterruptIds: ["int-open", "int-consumed"],
        at: "2026-09-18T02:00:00.000Z",
      }),
    ).toBe(1)

    const voided = await store.voidOutstanding({
      threadId: "t-1",
      keepInterruptIds: [],
      at: "2026-09-18T03:00:00.000Z",
    })
    // int-consumed and int-open. The earlier void keeps its own timestamp;
    // re-voiding must not restamp it or count it again.
    expect(voided).toBe(2)
    expect((await store.get("t-1", "int-voided"))?.voidedAt).toBe("2026-09-18T02:00:00.000Z")
    // The consumed row is voided once the thread moves past its prompt, and
    // keeps its consumption record.
    expect(await store.get("t-1", "int-consumed")).toMatchObject({
      voidedAt: "2026-09-18T03:00:00.000Z",
      consumedAt: "2026-09-18T01:00:00.000Z",
      consumedDecision: "always",
      consumedBy: null,
    })
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

  describe("prune", () => {
    const BEFORE = "2026-09-30T12:00:00.000Z"
    const OLD = "2026-09-30T01:00:00.000Z"
    const RECENT = "2026-09-30T13:00:00.000Z"

    it("deletes voided rows before the cutoff; keeps a recent void and one exactly at the cutoff", async () => {
      const store = newStore()
      await store.issue(record({ interruptId: "old_voided", voidedAt: OLD }))
      await store.issue(record({ interruptId: "new_voided", voidedAt: RECENT }))
      await store.issue(record({ interruptId: "at_cutoff", voidedAt: BEFORE }))
      expect(await store.prune({ before: BEFORE })).toBe(1)
      expect((await store.listForThread("t-1")).map((row) => row.interruptId).sort()).toEqual([
        "at_cutoff",
        "new_voided",
      ])
    })

    it("a consumed grant whose prompt is still parked is never pruned", async () => {
      // A resume consumes the row BEFORE the resumed run executes. If that run
      // fails the prompt stays parked with a consumed, unvoided row; deleting
      // it would let the prompt resume ungated under approvals.grants "optional".
      const store = newStore()
      await store.issue(
        record({
          interruptId: "stuck",
          consumedAt: OLD,
          consumedDecision: "once",
          consumedBy: null,
          voidedAt: null,
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.get("t-1", "stuck")).toMatchObject({
        consumedAt: OLD,
        voidedAt: null,
      })
    })

    it("deletes a consumed grant once it has been voided before the cutoff", async () => {
      const store = newStore()
      await store.issue(
        record({
          interruptId: "consumed_then_voided",
          consumedAt: OLD,
          consumedDecision: "once",
          consumedBy: null,
          voidedAt: OLD,
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(1)
      expect(await store.get("t-1", "consumed_then_voided")).toBeUndefined()
    })

    it("never deletes an outstanding row, expired or not", async () => {
      const store = newStore()
      await store.issue(
        record({
          interruptId: "expired_long_ago",
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
      )
      await store.issue(record({ interruptId: "never_expires", expiresAt: null }))
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect((await store.listForThread("t-1")).map((row) => row.interruptId).sort()).toEqual([
        "expired_long_ago",
        "never_expires",
      ])
    })

    it("sweeps every thread and is idempotent", async () => {
      const store = newStore()
      await store.issue(record({ threadId: "t-1", interruptId: "a", voidedAt: OLD }))
      await store.issue(record({ threadId: "t-2", interruptId: "b", voidedAt: OLD }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.listForThread("t-1")).toEqual([])
      expect(await store.listForThread("t-2")).toEqual([])
    })
  })
})
