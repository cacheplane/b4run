import {
  createMemoryInterruptGrantStore,
  type InterruptGrantRecord,
  type InterruptGrantStore,
} from "@b4run/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetApprovalGrantPruneThrottleForTests,
  APPROVAL_GRANT_PRUNE_INTERVAL_MS,
  ApprovalGrantConfigError,
  DEFAULT_APPROVAL_GRANT_RETENTION_MS,
  pruneSettledGrants,
  resolveApprovalGrantRetentionMs,
  validateInterruptGrantStore,
  voidSupersededGrants,
} from "../src/lib/dev/approval-grants.ts"
import { MAX_CLIENT_TOOL_TTL_MS } from "../src/lib/dev/client-tool-runtime.ts"

describe("approval grant retention settings", () => {
  it("grantRetentionMs defaults to 7 days, and a mistyped value fails the boot", () => {
    expect(resolveApprovalGrantRetentionMs(undefined)).toBe(DEFAULT_APPROVAL_GRANT_RETENTION_MS)
    expect(DEFAULT_APPROVAL_GRANT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(resolveApprovalGrantRetentionMs(1)).toBe(1)
    expect(resolveApprovalGrantRetentionMs(MAX_CLIENT_TOOL_TTL_MS)).toBe(MAX_CLIENT_TOOL_TTL_MS)
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "604800000", null]) {
      expect(() => resolveApprovalGrantRetentionMs(bad)).toThrow(ApprovalGrantConfigError)
    }
    expect(() => resolveApprovalGrantRetentionMs(MAX_CLIENT_TOOL_TTL_MS + 1)).toThrow(
      /approvals\.grantRetentionMs/,
    )
  })

  it("a configured grantStore must implement every method, prune included", () => {
    expect(validateInterruptGrantStore(undefined)).toBeUndefined()
    const store = createMemoryInterruptGrantStore()
    expect(validateInterruptGrantStore(store)).toBe(store)
    const { prune: _omitted, ...withoutPrune } = store
    expect(() => validateInterruptGrantStore(withoutPrune)).toThrow(/missing prune/)
    expect(() => validateInterruptGrantStore({ issue() {} })).toThrow(ApprovalGrantConfigError)
    expect(() => validateInterruptGrantStore("sqlite")).toThrow(/approvals\.grantStore/)
  })
})

describe("pruneSettledGrants (opportunistic sweep)", () => {
  const row = (over: Partial<InterruptGrantRecord>): InterruptGrantRecord => ({
    threadId: "t-sweep",
    interruptId: "i",
    checkpointNs: "",
    tokenHash: "0".repeat(64),
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    consumedAt: null,
    consumedDecision: null,
    voidedAt: null,
    ...over,
  })
  afterEach(() => __resetApprovalGrantPruneThrottleForTests())

  it("deletes settled rows older than the window and keeps outstanding ones, expired or not", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(row({ interruptId: "old", voidedAt: "2026-10-01T00:00:00.000Z" }))
    await store.issue(row({ interruptId: "expired", expiresAt: "2026-10-01T00:01:00.000Z" }))
    await store.issue(row({ interruptId: "live" }))
    const now = new Date("2026-10-01T12:00:00.000Z")
    expect(await pruneSettledGrants(store, 3_600_000, now)).toBe(1)
    expect((await store.listForThread("t-sweep")).map((r) => r.interruptId).sort()).toEqual([
      "expired",
      "live",
    ])
  })

  it("runs at most once per interval per store", async () => {
    const store = createMemoryInterruptGrantStore()
    let calls = 0
    const counting: InterruptGrantStore = {
      ...store,
      prune: async (options) => {
        calls += 1
        return store.prune(options)
      },
    }
    const t0 = new Date("2026-10-01T12:00:00.000Z")
    expect(await pruneSettledGrants(counting, 3_600_000, t0)).toBe(0)
    expect(
      await pruneSettledGrants(
        counting,
        3_600_000,
        new Date(t0.getTime() + APPROVAL_GRANT_PRUNE_INTERVAL_MS - 1),
      ),
    ).toBeUndefined()
    expect(
      await pruneSettledGrants(
        counting,
        3_600_000,
        new Date(t0.getTime() + APPROVAL_GRANT_PRUNE_INTERVAL_MS),
      ),
    ).toBe(0)
    expect(calls).toBe(2)
  })

  it("never throws: a failing store is warned about once and reports undefined", async () => {
    const store = createMemoryInterruptGrantStore()
    const failing: InterruptGrantStore = {
      ...store,
      prune: async () => {
        throw new Error("disk full")
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(pruneSettledGrants(failing, 3_600_000, new Date())).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not prune settled approval grants"),
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("rides voidSupersededGrants: the void count is returned and the sweep runs after it", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(
      row({ threadId: "t-other", interruptId: "old", voidedAt: "2020-01-01T00:00:00.000Z" }),
    )
    await store.issue(row({ threadId: "t-now", interruptId: "pending" }))
    await store.issue(row({ threadId: "t-now", interruptId: "moved_past" }))
    const voided = await voidSupersededGrants({
      store,
      threadId: "t-now",
      stillPending: ["pending"],
      retentionMs: 3_600_000,
    })
    expect(voided).toBe(1)
    expect(await store.get("t-other", "old")).toBeUndefined()
    expect((await store.get("t-now", "moved_past"))?.voidedAt).not.toBeNull()
    expect((await store.get("t-now", "pending"))?.voidedAt).toBeNull()
  })

  it("sweeps even when the void itself failed", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(
      row({ threadId: "t-other", interruptId: "old", voidedAt: "2020-01-01T00:00:00.000Z" }),
    )
    const voidFails: InterruptGrantStore = {
      ...store,
      voidOutstanding: async () => {
        throw new Error("void failed")
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const voided = await voidSupersededGrants({
        store: voidFails,
        threadId: "t-now",
        stillPending: [],
        retentionMs: 3_600_000,
      })
      expect(voided).toBe(0)
      expect(await store.get("t-other", "old")).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })
})
