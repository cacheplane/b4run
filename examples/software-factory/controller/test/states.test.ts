import { describe, expect, it } from "vitest"
import {
  ACTIVE_STATES,
  BLOCKED_REASONS,
  IllegalTransitionError,
  isTerminal,
  nextState,
  RETRYABLE_BLOCKED_REASONS,
  STATES,
  TERMINAL_STATES,
  TRANSITION_EVENTS,
} from "../src/lib/domain/states.ts"

describe("transition table", () => {
  it("follows the happy path", () => {
    expect(nextState("received", "dispatch_committed")).toBe("dispatched")
    expect(nextState("dispatched", "run_started")).toBe("running")
    expect(nextState("running", "turn_ended_with_workspace")).toBe("verifying")
    expect(nextState("verifying", "receipt_passed")).toBe("awaiting_approval")
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

  it("lets deny exit awaiting_approval and blocked only", () => {
    expect(nextState("awaiting_approval", "deny")).toBe("denied")
    expect(nextState("blocked", "deny")).toBe("denied")
    expect(() => nextState("running", "deny")).toThrow(IllegalTransitionError)
  })

  it("classifies states", () => {
    expect(isTerminal("failed")).toBe(true)
    expect(isTerminal("blocked")).toBe(false)
    expect([...ACTIVE_STATES].sort()).toEqual([
      "dispatched",
      "exporting",
      "intake_running",
      "running",
      "verifying",
    ])
  })

  it("fails the run from dispatched or running", () => {
    expect(nextState("dispatched", "run_failed")).toBe("failed")
    expect(nextState("running", "run_failed")).toBe("failed")
  })

  it("fails when the turn ends without changes, from dispatched or running", () => {
    expect(nextState("dispatched", "turn_ended_without_changes")).toBe("failed")
    expect(nextState("running", "turn_ended_without_changes")).toBe("failed")
  })

  it("blocks on an unconfirmed export", () => {
    expect(nextState("exporting", "export_unconfirmed")).toBe("blocked")
  })

  it("moves to cancel_requested on budget exhaustion from active states only", () => {
    expect(nextState("dispatched", "budget_exhausted")).toBe("cancel_requested")
    expect(nextState("running", "budget_exhausted")).toBe("cancel_requested")
    expect(nextState("verifying", "budget_exhausted")).toBe("cancel_requested")
    expect(nextState("exporting", "budget_exhausted")).toBe("cancel_requested")
    expect(() => nextState("awaiting_approval", "budget_exhausted")).toThrow(IllegalTransitionError)
    expect(() => nextState("blocked", "budget_exhausted")).toThrow(IllegalTransitionError)
  })

  it("routes a turn ended in dispatched into verification too", () => {
    expect(nextState("dispatched", "turn_ended_with_workspace")).toBe("verifying")
  })
})

describe("rung 1 lifecycle", () => {
  it("routes a finished turn into verification", () => {
    expect(nextState("running", "turn_ended_with_workspace")).toBe("verifying")
    expect(nextState("dispatched", "turn_ended_with_workspace")).toBe("verifying")
  })

  it("fails a turn that produced nothing", () => {
    expect(nextState("running", "turn_ended_without_changes")).toBe("failed")
    // The verifying phase is the only thing that can reach this verdict in rung 1: it is
    // the diff against the controller's baseline, not the stream, that finds no changes.
    expect(nextState("verifying", "turn_ended_without_changes")).toBe("failed")
  })

  it("admits exactly one way out of verifying per outcome", () => {
    expect(nextState("verifying", "receipt_passed")).toBe("awaiting_approval")
    expect(nextState("verifying", "assembly_rejected")).toBe("blocked")
    expect(nextState("verifying", "receipt_failed")).toBe("blocked")
    expect(nextState("verifying", "receipt_inconclusive")).toBe("blocked")
  })

  it("counts verifying as active for the budget", () => {
    expect(ACTIVE_STATES.has("verifying")).toBe(true)
    expect(nextState("verifying", "budget_exhausted")).toBe("cancel_requested")
    expect(nextState("verifying", "cancel")).toBe("cancel_requested")
  })

  it("keeps approval and denial reachable only from awaiting_approval", () => {
    expect(nextState("awaiting_approval", "approve")).toBe("exporting")
    expect(nextState("awaiting_approval", "deny")).toBe("denied")
    expect(() => nextState("verifying", "approve")).toThrow(IllegalTransitionError)
  })

  it("has deleted the worker-gate events with the gate", () => {
    expect(TRANSITION_EVENTS).not.toContain("candidate_interrupt")
    expect(TRANSITION_EVENTS).not.toContain("candidate_interrupt_without_digest")
    expect(TRANSITION_EVENTS).not.toContain("interrupt_vanished")
    expect(BLOCKED_REASONS).not.toContain("candidate_digest_unknown")
    expect(BLOCKED_REASONS).not.toContain("interrupt_vanished")
  })

  it("names the four ways the controller can refuse", () => {
    for (const reason of [
      "scope_violation",
      "encoding_violation",
      "verification_failed",
      "verification_inconclusive",
    ])
      expect(BLOCKED_REASONS).toContain(reason)
  })

  it("has no reason for a check rung 1 does not make", () => {
    // `baseline_mismatch` named a builder-declared source digest disagreeing with the
    // controller's. Nothing on this rung asks the builder for one, so no code path could
    // ever produce the reason and a row could never carry it honestly.
    expect(BLOCKED_REASONS).not.toContain("baseline_mismatch")
  })

  it("still blocks on an unexpected interrupt from the builder", () => {
    expect(nextState("running", "unexpected_interrupt")).toBe("blocked")
    expect(BLOCKED_REASONS).toContain("unexpected_interrupt")
  })
})

describe("retry", () => {
  it("moves only a blocked row, back to received", () => {
    expect(nextState("blocked", "retry")).toBe("received")
    for (const from of STATES.filter((state) => state !== "blocked"))
      expect(() => nextState(from, "retry")).toThrow(IllegalTransitionError)
  })

  it("retries only the blocks a candidate failure leaves", () => {
    expect([...RETRYABLE_BLOCKED_REASONS].sort()).toEqual(
      [
        "candidate_rejected",
        "encoding_violation",
        "scope_violation",
        "unexpected_interrupt",
        "verification_failed",
        "verification_inconclusive",
      ].sort(),
    )
    for (const reason of RETRYABLE_BLOCKED_REASONS) expect(BLOCKED_REASONS).toContain(reason)
  })
})

describe("intake prefix", () => {
  it("intake is a prefix on the lifecycle", () => {
    expect(nextState("received", "intake_started")).toBe("intake_running")
    expect(nextState("intake_running", "intake_drafted")).toBe("awaiting_intake_approval")
    expect(nextState("intake_running", "intake_retry")).toBe("intake_running")
    expect(nextState("intake_running", "intake_blocked")).toBe("blocked")
    expect(nextState("awaiting_intake_approval", "approve_intake")).toBe("received")
    expect(nextState("awaiting_intake_approval", "reject_intake")).toBe("intake_running")
    expect(nextState("awaiting_intake_approval", "intake_blocked")).toBe("blocked")
    expect(nextState("intake_running", "cancel")).toBe("cancel_requested")
    expect(nextState("awaiting_intake_approval", "cancel")).toBe("cancel_requested")
    expect(nextState("intake_running", "budget_exhausted")).toBe("cancel_requested")
    expect(ACTIVE_STATES.has("intake_running")).toBe(true)
    expect(ACTIVE_STATES.has("awaiting_intake_approval")).toBe(false)
    expect(() => nextState("received", "intake_drafted")).toThrow()
    expect(() => nextState("dispatched", "approve_intake")).toThrow()
  })

  it("names the ways intake can block", () => {
    for (const reason of [
      "intake_invalid",
      "oracle_did_not_fail",
      "intake_attempts_exhausted",
      "no_target_for_package",
      "image_unprepared",
      "image_prepare_failed",
      "intake_run_failed",
    ])
      expect(BLOCKED_REASONS).toContain(reason)
  })
})
