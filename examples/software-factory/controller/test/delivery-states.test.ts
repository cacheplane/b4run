import { describe, expect, it } from "vitest"
import {
  ACTIVE_STATES,
  BLOCKED_REASONS,
  isTerminal,
  nextState,
  REDELIVERABLE_BLOCKED_REASONS,
  RETRYABLE_BLOCKED_REASONS,
  STATES,
} from "../src/lib/domain/states.ts"

describe("the delivery lifecycle", () => {
  it("approves a draft-PR bundle into delivering, and confirms or refuses it from there", () => {
    expect(nextState("awaiting_approval", "approve_delivery")).toBe("delivering")
    expect(nextState("delivering", "delivery_confirmed")).toBe("delivered")
    expect(nextState("delivering", "delivery_refused")).toBe("blocked")
    expect(nextState("blocked", "redeliver")).toBe("delivering")
    expect(nextState("delivering", "cancel")).toBe("cancel_requested")
    expect(() => nextState("delivering", "budget_exhausted")).toThrow(/Illegal/)
    expect(() => nextState("exporting", "delivery_confirmed")).toThrow(/Illegal/)
  })

  it("allows each delivery event from exactly its one source state", () => {
    const sources = {
      approve_delivery: ["awaiting_approval", "delivering"],
      delivery_confirmed: ["delivering", "delivered"],
      delivery_refused: ["delivering", "blocked"],
      redeliver: ["blocked", "delivering"],
    } as const
    for (const [event, [source, target]] of Object.entries(sources) as [
      keyof typeof sources,
      (typeof sources)[keyof typeof sources],
    ][])
      for (const state of STATES) {
        if (state === source) expect(nextState(state, event), `${state} ${event}`).toBe(target)
        else expect(() => nextState(state, event), `${state} ${event}`).toThrow(/Illegal/)
      }
  })

  it("makes delivered terminal and delivering not active time", () => {
    expect(isTerminal("delivered")).toBe(true)
    expect(isTerminal("delivering")).toBe(false)
    expect(ACTIVE_STATES.has("delivering")).toBe(false)
  })

  it("redelivers only the blocks the world can heal, and retries none of them", () => {
    const delivery = BLOCKED_REASONS.filter((r) => r.startsWith("delivery_"))
    expect(delivery).toEqual([
      "delivery_base_conflict",
      "delivery_baseline_mismatch",
      "delivery_branch_conflict",
      "delivery_issue_closed",
      "delivery_unauthorized",
      "delivery_rate_limited",
      "delivery_unconfirmed",
    ])
    expect([...REDELIVERABLE_BLOCKED_REASONS].sort()).toEqual([
      "delivery_rate_limited",
      "delivery_unauthorized",
      "delivery_unconfirmed",
    ])
    for (const reason of delivery) expect(RETRYABLE_BLOCKED_REASONS.has(reason)).toBe(false)
  })
})
