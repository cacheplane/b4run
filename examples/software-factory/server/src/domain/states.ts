export const STATES = [
  "received",
  "dispatched",
  "running",
  "verifying",
  "awaiting_approval",
  "exporting",
  "exported",
  "denied",
  "cancel_requested",
  "cancelled",
  "blocked",
  "failed",
] as const
export type WorkOrderState = (typeof STATES)[number]

export const TERMINAL_STATES: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
  "exported",
  "denied",
  "cancelled",
  "failed",
])

/** States that count toward the active-time budget. Waiting on a person is not active time. */
export const ACTIVE_STATES: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
  "dispatched",
  "running",
  "verifying",
  "exporting",
])

/** Reasons are attached by the controller (later tasks), not by nextState. */
export const BLOCKED_REASONS = [
  "unexpected_interrupt",
  // The builder wrote where it may not: outside its inventory, over an immutable path, past
  // the byte cap, or by adding or removing a path at all.
  "scope_violation",
  // The builder wrote bytes the controller cannot represent — a NUL byte or a lone
  // surrogate. Distinct from `scope_violation`: the path was allowed, the content was not,
  // and conflating the two tells an operator to look in the wrong place. There is no
  // `baseline_mismatch`: rung 1 never asks the builder for a source digest to disagree with,
  // it diffs against its own captured baseline, so every assembly refusal is one of these two.
  "encoding_violation",
  "verification_failed",
  "verification_inconclusive",
  "export_unconfirmed",
  "budget_exhausted",
] as const
export type BlockedReason = (typeof BLOCKED_REASONS)[number]

export const FAILURE_REASONS = ["route_error", "ended_without_candidate"] as const
export type FailureReason = (typeof FAILURE_REASONS)[number]

export const TRANSITION_EVENTS = [
  "dispatch_committed",
  "run_started",
  "turn_ended_with_workspace",
  "turn_ended_without_changes",
  "unexpected_interrupt",
  "run_failed",
  "assembly_rejected",
  "receipt_passed",
  "receipt_failed",
  "receipt_inconclusive",
  "approve",
  "deny",
  "receipt_observed",
  "export_unconfirmed",
  "cancel",
  "run_ended_after_cancel",
  "run_ended_after_budget",
  "budget_exhausted",
] as const
export type TransitionEvent = (typeof TRANSITION_EVENTS)[number]

type Row = Readonly<Partial<Record<WorkOrderState, WorkOrderState>>>

const NON_TERMINAL = STATES.filter((state) => !TERMINAL_STATES.has(state))
const everyNonTerminalTo = (to: WorkOrderState): Row =>
  Object.fromEntries(NON_TERMINAL.map((from) => [from, to])) as Row

/** One row per legal move (spec: "Transition table"). Anything absent is illegal. */
const TABLE: Readonly<Record<TransitionEvent, Row>> = {
  dispatch_committed: { received: "dispatched" },
  run_started: { dispatched: "running" },
  turn_ended_with_workspace: { dispatched: "verifying", running: "verifying" },
  // Only the verifying phase can know the builder changed nothing: it is the diff against
  // the controller's own baseline that says so, not the end of the stream.
  turn_ended_without_changes: { dispatched: "failed", running: "failed", verifying: "failed" },
  unexpected_interrupt: { dispatched: "blocked", running: "blocked", verifying: "blocked" },
  run_failed: { dispatched: "failed", running: "failed" },
  assembly_rejected: { verifying: "blocked" },
  receipt_passed: { verifying: "awaiting_approval" },
  receipt_failed: { verifying: "blocked" },
  receipt_inconclusive: { verifying: "blocked" },
  approve: { awaiting_approval: "exporting" },
  deny: { awaiting_approval: "denied", blocked: "denied" },
  receipt_observed: { exporting: "exported" },
  export_unconfirmed: { exporting: "blocked" },
  cancel: everyNonTerminalTo("cancel_requested"),
  run_ended_after_cancel: { cancel_requested: "cancelled" },
  run_ended_after_budget: { cancel_requested: "blocked" },
  budget_exhausted: {
    dispatched: "cancel_requested",
    running: "cancel_requested",
    verifying: "cancel_requested",
    exporting: "cancel_requested",
  },
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: WorkOrderState,
    readonly event: TransitionEvent,
  ) {
    super(`Illegal transition: ${event} from ${from}`)
    this.name = "IllegalTransitionError"
  }
}

export function nextState(from: WorkOrderState, event: TransitionEvent): WorkOrderState {
  const to = TABLE[event][from]
  if (to === undefined) throw new IllegalTransitionError(from, event)
  return to
}

export function isTerminal(state: WorkOrderState): boolean {
  return TERMINAL_STATES.has(state)
}
