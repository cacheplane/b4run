import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { BlockedReason } from "../domain/states.js"
import type { Receipt, WorkOrderRow } from "../domain/work-order.js"
import { DRAFT_ROOT, parseDraft } from "../intake/draft.js"
import { writeGeneratedTask } from "../intake/generated-task.js"
import { proveOracle } from "../intake/oracle.js"
import { intakePrompt } from "../prompts.js"
import { relativePath } from "../targets/catalog.js"
import { loadPolicy } from "../verification/policy.js"
import { classifyDone, type StreamFrame } from "../worker/wire.js"
import { WorkspaceRootMissingError, workspaceReadFailure } from "../worker/workspace-reader.js"
import type { ControllerContext } from "./context.js"
import { prepareWorkOrderImage } from "./images.js"
import { reconcileWorkOrder } from "./reconcile.js"
import { handedSourceDigest } from "./source-digest.js"
import { consumeTurn } from "./turns.js"
import type { DrafterWorker } from "./workers.js"

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

/** At most this many carried notes, each cut to `CARRIED_NOTE_CHARS`: a bounded prompt section. */
export const CARRIED_DECISIONS = 4
export const CARRIED_NOTE_CHARS = 1500

/**
 * The operator's `intake_rejected` notes on this issue (repository and number), from every work
 * order of it including this one, newest first, bounded. The live rerun of issue 714 lost the
 * operator's decision (200 with a JSON `null`, not an empty body) when a new work order
 * replaced the one it was written on, and the next drafter asserted the rejected shape again.
 * The row's own notes count too: a rejection reaches the next turn as its `note`, but the
 * controller's refusal of THAT redraft becomes the note after it, and the operator's decision
 * would be gone by the third attempt. Only `currentNote`, already quoted as the refusal, is
 * left out.
 */
export function carriedDecisions(
  ctx: ControllerContext,
  row: WorkOrderRow,
  currentNote?: string,
): string[] {
  if (row.origin.kind !== "issue") return []
  const { repository, number } = row.origin
  const notes: { at: string; seq: number; note: string }[] = []
  for (const other of ctx.store.list()) {
    if (other.origin.kind !== "issue") continue
    if (other.origin.repository !== repository || other.origin.number !== number) continue
    for (const event of ctx.store.events(other.id))
      if (
        event.type === "intake_rejected" &&
        typeof event.payload.note === "string" &&
        !(other.id === row.id && event.payload.note === currentNote)
      )
        notes.push({ at: event.at, seq: event.seq, note: event.payload.note })
  }
  return notes
    .sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1))
    .slice(0, CARRIED_DECISIONS)
    .map(({ note }) =>
      note.length > CARRIED_NOTE_CHARS ? `${note.slice(0, CARRIED_NOTE_CHARS)}…` : note,
    )
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
  try {
    await runDrafterTurn(ctx, id, input)
  } catch (error) {
    // The backstop `finishIntake` has, for the turn: whatever escapes the faults below would
    // otherwise reach `track()`'s `run_observer_error` and leave the row in `intake_running`
    // with no turn and nothing to say why.
    ctx.recordEvent(id, "intake_phase_error", { phase: "run", error: String(error) })
    block(ctx, id, "intake_run_failed", { reason: "the intake run failed", error: String(error) })
  }
}

async function runDrafterTurn(
  ctx: ControllerContext,
  id: string,
  input: IntakeInput,
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
  // An issue row always has a pin (`createFromIssue` requires one); a row without is a fault
  // of whoever made it, and there is no commit to list prepared targets at.
  if (row.pin === null) {
    block(ctx, id, "intake_run_failed", { reason: "the work order has no pin to draft at" })
    return
  }
  // The prompt lists the targets prepared at the pin from disk, and a catalog that cannot be
  // read is a refusal to start the turn, not a fault to leave the row stranded on.
  let prompt: string
  try {
    const decisions = carriedDecisions(ctx, row, input.note)
    if (decisions.length > 0)
      ctx.recordEvent(id, "intake_decisions_carried", { count: decisions.length })
    prompt = intakePrompt({
      pin: row.pin,
      issueText: issue,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(decisions.length > 0 ? { decisions } : {}),
    })
  } catch (error) {
    ctx.recordEvent(id, "intake_prompt_failed", { error: String(error) })
    block(ctx, id, "intake_run_failed", { reason: "the drafter prompt could not be built" })
    return
  }
  let frames: AsyncIterable<StreamFrame>
  try {
    const drafter = ctx.drafter()
    frames = await drafter.client.startRun(threadId, drafter.route, prompt, ctx.signal)
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
  const result = await consumeTurn(frames, {
    // `consumeTurn` calls this at most once per stream.
    onFirstFrame: async () => {
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
    ctx.recordEvent(id, type, {
      phase: "intake",
      error: String(error),
      ...workspaceReadFailure(error),
    })
    block(ctx, id, "intake_run_failed", { reason, error: String(error) })
  }

  // The `intake` command refused before the thread existed; a row that reaches here with no
  // drafter is a fault of this process (the map changed under it), not a state to spend an
  // attempt on.
  let drafter: DrafterWorker
  try {
    drafter = ctx.drafter()
  } catch (error) {
    block(ctx, id, "intake_run_failed", { reason: String(error) })
    return
  }
  // The read is re-rooted at `draft/` (the reader's `root`), so the keys already carry the
  // prefix `parseDraft` expects and nothing under `repo/` was walked.
  let draft: ReadonlyMap<string, string>
  const readStarted = Date.now()
  try {
    // The drafter answers for the thread only with the source intake handed it; any other
    // refusal (the thread or workspace gone, a turn in flight, a timeout, an answer about
    // another source) is a read the controller could not make, not a verdict on the draft.
    const sourceDigest = handedSourceDigest(ctx.store.events(id), threadId, "drafter")
    draft = await drafter.reader.read({ threadId, sourceDigest }, signal)
  } catch (error) {
    // The one read failure that IS a verdict on the draft: the thread was reached and there
    // is nothing where the draft belongs. The drafter's fault, and an attempt spent on it.
    if (error instanceof WorkspaceRootMissingError && !signal.aborted) {
      await refuse(
        ctx,
        id,
        error.kind === "absent"
          ? `${DRAFT_ROOT} is missing: the drafter wrote nothing under it`
          : `${DRAFT_ROOT} is not a directory: the drafter must write files under it`,
        "intake_invalid",
        new Map(),
      )
      return
    }
    unavailable("workspace_unreadable", error, "the drafter workspace could not be read")
    return
  }
  // What the re-rooted read returned, on the record: the paths are the drafter's whole
  // output as the controller saw it, and a count under the inspection bound with a duration
  // of seconds is the journal's own evidence that `repo/` was never walked.
  ctx.recordEvent(id, "draft_read", {
    files: [...draft.keys()].sort(),
    ms: Date.now() - readStarted,
  })
  // The read was an await: a cancel may have moved the row, and nothing below is legal from
  // where it left it.
  if (!isIntake(ctx.mustGet(id).state)) return

  // The pin the work order was created at: the generated task carries it, so the target, the
  // baseline, the image and the policy are all looked up at it.
  const { pin } = ctx.mustGet(id)
  if (pin === null) {
    block(ctx, id, "intake_run_failed", { reason: "the work order has no pin to draft at" })
    return
  }
  const parsed = parseDraft(draft, { workOrderId: id, pin })
  if (!parsed.ok) {
    // The catalog failed the controller, not the drafter: no attempt is spent on it.
    if (parsed.blockedReason === "intake_run_failed") {
      unavailable("target_unavailable", parsed.reason, "the draft's target could not be loaded")
      return
    }
    await refuse(ctx, id, parsed.reason, parsed.blockedReason, draft)
    return
  }
  // The fit step's image (spec item 4): the drafted target at the work order's pin, built now
  // if this host has none, journalled with its log, and bound to this attempt, which proves
  // its oracle in it. Its time is not the work order's (the budget is paused around it), and a
  // failure is not the drafter's: the row blocks with no attempt spent.
  const image = await prepareWorkOrderImage(ctx, id, parsed.target, signal, { rebind: true })
  if (!image.ok) {
    if (image.kind === "aborted") {
      ctx.recordEvent(id, "intake_aborted", { reason: String(signal.reason) })
      return
    }
    block(ctx, id, "image_prepare_failed", { reason: image.reason })
    return
  }
  if (!isIntake(ctx.mustGet(id).state)) return

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
    const why = await inconclusiveReason(ctx, proof.receipt, proof.checkId)
    await refuse(
      ctx,
      id,
      `the drafted check did not fail on the unpatched baseline: ${proof.verdict} (${proof.checkId ?? "no check ran"})${why ? `: ${why}` : ""}`,
      "oracle_did_not_fail",
      draft,
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
 * Where a refused attempt's draft is kept: `<generatedTasksDir>/.refused/<id>/attempt-<n>/`.
 * Not under the task directory itself (`<generatedTasksDir>/<id>/`): that directory is
 * replaced wholesale by the next attempt's `writeGeneratedTask`, and digested wholesale by
 * the approval gate, so a copy there would either be lost or change the digest a person
 * approves. A dot name is not a catalog id, so the catalog never lists it as a task.
 */
export function refusedDraftDir(ctx: ControllerContext, id: string, attempt: number): string {
  return join(ctx.generatedTasksDir, ".refused", id, `attempt-${attempt}`)
}

/**
 * Copy what the controller read under `draft/` for a refused attempt, with the refusal as
 * `reason.txt`, so an operator can read what the model produced after the retry overwrites
 * the drafter's own `draft/`. The keys are drafter-controlled: only canonical relative paths
 * are written (the rest are named in `reason.txt`), so none can land outside the directory.
 * Best effort: a copy that cannot be written is journalled and the refusal proceeds.
 */
function keepRefusedDraft(
  ctx: ControllerContext,
  id: string,
  attempt: number,
  reason: string,
  draft: ReadonlyMap<string, string>,
): { readonly keptAt: string; readonly files: readonly string[] } | undefined {
  const directory = refusedDraftDir(ctx, id, attempt)
  try {
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    const files: string[] = []
    const skipped: string[] = []
    for (const [key, content] of draft) {
      const path = key.startsWith(DRAFT_ROOT) ? key.slice(DRAFT_ROOT.length) : key
      if (path === "reason.txt" || path.includes("\0") || !relativePath.safeParse(path).success) {
        skipped.push(key)
        continue
      }
      const absolute = join(directory, path)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, content)
      files.push(path)
    }
    const note = skipped.length
      ? `\n\nNot copied (not a canonical path under ${DRAFT_ROOT}): ${skipped.map((k) => JSON.stringify(k)).join(", ")}`
      : ""
    writeFileSync(join(directory, "reason.txt"), `attempt ${attempt}: ${reason}${note}\n`)
    return { keptAt: directory, files: files.sort() }
  } catch (error) {
    ctx.recordEvent(id, "refused_draft_unkept", { attempt, path: directory, error: String(error) })
    return undefined
  }
}

/**
 * A draft the controller will not take. The attempt is spent either way; a
 * `no_target_for_package` never retries (no redraft can prepare a target), and the last
 * attempt blocks as `intake_attempts_exhausted` with the refusal in the journal. Otherwise
 * the row stays `intake_running` through `intake_retry` and another turn runs on the same
 * thread with the reason quoted. What was read is kept first (`keepRefusedDraft`), since the
 * retry's turn rewrites the drafter's `draft/` in place.
 */
async function refuse(
  ctx: ControllerContext,
  id: string,
  reason: string,
  refusal: "intake_invalid" | "no_target_for_package" | "oracle_did_not_fail",
  draft: ReadonlyMap<string, string>,
): Promise<void> {
  const current = ctx.mustGet(id)
  if (!isIntake(current.state)) return
  const attempt = current.intakeAttempts + 1
  const kept = keepRefusedDraft(ctx, id, attempt, reason, draft)
  ctx.recordEvent(id, "intake_refused", {
    reason,
    blockedReason: refusal,
    attempt,
    ...(kept ? { keptAt: kept.keptAt, keptFiles: kept.files } : {}),
  })
  const exhausted = attempt >= current.maxIntakeAttempts
  const final = refusal === "no_target_for_package"
  if (final || exhausted) {
    // The row's reason and the transition's agree; the refusal that spent the last attempt
    // rides beside it as `lastRefusal`, and each `intake_refused` above keeps its own.
    const blockedReason = final ? refusal : "intake_attempts_exhausted"
    ctx.transition(
      id,
      "intake_blocked",
      { blockedReason, intakeAttempts: attempt },
      { reason, blockedReason, lastRefusal: refusal, attempt },
    )
    return
  }
  ctx.transition(id, "intake_retry", { intakeAttempts: attempt }, { reason, attempt })
  await runIntake(ctx, id, { note: reason })
}

/**
 * The first line of an `inconclusive:` explanation the verifier put at the head of the
 * deciding check's evidence (a check that could not load, or failed other than by a named
 * assertion), so the redraft is told what to mend. Best effort: an evidence store that cannot
 * be read leaves the refusal as it was.
 */
async function inconclusiveReason(
  ctx: ControllerContext,
  receipt: Receipt,
  checkId: string | null,
): Promise<string | null> {
  const check = receipt.checks.find((c) => c.id === checkId)
  const digest = check?.verdict === "inconclusive" ? check.evidence[0]?.digest : undefined
  if (digest === undefined) return null
  try {
    const first = (await ctx.artifacts.read(digest)).split("\n", 1)[0] ?? ""
    return first.startsWith("inconclusive: ") ? first.slice("inconclusive: ".length) : null
  } catch {
    return null
  }
}
