import { describe, expect, it } from "vitest"
import { activeElapsedMs, startBudgetTicker } from "../src/lib/controller/budget.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { openRegistry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore } from "../src/lib/registry/work-orders.ts"

function row(overrides: Partial<WorkOrderRow>): WorkOrderRow {
  return {
    id: "wo-1",
    revision: 0,
    state: "running",
    taskId: "cli-flags",
    workerRoute: "/fix#agent",
    workerThreadId: "t-1",
    interruptId: null,
    candidateDigest: null,
    bundleDigest: null,
    blockedReason: null,
    failureReason: null,
    maxCandidateAttempts: 1,
    maxActiveMs: 1_000,
    activeMs: 0,
    activeStartedAt: "2026-09-16T00:00:00.000Z",
    awaitingSince: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  }
}

describe("budget", () => {
  it("adds the open interval to banked active time", () => {
    const nowMs = Date.parse("2026-09-16T00:00:02.000Z")
    expect(activeElapsedMs(row({ activeMs: 500 }), nowMs)).toBe(2_500)
    expect(activeElapsedMs(row({ activeMs: 500, activeStartedAt: null }), nowMs)).toBe(500)
  })

  it("fires once for an active work order over its limit and never for parked ones", async () => {
    const store = createWorkOrderStore(openRegistry(":memory:").db)
    store.insert(row({ id: "over" }))
    store.insert(row({ id: "under", maxActiveMs: 10_000_000 }))
    store.insert(
      row({ id: "parked", state: "awaiting_approval", activeStartedAt: null, activeMs: 999_999 }),
    )
    const fired: string[] = []
    let now = Date.parse("2026-09-16T00:00:02.000Z")
    const ticker = startBudgetTicker({
      store,
      now: () => now,
      tickMs: 5,
      onExhausted: async (id) => {
        fired.push(id)
        store.update(id, 0, { state: "cancel_requested" }, new Date(now).toISOString())
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    now += 5
    await new Promise((resolve) => setTimeout(resolve, 30))
    ticker.stop()
    expect(fired).toEqual(["over"])
  })
})
