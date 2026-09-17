import type { WorkOrderRow } from "../domain/work-order.js"
import {
  classifyDone,
  isExportGate,
  PREPARE_TOOL,
  parsePrepareReviewOutput,
  type StreamFrame,
} from "../worker/wire.js"
import type { ControllerContext } from "./context.js"
import { consumeTurn } from "./turns.js"

const isRunState = (state: WorkOrderRow["state"]) => state === "dispatched" || state === "running"

/**
 * The worker's single turn (spec: "Where the candidate digest comes from" and the
 * dispatched/running rows of the transition table). Every handler re-reads the row and
 * acts only while the work order is still in a run state, so a concurrent cancel wins.
 */
export async function observeRun(
  ctx: ControllerContext,
  id: string,
  frames: AsyncIterable<StreamFrame>,
): Promise<void> {
  const result = await consumeTurn(frames, {
    onFirstFrame: async () => {
      // `transition` re-reads the row inside its own transaction, so the state it checks
      // is the state it writes from: no read-then-write race with a concurrent command.
      if (ctx.mustGet(id).state === "dispatched") ctx.transition(id, "run_started")
    },
    onToolResult: async (name, output) => {
      if (name !== PREPARE_TOOL) return
      // Read, write and journal as one unit: a half-applied candidate (digest stored with no
      // event, or an event with no digest) would leave reconciliation guessing.
      ctx.store.transaction(() => {
        const row = ctx.mustGet(id)
        if (!isRunState(row.state)) return
        try {
          const parsed = parsePrepareReviewOutput(output)
          ctx.store.update(
            id,
            row.revision,
            {
              candidateDigest: parsed.candidate.receiptDigest,
              candidateVerified: parsed.verification.passed,
            },
            ctx.iso(),
          )
          ctx.recordEvent(id, "candidate_observed", {
            digest: parsed.candidate.receiptDigest,
            verified: parsed.verification.passed,
            candidate: parsed.candidate,
          })
        } catch (error) {
          ctx.recordEvent(id, "candidate_unparseable", { error: String(error) })
        }
      })
    },
    onInterrupt: async (frame) => {
      const row = ctx.mustGet(id)
      if (!isRunState(row.state)) return
      if (!isExportGate(frame)) {
        ctx.transition(
          id,
          "unexpected_interrupt",
          { interruptId: frame.interruptId, blockedReason: "unexpected_interrupt" },
          { interruptId: frame.interruptId, kind: frame.kind },
        )
        return
      }
      if (row.candidateDigest && row.candidateVerified === true) {
        ctx.transition(
          id,
          "candidate_interrupt",
          { interruptId: frame.interruptId, awaitingSince: ctx.iso() },
          { interruptId: frame.interruptId, candidateDigest: row.candidateDigest },
        )
        return
      }
      ctx.transition(
        id,
        "candidate_interrupt_without_digest",
        { interruptId: frame.interruptId, blockedReason: "candidate_digest_unknown" },
        { interruptId: frame.interruptId, verified: row.candidateVerified },
      )
    },
    onDone: async (data) => {
      const row = ctx.mustGet(id)
      if (!isRunState(row.state)) return
      const { error, cancelled } = classifyDone(data)
      // A cancelled turn is settled by the cancel command, not here; journal that we saw it.
      if (cancelled) {
        ctx.recordEvent(id, "run_cancelled_observed", {})
        return
      }
      if (error) {
        ctx.transition(id, "run_failed", { failureReason: "route_error" }, { error })
        return
      }
      ctx.transition(
        id,
        "run_ended_without_candidate",
        { failureReason: "ended_without_candidate" },
        { verified: row.candidateVerified },
      )
    },
  })
  if (result.ended === "lost") {
    ctx.recordEvent(id, "stream_lost", { phase: "run", error: result.error ?? null })
  } else if (result.ended === "handler_error") {
    // A controller fault, not a worker fault: reconciliation must not read it as a lost stream.
    ctx.recordEvent(id, "run_observer_error", { phase: "run", error: result.error ?? null })
  }
}

/** Resolve every pending interrupt on the work order's thread with `deny`. */
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
