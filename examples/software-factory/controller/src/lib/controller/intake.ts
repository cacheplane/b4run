import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { BlockedReason } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import { DRAFT_ROOT, parseDraft } from "../intake/draft.js"
import { writeGeneratedTask } from "../intake/generated-task.js"
import { proveOracle } from "../intake/oracle.js"
import { intakePrompt } from "../prompts.js"
import { loadPolicy } from "../verification/policy.js"
import { classifyDone, type StreamFrame } from "../worker/wire.js"
import type { ControllerContext } from "./context.js"
import { reconcileWorkOrder } from "./reconcile.js"
import { consumeTurn } from "./turns.js"

/**
 * The intake phase (spec §6.5), mirroring `verify.ts`: one drafter turn on the work order's
 * intake thread, then the controller's own reading of what it left under `draft/`. Nothing
 * the drafter wrote is trusted at any step: the draft is parsed, fitted to a prepared
 * target, materialised as a task, and its check is shown to FAIL on the unpatched baseline
 * before a person is asked to approve it.
 *
 * Every exit is a recorded transition or a journalled return, and a refusal with attempts
 * remaining runs another turn on the SAME thread (the drafter keeps its `draft/`) with the
 * refusal quoted in the prompt. The caller tracks the whole chain as one run.
 */

export interface IntakeInput {
  /** The previous attempt's refusal, or the operator's rejection note, quoted in the prompt. */
  readonly note?: string
}

export interface ObserveIntakeOptions {
  /**
   * Set when reconciliation reattached to a drafter turn already in flight. A reattached
   * stream carries only the tail of the turn, so its end is not read as the turn's end: the
   * worker is re-read by the pass after this one, which then finishes the intake.
   */
  readonly reconcileAttempt?: number
}

const isIntake = (state: WorkOrderRow["state"]) => state === "intake_running"

/** The intake_blocked transition every unrecoverable exit takes, when the row is still ours. */
function block(
  ctx: ControllerContext,
  id: string,
  blockedReason: BlockedReason,
  payload: Record<string, unknown>,
): void {
  if (!isIntake(ctx.mustGet(id).state)) return
  ctx.transition(id, "intake_blocked", { blockedReason }, payload)
}

/**
 * One drafter attempt: the turn, then `finishIntake`. The row is already `intake_running`
 * with its intake thread recorded (the `intake` command and `reject_intake` do both before
 * calling here), so a row without a thread is a fault, not a state to wait in.
 */
export async function runIntake(
  ctx: ControllerContext,
  id: string,
  input: IntakeInput = {},
): Promise<void> {
  const row = ctx.mustGet(id)
  if (!isIntake(row.state)) return
  if (!row.workerThreadId) {
    block(ctx, id, "intake_run_failed", { reason: "no intake thread recorded" })
    return
  }
  const threadId = row.workerThreadId
  let issue: string
  try {
    issue = readIssue(ctx, id)
  } catch (error) {
    ctx.recordEvent(id, "intake_issue_missing", { error: String(error) })
    block(ctx, id, "intake_run_failed", { reason: "issue.md could not be read" })
    return
  }
  const prompt = intakePrompt({
    issueText: issue,
    ...(input.note !== undefined ? { note: input.note } : {}),
  })
  let frames: AsyncIterable<StreamFrame>
  try {
    frames = await ctx.worker.startRun(threadId, ctx.intakeRoute, prompt, ctx.signal)
  } catch (error) {
    ctx.recordEvent(id, "stream_lost", { phase: "intake_start", error: String(error) })
    // A closing factory or a cancel aborted the start; the row is theirs, not this run's.
    if (ctx.signal.aborted) return
    block(ctx, id, "intake_run_failed", { reason: "the drafter turn could not be started" })
    return
  }
  await observeIntakeTurn(ctx, id, frames)
}

/** `<generatedTasksDir>/<id>/issue.md`, what `createFromIssue` wrote. */
function readIssue(ctx: ControllerContext, id: string): string {
  return readFileSync(join(ctx.generatedTasksDir, id, "issue.md"), "utf8")
}

/**
 * The drafter's turn. The drafter route has no gate, so any prompt parked on it is a turn
 * that cannot finish; a cancelled turn is the cancel command's to settle. A clean end hands
 * the workspace to `finishIntake`; a lost stream, and the end of a reattached one, are
 * reconciled against the worker rather than trusted.
 */
export async function observeIntakeTurn(
  ctx: ControllerContext,
  id: string,
  frames: AsyncIterable<StreamFrame>,
  options: ObserveIntakeOptions = {},
): Promise<void> {
  const reattached = options.reconcileAttempt !== undefined
  let started = false
  const result = await consumeTurn(frames, {
    onFirstFrame: async () => {
      if (started) return
      started = true
      ctx.recordEvent(id, "intake_run_started", { ...(reattached ? { reattached: true } : {}) })
    },
    onInterrupt: async (frame) => {
      if (!isIntake(ctx.mustGet(id).state)) return
      ctx.recordEvent(id, "intake_unexpected_interrupt", {
        interruptId: frame.interruptId,
        kind: frame.kind,
      })
      ctx.transition(
        id,
        "intake_blocked",
        { interruptId: frame.interruptId, blockedReason: "intake_run_failed" },
        { reason: "the drafter parked on an unexpected prompt", interruptId: frame.interruptId },
      )
    },
    onDone: async (data) => {
      const { error, cancelled } = classifyDone(data)
      // Journalled before the state guard: the cancel command has already moved the row by
      // the time this frame arrives, and the line would otherwise never be written.
      if (cancelled) {
        ctx.recordEvent(id, "intake_run_cancelled_observed", {})
        return
      }
      if (!isIntake(ctx.mustGet(id).state)) return
      if (error) {
        block(ctx, id, "intake_run_failed", { reason: "the drafter turn failed", error })
        return
      }
      ctx.recordEvent(id, "intake_turn_ended", {
        ...(reattached ? { reattached: true, attempt: options.reconcileAttempt } : {}),
      })
    },
  })
  if (result.ended === "handler_error") {
    // A controller fault, not a worker fault: not a lost stream, and not something to
    // reconcile on the strength of.
    ctx.recordEvent(id, "intake_observer_error", { error: result.error ?? null })
    return
  }
  if (result.ended === "lost")
    ctx.recordEvent(id, "stream_lost", { phase: "intake", error: result.error ?? null })
  // The worker, not this stream, is the authority on whether the turn is over: a lost stream
  // is reconciled, and so is the end of a stream reconciliation itself reattached (its
  // `done` may be the tail of a turn the pass before saw only the head of). A pass that
  // finds the thread idle finishes the intake; one that finds it busy reattaches once.
  if (result.ended === "lost" || reattached) {
    await reconcileWorkOrder(ctx, id, reattached ? (options.reconcileAttempt ?? 0) + 1 : 0, {
      fromTrackedRun: true,
    })
    return
  }
  if (isIntake(ctx.mustGet(id).state)) await finishIntake(ctx, id)
}

/**
 * Read `draft/`, parse it, materialise the task, prove its check fails on the baseline, and
 * park the row for a person — or refuse, and retry or block. Guarded by a backstop like
 * `runVerification`: whatever escapes the specific faults below is journalled and blocks the
 * row, so no path leaves `intake_running` with nothing to say why.
 */
export async function finishIntake(ctx: ControllerContext, id: string): Promise<void> {
  const row = ctx.mustGet(id)
  if (!isIntake(row.state)) return
  if (!row.workerThreadId) {
    block(ctx, id, "intake_run_failed", { reason: "no intake thread recorded" })
    return
  }
  const signal = ctx.intakeSignal(id)
  try {
    await proveDraft(ctx, id, row.workerThreadId, signal)
  } catch (error) {
    ctx.recordEvent(id, "intake_phase_error", { error: String(error) })
    block(ctx, id, "intake_run_failed", { reason: "the intake phase failed", error: String(error) })
  }
}

async function proveDraft(
  ctx: ControllerContext,
  id: string,
  threadId: string,
  signal: AbortSignal,
): Promise<void> {
  /**
   * A read or a harness the controller could not run is not a verdict on the draft: it is
   * the controller admitting it does not know, which blocks as `intake_run_failed` rather
   * than spending one of the drafter's attempts. An aborted one is the controller's own
   * doing (the row left `intake_running`, or the factory is closing) and the row is already
   * whoever aborted it's.
   */
  const unavailable = (type: string, error: unknown, reason: string): void => {
    if (signal.aborted) {
      ctx.recordEvent(id, "intake_aborted", { reason: String(signal.reason) })
      return
    }
    ctx.recordEvent(id, type, { phase: "intake", error: String(error) })
    block(ctx, id, "intake_run_failed", { reason, error: String(error) })
  }

  if (ctx.intakeTaskId === undefined) {
    block(ctx, id, "intake_run_failed", {
      reason: "intake is not configured: set FACTORY_INTAKE_TASK",
    })
    return
  }
  let observed: ReadonlyMap<string, string>
  try {
    observed = await ctx.workspaceReader.read({ threadId, taskId: ctx.intakeTaskId }, signal)
  } catch (error) {
    unavailable("workspace_unreadable", error, "the drafter workspace could not be read")
    return
  }
  // The read was an await: a cancel may have moved the row, and nothing below is legal from
  // where it left it.
  if (!isIntake(ctx.mustGet(id).state)) return

  const draft = new Map<string, string>()
  for (const [path, content] of observed) if (path.startsWith(DRAFT_ROOT)) draft.set(path, content)
  const parsed = parseDraft(draft, { workOrderId: id })
  if (!parsed.ok) {
    await refuse(ctx, id, parsed.reason, parsed.blockedReason)
    return
  }

  // Read before the task is written: materialising replaces the directory wholesale, and
  // `issue.md` is one of the files it writes back.
  let issue: string
  try {
    issue = readIssue(ctx, id)
  } catch (error) {
    ctx.recordEvent(id, "intake_issue_missing", { error: String(error) })
    block(ctx, id, "intake_run_failed", { reason: "issue.md could not be read" })
    return
  }
  const generated = writeGeneratedTask(ctx.generatedTasksDir, parsed, { issueText: issue })
  ctx.recordEvent(id, "task_generated", {
    taskDigest: generated.digest,
    target: parsed.manifest.target,
    files: generated.files,
  })
  // The catalog search path now resolves `id`: the policy is the generated task's own.
  const policy = loadPolicy(id)

  let baseline: Awaited<ReturnType<typeof ctx.captureBaseline>>
  try {
    baseline = await ctx.captureBaseline(id, signal)
  } catch (error) {
    unavailable("baseline_unavailable", error, "the baseline could not be captured")
    return
  }
  if (!isIntake(ctx.mustGet(id).state)) return

  let proof: Awaited<ReturnType<typeof proveOracle>>
  try {
    proof = await proveOracle({
      verifier: ctx.verifier,
      workOrderId: id,
      taskId: id,
      policyDigest: policy.policyDigest,
      baselineDigest: baseline.digest,
      signal,
    })
  } catch (error) {
    unavailable("verifier_unavailable", error, "the oracle proof could not run")
    return
  }
  // One unit, as in the verifying phase: a receipt row with no journal line would leave an
  // auditor unable to say which of the two is the truth.
  const { receipt } = proof
  ctx.store.transaction(() => {
    ctx.evidence.recordReceipt(receipt)
    ctx.recordEvent(id, "oracle_receipt", {
      receiptId: receipt.id,
      verdict: receipt.verdict,
      checkId: proof.proven ? "independent" : proof.checkId,
      proven: proof.proven,
    })
  })
  if (!isIntake(ctx.mustGet(id).state)) return

  if (!proof.proven) {
    await refuse(
      ctx,
      id,
      `the drafted check did not fail on the unpatched baseline: ${proof.verdict} (${proof.checkId ?? "no check ran"})`,
      "oracle_did_not_fail",
    )
    return
  }
  const current = ctx.mustGet(id)
  ctx.transition(
    id,
    "intake_drafted",
    {
      targetId: parsed.manifest.target,
      taskDigest: generated.digest,
      intakeAttempts: current.intakeAttempts + 1,
    },
    { taskDigest: generated.digest, receiptId: receipt.id, attempt: current.intakeAttempts + 1 },
  )
}

/**
 * A draft the controller will not take. The attempt is spent either way; a
 * `no_target_for_package` never retries (no redraft can prepare a target), and the last
 * attempt blocks as `intake_attempts_exhausted` with the refusal in the journal. Otherwise
 * the row stays `intake_running` through `intake_retry` and another turn runs on the same
 * thread with the reason quoted.
 */
async function refuse(
  ctx: ControllerContext,
  id: string,
  reason: string,
  blockedReason: "intake_invalid" | "no_target_for_package" | "oracle_did_not_fail",
): Promise<void> {
  const current = ctx.mustGet(id)
  if (!isIntake(current.state)) return
  const attempt = current.intakeAttempts + 1
  ctx.recordEvent(id, "intake_refused", { reason, blockedReason, attempt })
  const exhausted = attempt >= current.maxIntakeAttempts
  if (blockedReason === "no_target_for_package" || exhausted) {
    ctx.transition(
      id,
      "intake_blocked",
      {
        blockedReason:
          blockedReason === "no_target_for_package" ? blockedReason : "intake_attempts_exhausted",
        intakeAttempts: attempt,
      },
      { reason, blockedReason, attempt },
    )
    return
  }
  ctx.transition(id, "intake_retry", { intakeAttempts: attempt }, { reason, attempt })
  await runIntake(ctx, id, { note: reason })
}
