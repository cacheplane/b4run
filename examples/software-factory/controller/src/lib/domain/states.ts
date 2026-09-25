export const STATES = [
  "received",
  "intake_running",
  "awaiting_intake_approval",
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
  "intake_running",
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
  // The drafter's task failed the task schema, or names a package the target does not
  // contain: it cannot be proved against anything.
  "intake_invalid",
  // The drafted check passed, or was inconclusive, on the unpatched baseline. A check that
  // does not fail before the fix cannot be evidence that the fix worked.
  "oracle_did_not_fail",
  "intake_attempts_exhausted",
  // The draft names a package with no prepared target; there is nothing to pin it to.
  "no_target_for_package",
  // Retired (images are built when first needed); kept because rows blocked before that carry it and the row schema is an enum.
  "image_unprepared",
  // The fit step could not build the drafted target's image at the work order's pin (the log
  // is in evidence). Not the drafter's doing, so no attempt is spent; not standing either: a
  // failure is never recorded, and the next work order at the pin builds again.
  "image_prepare_failed",
  // The drafter turn ended without a draft, or the stream was lost past its retries.
  "intake_run_failed",
  // The candidate's allowed file carries an elision placeholder (`... (file truncated)`) or
  // shrank past half its baseline: the builder rewrote a file it had only partly read.
  // Refused at assembly, before a verification that could only fail on it.
  "candidate_rejected",
] as const
export type BlockedReason = (typeof BLOCKED_REASONS)[number]

/**
 * The blocks a candidate failure leaves, which `retry` may return to `received` while the
 * row has candidate attempts left. Every other block is not the candidate's: an intake block
 * has no approved task to dispatch, an unconfirmed export or an exhausted budget is the
 * controller's to settle, and none of them is mended by a fresh builder thread.
 */
export const RETRYABLE_BLOCKED_REASONS: ReadonlySet<BlockedReason> = new Set<BlockedReason>([
  "unexpected_interrupt",
  "scope_violation",
  "encoding_violation",
  "candidate_rejected",
  "verification_failed",
  "verification_inconclusive",
])

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
  "intake_started",
  "intake_drafted",
  "intake_retry",
  "intake_blocked",
  "approve_intake",
  "reject_intake",
  "retry",
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
    intake_running: "cancel_requested",
    dispatched: "cancel_requested",
    running: "cancel_requested",
    verifying: "cancel_requested",
    exporting: "cancel_requested",
  },
  // The intake prefix: an issue becomes a task the controller has proved as an oracle and a
  // person has approved, and only then does the lifecycle above begin from `received`.
  intake_started: { received: "intake_running" },
  intake_drafted: { intake_running: "awaiting_intake_approval" },
  intake_retry: { intake_running: "intake_running" },
  intake_blocked: { intake_running: "blocked", awaiting_intake_approval: "blocked" },
  approve_intake: { awaiting_intake_approval: "received" },
  reject_intake: { awaiting_intake_approval: "intake_running" },
  // A candidate failure, attempts permitting, back to where `dispatch` starts a fresh builder
  // thread. The table cannot see the reason; `retry` refuses every block but a candidate's.
  retry: { blocked: "received" },
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
