import { type ExportedState, exportedState, exportPath } from "../delivery/export.js"
import { isTerminal } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import type { StreamFrame } from "../worker/wire.js"
import type { ControllerContext } from "./context.js"
import { removeUnhandedManifest } from "./manifest-files.js"

const isRunState = (state: WorkOrderRow["state"]) => state === "dispatched" || state === "running"

/**
 * Startup reconciliation (spec: "Startup reconciliation"). Never re-dispatches. Open command
 * intents are settled first, then every non-terminal work order is inspected.
 *
 * One unreachable thread must not keep the factory from booting, so each work order's rules
 * run inside `safeReconcile`: a failure is journalled and the walk continues.
 */
export async function reconcileAll(ctx: ControllerContext): Promise<void> {
  // Loop 1 already applied the rules to these: a second pass at attempt 0 would reattach to a
  // live run twice (the first observer is then evicted from the runs map and no longer awaited
  // by close or settleRun) and would send a second cancel round trip to an unconfirmed
  // cancel_requested row.
  const handled = new Set<string>()
  for (const open of ctx.commands.open()) {
    // Guarded like the walk below: one row the worker or the log cannot answer for must not
    // stop the factory from booting.
    try {
      const row = ctx.store.get(open.workOrderId)
      if (!row) {
        ctx.commands.complete(open.operationKey, {
          ok: false,
          message: "Work order missing at reconciliation",
        })
        continue
      }
      handled.add(row.id)
      // A `received` row's thread, if any, is the lingering intake thread of an approved
      // draft, so "no thread" is not the test for an uncommitted dispatch: the test is
      // whether the thread `dispatch` journalled is one the row does not hold.
      if (
        open.intent.command === "dispatch" &&
        row.state === "received" &&
        (!row.workerThreadId || journalledThreadId(ctx, row.id) !== row.workerThreadId)
      ) {
        await settleIncompleteDispatch(ctx, row.id, open.operationKey)
        continue
      }
      // An `intake` that died between its manifest and its thread left a file no thread will
      // be admitted with; the rerun writes its own.
      if (open.intent.command === "intake") removeUnhandedManifest(ctx, row.id, "drafter")
      await safeReconcile(ctx, row.id)
      const final = ctx.mustGet(row.id)
      ctx.commands.complete(open.operationKey, {
        // A `retry` that committed its transition before the crash did what it was for.
        ok: open.intent.command === "retry" ? final.state === "received" : settledOk(final),
        state: final.state,
        message: `Reconciled after restart; work order is ${final.state}`,
      })
    } catch (error) {
      journal(ctx, open.workOrderId, "reconcile_failed", {
        operationKey: open.operationKey,
        error: String(error),
      })
    }
  }
  for (const row of ctx.store.list()) {
    if (!isTerminal(row.state) && !handled.has(row.id)) await safeReconcile(ctx, row.id)
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
    // The manifest was written and never handed to a thread: nothing will read it.
    removeUnhandedManifest(ctx, id, "builder")
    ctx.recordEvent(id, "reconciled", { operationKey, resolution: "dispatch_incomplete" })
    ctx.commands.complete(operationKey, {
      ok: false,
      state: "received",
      message: "Dispatch was interrupted before a thread was committed; dispatch again",
    })
    return
  }
  // Adopting the orphan is the only way not to leak it: a second dispatch would create a
  // second thread and leave this one running unobserved. The route is the target worker's,
  // as `dispatch` would have recorded it.
  try {
    const { route } = ctx.workerFor(ctx.mustGet(id))
    ctx.transition(
      id,
      "dispatch_committed",
      { workerThreadId: threadId, workerRoute: route },
      { reconciled: true },
    )
    // Journalled only once the row actually holds the thread: an adoption line above a
    // rolled-back transition would read as an adoption that never happened.
    ctx.recordEvent(id, "reconciled", { operationKey, resolution: "thread_adopted", threadId })
  } catch (error) {
    // The thread is still the worker's, unobserved: journalled so an operator can find it,
    // then the command is answered.
    ctx.recordEvent(id, "dispatch_adoption_failed", { threadId, error: String(error) })
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

/**
 * Did reconciliation settle this work order? A budget cancel's terminal row is `blocked`
 * with `budget_exhausted` — the limit was applied, so the command did what it was for.
 */
function settledOk(row: WorkOrderRow): boolean {
  if (row.state === "blocked") return row.blockedReason === "budget_exhausted"
  return row.state === "exported" || row.state === "cancelled" || row.state === "denied"
}

/** Journal a reconciliation note that must never itself abort the walk. */
function journal(
  ctx: ControllerContext,
  id: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  try {
    ctx.recordEvent(id, type, payload)
  } catch {
    // The row is gone (so the event has nothing to hang off) or the registry is closed.
  }
}

/**
 * The thread id `dispatch` journalled before it crashed, if it got that far. Only a thread
 * created since the last `retry` counts: the one before it is the abandoned attempt's, and
 * adopting it would hand the failed candidate's workspace to the new dispatch.
 */
function journalledThreadId(ctx: ControllerContext, id: string): string | null {
  for (const event of ctx.store.events(id).reverse()) {
    if (event.type === "retry") return null
    if (event.type !== "thread_created") continue
    const threadId = event.payload.threadId
    if (typeof threadId === "string" && threadId.length > 0) return threadId
  }
  return null
}

/** How a reconciliation pass was reached, for the rules that depend on the caller. */
export interface ReconcileOptions {
  /**
   * The call comes from the tracked run for this work order, handing its own dead stream on.
   * Only then may a pass reattach to a busy thread while a run is tracked: the observer it
   * would replace in the runs map is the one asking.
   */
  readonly fromTrackedRun?: boolean
}

async function safeReconcile(ctx: ControllerContext, id: string, attempt = 0): Promise<void> {
  try {
    await reconcileWorkOrder(ctx, id, attempt)
  } catch (error) {
    journal(ctx, id, "reconcile_failed", { attempt, error: String(error) })
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
  options: ReconcileOptions = {},
): Promise<void> {
  // A closing factory reconciles nothing: its aborted signal would fail every worker call,
  // and a run tracked here would outlive the registry connection.
  if (ctx.signal.aborted) return
  const row = ctx.mustGet(id)
  switch (row.state) {
    case "dispatched":
    case "running":
      return reconcileRun(ctx, row, attempt, options)
    case "intake_running":
      return reconcileIntake(ctx, row, attempt, options)
    case "verifying":
      return reconcileVerifying(ctx, row)
    case "exporting":
      return reconcileExporting(ctx, row)
    case "cancel_requested":
      await ctx.finishCancel(id, row.blockedReason === "budget_exhausted" ? "budget" : "operator")
      return
    // `awaiting_approval` has no rule: rung 1's gate is the controller's own frozen bundle,
    // recorded in the registry, and there is nothing parked on the worker to go missing. The
    // row is already everything the operator needs to decide, and `approve` re-verifies before
    // it writes, so a restart is not an event in its life at all.
    // `awaiting_intake_approval` has none for the same reason: the generated task is on disk
    // under the row's digest, the drafter thread is idle with nothing parked, and
    // `approveIntake` recomputes the digest from disk before it moves the row.
    default:
      return
  }
}

/** Rule 2: a run that was in flight when the factory stopped. */
async function reconcileRun(
  ctx: ControllerContext,
  row: WorkOrderRow,
  attempt: number,
  options: ReconcileOptions = {},
): Promise<void> {
  const id = row.id
  // A live observer already owns this run, and every rule below would step on it: reattaching
  // would `track` a second observer and evict the first from the runs map (so close(),
  // settleRun and cancel stop awaiting the one actually applying the turn rules), and the
  // other arms would judge a turn that is still being watched. Checked before the first
  // worker call, so a `cancel` or `deny` on a running row pays no round trip for a pass that
  // has nothing to do. A restart leaves a busy thread with nothing watching it, and then
  // nothing is tracked; the tracked run handing on its own dead stream says so with the flag,
  // and is the one caller allowed through.
  if (!options.fromTrackedRun && ctx.isTracked(id)) {
    ctx.recordEvent(id, "reconcile_skipped", {
      threadId: row.workerThreadId,
      attempt,
      reason: "observer_live",
    })
    return
  }
  const fail = (reason: string) =>
    ctx.transition(
      id,
      "turn_ended_without_changes",
      { failureReason: "ended_without_candidate" },
      { reconciled: true, reason },
    )
  if (!row.workerThreadId) {
    fail("no thread recorded")
    return
  }
  const threadId = row.workerThreadId
  // The one builder holds a run-state row's thread. A worker map that cannot serve the row
  // throws here, into `safeReconcile`'s journal: the row keeps its state for the operator.
  const worker = ctx.workerFor(row).client
  const thread = await worker.getThread(threadId)
  // Every worker call is an await: a cancel may have moved the row meanwhile, and none of
  // the moves below is legal from where it left it.
  if (!isRunState(ctx.mustGet(id).state)) return
  if (!thread) {
    // No workspace to read and no turn to wait for: there is nothing left to judge.
    fail("thread not found on worker")
    return
  }
  const pending = await worker.pendingInterrupts(threadId)
  if (!isRunState(ctx.mustGet(id).state)) return
  if (pending.length > 0) {
    // Rung 1's builder route has no gate to park on, so any prompt is an unexpected one —
    // the same judgement the run observer makes, made again from the worker's own list.
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
    let reattached: Reattachment
    try {
      reattached = await reattachLive(worker.reattach(threadId, ctx.signal))
    } catch (error) {
      ctx.recordEvent(id, "reattach_failed", { threadId, error: String(error) })
      return
    }
    if (!isRunState(ctx.mustGet(id).state)) {
      await reattached.close()
      return
    }
    if (reattached.live) {
      ctx.recordEvent(id, "reattached", { threadId })
      // The reattached observer carries this pass's number; the pass it opens when the stream
      // ends is the one that increments it.
      ctx.track(id, ctx.observeRun(id, reattached.frames, { reconcileAttempt: attempt }))
      return
    }
    // A thread the worker still calls busy, with no run behind it: see `reattachLive`. The
    // turn is over, so it is judged as one that ended.
    ctx.recordEvent(id, "reattach_not_live", { threadId, status: thread.status })
  }
  // The turn is over with nothing parked, so it left a workspace behind — exactly what the
  // end of a stream means when the controller is watching one. Whether that workspace holds
  // a candidate is the verifying phase's judgement, not this rule's.
  ctx.transition(id, "turn_ended_with_workspace", {}, { reconciled: true, status: thread.status })
  reverify(ctx, id)
}

/**
 * The intake rule: a drafter turn that was in flight when the factory stopped, or whose
 * stream a tracked run lost. The same shape as `reconcileRun`, with the intake observer and
 * `finishIntake` in place of the run observer and the verifying phase: a busy thread is
 * reattached once, an idle one has left a `draft/` for the controller to read and prove,
 * and a thread that is missing or parked on a prompt cannot finish, so the row blocks as
 * `intake_run_failed` (an unrecoverable turn, not a spent drafter attempt).
 */
async function reconcileIntake(
  ctx: ControllerContext,
  row: WorkOrderRow,
  attempt: number,
  options: ReconcileOptions = {},
): Promise<void> {
  const id = row.id
  // The same guard as `reconcileRun`: a live observer owns this run, and a second one would
  // evict it from the runs map. Only the tracked run handing on its own stream comes through.
  if (!options.fromTrackedRun && ctx.isTracked(id)) {
    ctx.recordEvent(id, "reconcile_skipped", {
      threadId: row.workerThreadId,
      attempt,
      reason: "observer_live",
    })
    return
  }
  const isIntake = () => ctx.mustGet(id).state === "intake_running"
  const fail = (reason: string, patch: Record<string, unknown> = {}) =>
    ctx.transition(
      id,
      "intake_blocked",
      { blockedReason: "intake_run_failed" },
      { reconciled: true, reason, ...patch },
    )
  if (!row.workerThreadId) {
    fail("no thread recorded")
    return
  }
  const threadId = row.workerThreadId
  // The drafter holds an `intake_running` row's thread; no drafter configured throws into
  // `safeReconcile`'s journal, and the row waits for the operator.
  const worker = ctx.drafter().client
  const thread = await worker.getThread(threadId)
  // Every worker call is an await: a cancel may have moved the row meanwhile.
  if (!isIntake()) return
  if (!thread) {
    fail("thread not found on worker")
    return
  }
  const pending = await worker.pendingInterrupts(threadId)
  if (!isIntake()) return
  if (pending.length > 0) {
    // The drafter route has no gate: a parked prompt is a turn that cannot finish.
    ctx.transition(
      id,
      "intake_blocked",
      { interruptId: pending[0]?.interruptId ?? null, blockedReason: "intake_run_failed" },
      {
        reconciled: true,
        reason: "the drafter is parked on an unexpected prompt",
        interruptIds: pending.map((p) => p.interruptId),
        kinds: pending.map((p) => p.kind),
      },
    )
    return
  }
  if (thread.status === "busy") {
    if (attempt > 0) {
      // Already reattached once this cycle and the turn is still live with nothing parked.
      ctx.recordEvent(id, "intake_still_live", { threadId, attempt })
      return
    }
    let reattached: Reattachment
    try {
      reattached = await reattachLive(worker.reattach(threadId, ctx.signal))
    } catch (error) {
      ctx.recordEvent(id, "reattach_failed", { threadId, error: String(error) })
      return
    }
    if (!isIntake()) {
      await reattached.close()
      return
    }
    if (reattached.live) {
      ctx.recordEvent(id, "reattached", { threadId, phase: "intake" })
      // The reattached observer carries this pass's number; the pass it opens when the stream
      // ends is the one that increments it, and that pass finishes the intake once idle.
      ctx.track(id, ctx.observeIntakeTurn(id, reattached.frames, { reconcileAttempt: attempt }))
      return
    }
    // A stale busy thread (see `reattachLive`): the turn is over, and its `draft/` is read
    // like any ended turn's. A missing or partial draft is then refused, spending an attempt.
    ctx.recordEvent(id, "reattach_not_live", { threadId, phase: "intake", status: thread.status })
  }
  // The turn is over with nothing parked: whatever it left under `draft/` is now the
  // controller's to read and prove. Tracked, not awaited, for the reason `reverify` gives:
  // the proof is container work with a deadline of its own, and a boot walk that waited on
  // it would have nothing listening meanwhile.
  ctx.recordEvent(id, "reconciled", {
    resolution: "finish_intake",
    state: row.state,
    status: thread.status,
  })
  // No post-condition check after the phase, unlike `reverify`'s `settleUndecided`: the
  // phase decides on every path but its own aborts, and a row it left in `intake_running`
  // is one a closing factory aborted (`intake_aborted`, for the next boot to finish) or one
  // a retry inside the phase reattached a new observer to. Blocking either would be wrong.
  ctx.track(
    id,
    ctx.finishIntake(id).catch((error) => {
      ctx.recordEvent(id, "reconcile_failed", { phase: "intake", error: String(error) })
    }),
  )
}

/** A reattached stream, once its first frame has said whether a run is behind it. */
type Reattachment = { readonly close: () => Promise<void> } & (
  | { readonly live: true; readonly frames: AsyncIterable<StreamFrame> }
  | { readonly live: false }
)

/**
 * Open a reattachment and read its first frame. The runtime answers a reattach with a
 * `state` frame first, and `live: false` there means no run is in memory behind the thread:
 * the turn ended, or the worker died mid-turn and came back. The second case is why this
 * exists. The runtime persists a thread's `busy` status across a crash (framework-gaps spec
 * §9), so after a `kill -9` a thread reads `busy` forever with no run to finish it; waiting
 * for one would leave the row `intake_still_live` (or `run_still_live`) on every pass. A
 * stream that ends before any frame says the same. Otherwise the first frame is handed back
 * in front of the rest, so the observer sees the stream exactly as the worker sent it.
 */
async function reattachLive(opening: Promise<AsyncIterable<StreamFrame>>): Promise<Reattachment> {
  const iterator = (await opening)[Symbol.asyncIterator]()
  const close = async () => {
    try {
      await iterator.return?.()
    } catch {
      // Closing a stream we are done with: nothing to report.
    }
  }
  const first = await iterator.next()
  if (first.done) return { live: false, close }
  if (first.value.event === "state" && notLive(first.value.data)) {
    await close()
    return { live: false, close }
  }
  const head = first.value
  async function* frames(): AsyncGenerator<StreamFrame> {
    yield head
    for (;;) {
      const next = await iterator.next()
      if (next.done) return
      yield next.value
    }
  }
  return { live: true, frames: frames(), close }
}

/** `live: false` exactly: a state frame that omits the field says nothing either way. */
function notLive(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { live?: unknown }).live === false
}

/**
 * Rule 7: a work order interrupted mid-verification. Verification has no durable external
 * effect — no bytes leave the controller until an approval is bound to a frozen bundle — so
 * the phase is never resumed and never re-dispatched: it is simply run again from the
 * controller's own baseline and the builder's workspace.
 */
async function reconcileVerifying(ctx: ControllerContext, row: WorkOrderRow): Promise<void> {
  ctx.recordEvent(row.id, "reconciled", { resolution: "reverify", state: row.state })
  reverify(ctx, row.id)
}

/**
 * Run the verifying phase again after a restart, as a tracked background run.
 *
 * Not awaited by the boot walk. The phase is container work with a deadline of its own, and
 * a boot that waited for it would have nothing listening meanwhile — no HTTP to take a
 * cancel, no budget ticker — so a verifier that hung would hold the whole factory down for
 * as long as its container ran. Tracked, it is a run like any other: `close()` waits for it
 * within its bound, and a cancel or an exhausted budget aborts it through the row's own
 * verification signal.
 *
 * The phase reads the builder's workspace itself and already has an answer for a workspace
 * that is no longer there — `workspace_unreadable`, journalled, then `inconclusive`, which
 * is what "the controller knows nothing about this candidate" means. Reconciliation does not
 * probe the workspace first: a second read costs another sandbox attach and workspace walk
 * per reconciled row, and the two reads can disagree. Nor could a probe honestly call a
 * vanished workspace a `scope_violation`, which is a statement about what the builder wrote —
 * nothing is known about the builder's work when the workspace is gone.
 *
 * What reconciliation does insist on is that the phase decide. `runVerification` returns
 * without a transition on any early exit (today: a row with no worker thread), and a
 * `verifying` row nobody moved is stranded for every later boot to rediscover. So the
 * post-condition below is checked against the row, not against any one cause: if the phase
 * came back and the row is still `verifying`, that is recorded and settled here.
 */
function reverify(ctx: ControllerContext, id: string): void {
  if (ctx.mustGet(id).state !== "verifying") return
  ctx.track(
    id,
    (async () => {
      try {
        await ctx.runVerification(id)
      } catch (error) {
        ctx.recordEvent(id, "reconcile_failed", { phase: "verifying", error: String(error) })
        settleUndecided(ctx, id, "the verifying phase could not be completed after restart")
        return
      }
      settleUndecided(ctx, id, "the verifying phase returned without deciding after restart")
    })(),
  )
}

/**
 * The verifying phase's post-condition: a row it left in `verifying` is one it declined to
 * decide. Nothing is known about the candidate, which is what `inconclusive` means, and the
 * reason says which of the two ways the phase came back.
 */
function settleUndecided(ctx: ControllerContext, id: string, reason: string): void {
  if (ctx.mustGet(id).state !== "verifying") return
  ctx.recordEvent(id, "verification_undecided", { reason })
  ctx.transition(
    id,
    "receipt_inconclusive",
    { blockedReason: "verification_inconclusive" },
    { reconciled: true, reason },
  )
}

/**
 * Rule 3: an export that was in progress. In rung 1 the controller writes the approved bytes
 * itself, named by the bundle digest it approved, so its own export directory — not a receipt
 * some worker was trusted to leave behind — is what says whether the write happened. Nothing
 * is resumed: the bytes are either there or they are not.
 *
 * "There" means the approved bundle and bytes, compared, not a file under the right name:
 * `exportApproved` will not call an existing file its own without reading it, and a rule
 * that marks a work order `exported` cannot hold a lower standard than the export did.
 */
async function reconcileExporting(ctx: ControllerContext, row: WorkOrderRow): Promise<void> {
  const id = row.id
  const unconfirmed = (reason: string) => {
    if (ctx.mustGet(id).state !== "exporting") return
    ctx.transition(
      id,
      "export_unconfirmed",
      { blockedReason: "export_unconfirmed" },
      { reconciled: true, reason },
    )
  }
  const bundle = row.bundleDigest ? ctx.evidence.bundle(row.bundleDigest) : null
  if (!bundle) {
    unconfirmed("no frozen bundle to export")
    return
  }
  const candidate = ctx.evidence.candidate(bundle.candidateDigest)
  if (!candidate) {
    unconfirmed("the frozen bundle's candidate is missing from the registry")
    return
  }
  // The same read `approve` makes: content-addressed, re-hashed against the digest asked for.
  let changes: Record<string, string>
  try {
    changes = JSON.parse(await ctx.artifacts.read(candidate.artifactDigest)) as Record<
      string,
      string
    >
  } catch (error) {
    ctx.recordEvent(id, "candidate_unreadable", { phase: "reconcile", error: String(error) })
    unconfirmed("the approved bytes could not be read to compare against the export")
    return
  }
  const path = exportPath(ctx.exportDir, bundle)
  let state: ExportedState
  try {
    state = await exportedState({ directory: ctx.exportDir, bundle, changes })
  } catch (error) {
    ctx.recordEvent(id, "export_unreadable", { receiptPath: path, error: String(error) })
    unconfirmed("the export directory could not be read after restart")
    return
  }
  switch (state) {
    case "exported":
      if (ctx.mustGet(id).state !== "exporting") return
      ctx.store.transaction(() => {
        if (!ctx.store.delivery(id))
          ctx.store.recordDelivery({
            workOrderId: id,
            candidateDigest: bundle.candidateDigest,
            receiptPath: path,
            observedAt: ctx.iso(),
          })
        ctx.recordEvent(id, "delivery_observed", { receiptPath: path, reconciled: true })
        ctx.transition(id, "receipt_observed", {}, { reconciled: true })
      })
      return
    case "differs":
      // Left in place for the operator: reconciliation never writes or removes exported
      // bytes, and whatever is under that name is evidence of something.
      ctx.recordEvent(id, "export_mismatch", { receiptPath: path, reconciled: true })
      unconfirmed("the file under the bundle's name is not the approved bundle")
      return
    case "missing":
      unconfirmed("no exported bytes after restart")
      return
  }
}
