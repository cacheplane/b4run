import { describe, expect, it } from "vitest"
import {
  ACTIVE_STATES,
  IllegalTransitionError,
  isTerminal,
  nextState,
  STATES,
  TERMINAL_STATES,
} from "../src/domain/states.ts"

describe("transition table", () => {
  it("follows the happy path", () => {
    expect(nextState("received", "dispatch_committed")).toBe("dispatched")
    expect(nextState("dispatched", "run_started")).toBe("running")
    expect(nextState("running", "candidate_interrupt")).toBe("awaiting_approval")
    expect(nextState("awaiting_approval", "approve")).toBe("exporting")
    expect(nextState("exporting", "receipt_observed")).toBe("exported")
  })

  it("refuses anything not in the table", () => {
    expect(() => nextState("received", "approve")).toThrow(IllegalTransitionError)
    expect(() => nextState("exported", "cancel")).toThrow(IllegalTransitionError)
    expect(() => nextState("awaiting_approval", "run_failed")).toThrow(IllegalTransitionError)
  })

  it("allows cancel from every non-terminal state and nowhere else", () => {
    for (const state of STATES) {
      if (TERMINAL_STATES.has(state)) expect(() => nextState(state, "cancel")).toThrow()
      else expect(nextState(state, "cancel")).toBe("cancel_requested")
    }
  })

  it("separates cancel outcomes by cause", () => {
    expect(nextState("cancel_requested", "run_ended_after_cancel")).toBe("cancelled")
    expect(nextState("cancel_requested", "run_ended_after_budget")).toBe("blocked")
  })

  it("blocks on the three turn-1 hazards", () => {
    expect(nextState("running", "candidate_interrupt_without_digest")).toBe("blocked")
    expect(nextState("running", "unexpected_interrupt")).toBe("blocked")
    expect(nextState("awaiting_approval", "interrupt_vanished")).toBe("blocked")
  })

  it("lets deny exit awaiting_approval and blocked only", () => {
    expect(nextState("awaiting_approval", "deny")).toBe("denied")
    expect(nextState("blocked", "deny")).toBe("denied")
    expect(() => nextState("running", "deny")).toThrow(IllegalTransitionError)
  })

  it("classifies states", () => {
    expect(isTerminal("failed")).toBe(true)
    expect(isTerminal("blocked")).toBe(false)
    expect([...ACTIVE_STATES].sort()).toEqual(["dispatched", "exporting", "running"])
  })
})
