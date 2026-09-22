import { describe, expect, it } from "vitest"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { openRegistry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore, StaleRevisionError } from "../src/lib/registry/work-orders.ts"

const at = "2026-09-16T00:00:00.000Z"
const digest = "b".repeat(64)

function freshRow(id = "wo-1"): WorkOrderRow {
  return {
    id,
    revision: 0,
    state: "received",
    taskId: "cli-flags",
    workerRoute: "/fix#agent",
    workerThreadId: null,
    interruptId: null,
    candidateDigest: null,
    bundleDigest: null,
    blockedReason: null,
    failureReason: null,
    maxCandidateAttempts: 1,
    maxActiveMs: 60_000,
    activeMs: 0,
    activeStartedAt: null,
    awaitingSince: null,
    createdAt: at,
    updatedAt: at,
  }
}

function store() {
  return createWorkOrderStore(openRegistry(":memory:").db)
}

describe("work-order store", () => {
  it("round-trips a row", () => {
    const s = store()
    s.insert(freshRow())
    expect(s.get("wo-1")).toEqual(freshRow())
    expect(s.get("missing")).toBeNull()
    expect(s.list().map((r) => r.id)).toEqual(["wo-1"])
  })

  it("updates only when the revision matches, and bumps it", () => {
    const s = store()
    s.insert(freshRow())
    const updated = s.update("wo-1", 0, { state: "dispatched", workerThreadId: "t-1" }, at)
    expect(updated.revision).toBe(1)
    expect(updated.state).toBe("dispatched")
    expect(updated.workerThreadId).toBe("t-1")
    expect(() => s.update("wo-1", 0, { state: "running" }, at)).toThrow(StaleRevisionError)
    expect(s.get("wo-1")?.state).toBe("dispatched")
  })

  it("stores strings and nulls faithfully", () => {
    const s = store()
    s.insert(freshRow())
    const row = s.update("wo-1", 0, { candidateDigest: digest, interruptId: "perm-1" }, at)
    expect(row.candidateDigest).toBe(digest)
    expect(row.interruptId).toBe("perm-1")
    expect(s.update("wo-1", 1, { interruptId: null }, at).interruptId).toBeNull()
  })

  it("appends and reads events in sequence", () => {
    const s = store()
    s.insert(freshRow())
    s.appendEvent("wo-1", "created", { taskId: "cli-flags" }, at)
    s.appendEvent("wo-1", "thread_created", { threadId: "t-1" }, at)
    const events = s.events("wo-1")
    expect(events.map((e) => e.type)).toEqual(["created", "thread_created"])
    expect(events[1]?.seq).toBeGreaterThan(events[0]?.seq ?? Number.POSITIVE_INFINITY)
    expect(events[1]?.payload).toEqual({ threadId: "t-1" })
  })

  it("records approvals and deliveries", () => {
    const s = store()
    s.insert(freshRow())
    s.recordApproval({
      id: "ap-1",
      workOrderId: "wo-1",
      bundleDigest: digest,
      candidateDigest: digest,
      decision: "approved",
      decidedBy: "operator",
      decidedAt: at,
      expiresAt: at,
    })
    expect(s.approvals("wo-1")).toHaveLength(1)
    s.recordDelivery({
      workOrderId: "wo-1",
      candidateDigest: digest,
      receiptPath: "/x",
      observedAt: at,
    })
    expect(s.delivery("wo-1")?.receiptPath).toBe("/x")
  })

  it("is reentrant: a nested transaction commits once with the outermost", () => {
    const s = store()
    s.insert(freshRow())
    s.transaction(() => {
      s.appendEvent("wo-1", "outer", {}, at)
      s.transaction(() => {
        s.appendEvent("wo-1", "inner", {}, at)
      })
    })
    expect(s.events("wo-1").map((e) => e.type)).toEqual(["outer", "inner"])
  })

  it("is reentrant: a throw inside a nested transaction rolls everything back", () => {
    const s = store()
    s.insert(freshRow())
    expect(() =>
      s.transaction(() => {
        s.appendEvent("wo-1", "outer", {}, at)
        s.transaction(() => {
          s.appendEvent("wo-1", "inner", {}, at)
          throw new Error("boom")
        })
      }),
    ).toThrow("boom")
    expect(s.events("wo-1")).toEqual([])
    // The failed transaction must not leave the connection inside a transaction.
    s.transaction(() => s.appendEvent("wo-1", "after", {}, at))
    expect(s.events("wo-1").map((e) => e.type)).toEqual(["after"])
  })

  it("rolls back only the inner savepoint when the outer catches the throw", () => {
    const s = store()
    s.insert(freshRow())
    s.transaction(() => {
      s.appendEvent("wo-1", "outer-before", {}, at)
      expect(() =>
        s.transaction(() => {
          s.appendEvent("wo-1", "inner", {}, at)
          throw new Error("inner boom")
        }),
      ).toThrow("inner boom")
      s.appendEvent("wo-1", "outer-after", {}, at)
    })
    expect(s.events("wo-1").map((e) => e.type)).toEqual(["outer-before", "outer-after"])
  })

  it("shares nesting depth between two stores over one connection", () => {
    const db = openRegistry(":memory:").db
    const a = createWorkOrderStore(db)
    const b = createWorkOrderStore(db)
    a.insert(freshRow())
    // `b` must recognise that `a` already owns the outermost transaction and nest instead.
    a.transaction(() => {
      b.transaction(() => b.appendEvent("wo-1", "from-b", {}, at))
      a.appendEvent("wo-1", "from-a", {}, at)
    })
    expect(a.events("wo-1").map((e) => e.type)).toEqual(["from-b", "from-a"])
  })

  it("rolls a transaction back on error", () => {
    const s = store()
    s.insert(freshRow())
    expect(() =>
      s.transaction(() => {
        s.appendEvent("wo-1", "x", {}, at)
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(s.events("wo-1")).toEqual([])
  })

  it("round-trips the bundle digest and a bundle-bound approval", () => {
    const s = store()
    s.insert(freshRow())
    const digest = "a".repeat(64)
    expect(s.update("wo-1", 0, { bundleDigest: digest }, at).bundleDigest).toBe(digest)
    s.recordApproval({
      id: "ap-1",
      workOrderId: "wo-1",
      bundleDigest: digest,
      candidateDigest: "b".repeat(64),
      decision: "approved",
      decidedBy: "operator",
      decidedAt: at,
      expiresAt: at,
    })
    expect(s.approvals("wo-1")[0]?.bundleDigest).toBe(digest)
  })
})
