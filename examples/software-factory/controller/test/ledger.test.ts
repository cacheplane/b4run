import { describe, expect, it } from "vitest"
import type { FactoryEvent, WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { ledgerRow, renderLedger, renderLedgerMarkdown } from "../src/lib/operator/ledger.ts"
import { costOf, DEFAULT_PRICES, priceTable } from "../src/lib/operator/prices.ts"

const row = (patch: Partial<WorkOrderRow> = {}): WorkOrderRow => ({
  id: "wo-1",
  revision: 12,
  state: "delivered",
  taskId: "wo-1",
  workerRoute: "/build#agent",
  workerThreadId: "t-1",
  interruptId: null,
  candidateDigest: "c".repeat(64),
  bundleDigest: "b".repeat(64),
  blockedReason: null,
  failureReason: null,
  candidateAttempts: 1,
  maxCandidateAttempts: 2,
  maxActiveMs: 18_000_000,
  activeMs: 150_000,
  activeStartedAt: null,
  awaitingSince: null,
  origin: { kind: "issue", repository: "o/r", number: 7, bodyDigest: "d".repeat(64) },
  pin: "p".repeat(40),
  delivery: {
    kind: "draft-pr",
    repository: "o/r",
    baseBranch: "main",
    branch: "factory/wo-1",
    pathPrefix: ".",
    issueStateAtCreate: "open",
  },
  targetId: "devkit",
  taskDigest: "t".repeat(64),
  intakeAttempts: 1,
  maxIntakeAttempts: 2,
  createdAt: "2026-10-21T05:06:11.000Z",
  updatedAt: "2026-10-21T16:06:22.000Z",
  ...patch,
})

/** A journal in the shape the second live run left, with times chosen to be easy to sum. */
function journal(): FactoryEvent[] {
  const t0 = Date.parse("2026-10-21T05:00:00.000Z")
  const minute = 60_000
  let seq = 0
  const ev = (
    minutesAfter: number,
    type: string,
    payload: Record<string, unknown> = {},
  ): FactoryEvent => ({
    seq: ++seq,
    workOrderId: "wo-1",
    type,
    payload,
    at: new Date(t0 + minutesAfter * minute).toISOString(),
  })
  const tr = (
    minutesAfter: number,
    event: string,
    from: string,
    to: string,
    extra: Record<string, unknown> = {},
  ) => ev(minutesAfter, "transition", { event, from, to, ...extra })
  const usage = (
    minutesAfter: number,
    phase: string,
    input: number,
    output: number,
    cached = 0,
    reasoning = 0,
  ) =>
    ev(minutesAfter, "model_usage", {
      phase,
      provider: "openai",
      model: "gpt-5-mini",
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
      reasoningTokens: reasoning,
      totalTokens: input + output,
    })
  return [
    ev(0, "created"),
    tr(0, "intake_started", "received", "intake_running"),
    usage(0.5, "intake", 10_000, 500, 4_000, 100),
    usage(1, "intake", 20_000, 1_500),
    ev(1.5, "image_prepared", { targetId: "devkit", ms: 75_000 }),
    tr(2, "intake_drafted", "intake_running", "awaiting_intake_approval"),
    // Parked ten minutes at the first gate.
    tr(12, "approve_intake", "awaiting_intake_approval", "received"),
    tr(12, "dispatch_committed", "received", "dispatched"),
    tr(12.5, "run_started", "dispatched", "running"),
    usage(13, "build", 30_000, 2_000, 0, 500),
    tr(13.5, "turn_ended_with_workspace", "running", "verifying"),
    tr(14, "receipt_passed", "verifying", "awaiting_approval"),
    // Parked five minutes at the second gate.
    ev(19, "approve_started"),
    tr(19.5, "approve_delivery", "awaiting_approval", "delivering"),
    tr(20, "delivery_confirmed", "delivering", "delivered", { number: 1055 }),
  ]
}

describe("ledgerRow", () => {
  it("sums each phase's minutes, the gate waits, the attempts, and the tokens by phase", () => {
    const r = ledgerRow(row(), journal(), DEFAULT_PRICES)
    expect(r).toMatchObject({
      id: "wo-1",
      origin: "o/r#7",
      targetId: "devkit",
      outcome: "delivered #1055",
      intakeAttempts: 1,
      candidateAttempts: 1,
      gates: { drafts: 1, bundles: 1 },
      priceTableAsOf: DEFAULT_PRICES.asOf,
    })
    expect(r.ms).toEqual({
      intake: 2 * 60_000,
      imageBuild: 75_000,
      build: 60_000,
      verify: 30_000,
      delivery: 30_000,
      waiting: 15 * 60_000,
      wall: 20 * 60_000,
      active: 150_000,
    })
    expect(r.usage?.intake).toMatchObject({
      calls: 2,
      inputTokens: 30_000,
      cachedInputTokens: 4_000,
      outputTokens: 2_000,
      reasoningTokens: 100,
      models: { "gpt-5-mini": 2 },
    })
    expect(r.usage?.build).toMatchObject({ calls: 1, inputTokens: 30_000, outputTokens: 2_000 })
    expect(r.usage?.total).toMatchObject({ calls: 3, inputTokens: 60_000, outputTokens: 4_000 })
    // Cost: 56k uncached input at $0.25/M, 4k cached at $0.025/M, 4k output at $2/M.
    const expected = (56_000 * 0.25 + 4_000 * 0.025 + 4_000 * 2) / 1_000_000
    expect(r.estimatedUsd).toBeCloseTo(expected, 9)
    expect(r.usage?.total.estimatedUsd).toBeCloseTo(expected, 9)
  })

  it("reports no usage and no cost for a run journalled before the ledger, and a null cost for an unpriced model", () => {
    const silent = ledgerRow(
      row(),
      journal().filter((e) => e.type !== "model_usage"),
      DEFAULT_PRICES,
    )
    expect(silent.usage).toBeNull()
    expect(silent.estimatedUsd).toBeNull()
    // Phases still sum: timing needs no usage.
    expect(silent.ms.intake).toBe(2 * 60_000)

    const unpriced = ledgerRow(
      row(),
      journal().map((e) =>
        e.type === "model_usage"
          ? { ...e, payload: { ...e.payload, model: "someone-elses-model" } }
          : e,
      ),
      DEFAULT_PRICES,
    )
    expect(unpriced.usage?.total.calls).toBe(3)
    expect(unpriced.estimatedUsd).toBeNull()
  })

  it("counts every attempt's span once, and an open phase not at all", () => {
    const events = journal()
    // A second builder turn after a retry: build time is both turns.
    const t = (e: FactoryEvent) => e
    const extra: FactoryEvent[] = [
      t({
        seq: 100,
        workOrderId: "wo-1",
        type: "transition",
        payload: { event: "retry", from: "blocked", to: "received" },
        at: "2026-10-21T05:30:00.000Z",
      }),
      t({
        seq: 101,
        workOrderId: "wo-1",
        type: "transition",
        payload: { event: "run_started", from: "dispatched", to: "running" },
        at: "2026-10-21T05:31:00.000Z",
      }),
      t({
        seq: 102,
        workOrderId: "wo-1",
        type: "transition",
        payload: { event: "turn_ended_with_workspace", from: "running", to: "verifying" },
        at: "2026-10-21T05:33:00.000Z",
      }),
      // Still verifying: no closer.
    ]
    const r = ledgerRow(
      row({ state: "verifying", candidateAttempts: 2 }),
      [...events, ...extra],
      DEFAULT_PRICES,
    )
    expect(r.ms.build).toBe(60_000 + 2 * 60_000)
    expect(r.ms.verify).toBe(30_000)
    expect(r.outcome).toBe("verifying")
  })
})

describe("renderLedger", () => {
  it("prints one aligned line per row, the legend, and the cost per accepted change", () => {
    const text = renderLedger([ledgerRow(row(), journal(), DEFAULT_PRICES)])
    const lines = text.split("\n")
    expect(lines[0]).toMatch(/^work order\s+origin\s+target\s+intake\s+cand\./)
    expect(lines[2]).toMatch(
      /^wo-1\s+o\/r#7\s+devkit\s+1\s+1\s+2\.0m\s+1\.3m\s+1\.0m\s+0\.5m\s+0\.5m\s+15\.0m\s+20\.0m\s+60\.0k\/4\.0k\s+\$0\.022\s+delivered #1055$/,
    )
    expect(text).toContain(`price table as of ${DEFAULT_PRICES.asOf}`)
    expect(text).toContain(
      "accepted: 1 of 1; estimated cost per accepted change over the 1 costed: $0.022.",
    )
    const md = renderLedgerMarkdown([ledgerRow(row(), journal(), DEFAULT_PRICES)])
    expect(md).toContain(
      "| `wo-1` | o/r#7 | devkit | 1/1 | 2.0m | 1.3m | 1.0m | 0.5m | 0.5m | 15.0m | 60.0k/4.0k | $0.022 | delivered #1055 |",
    )
  })
})

describe("priceTable", () => {
  it("lays FACTORY_PRICES_JSON over the defaults and refuses a malformed table", () => {
    expect(priceTable({})).toBe(DEFAULT_PRICES)
    const table = priceTable({
      FACTORY_PRICES_JSON: JSON.stringify({
        asOf: "2027-01-01",
        "gpt-5-mini": { input: 1, cachedInput: 0.5, output: 4 },
        "my-model": { input: 2, cachedInput: 1, output: 8 },
      }),
    })
    expect(table.asOf).toBe("2027-01-01")
    expect(table.models["gpt-5-mini"]).toEqual({ input: 1, cachedInput: 0.5, output: 4 })
    expect(table.models["my-model"]).toEqual({ input: 2, cachedInput: 1, output: 8 })
    expect(table.models["gpt-5"]).toEqual(DEFAULT_PRICES.models["gpt-5"])
    expect(() => priceTable({ FACTORY_PRICES_JSON: "nope" })).toThrow(/not JSON/)
    expect(() =>
      priceTable({ FACTORY_PRICES_JSON: '{"x":{"input":-1,"cachedInput":0,"output":0}}' }),
    ).toThrow(/non-negative/)
    expect(
      costOf(
        { input: 1, cachedInput: 0.5, output: 4 },
        { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 250_000 },
      ),
    ).toBeCloseTo(0.5 + 0.25 + 1, 9)
  })
})
