import type { WorkOrderRow } from "../domain/work-order.js"
import { classifyDone, type StreamFrame } from "../worker/wire.js"
import type { ControllerContext } from "./context.js"
import { reconcileWorkOrder } from "./reconcile.js"
import { consumeTurn } from "./turns.js"

const isRunState = (state: WorkOrderRow["state"]) => state === "dispatched" || state === "running"

export interface ObserveRunOptions {
  /**
   * Set when reconciliation reattached to a run that was already in flight. A reattached
   * stream carries only the tail of the turn — the gate may have been emitted on the stream
   * that was lost — so its end is no evidence that the run produced no candidate: the worker
   * is re-read instead. The number is the reconciliation pass, which bounds that cycle.
   */
  readonly reconcileAttempt?: number
}

/**
 * The worker's single turn (spec: "Where the candidate digest comes from" and the
 * dispatched/running rows of the transition table). Every handler re-reads the row and
 * acts only while the work order is still in a run state, so a concurrent cancel wins.
 */
export async function observeRun(
  ctx: ControllerContext,
  id: string,
  frames: AsyncIterable<StreamFrame>,
  options: ObserveRunOptions = {},
): Promise<void> {
  const reattached = options.reconcileAttempt !== undefined
  const result = await consumeTurn(frames, {
    onFirstFrame: async () => {
      // `transition` re-reads the row inside its own transaction, so the state it checks
      // is the state it writes from: no read-then-write race with a concurrent command.
      if (ctx.mustGet(id).state === "dispatched") ctx.transition(id, "run_started")
    },
    onInterrupt: async (frame) => {
      // Rung 1's builder route has no gate to park on: the controller decides what the turn
      // was worth after it ends. Any prompt reaching here is therefore unexpected.
      if (!isRunState(ctx.mustGet(id).state)) return
      ctx.transition(
        id,
        "unexpected_interrupt",
        { interruptId: frame.interruptId, blockedReason: "unexpected_interrupt" },
        { interruptId: frame.interruptId, kind: frame.kind },
      )
    },
    onDone: async (data) => {
      const { error, cancelled } = classifyDone(data)
      // A cancelled turn is settled by the cancel command, not here; journal that we saw it.
      // Checked before the run-state guard on purpose: by the time this frame arrives the
      // cancel command has already moved the row to cancel_requested, so behind the guard
      // the journal line would never be written.
      if (cancelled) {
        ctx.recordEvent(id, "run_cancelled_observed", {})
        return
      }
      const row = ctx.mustGet(id)
      if (!isRunState(row.state)) return
      if (error) {
        ctx.transition(id, "run_failed", { failureReason: "route_error" }, { error })
        return
      }
      if (reattached) {
        // Not a verdict: the reconciliation pass below re-reads the worker.
        ctx.recordEvent(id, "reattached_turn_ended", { attempt: options.reconcileAttempt })
        return
      }
      // Not a verdict either: the turn left a workspace behind, and the verifying phase —
      // not this stream, and not anything the builder said on it — decides what it contains.
      ctx.transition(id, "turn_ended_with_workspace")
    },
  })
  if (result.ended === "handler_error") {
    // A controller fault, not a worker fault: reconciliation must not read it as a lost
    // stream, and must not run on the strength of one.
    ctx.recordEvent(id, "run_observer_error", { phase: "run", error: result.error ?? null })
    return
  }
  if (result.ended === "lost")
    ctx.recordEvent(id, "stream_lost", { phase: "run", error: result.error ?? null })
  // The worker, not this stream, is the authority on what the run left behind: a lost stream
  // is reconciled, and so is the end of a stream reconciliation itself reattached.
  // One increment per pass: a lost stream opens pass 0 (which may reattach), and the end of
  // a reattached stream opens the pass after the one that reattached.
  if (result.ended === "lost" || reattached)
    await reconcileWorkOrder(ctx, id, reattached ? (options.reconcileAttempt ?? 0) + 1 : 0, {
      // This run is still tracked as it reconciles — it IS the tracked run — and the reattach
      // it may make is the handover of its own stream, not a second observer over a live one.
      fromTrackedRun: true,
    })
}

/**
 * Resolve every pending interrupt on the work order's thread with `deny`. The resume goes
 * out on the builder route, which is the wrong route for a drafter thread — and a drafter
 * thread can be parked: `intake_unexpected_interrupt` blocks the row precisely because it
 * parked, and the deny or cancel that follows lands here. Tolerated in 3a because the
 * outcome is a deny either way; a drafter route that gains a gate of its own must resume on
 * `ctx.intakeRoute` (a Task 8 / 3b follow-up).
 */
export async function denyPending(ctx: ControllerContext, id: string): Promise<void> {
  const row = ctx.mustGet(id)
  if (!row.workerThreadId) return
  const pending = await ctx.worker.pendingInterrupts(row.workerThreadId)
  if (pending.length === 0) return
  ctx.recordEvent(id, "pending_denied", { interruptIds: pending.map((p) => p.interruptId) })
  const frames = await ctx.worker.resume(
    row.workerThreadId,
    ctx.workerRoute,
    pending.map((p) => ({ interruptId: p.interruptId, payload: "deny" as const })),
    ctx.signal,
  )
  await consumeTurn(frames, {})
}
