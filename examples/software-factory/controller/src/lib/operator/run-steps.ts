import { dispatchPreparing } from "../controller/images.js"
import {
  REDELIVERABLE_BLOCKED_REASONS,
  RETRYABLE_BLOCKED_REASONS,
  TERMINAL_STATES,
} from "../domain/states.js"
import type { FactoryEvent, WorkOrderRow } from "../domain/work-order.js"

/** `run`'s exit code when it stopped at a person's gate and approved nothing. */
export const RUN_WAITING_ON_A_PERSON = 3

/**
 * What `factory run` does next for a work order. There is deliberately no approval step: at
 * either gate the step is `gate`, which `run` answers only with `factory review`'s own display
 * and typed-prefix prompt (or by stopping). Nothing here can say "approve".
 */
export type RunStep =
  | { readonly kind: "intake" }
  | { readonly kind: "dispatch" }
  | { readonly kind: "follow"; readonly why: string }
  | { readonly kind: "gate"; readonly gate: "intake" | "export" }
  | { readonly kind: "done" }
  | { readonly kind: "stop"; readonly message: string; readonly next: readonly string[] }

/** The arguments `run` would be given to start this work order's issue or task over. */
export function runAgainArgs(row: Pick<WorkOrderRow, "origin" | "pin" | "taskId">): string {
  if (row.origin.kind === "catalog") return `--task ${row.taskId}`
  const pin = row.pin === null ? "" : ` --pin ${row.pin}`
  return `--issue ${row.origin.number} --repo ${row.origin.repository}${pin}`
}

/** What `run` knows besides the row: the time, and the controller's approval window if `up` recorded it. */
export interface RunContext {
  readonly now: number
  /** The controller's `FACTORY_APPROVAL_TTL_MS` as `up` recorded it; undefined when unknown. */
  readonly approvalTtlMs?: number
}

/**
 * Whether the parked bundle can no longer be approved (D24): the known window has passed, or an
 * approval was refused as expired since the row last entered `awaiting_approval` (a window run
 * did not know). Either way prompting a person again would only be refused.
 */
export function bundleExpired(
  row: Pick<WorkOrderRow, "awaitingSince">,
  events: readonly Pick<FactoryEvent, "type" | "payload">[],
  context: RunContext,
): boolean {
  const since = row.awaitingSince === null ? Number.NaN : Date.parse(row.awaitingSince)
  if (context.approvalTtlMs !== undefined && Number.isFinite(since))
    if (context.now > since + context.approvalTtlMs) return true
  let parked = -1
  events.forEach((event, index) => {
    if (event.type === "transition" && event.payload.to === "awaiting_approval") parked = index
  })
  return events
    .slice(parked + 1)
    .some(
      (e) =>
        e.type === "approve_refused" &&
        typeof e.payload.message === "string" &&
        e.payload.message.includes("has expired"),
    )
}

/**
 * Whether the journal shows an approval started since the row last entered
 * `awaiting_approval` with no refusal after it. While the row still waits, that is an approval
 * re-verifying, or one a controller restart cut off (Trap 13): only the runtime can say which,
 * so this is a reason not to claim "nothing was approved", never a reason to follow.
 */
export function approvalStartedSinceParked(
  events: readonly Pick<FactoryEvent, "type" | "payload">[],
): boolean {
  let parked = -1
  events.forEach((event, index) => {
    if (event.type === "transition" && event.payload.to === "awaiting_approval") parked = index
  })
  const marks = events
    .slice(parked + 1)
    .filter((e) => e.type === "approve_started" || e.type === "approve_refused")
  return marks.at(-1)?.type === "approve_started"
}

export function nextStep(
  row: WorkOrderRow,
  events: readonly Pick<FactoryEvent, "type" | "payload">[],
  context: RunContext = { now: Date.now() },
): RunStep {
  const id = row.id
  const state = row.state
  switch (state) {
    case "received":
      // An issue has no task until a person approves a draft; a catalog task, or an approved
      // draft (also after a person's `retry`), is dispatched.
      if (row.origin.kind === "issue" && row.taskDigest === null) return { kind: "intake" }
      return dispatchPreparing(events)
        ? { kind: "follow", why: "a dispatch already sent is building its image" }
        : { kind: "dispatch" }
    case "intake_running":
    case "dispatched":
    case "running":
    case "verifying":
    case "exporting":
    case "delivering":
    case "cancel_requested":
      return { kind: "follow", why: `it is ${state}` }
    case "awaiting_intake_approval":
      return { kind: "gate", gate: "intake" }
    case "awaiting_approval":
      if (bundleExpired(row, events, context))
        return {
          kind: "stop",
          message: `The review bundle parked at ${row.awaitingSince ?? "an unknown time"} has expired (FACTORY_APPROVAL_TTL_MS) and cannot be re-frozen`,
          next: [
            `pnpm factory review ${id} --reject --note "expired"`,
            `pnpm factory cancel ${id}`,
            `pnpm factory run ${runAgainArgs(row)} --new`,
          ],
        }
      return { kind: "gate", gate: "export" }
    case "exported":
    case "delivered":
      return { kind: "done" }
    case "blocked": {
      const reason = row.blockedReason
      const retryable =
        reason !== null &&
        RETRYABLE_BLOCKED_REASONS.has(reason) &&
        row.candidateAttempts < row.maxCandidateAttempts
      // A delivery block the world can heal: a person redelivers (it asks for the bundle
      // digest's prefix, like a review); run never does.
      const redeliverable = reason !== null && REDELIVERABLE_BLOCKED_REASONS.has(reason)
      return {
        kind: "stop",
        message: `Blocked: ${reason ?? "no reason recorded"}`,
        next: retryable
          ? [`pnpm factory retry ${id}`, `pnpm factory run ${id}`]
          : redeliverable
            ? [
                `pnpm factory events ${id}`,
                `pnpm factory redeliver ${id}`,
                `pnpm factory cancel ${id}`,
              ]
            : [`pnpm factory events ${id}`, `pnpm factory cancel ${id}`],
      }
    }
    case "denied":
    case "cancelled":
    case "failed":
      return {
        kind: "stop",
        message: `${state}${row.failureReason ? ` (${row.failureReason})` : ""}: this work order is over`,
        next: [`pnpm factory events ${id}`, `pnpm factory run ${runAgainArgs(row)} --new`],
      }
    default: {
      const unreachable: never = state
      throw new Error(`No run step for state ${String(unreachable)}`)
    }
  }
}

export type WorkOrderChoice =
  | { readonly kind: "create" }
  | { readonly kind: "resume"; readonly row: WorkOrderRow }
  | { readonly kind: "done"; readonly row: WorkOrderRow }
  | { readonly kind: "ambiguous"; readonly rows: readonly WorkOrderRow[] }

/**
 * Which of an issue's (or a catalog task's) work orders `run` works on. One that has not ended
 * is resumed; two are not guessed between; an exported newest one is the answer already. A
 * `blocked` work order has not ended (a person may retry or cancel it), so it is resumed and
 * `run` stops at it with the commands.
 */
export function chooseWorkOrder(rows: readonly WorkOrderRow[], fresh: boolean): WorkOrderChoice {
  if (fresh) return { kind: "create" }
  const live = rows.filter((row) => !TERMINAL_STATES.has(row.state))
  if (live.length > 1) return { kind: "ambiguous", rows: live }
  const [only] = live
  if (only !== undefined) return { kind: "resume", row: only }
  const newest = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (newest?.state === "exported" || newest?.state === "delivered")
    return { kind: "done", row: newest }
  return { kind: "create" }
}
