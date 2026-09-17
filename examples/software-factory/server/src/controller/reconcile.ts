import { isTerminal } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import { receiptExists, receiptPath } from "../worker/outbox.js"
import { isExportGate, type StreamFrame } from "../worker/wire.js"
import type { ControllerContext } from "./context.js"

const isRunState = (state: WorkOrderRow["state"]) => state === "dispatched" || state === "running"

/**
 * Startup reconciliation (spec: "Startup reconciliation"). Never re-dispatches. Open command
 * intents are settled first, then every non-terminal work order is inspected.
 *
 * One unreachable thread must not keep the factory from booting, so each work order's rules
 * run inside `safeReconcile`: a failure is journalled and the walk continues.
 */
export async function reconcileAll(ctx: ControllerContext): Promise<void> {
  for (const open of ctx.commands.open()) {
    const row = ctx.store.get(open.workOrderId)
    if (!row) {
      ctx.commands.complete(open.operationKey, {
        ok: false,
        message: "Work order missing at reconciliation",
      })
      continue
    }
    if (open.intent.command === "dispatch" && row.state === "received" && !row.workerThreadId) {
      await settleIncompleteDispatch(ctx, row.id, open.operationKey)
      continue
    }
    await safeReconcile(ctx, row.id)
    const final = ctx.mustGet(row.id)
    ctx.commands.complete(open.operationKey, {
      ok: final.state === "exported" || final.state === "cancelled" || final.state === "denied",
      state: final.state,
      message: `Reconciled after restart; work order is ${final.state}`,
    })
  }
  for (const row of ctx.store.list()) {
    if (!isTerminal(row.state)) await safeReconcile(ctx, row.id)
  }
}

/**
 * Rule 1 for a `dispatch` that died before `dispatch_committed` reached the row. `dispatch`
 * journals `thread_created` before it transitions, so the event log — not the row — is what
 * says whether a thread was left behind on the worker. Completes the command either way.
 */
async function settleIncompleteDispatch(
  ctx: ControllerContext,
  id: string,
  operationKey: string,
): Promise<void> {
  const threadId = journalledThreadId(ctx, id)
  if (!threadId) {
    ctx.recordEvent(id, "reconciled", { operationKey, resolution: "dispatch_incomplete" })
    ctx.commands.complete(operationKey, {
      ok: false,
      state: "received",
      message: "Dispatch was interrupted before a thread was committed; dispatch again",
    })
    return
  }
  // Adopting the orphan is the only way not to leak it: a second dispatch would create a
  // second thread and leave this one running unobserved.
  try {
    ctx.recordEvent(id, "reconciled", { operationKey, resolution: "thread_adopted", threadId })
    ctx.transition(id, "dispatch_committed", { workerThreadId: threadId }, { reconciled: true })
  } catch (error) {
    ctx.commands.complete(operationKey, {
      ok: false,
      state: ctx.mustGet(id).state,
      message: `Thread ${threadId} could not be adopted: ${String(error)}`,
    })
    return
  }
  ctx.commands.complete(operationKey, {
    ok: true,
    state: "dispatched",
    message: "Adopted thread after restart",
  })
  // The adopted thread is now a run like any other: the run rules decide what it is worth.
  await safeReconcile(ctx, id)
}

/** The thread id `dispatch` journalled before it crashed, if it got that far. */
function journalledThreadId(ctx: ControllerContext, id: string): string | null {
  for (const event of ctx.store.events(id).reverse()) {
    if (event.type !== "thread_created") continue
    const threadId = event.payload.threadId
    if (typeof threadId === "string" && threadId.length > 0) return threadId
  }
  return null
}

async function safeReconcile(ctx: ControllerContext, id: string, attempt = 0): Promise<void> {
  try {
    await reconcileWorkOrder(ctx, id, attempt)
  } catch (error) {
    ctx.recordEvent(id, "reconcile_failed", { attempt, error: String(error) })
  }
}

/**
 * `attempt` bounds the reattach cycle: pass 0 may reattach to a live run, and the pass that
 * follows the reattached stream may not. A worker whose stream keeps dying is left in its run
 * state for the next boot or a cancel to settle, rather than reattached to forever.
 */
export async function reconcileWorkOrder(
  ctx: ControllerContext,
  id: string,
  attempt = 0,
): Promise<void> {
  // A closing factory reconciles nothing: its aborted signal would fail every worker call,
  // and a run tracked here would outlive the registry connection.
  if (ctx.signal.aborted) return
  const row = ctx.mustGet(id)
  switch (row.state) {
    case "dispatched":
    case "running":
      return reconcileRun(ctx, row, attempt)
    case "awaiting_approval":
      return reconcileAwaiting(ctx, row)
    case "exporting":
      return reconcileExporting(ctx, row)
    case "cancel_requested":
      await ctx.finishCancel(id, row.blockedReason === "budget_exhausted" ? "budget" : "operator")
      return
    default:
      return
  }
}

/** Rule 2: a run that was in flight when the factory stopped. */
async function reconcileRun(
  ctx: ControllerContext,
  row: WorkOrderRow,
  attempt: number,
): Promise<void> {
  const id = row.id
  const fail = (reason: string) =>
    ctx.transition(
      id,
      "run_ended_without_candidate",
      { failureReason: "ended_without_candidate" },
      { reconciled: true, reason },
    )
  if (!row.workerThreadId) {
    fail("no thread recorded")
    return
  }
  const threadId = row.workerThreadId
  const thread = await ctx.worker.getThread(threadId)
  // Every worker call is an await: a cancel may have moved the row meanwhile, and none of
  // the moves below is legal from where it left it.
  if (!isRunState(ctx.mustGet(id).state)) return
  if (!thread) {
    fail("thread not found on worker")
    return
  }
  const pending = await ctx.worker.pendingInterrupts(threadId)
  if (!isRunState(ctx.mustGet(id).state)) return
  if (pending.length > 0) {
    const gate = pending.length === 1 && pending[0] && isExportGate(pending[0]) ? pending[0] : null
    if (gate && row.candidateDigest && row.candidateVerified === true) {
      ctx.transition(
        id,
        "candidate_interrupt",
        { interruptId: gate.interruptId, awaitingSince: ctx.iso() },
        { reconciled: true, interruptId: gate.interruptId },
      )
      return
    }
    if (gate) {
      ctx.transition(
        id,
        "candidate_interrupt_without_digest",
        { interruptId: gate.interruptId, blockedReason: "candidate_digest_unknown" },
        { reconciled: true },
      )
      return
    }
    ctx.transition(
      id,
      "unexpected_interrupt",
      { interruptId: pending[0]?.interruptId ?? null, blockedReason: "unexpected_interrupt" },
      {
        reconciled: true,
        interruptIds: pending.map((p) => p.interruptId),
        kinds: pending.map((p) => p.kind),
      },
    )
    return
  }
  if (thread.status === "busy") {
    if (attempt > 0) {
      // Already reattached once this cycle and the turn is still live with nothing parked.
      ctx.recordEvent(id, "run_still_live", { threadId, attempt })
      return
    }
    let frames: AsyncIterable<StreamFrame>
    try {
      frames = await ctx.worker.reattach(threadId, ctx.signal)
    } catch (error) {
      ctx.recordEvent(id, "reattach_failed", { threadId, error: String(error) })
      return
    }
    ctx.recordEvent(id, "reattached", { threadId })
    ctx.track(id, ctx.observeRun(id, frames, { reconcileAttempt: attempt + 1 }))
    return
  }
  if (row.candidateDigest && (await receiptExists(ctx.outboxDir, row.candidateDigest))) {
    // Cannot happen without an approval; record it loudly rather than pretend it was exported.
    ctx.recordEvent(id, "unexpected_receipt", {
      path: receiptPath(ctx.outboxDir, row.candidateDigest),
    })
  }
  if (!isRunState(ctx.mustGet(id).state)) return
  fail(`thread ${thread.status} with no pending prompt`)
}

/** Rule 5: the prompt the operator is expected to answer must still be there. */
async function reconcileAwaiting(ctx: ControllerContext, row: WorkOrderRow): Promise<void> {
  if (!row.workerThreadId || !row.interruptId) {
    ctx.transition(
      row.id,
      "interrupt_vanished",
      { blockedReason: "interrupt_vanished" },
      { reconciled: true, reason: "no gate recorded" },
    )
    return
  }
  const pending = await ctx.worker.pendingInterrupts(row.workerThreadId)
  if (ctx.mustGet(row.id).state !== "awaiting_approval") return
  if (pending.length === 1 && pending[0]?.interruptId === row.interruptId) {
    ctx.recordEvent(row.id, "reconciled", {
      resolution: "gate_still_pending",
      interruptId: row.interruptId,
    })
    return
  }
  ctx.transition(
    row.id,
    "interrupt_vanished",
    { blockedReason: "interrupt_vanished" },
    { reconciled: true, expected: row.interruptId, pending: pending.map((p) => p.interruptId) },
  )
}

/** Rule 3: an export that was in progress. The receipt decides; nothing is resumed again. */
async function reconcileExporting(ctx: ControllerContext, row: WorkOrderRow): Promise<void> {
  const id = row.id
  if (row.candidateDigest && (await receiptExists(ctx.outboxDir, row.candidateDigest))) {
    const path = receiptPath(ctx.outboxDir, row.candidateDigest)
    const digest = row.candidateDigest
    if (ctx.mustGet(id).state !== "exporting") return
    ctx.store.transaction(() => {
      if (!ctx.store.delivery(id))
        ctx.store.recordDelivery({
          workOrderId: id,
          candidateDigest: digest,
          receiptPath: path,
          observedAt: ctx.iso(),
        })
      ctx.recordEvent(id, "delivery_observed", { receiptPath: path, reconciled: true })
      ctx.transition(id, "receipt_observed", {}, { reconciled: true })
    })
    return
  }
  if (ctx.mustGet(id).state !== "exporting") return
  ctx.transition(
    id,
    "export_unconfirmed",
    { blockedReason: "export_unconfirmed" },
    { reconciled: true, reason: "no receipt after restart" },
  )
}
