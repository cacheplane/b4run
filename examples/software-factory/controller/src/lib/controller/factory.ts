import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { DEFAULT_WORKER_ROUTE } from "../config.js"
import { exportApproved } from "../delivery/export.js"
import { canon } from "../domain/digest.js"
import { CommandInFlightError, UnknownTaskError, UnknownWorkOrderError } from "../domain/errors.js"
import {
  ACTIVE_STATES,
  IllegalTransitionError,
  isTerminal,
  nextState,
  type TransitionEvent,
} from "../domain/states.js"
import {
  type Bundle,
  type Candidate,
  COMMIT_PATTERN,
  type CommandOutcome,
  type FactoryEvent,
  type IssueOrigin,
  IssueOriginSchema,
  type Receipt,
  type WorkOrderRow,
} from "../domain/work-order.js"
import {
  type WriteDrafterManifestOptions,
  type WrittenDrafterManifest,
  writeDrafterManifest as writeDrafterManifestOnDisk,
} from "../drafter-manifest.js"
import { digestGeneratedTask } from "../intake/generated-task.js"
import { issueText } from "../intake/issue.js"
import { oracleReceiptIdFor } from "../intake/oracle.js"
import { promptFor } from "../prompts.js"
import { type CommandLog, createCommandLog } from "../registry/commands.js"
import { openRegistry } from "../registry/db.js"
import { createEvidenceStore, type EvidenceStore } from "../registry/evidence.js"
import { createWorkOrderStore, type WorkOrderPatch } from "../registry/work-orders.js"
import { BundlePayloadSchema } from "../review/bundle.js"
import { type ArtifactStore, createArtifactStore } from "../storage/artifacts.js"
import { type CatalogOptions, isShippedTask, loadTask, repositoryRoot } from "../targets/catalog.js"
import { loadPolicy } from "../verification/policy.js"
import type { Verifier } from "../verification/verifier.js"
import type { CancelResult, WorkerClient } from "../worker/client.js"
import type { InterruptFrame, StreamFrame } from "../worker/wire.js"
import { type BudgetTicker, startBudgetTicker } from "./budget.js"
import type { ControllerContext } from "./context.js"
import { finishIntake, observeIntakeTurn, removeDrafterManifest, runIntake } from "./intake.js"
import { reconcileAll, reconcileWorkOrder } from "./reconcile.js"
import { denyPending, observeRun } from "./run-observer.js"
import { consumeTurn } from "./turns.js"
import { runVerification } from "./verify.js"
import {
  DRAFTER_UNCONFIGURED,
  DrafterUnconfiguredError,
  type DrafterWorker,
  NoWorkerForTargetError,
  type TargetWorker,
  type WorkerMap,
} from "./workers.js"

export interface FactoryOptions {
  readonly registryPath: string
  /**
   * One builder worker per target and one drafter (`createWorkerMap` in the runtime). Every
   * worker call goes through the row: `workerFor` for the target's builder, `drafter()` for
   * the intake thread, `workerOfThread` for whichever holds the row's thread right now.
   */
  readonly workers: WorkerMap
  /** Where the approved bytes are written, and the bundle's destination identity. */
  readonly exportDir: string
  /** Content-addressed evidence store for candidate and check output. */
  readonly artifactsDir: string
  /**
   * Where an issue work order's `issue.md` (and later its drafted task) is written, under a
   * directory named by the work order id. Must be the directory `configureCatalog` was given,
   * or the catalog will never find what intake writes; the runtime passes the one config value
   * to both.
   */
  readonly generatedTasksDir: string
  readonly verifier: Verifier
  /**
   * Writes the drafter manifest `intake` hands the drafter before it creates the thread: the
   * wide capture of the repository at the row's pin. Injected so tests need neither the
   * repository at a real pin nor the capture; the runtime uses the real writer.
   */
  readonly writeDrafterManifest?: (
    options: WriteDrafterManifestOptions,
  ) => Promise<WrittenDrafterManifest>
  /** The controller's own baseline for a task. Injected so tests need no container. */
  captureBaseline(
    taskId: string,
    signal: AbortSignal,
  ): Promise<{ readonly digest: string; readonly files: ReadonlyMap<string, string> }>
  readonly maxChangedBytes?: number
  /**
   * Task id to prompt, consulted INSTEAD of the catalog when given: a test's fixed table.
   * Without it every prompt is resolved from the catalog at the point of use.
   */
  readonly tasks?: Readonly<Record<string, string>>
  /**
   * Scopes ONLY the prompt lookup to a fixture catalog: for a test that drives create and
   * the dispatch refusal over tasks the shipped catalog does not have. Policy, baseline, the
   * verifier and the workspace reader read the process-wide search path `configureCatalog`
   * sets, so a test that must dispatch a fixture task successfully uses that instead.
   */
  readonly promptCatalog?: CatalogOptions
  readonly approvalTtlMs?: number
  readonly maxActiveMs?: number
  /** Drafter turns an intake may spend before it blocks. Default 2. */
  readonly maxIntakeAttempts?: number
  /** How long a cancel waits for the cancelled run's observer to settle. Default 10s. */
  readonly cancelSettleMs?: number
  readonly budgetTickMs?: number
  /** How long close() waits for tracked runs to settle after aborting them. */
  readonly closeTimeoutMs?: number
  readonly now?: () => number
  readonly actor?: string
  readonly log?: (event: string, payload: Record<string, unknown>) => void
}

export interface Factory {
  create(input: { taskId: string; operationKey?: string }): Promise<WorkOrderRow>
  /**
   * A work order from a GitHub issue: the origin and the pin are recorded on the row, the
   * issue text is written as `<generatedTasksDir>/<id>/issue.md`, and `taskId` is the id
   * itself, which is where intake will later materialise the drafted task.
   */
  createFromIssue(input: {
    origin: IssueOrigin
    pin: string
    issue: { title: string; body: string }
    operationKey?: string
  }): Promise<WorkOrderRow>
  /**
   * Start the drafter turn for an issue work order: from `received` with an issue origin,
   * to `intake_running`. The tracked run reads, proves and parks the draft, or blocks.
   */
  intake(id: string, operationKey?: string): Promise<CommandOutcome>
  /**
   * The intake gate: the digest of the generated task on disk, recomputed now, must equal
   * both the row's and the caller's. Approval returns the work order to `received`, where
   * `dispatch` starts the rung 2 lifecycle on the generated task.
   */
  approveIntake(
    id: string,
    input: { revision: number; taskDigest: string; operationKey?: string },
  ): Promise<CommandOutcome>
  /** Journal the note and, attempts permitting, run another drafter turn with it quoted. */
  rejectIntake(id: string, input: { note: string; operationKey?: string }): Promise<CommandOutcome>
  dispatch(id: string, operationKey?: string): Promise<CommandOutcome>
  approve(
    id: string,
    input: { revision: number; bundleDigest: string; operationKey?: string },
  ): Promise<CommandOutcome>
  deny(id: string, operationKey?: string): Promise<CommandOutcome>
  cancel(id: string, operationKey?: string): Promise<CommandOutcome>
  show(id: string): WorkOrderRow | null
  list(): WorkOrderRow[]
  events(id: string): FactoryEvent[]
  /** The frozen evidence behind the row: what an approver is asked to consent to. */
  evidence(id: string): {
    candidate: Candidate | null
    receipt: Receipt | null
    bundle: Bundle | null
    /** The receipt that proved the approved draft's check fails on the baseline; null without intake. */
    oracleReceipt: Receipt | null
  }
  waitFor(
    id: string,
    predicate: (row: WorkOrderRow) => boolean,
    timeoutMs?: number,
  ): Promise<WorkOrderRow>
  /**
   * Wait for the tracked background run of `id` (the builder turn and the verification
   * that follows it) to settle, then return the row once it has left the active states.
   * Times out with the row's current state in the message.
   */
  settle(id: string, timeoutMs: number): Promise<WorkOrderRow>
  /**
   * `settle` for an intake: the tracked run is the drafter turn and the read-and-prove that
   * follows it (and any retry), and `intake_running` is an active state, so the same wait
   * serves. Kept as its own name so a caller says which run it is waiting on.
   */
  settleIntake(id: string, timeoutMs: number): Promise<WorkOrderRow>
  /** Reconcile one work order now (what boot does for all of them). */
  reconcileWorkOrder(id: string): Promise<void>
  /**
   * The boot walk, on demand: settles open command intents and applies the rules to every
   * non-terminal row, each inside its own guard. What `/reconcile` calls.
   */
  reconcileAll(): Promise<void>
  close(): Promise<void>
}

// Re-exported where they have always been imported from: moving the classes must not make
// every caller change its import.
export { CommandInFlightError, UnknownTaskError, UnknownWorkOrderError }

export async function createFactory(options: FactoryOptions): Promise<Factory> {
  const registry = openRegistry(options.registryPath)
  const store = createWorkOrderStore(registry.db)
  const commands: CommandLog = createCommandLog(registry.db)
  const evidenceStore: EvidenceStore = createEvidenceStore(registry.db)
  const artifacts: ArtifactStore = createArtifactStore(options.artifactsDir)
  const log = options.log ?? (() => {})
  /**
   * The prompt for `taskId`, or the Error saying why the catalog cannot serve it. Resolved
   * at the point of use and never at boot: one unprepared sibling target must not decide
   * whether the controller boots, and a task generated after boot is dispatchable the moment
   * its directory lands. A task the catalog cannot load is reported here, once per use.
   */
  const prompt = (taskId: string): string | Error => {
    if (options.tasks) return options.tasks[taskId] ?? new Error(`Unknown task ${taskId}`)
    try {
      return promptFor(taskId, options.promptCatalog ?? {})
    } catch (error) {
      log("task_unavailable", { id: taskId, error: String(error) })
      return error instanceof Error ? error : new Error(String(error))
    }
  }
  const now = options.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  const abort = new AbortController()
  const runs = new Map<string, Promise<void>>()
  /**
   * One per work order in a container phase (`verifying`, `intake_running`); aborted the
   * moment the row leaves that state. A work order is in at most one such phase at a time,
   * so one entry per id serves both.
   */
  const phases = new Map<string, AbortController>()
  const PHASE_STATES: ReadonlySet<WorkOrderRow["state"]> = new Set(["verifying", "intake_running"])
  const INTAKE_STATES: ReadonlySet<WorkOrderRow["state"]> = new Set([
    "intake_running",
    "awaiting_intake_approval",
  ])
  let closed = false
  /** Started only once reconciliation has run, so no tick can race the boot rules. */
  let ticker: BudgetTicker | null = null

  /** Sleep that resolves (rather than rejecting) when close() aborts. */
  const quietSleep = (ms: number) => sleep(ms, undefined, { signal: abort.signal }).catch(() => {})

  const mustGet = (id: string): WorkOrderRow => {
    const row = store.get(id)
    if (!row) throw new UnknownWorkOrderError(id)
    return row
  }

  const recordEvent = (id: string, type: string, payload: Record<string, unknown> = {}) => {
    store.appendEvent(id, type, payload, iso())
    log(type, { id, ...payload })
  }

  /**
   * Manifest removals a transition decided while a caller's own transaction was open. An
   * `rm` cannot be rolled back, so it never runs inside a transaction: `transition` performs
   * it after its own commits, and a caller that wraps `transition` in an outer transaction
   * (`approveIntake`, `rejectIntake`) goes through `outerTransaction`, which flushes these
   * once it has committed.
   */
  let outerDepth = 0
  const pendingRemovals = new Set<string>()
  const flushRemovals = () => {
    for (const id of [...pendingRemovals]) {
      pendingRemovals.delete(id)
      removeDrafterManifest(ctx, id)
    }
  }
  const outerTransaction = <T>(fn: () => T): T => {
    outerDepth += 1
    try {
      return store.transaction(fn)
    } finally {
      outerDepth -= 1
      if (outerDepth === 0) flushRemovals()
    }
  }
  const leftIntakeStates = (from: WorkOrderRow["state"], to: WorkOrderRow["state"]) =>
    INTAKE_STATES.has(from) && !INTAKE_STATES.has(to) && to !== "cancel_requested"

  const transition = (
    id: string,
    event: TransitionEvent,
    patch: WorkOrderPatch = {},
    payload: Record<string, unknown> = {},
  ): WorkOrderRow => {
    let leftIntake = false
    const updated = store.transaction(() => {
      const row = mustGet(id)
      const to = nextState(row.state, event)
      const accounting: WorkOrderPatch = {}
      const wasActive = ACTIVE_STATES.has(row.state)
      const willBeActive = ACTIVE_STATES.has(to)
      if (wasActive && !willBeActive) {
        const open = row.activeStartedAt ? Math.max(0, now() - Date.parse(row.activeStartedAt)) : 0
        accounting.activeMs = row.activeMs + open
        accounting.activeStartedAt = null
      } else if (!wasActive && willBeActive) {
        accounting.activeStartedAt = iso()
      }
      const updated = store.update(id, row.revision, { ...patch, ...accounting, state: to }, iso())
      recordEvent(id, "transition", { event, from: row.state, to, ...payload })
      // Container work for a row that has left its phase has no one to report to: abort it
      // now rather than let it run to the verifier's own deadline. An `intake_retry` keeps
      // the row in `intake_running`, and so keeps its signal.
      if (PHASE_STATES.has(row.state) && to !== row.state) {
        phases.get(id)?.abort()
        phases.delete(id)
      }
      // Decided here, where the move is known; performed below, once it has committed.
      leftIntake = leftIntakeStates(row.state, to)
      return updated
    })
    // The drafter manifest lives until the intake thread has been admitted or never will
    // be: removed when the row leaves the intake states for good (a block, an approval),
    // not on a redraft (`intake_retry`, `reject_intake` stay inside them) and not on a
    // cancel, whose `finishCancel` removes it once the thread itself is settled. The removal
    // follows the committed transition in the journal, and never runs inside a transaction:
    // a caller's outer one defers it until that has committed too.
    if (leftIntake) {
      if (outerDepth === 0) removeDrafterManifest(ctx, id)
      else pendingRemovals.add(id)
    }
    return updated
  }

  const phaseSignal = (id: string): AbortSignal => {
    let controller = phases.get(id)
    if (!controller) {
      controller = new AbortController()
      phases.set(id, controller)
    }
    return AbortSignal.any([abort.signal, controller.signal])
  }
  const verificationSignal = phaseSignal
  const intakeSignal = phaseSignal

  const finish = (operationKey: string, outcome: CommandOutcome): CommandOutcome => {
    commands.complete(operationKey, outcome)
    return outcome
  }

  const track = (id: string, run: Promise<void>) => {
    const tracked: Promise<void> = run
      .catch((error) => {
        try {
          recordEvent(id, "run_observer_error", { error: String(error) })
        } catch {
          // close() gave up on this run and took the registry with it: there is nothing left
          // to journal the fault on, and throwing here would be an unhandled rejection.
        }
      })
      .finally(() => {
        if (runs.get(id) === tracked) runs.delete(id)
      })
    runs.set(id, tracked)
  }

  /**
   * Waiting is wall-clock work, not domain time: an injected `now` (tests, replay) must not
   * be able to freeze or fast-forward it. An abort means stop waiting, not fail.
   */
  const settleRun = async (id: string, timeoutMs: number) => {
    const run = runs.get(id)
    if (!run) return
    await Promise.race([run, quietSleep(timeoutMs)])
  }

  /**
   * The target a row's builder thread belongs to: recorded on the row at `intake_drafted`
   * for a generated task, the catalog's for a shipped one. A fixed prompt table (`tasks`)
   * names no catalog, and the wildcard entry is the only one that can serve it. A task the
   * catalog cannot load throws the catalog's own error: that is the task's fault (an
   * unprepared target, say), which `dispatch` reports as such, not a missing worker.
   */
  function targetOf(row: WorkOrderRow): string {
    if (row.targetId !== null) return row.targetId
    if (options.tasks) return "*"
    return loadTask(row.taskId, options.promptCatalog ?? {}).target.id
  }
  const workerFor = (row: WorkOrderRow): TargetWorker => {
    const targetId = targetOf(row)
    const worker = options.workers.forTarget(targetId)
    if (worker === undefined) throw new NoWorkerForTargetError(targetId)
    return worker
  }
  const drafter = (): DrafterWorker => {
    const worker = options.workers.drafter
    if (worker === undefined) throw new DrafterUnconfiguredError()
    return worker
  }
  /** Did `intake` record `row.workerThreadId` as the thread it created for the drafter? */
  function isJournalledIntakeThread(row: WorkOrderRow): boolean {
    if (row.workerThreadId === null) return false
    return store
      .events(row.id)
      .some(
        (event) =>
          event.type === "intake_thread_created" && event.payload.threadId === row.workerThreadId,
      )
  }
  /** Is the row's thread the drafter's? See `ControllerContext.workerOfThread`. */
  function holdsIntakeThread(row: WorkOrderRow): boolean {
    switch (row.state) {
      case "intake_running":
      case "awaiting_intake_approval":
        return true
      case "received":
        return row.taskDigest !== null && row.workerThreadId !== null
      // A cancel or a block can come from either phase, and the state alone no longer says
      // which: the journal, written before the row ever held the thread, does.
      case "cancel_requested":
      case "blocked":
        return isJournalledIntakeThread(row)
      default:
        return false
    }
  }
  const workerOfThread = (row: WorkOrderRow) =>
    holdsIntakeThread(row) ? drafter() : workerFor(row)

  /**
   * Is there a turn on `threadId` for the cancel to interrupt, and is the thread there at
   * all? The worker is the authority, not the controller's in-memory `runs` map: after a
   * restart that map is empty, and while a run is draining its last frames the map still
   * holds a promise for a turn that has parked. An unreadable status is treated as live —
   * cancelling a parked thread is a tolerated 409, whereas skipping the cancel of a live one
   * leaks a run. A 404 (`missing`) is different: there is nothing to cancel and nothing to
   * deny on a thread the worker does not have.
   */
  async function threadLiveness(
    id: string,
    worker: WorkerClient,
    threadId: string,
  ): Promise<"live" | "ended" | "missing" | "unknown"> {
    try {
      const thread = await worker.getThread(threadId)
      if (!thread) return "missing"
      return thread.status === "busy" ? "live" : "ended"
    } catch (error) {
      recordEvent(id, "thread_status_unknown", { error: String(error) })
      return "unknown"
    }
  }

  /**
   * Shared by the cancel command, the budget ticker, and reconciliation. Cancels a live run,
   * denies whatever prompt is still parked, and applies the terminal cancel row for `cause`.
   *
   * Nothing reaches a terminal cancel row without evidence: an undelivered cancel or an
   * undelivered denial leaves the work order in `cancel_requested` and returns it unchanged,
   * which is exactly the state reconciliation knows how to finish on the next boot. Callers
   * read the returned row — never the fact that this function was called — as the outcome.
   */
  async function finishCancel(id: string, cause: "operator" | "budget"): Promise<WorkOrderRow> {
    const row = mustGet(id)
    if (row.workerThreadId) {
      const threadId = row.workerThreadId
      // Which worker holds the thread is the row's to say; a row whose worker is no longer
      // configured (the drafter removed, a target's entry dropped) has nowhere to send the
      // cancel, and stays `cancel_requested` for the operator to fix the map and reconcile.
      let worker: WorkerClient
      try {
        worker = workerOfThread(row).client
      } catch (error) {
        recordEvent(id, "worker_unavailable", { phase: "cancel", error: String(error) })
        return mustGet(id)
      }
      const intakeThread = holdsIntakeThread(row)
      const liveness = await threadLiveness(id, worker, threadId)
      let result: CancelResult | null = null
      if (liveness === "live" || liveness === "unknown") {
        try {
          result = await worker.cancel(threadId)
        } catch (error) {
          // The turn may well still be running: a row reading `cancelled` here would be a
          // claim the worker never confirmed.
          recordEvent(id, "worker_cancel_failed", { error: String(error) })
          return mustGet(id)
        }
        recordEvent(id, "worker_cancel", { result })
        await settleRun(id, options.cancelSettleMs ?? 10_000)
      }
      if (liveness !== "missing" && result !== "thread_not_found") {
        try {
          await denyPending(ctx, id)
        } catch (error) {
          // A prompt still parked on the worker is a turn still waiting on us.
          recordEvent(id, "pending_deny_failed", { error: String(error) })
          return mustGet(id)
        }
      }
      // The intake thread is settled: whatever the manifest was for, it has been admitted or
      // never will be.
      if (intakeThread) removeDrafterManifest(ctx, id)
    }
    try {
      return cause === "budget"
        ? transition(id, "run_ended_after_budget", { blockedReason: "budget_exhausted" })
        : transition(id, "run_ended_after_cancel")
    } catch (error) {
      // Something else settled the row while this cancel was talking to the worker.
      if (!(error instanceof IllegalTransitionError)) throw error
      recordEvent(id, "cancel_transition_skipped", { cause, error: String(error) })
      return mustGet(id)
    }
  }

  // The narrow view the run observer, the verifying phase and reconciliation share.
  const ctx: ControllerContext = {
    store,
    commands,
    evidence: evidenceStore,
    artifacts,
    verifier: options.verifier,
    workerFor,
    drafter,
    workerOfThread,
    generatedTasksDir: options.generatedTasksDir,
    exportDir: options.exportDir,
    maxChangedBytes: options.maxChangedBytes ?? 256 * 1024,
    signal: abort.signal,
    verificationSignal,
    intakeSignal,
    now,
    iso,
    mustGet,
    recordEvent,
    transition,
    observeRun: (id, frames, observeOptions) => observeRun(ctx, id, frames, observeOptions),
    captureBaseline: (taskId, signal) => options.captureBaseline(taskId, signal),
    runVerification: (id) => runVerification(ctx, id),
    observeIntakeTurn: (id, frames, observeOptions) =>
      observeIntakeTurn(ctx, id, frames, observeOptions),
    finishIntake: (id) => finishIntake(ctx, id),
    denyPending: (id) => denyPending(ctx, id),
    finishCancel: (id, cause) => finishCancel(id, cause),
    settleRun,
    track,
    isTracked: (id) => runs.has(id),
  }

  /**
   * Run the builder's turn on `id`'s thread. `input` is the prompt dispatch already resolved;
   * an entry that reaches here without one (none today: dispatch is the only caller) resolves
   * it itself, so this never sends an empty prompt.
   */
  async function startRun(id: string, input = prompt(mustGet(id).taskId)): Promise<void> {
    const row = mustGet(id)
    if (!row.workerThreadId) return
    if (input instanceof Error) {
      recordEvent(id, "prompt_missing", { taskId: row.taskId })
      return
    }
    let frames: AsyncIterable<StreamFrame>
    try {
      const worker = workerFor(row)
      frames = await worker.client.startRun(row.workerThreadId, worker.route, input, abort.signal)
    } catch (error) {
      recordEvent(id, "stream_lost", { phase: "run_start", error: String(error) })
      return
    }
    await observeRun(ctx, id, frames)
    // The turn is over; what it left behind is now the controller's to judge.
    if (mustGet(id).state === "verifying") await runVerification(ctx, id)
  }

  /** The thread a crashed `intake` journalled before it could commit it to the row, if any. */
  function journalledIntakeThreadId(id: string): string | null {
    for (const event of store.events(id).reverse()) {
      if (event.type !== "intake_thread_created") continue
      const threadId = event.payload.threadId
      if (typeof threadId === "string" && threadId.length > 0) return threadId
    }
    return null
  }

  /** The generated task's digest as it is on disk right now, or the reason it cannot be read. */
  function diskTaskDigest(id: string): { digest: string } | { error: unknown } {
    try {
      return { digest: digestGeneratedTask(join(options.generatedTasksDir, id)) }
    } catch (error) {
      return { error }
    }
  }

  /**
   * The insert both creates share. A caller-supplied operationKey is also the work-order
   * address: the same key always names the same id, which is what makes create idempotent
   * across a crash: a spent key whose row exists returns that row untouched.
   */
  function insertWorkOrder(
    operationKey: string | undefined,
    /** Both the command's recorded args and the `created` event's payload. */
    payload: Record<string, unknown>,
    fields: (id: string) => Pick<WorkOrderRow, "taskId" | "origin" | "pin">,
  ): WorkOrderRow {
    const id = operationKey
      ? `wo-${createHash("sha256").update(operationKey).digest("hex").slice(0, 16)}`
      : `wo-${randomUUID().replace(/-/g, "").slice(0, 16)}`
    const key = operationKey ?? `create:${id}`
    const begun = commands.begin(key, id, { command: "create", args: payload }, iso())
    if (begun.status === "in_flight") throw new CommandInFlightError(key)
    // A spent key with no row is a crash between the command log and the insert. The id is
    // derived from the key, so re-running the insert is idempotent rather than a second work
    // order — and throwing here would leave that key permanently unusable.
    if (begun.status === "done") {
      const existing = store.get(id)
      if (existing) return existing
    }
    const at = iso()
    const row: WorkOrderRow = {
      id,
      revision: 0,
      state: "received",
      ...fields(id),
      // The route of the row's current thread: rewritten when a thread is committed to the
      // row (`intake_started`, `dispatch_committed`), whose worker decides it.
      workerRoute: DEFAULT_WORKER_ROUTE,
      workerThreadId: null,
      interruptId: null,
      candidateDigest: null,
      bundleDigest: null,
      blockedReason: null,
      failureReason: null,
      maxCandidateAttempts: 1,
      maxActiveMs: options.maxActiveMs ?? 1_200_000,
      activeMs: 0,
      activeStartedAt: null,
      awaitingSince: null,
      targetId: null,
      taskDigest: null,
      intakeAttempts: 0,
      maxIntakeAttempts: options.maxIntakeAttempts ?? 2,
      createdAt: at,
      updatedAt: at,
    }
    store.transaction(() => {
      store.insert(row)
      recordEvent(id, "created", payload)
      // Only a fresh key has an outcome left to record; a replayed one already has its own.
      if (begun.status === "new")
        commands.complete(key, { ok: true, state: "received", message: "Created" })
    })
    return row
  }

  const factory: Factory = {
    async create({ taskId, operationKey }) {
      // Shipped catalog only, decided BEFORE the key is spent. The search path also resolves
      // generated tasks, so without this a draft left under `<state>/tasks/` (refused, or
      // never approved) could be created as a catalog work order with `taskDigest: null`,
      // and dispatch and approve would bind nothing: a generated task is reachable only
      // through `createFromIssue` + `intake` + `approveIntake`. An injected `tasks` map is
      // the test seam and names its own catalog.
      if (!options.tasks && !isShippedTask(taskId, options.promptCatalog?.tasksDir))
        throw new UnknownTaskError(taskId)
      if (prompt(taskId) instanceof Error) throw new UnknownTaskError(taskId)
      return insertWorkOrder(operationKey, { taskId }, () => ({
        taskId,
        origin: { kind: "catalog" },
        pin: null,
      }))
    },

    async createFromIssue({ origin, pin, issue, operationKey }) {
      // Refused before the key is spent, like `create`'s task guard: the row parse inside the
      // insert would roll the row back but leave the command in flight until the next boot.
      const parsedOrigin = IssueOriginSchema.safeParse(origin)
      if (!parsedOrigin.success) {
        const [issue] = parsedOrigin.error.issues
        const at = issue?.path.length ? `origin.${issue.path.join(".")}` : "origin"
        throw new Error(`${at} is not an issue origin: ${issue?.message}`)
      }
      if (!COMMIT_PATTERN.test(pin)) throw new Error(`pin must be a 40-hex commit sha, got ${pin}`)
      const row = insertWorkOrder(operationKey, { origin, pin }, (id) => ({
        taskId: id,
        origin,
        pin,
      }))
      // The issue text lands after the row: a directory with only `issue.md` is not a task the
      // catalog lists, so nothing can dispatch it. Written only when absent, so a replayed key
      // rewrites nothing and a crash between the insert and this write is repaired by the replay.
      const directory = join(options.generatedTasksDir, row.id)
      const path = join(directory, "issue.md")
      if (!existsSync(path)) {
        mkdirSync(directory, { recursive: true })
        writeFileSync(
          path,
          issueText({ ...issue, repository: origin.repository, number: origin.number }),
        )
      }
      return row
    },

    async intake(id, operationKey) {
      const row = mustGet(id)
      // Refused BEFORE the key is spent: a `received` row's revision does not change on a
      // refusal, so a refusal recorded under `intake:<id>:<revision>` would replay to every
      // later call at that revision — including the one after the operator sets
      // `FACTORY_DRAFTER_APP_ROOT` and restarts. None of these three is a function of the row's
      // revision (same principle as `createFromIssue`'s validation).
      const unspent = (message: string): CommandOutcome => ({
        ok: false,
        state: row.state,
        message,
      })
      if (row.origin.kind !== "issue") return unspent("Cannot intake a catalog work order")
      // An approved task is bound to the row's digest until dispatch: a redraft would replace
      // the directory a person consented to, under the same id. Only a `received` row's digest
      // means "approved" (a parked row's is the one awaiting approval); any other state is the
      // revision-bound refusal below.
      if (row.state === "received" && row.taskDigest !== null)
        return unspent(
          "Work order already has an approved task; reject-intake is the only way back",
        )
      // Refused here, not discovered after a thread and a turn were spent: without a drafter,
      // nothing can run the turn or read what it wrote.
      if (options.workers.drafter === undefined) return unspent(DRAFTER_UNCONFIGURED)
      const drafterWorker = options.workers.drafter
      const key = operationKey ?? `intake:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "intake", args: {} }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      const refuse = (message: string) =>
        finish(key, { ok: false, state: mustGet(id).state, message })
      if (row.state !== "received") return refuse(`Cannot intake from ${row.state}`)
      // A retry after a rejection redrafts on the thread the first intake made: the drafter
      // keeps its `draft/`, and the row already names it.
      // A crashed `intake` journals `intake_thread_created` before `intake_started` reaches
      // the row (the same window `dispatch` leaves): a rerun adopts that thread rather than
      // leaving it idle on the worker and making a second one.
      let threadId = row.workerThreadId ?? journalledIntakeThreadId(id)
      let created = false
      if (!threadId) {
        // The manifest first: the drafter's resolver reads it when the thread's first run is
        // admitted, so a thread created before it exists would be one nothing can serve. A
        // redraft (the thread exists) writes nothing — the thread was admitted with its
        // manifest, and the pin cannot change.
        if (row.pin === null) return refuse("An issue work order has no pin to draft at")
        try {
          const written = await (options.writeDrafterManifest ?? writeDrafterManifestOnDisk)({
            workOrderId: id,
            pin: row.pin,
            repositoryRoot: options.promptCatalog?.repositoryRoot ?? repositoryRoot(),
            dir: drafterWorker.manifestDir,
            signal: abort.signal,
          })
          recordEvent(id, "drafter_manifest_written", {
            path: written.path,
            sourceDigest: written.sourceDigest,
          })
        } catch (error) {
          recordEvent(id, "drafter_manifest_failed", { error: String(error) })
          return refuse(`drafter manifest could not be written: ${String(error)}`)
        }
        try {
          threadId = await drafterWorker.client.createThread({
            factoryWorkOrderId: id,
            factoryStage: "intake",
          })
        } catch (error) {
          // No thread will ever be admitted with this manifest: the next intake writes its own.
          removeDrafterManifest(ctx, id)
          return refuse(`Thread creation failed: ${String(error)}`)
        }
        created = true
        // Journalled before the transition, as dispatch does, so a crash in between leaves
        // the thread id in the event log rather than leaking it.
        recordEvent(id, "intake_thread_created", { threadId })
      }
      let started: WorkOrderRow
      try {
        started = transition(
          id,
          "intake_started",
          { workerThreadId: threadId, workerRoute: drafterWorker.route },
          { threadId },
        )
      } catch (error) {
        // A cancel moved the row while the worker was creating the thread.
        if (!(error instanceof IllegalTransitionError)) throw error
        if (created) {
          recordEvent(id, "thread_orphaned", { threadId })
          try {
            await drafterWorker.client.cancel(threadId)
          } catch (cancelError) {
            recordEvent(id, "worker_cancel_failed", { threadId, error: String(cancelError) })
          }
          // The cancel that moved the row found no thread on it, so it removed nothing: the
          // manifest written a moment ago is this path's to remove.
          removeDrafterManifest(ctx, id)
        }
        return refuse("Work order changed state while starting intake")
      }
      const outcome = finish(key, { ok: true, state: started.state, message: "Intake started" })
      track(id, runIntake(ctx, id, {}))
      return outcome
    },

    async approveIntake(id, { revision, taskDigest, operationKey }) {
      const row = mustGet(id)
      // Recomputed from disk before the key is spent, never read back from the row: the gate
      // binds what the person read to what the builder and the verifier will be given, and a
      // file edited under the directory since intake is exactly what it must catch.
      const onDisk = diskTaskDigest(id)
      // The default key carries the caller's digest, as the bundle digest does for `approve`,
      // AND the digest on disk at call time. `approve` needs only the former because every
      // refusal it can give is a function of the row's revision, which changes with the row;
      // this gate's disk check is not — a refused approval whose file is then restored is a
      // new intent, and a key without the disk digest would replay the refusal to it forever.
      // A repeat of the same call over the same bytes still replays.
      const key =
        operationKey ??
        `approve_intake:${id}:${revision}:${taskDigest}:${"digest" in onDisk ? onDisk.digest : "unreadable"}`
      const begun = commands.begin(
        key,
        id,
        { command: "approve_intake", args: { revision, taskDigest } },
        iso(),
      )
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      const refuse = (message: string) =>
        finish(key, { ok: false, state: mustGet(id).state, message })
      if (row.state !== "awaiting_intake_approval")
        return refuse(`Cannot approve intake from ${row.state}`)
      if (row.revision !== revision)
        return refuse(`Stale revision ${revision}; work order is at ${row.revision}`)
      if ("error" in onDisk) {
        recordEvent(id, "generated_task_unreadable", { error: String(onDisk.error) })
        return refuse(`Generated task unreadable: ${String(onDisk.error)}`)
      }
      if (onDisk.digest !== row.taskDigest)
        return refuse("Task digest does not match the generated task on disk")
      if (taskDigest !== row.taskDigest)
        return refuse("Task digest does not match the work order's")
      try {
        outerTransaction(() => {
          transition(id, "approve_intake", {}, { taskDigest, operationKey: key })
          recordEvent(id, "intake_approved", { taskDigest })
        })
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error
        return refuse("Work order changed state while approving intake")
      }
      return finish(key, { ok: true, state: mustGet(id).state, message: "Intake approved" })
    },

    async rejectIntake(id, { note, operationKey }) {
      const row = mustGet(id)
      const key = operationKey ?? `reject_intake:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "reject_intake", args: { note } }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      const refuse = (message: string) =>
        finish(key, { ok: false, state: mustGet(id).state, message })
      if (row.state !== "awaiting_intake_approval")
        return refuse(`Cannot reject intake from ${row.state}`)
      // The rejection is journalled whichever way the row goes: it is the person's reason,
      // and the next drafter turn (if there is one) quotes it.
      let next: WorkOrderRow
      try {
        next = outerTransaction(() => {
          recordEvent(id, "intake_rejected", { note, attempt: row.intakeAttempts })
          // The rejected draft is no longer the row's, whichever way the row goes: its digest
          // and target are cleared so nothing (a `show`, the evidence, a later approve-intake)
          // can mistake it for the one being drafted, or for one a blocked row still holds.
          if (row.intakeAttempts >= row.maxIntakeAttempts)
            return transition(
              id,
              "intake_blocked",
              { blockedReason: "intake_attempts_exhausted", taskDigest: null, targetId: null },
              { reason: note, operationKey: key },
            )
          return transition(
            id,
            "reject_intake",
            { taskDigest: null, targetId: null },
            { reason: note, operationKey: key },
          )
        })
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error
        return refuse("Work order changed state while rejecting intake")
      }
      if (next.state === "blocked")
        return finish(key, {
          ok: true,
          state: next.state,
          message: "Intake rejected; no drafter attempts remain",
        })
      const outcome = finish(key, {
        ok: true,
        state: next.state,
        message: "Intake rejected; redrafting",
      })
      track(id, runIntake(ctx, id, { note }))
      return outcome
    },

    async dispatch(id, operationKey) {
      const row = mustGet(id)
      // An approved generated task is bound to the digest the person consented to, and the
      // gate recomputed it at approval; this is the other end of that binding, so the window
      // between approval and dispatch cannot hand the builder a task nobody approved.
      // Checked BEFORE the key is spent, as `intake`'s config check is: what is on disk is
      // not a function of the row's revision, and a refusal recorded under
      // `dispatch:<id>:<revision>` would replay to the dispatch after the file is restored.
      if (row.taskDigest !== null && row.state === "received") {
        const onDisk = diskTaskDigest(id)
        if ("error" in onDisk) {
          recordEvent(id, "generated_task_unreadable", {
            phase: "dispatch",
            error: String(onDisk.error),
          })
          return {
            ok: false,
            state: row.state,
            message: `Generated task unreadable: ${String(onDisk.error)}`,
          }
        }
        if (onDisk.digest !== row.taskDigest) {
          recordEvent(id, "generated_task_changed", {
            phase: "dispatch",
            approved: row.taskDigest,
            onDisk: onDisk.digest,
          })
          return {
            ok: false,
            state: row.state,
            message: "Generated task on disk no longer matches the approved digest",
          }
        }
      }
      // The worker map is the operator's configuration, not a function of the row: refused
      // before the key is spent, so the dispatch after the entry is added is not a replay.
      // The target is the catalog's to name, and a task the catalog cannot load is the
      // prompt refusal's below, under the key: only a resolved target can lack a worker.
      let targetId: string | undefined
      try {
        targetId = targetOf(row)
      } catch {
        targetId = undefined
      }
      if (targetId !== undefined && row.state === "received") {
        if (options.workers.forTarget(targetId) === undefined) {
          recordEvent(id, "no_worker_for_target", { targetId })
          return {
            ok: false,
            state: row.state,
            message: new NoWorkerForTargetError(targetId).message,
          }
        }
      }
      const key = operationKey ?? `dispatch:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "dispatch", args: {} }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      if (row.state !== "received")
        return finish(key, {
          ok: false,
          state: row.state,
          message: `Cannot dispatch from ${row.state}`,
        })
      // Refuse rather than send an empty prompt: a worker asked to fix nothing still burns a
      // thread and a run, and the resulting turn would fail in a way that looks like the worker.
      // Re-resolved here rather than trusted from create: the task may have stopped loading
      // since (its target re-prepared, say), and that is a refusal, not a throw. The cause
      // rides along so an unprepared target is not reported as a task nobody has heard of.
      const input = prompt(row.taskId)
      if (input instanceof Error)
        return finish(key, {
          ok: false,
          state: row.state,
          message: options.tasks
            ? `Unknown task ${row.taskId}`
            : `Unknown task ${row.taskId}: ${input.message}`,
        })
      // The prompt loaded, so the task loads and names its target; a map with no entry for
      // it is the refusal above, now under the key.
      targetId ??= targetOf(row)
      const worker = options.workers.forTarget(targetId)
      if (worker === undefined) {
        recordEvent(id, "no_worker_for_target", { targetId })
        return finish(key, {
          ok: false,
          state: row.state,
          message: new NoWorkerForTargetError(targetId).message,
        })
      }
      let threadId: string
      try {
        threadId = await worker.client.createThread({ factoryWorkOrderId: id })
      } catch (error) {
        return finish(key, {
          ok: false,
          state: row.state,
          message: `Thread creation failed: ${String(error)}`,
        })
      }
      // Journalled before the transition so a crash in between still leaves the thread id in
      // the event log: reconciliation can adopt the orphan thread instead of leaking it.
      recordEvent(id, "thread_created", { threadId })
      let dispatched: WorkOrderRow
      try {
        dispatched = transition(id, "dispatch_committed", {
          workerThreadId: threadId,
          workerRoute: worker.route,
        })
      } catch (error) {
        // A cancel moved the row while the worker was creating the thread. The row cannot hold
        // the thread now, so end it here rather than leak a thread nothing observes.
        if (!(error instanceof IllegalTransitionError)) throw error
        recordEvent(id, "thread_orphaned", { threadId })
        try {
          await worker.client.cancel(threadId)
        } catch (cancelError) {
          recordEvent(id, "worker_cancel_failed", { threadId, error: String(cancelError) })
        }
        return finish(key, {
          ok: false,
          state: mustGet(id).state,
          message: "Work order changed state while dispatching",
        })
      }
      const outcome = finish(key, { ok: true, state: dispatched.state, message: "Dispatched" })
      track(id, startRun(id, input))
      return outcome
    },

    async approve(id, { revision, bundleDigest, operationKey }) {
      const row = mustGet(id)
      // The default key carries the bundle digest as well as the revision: two approvals of
      // the same revision naming different bundles are different intents, and one key cannot
      // hold both.
      const key = operationKey ?? `approve:${id}:${revision}:${bundleDigest}`
      const begun = commands.begin(
        key,
        id,
        { command: "approve", args: { revision, bundleDigest } },
        iso(),
      )
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      const refuse = (message: string) =>
        finish(key, { ok: false, state: mustGet(id).state, message })
      if (row.state !== "awaiting_approval") return refuse(`Cannot approve from ${row.state}`)
      if (row.revision !== revision)
        return refuse(`Stale revision ${revision}; work order is at ${row.revision}`)
      // Consent names the frozen bundle, not the bytes: the bundle digest covers the policy
      // and the environment the verifier ran in, so a change to either invalidates it even
      // when the candidate bytes are identical.
      if (row.bundleDigest !== bundleDigest)
        return refuse("Bundle digest does not match the frozen review bundle")
      const since = row.awaitingSince ? Date.parse(row.awaitingSince) : Number.NaN
      const ttl = options.approvalTtlMs ?? 900_000
      if (!Number.isFinite(since) || now() > since + ttl)
        return refuse("Review bundle has expired; deny or cancel it")

      const bundle = evidenceStore.bundle(bundleDigest)
      if (!bundle) return refuse("Frozen bundle is missing from the registry")
      const candidate = evidenceStore.candidate(bundle.candidateDigest)
      if (!candidate) return refuse("Assembled candidate is missing from the registry")

      // Re-verify the same bytes under the same policy before writing anything. Nothing below
      // this point may run if the re-verification did not pass: the export is the one thing
      // the controller cannot take back.
      // `artifacts.read` re-hashes the bytes against the digest it was asked for, so what is
      // parsed here is the candidate the receipt was issued over and nothing else.
      let changes: Record<string, string>
      try {
        changes = JSON.parse(await artifacts.read(candidate.artifactDigest)) as Record<
          string,
          string
        >
      } catch (error) {
        recordEvent(id, "candidate_unreadable", { error: String(error) })
        return refuse(`Approved bytes could not be read: ${String(error)}`)
      }
      // A policy that will not load is a refusal, not an escape: an exception here would
      // leave this command's key in flight and need a restart to reconcile.
      let policy: ReturnType<typeof loadPolicy>
      try {
        policy = loadPolicy(row.taskId)
      } catch (error) {
        recordEvent(id, "policy_unavailable", { phase: "export", error: String(error) })
        return refuse(`Verification policy could not be loaded: ${String(error)}`)
      }
      // Consent named a whole claim, not the diff: the frozen payload asserts the policy,
      // the specification, the baseline and the environment the passing verdict was earned
      // under. Without comparing them, a changed checks fixture or a changed sandbox image
      // would simply be re-verified under its NEW self and pass, and the export would go out
      // under a bundle asserting the old one. The spec's invariant and the README both say a
      // policy or environment change invalidates consent; this is where that is enforced.
      const parsed = BundlePayloadSchema.safeParse(bundle.payload)
      if (!parsed.success) {
        recordEvent(id, "bundle_unreadable", { error: String(parsed.error) })
        // No re-freeze exists from `awaiting_approval`: the way forward is a new work order.
        return refuse(
          "Frozen bundle payload could not be read; deny it and create a new work order",
        )
      }
      const frozen = parsed.data
      /** A refusal, not a throw: an exception here would strand this command's key. */
      const invalidated = (field: string, was: string, current: string) => {
        recordEvent(id, "bundle_invalidated", { field, frozen: was, current })
        return refuse(`${field} changed since the bundle was frozen; freeze a new bundle`)
      }
      if (frozen.policyDigest !== policy.policyDigest)
        return invalidated("Verification policy", frozen.policyDigest, policy.policyDigest)
      if (frozen.specificationDigest !== policy.specificationDigest)
        return invalidated(
          "Task specification",
          frozen.specificationDigest,
          policy.specificationDigest,
        )
      if (frozen.candidateDigest !== candidate.digest)
        return invalidated("Candidate", frozen.candidateDigest, candidate.digest)
      if (frozen.destinationId !== options.exportDir)
        return invalidated("Export destination", frozen.destinationId, options.exportDir)
      // The baseline is re-captured rather than read back from the candidate record: the
      // record is frozen evidence and would agree with the bundle by construction, whereas
      // the question is whether the fixture the candidate was diffed against is still the
      // one on disk.
      let baselineDigest: string
      try {
        baselineDigest = (await options.captureBaseline(row.taskId, abort.signal)).digest
      } catch (error) {
        recordEvent(id, "baseline_unavailable", { phase: "export", error: String(error) })
        return refuse(`Baseline could not be captured: ${String(error)}`)
      }
      if (frozen.baselineDigest !== baselineDigest)
        return invalidated("Baseline", frozen.baselineDigest, baselineDigest)
      // Neither the origin nor the pin can move once the row exists, so these two are
      // consistency assertions: a bundle naming another issue or another pin than the row
      // is a bundle for some other work order, whatever its digest says.
      const frozenOrigin = canon(frozen.origin)
      const rowOrigin = canon(row.origin)
      if (frozenOrigin !== rowOrigin) return invalidated("Origin", frozenOrigin, rowOrigin)
      if (frozen.pin !== row.pin) return invalidated("Pin", String(frozen.pin), String(row.pin))
      if (frozen.taskDigest !== row.taskDigest)
        return invalidated("Task digest", String(frozen.taskDigest), String(row.taskDigest))
      // The generated task is re-read from disk, as the baseline is re-captured: consent
      // named the task the person approved at intake, and a file edited under the directory
      // since the freeze (a loosened check, a widened allow-list) is not that task even when
      // the candidate bytes and the policy it was verified under are unchanged.
      if (frozen.taskDigest !== null) {
        const onDisk = diskTaskDigest(id)
        if ("error" in onDisk) {
          recordEvent(id, "generated_task_unreadable", {
            phase: "export",
            error: String(onDisk.error),
          })
          return refuse(`Generated task unreadable: ${String(onDisk.error)}`)
        }
        if (onDisk.digest !== frozen.taskDigest)
          return invalidated("Generated task", frozen.taskDigest, onDisk.digest)
      }

      let receipt: Receipt
      try {
        receipt = await ctx.verifier.verify(
          {
            workOrderId: id,
            taskId: row.taskId,
            candidateDigest: candidate.digest,
            changes,
            policyDigest: policy.policyDigest,
          },
          abort.signal,
        )
      } catch (error) {
        recordEvent(id, "verifier_unavailable", { phase: "export", error: String(error) })
        return refuse(`Re-verification could not run: ${String(error)}`)
      }
      // One unit, as in the verifying phase: a receipt row with no journal line would leave
      // an auditor unable to say which of the two is the truth.
      const rejected = receipt.verdict !== "pass" || receipt.candidateDigest !== candidate.digest
      try {
        store.transaction(() => {
          evidenceStore.recordReceipt(receipt)
          recordEvent(id, rejected ? "reverification_rejected" : "reverified", {
            verdict: receipt.verdict,
            receiptId: receipt.id,
          })
        })
      } catch (error) {
        // A write that will not land (a receipt id already stored with a different verdict, a
        // full disk) is a refusal, not an escape: an exception here would leave this command's
        // key in flight forever, which no restart can reconcile because the key is only ever
        // completed by the command that owns it. Nothing was written to the export directory,
        // so refusing leaves the review exactly where the operator found it.
        recordEvent(id, "receipt_unrecorded", { phase: "export", error: String(error) })
        return refuse(`Re-verification receipt could not be recorded: ${String(error)}`)
      }
      if (rejected) return refuse(`Re-verification did not pass: ${receipt.verdict}`)
      // The environment identity is the verifier's own claim about what it ran in, so it can
      // only be compared once the re-verification has issued a receipt. A pass earned in a
      // different environment is not the pass this bundle froze.
      if (receipt.environmentIdentity !== frozen.environmentIdentity)
        return invalidated(
          "Verifier environment",
          frozen.environmentIdentity,
          receipt.environmentIdentity,
        )

      // The verify above was an await: a cancel (operator or budget) may have moved the row,
      // and `approve` is not a legal move from where it left it.
      try {
        store.transaction(() => {
          store.recordApproval({
            id: `ap-${randomUUID()}`,
            workOrderId: id,
            bundleDigest,
            candidateDigest: candidate.digest,
            decision: "approved",
            decidedBy: options.actor ?? "operator",
            decidedAt: iso(),
            expiresAt: new Date(since + ttl).toISOString(),
          })
          transition(id, "approve", {}, { bundleDigest, operationKey: key })
        })
      } catch (error) {
        // The transaction rolled the authority record back with the transition.
        if (!(error instanceof IllegalTransitionError)) throw error
        return refuse("Work order changed state while approving")
      }

      let path: string
      try {
        path = await exportApproved({ directory: options.exportDir, bundle, changes })
      } catch (error) {
        recordEvent(id, "export_failed", { error: String(error) })
        if (mustGet(id).state === "exporting")
          transition(id, "export_unconfirmed", { blockedReason: "export_unconfirmed" })
        return finish(key, {
          ok: false,
          state: mustGet(id).state,
          message: `Export failed: ${String(error)}`,
        })
      }

      // The write was an await too, and a cancel may have landed while it ran. The bytes are
      // on disk either way, so the delivery is journalled either way — a row that reads
      // `cancelled` over a delivery that happened is the truth, and hiding the delivery
      // would not be. Only the transition is conditional, because `receipt_observed` is
      // illegal from anywhere a cancel could have moved the row to.
      try {
        store.transaction(() => {
          store.recordDelivery({
            workOrderId: id,
            candidateDigest: candidate.digest,
            receiptPath: path,
            observedAt: iso(),
          })
          recordEvent(id, "delivery_written", { receiptPath: path })
          if (mustGet(id).state === "exporting") transition(id, "receipt_observed")
        })
      } catch (error) {
        // The bytes are on disk and this write did not land, which is the one thing worth
        // saying out loud. Letting it escape would say it by leaving the operation key in
        // flight forever, and the operator would be told nothing at all.
        try {
          recordEvent(id, "delivery_unrecorded", { receiptPath: path, error: String(error) })
        } catch {
          // The registry is the thing that just failed; there may be nowhere left to journal.
        }
        return finish(key, {
          ok: false,
          state: mustGet(id).state,
          message: `Exported to ${path}, but the delivery could not be recorded: ${String(error)}`,
        })
      }
      const final = mustGet(id)
      return finish(key, {
        ok: final.state === "exported",
        state: final.state,
        message:
          final.state === "exported"
            ? "Exported"
            : "Exported, but the work order changed state while the bytes were being written",
      })
    },

    async deny(id, operationKey) {
      const row = mustGet(id)
      const key = operationKey ?? `deny:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "deny", args: {} }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      const refuse = (message: string) =>
        finish(key, { ok: false, state: mustGet(id).state, message })
      if (row.state !== "awaiting_approval" && row.state !== "blocked")
        return refuse(`Cannot deny from ${row.state}`)

      // From `awaiting_approval` there is nothing parked on the worker: rung 1's builder route
      // has no gate, and the review the operator is denying is the controller's own frozen
      // bundle. Only a `blocked` row can be holding a prompt, and it is an unexpected one.
      if (row.state === "blocked") {
        // The blocked row's thread may be the drafter's (a drafter parked on a prompt blocks
        // the row too) or the builder's: the row says which, and the deny goes there.
        const threadId = row.workerThreadId
        let worker: { client: WorkerClient; route: string } | undefined
        let pending: InterruptFrame[] = []
        try {
          if (threadId) {
            worker = workerOfThread(row)
            pending = await worker.client.pendingInterrupts(threadId)
          }
        } catch (error) {
          recordEvent(id, "pending_deny_failed", { error: String(error) })
          return refuse(`Deny could not be delivered to the worker: ${String(error)}`)
        }
        // Re-read after the await: a cancel (operator or budget) may have moved the row while
        // this deny was reading the worker, and `deny` is not legal from where it left it.
        if (mustGet(id).state !== row.state) return refuse("Work order changed state while denying")
        if (pending.length === 0 || !threadId || !worker)
          // A blocked work order with nothing parked (verification_failed, say) has no prompt
          // to deny; denying it would fake a decision the worker never heard.
          return refuse("Nothing is pending to deny; cancel the work order instead")

        try {
          recordEvent(id, "pending_denied", { interruptIds: pending.map((p) => p.interruptId) })
          const frames = await worker.client.resume(
            threadId,
            worker.route,
            pending.map((p) => ({ interruptId: p.interruptId, payload: "deny" as const })),
            abort.signal,
          )
          await consumeTurn(frames, {})
        } catch (error) {
          // Undelivered: the row keeps its state so the operator can retry or cancel, rather
          // than reading `denied` for a denial the worker never received.
          recordEvent(id, "pending_deny_failed", { error: String(error) })
          return refuse(`Deny could not be delivered to the worker: ${String(error)}`)
        }
        // The resume was another await: the row may have moved again while the worker was
        // hearing the denial.
        if (mustGet(id).state !== row.state) return refuse("Work order changed state while denying")
      }

      // One unit, as in approve: a denied authority row without the transition (or the other
      // way round) would leave reconciliation guessing which of the two is the truth.
      let denied: WorkOrderRow
      try {
        denied = store.transaction(() => {
          if (row.bundleDigest && row.candidateDigest)
            store.recordApproval({
              id: `ap-${randomUUID()}`,
              workOrderId: id,
              bundleDigest: row.bundleDigest,
              candidateDigest: row.candidateDigest,
              decision: "denied",
              decidedBy: options.actor ?? "operator",
              decidedAt: iso(),
              expiresAt: iso(),
            })
          return transition(id, "deny", {}, { operationKey: key })
        })
      } catch (error) {
        // The transaction rolled the denied authority row back with it.
        if (!(error instanceof IllegalTransitionError)) throw error
        return refuse("Work order changed state while denying")
      }
      return finish(key, { ok: true, state: denied.state, message: "Denied" })
    },
    async cancel(id, operationKey) {
      const row = mustGet(id)
      const key = operationKey ?? `cancel:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "cancel", args: {} }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      if (isTerminal(row.state))
        return finish(key, {
          ok: false,
          state: row.state,
          message: `Work order is terminal (${row.state})`,
        })
      if (row.state === "cancel_requested")
        return finish(key, {
          ok: false,
          state: row.state,
          message: "Cancel already in progress",
        })
      // Recorded before any worker call: a crash in between leaves cancel_requested, which is
      // exactly what reconciliation knows how to finish.
      try {
        transition(id, "cancel", {}, { operationKey: key })
      } catch (error) {
        // Something settled the row between the state checks above and here.
        if (!(error instanceof IllegalTransitionError)) throw error
        const current = mustGet(id).state
        return finish(key, { ok: false, state: current, message: `Cannot cancel from ${current}` })
      }
      let final: WorkOrderRow
      try {
        final = await finishCancel(id, "operator")
      } catch (error) {
        return finish(key, {
          ok: false,
          state: mustGet(id).state,
          message: `Cancel failed: ${String(error)}`,
        })
      }
      // The row, not the call, is the outcome: an unconfirmed cancel is still cancel_requested,
      // and reconciliation finishes it on the next boot.
      if (final.state === "cancelled")
        return finish(key, { ok: true, state: final.state, message: "Cancelled" })
      return finish(key, {
        ok: false,
        state: final.state,
        message:
          final.state === "cancel_requested"
            ? "Cancel not confirmed; the worker was unreachable. Reconciliation will finish it on restart"
            : `Cancel did not complete; work order is ${final.state}`,
      })
    },

    show: (id) => store.get(id),
    list: () => store.list(),
    events: (id) => store.events(id),

    evidence(id) {
      const row = mustGet(id)
      const candidate = row.candidateDigest ? evidenceStore.candidate(row.candidateDigest) : null
      const bundle = row.bundleDigest ? evidenceStore.bundle(row.bundleDigest) : null
      const receipt = bundle ? evidenceStore.receipt(bundle.receiptId) : null
      const oracleId = oracleReceiptIdFor(store.events(id), row.taskDigest)
      const oracleReceipt = oracleId ? evidenceStore.receipt(oracleId) : null
      return { candidate, receipt, bundle, oracleReceipt }
    },

    async waitFor(id, predicate, timeoutMs = 10_000) {
      // Wall clock, for the same reason as settleRun: a frozen injected `now` would spin here.
      const deadline = Date.now() + timeoutMs
      while (true) {
        const row = mustGet(id)
        if (predicate(row)) return row
        if (Date.now() >= deadline || abort.signal.aborted)
          throw new Error(`Timed out waiting for ${id}; state is ${row.state}`)
        await quietSleep(20)
      }
    },

    async settle(id, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      await settleRun(id, timeoutMs)
      return factory.waitFor(
        id,
        (r) => !ACTIVE_STATES.has(r.state),
        Math.max(0, deadline - Date.now()),
      )
    },
    settleIntake: (id, timeoutMs) => factory.settle(id, timeoutMs),
    reconcileWorkOrder: (id) => reconcileWorkOrder(ctx, id),
    reconcileAll: () => reconcileAll(ctx),

    async close() {
      if (closed) return
      closed = true
      ticker?.stop()
      abort.abort()
      // Bounded: a run whose stream ignores the abort must not hold the process open.
      await Promise.race([
        Promise.allSettled([...runs.values()]),
        sleep(options.closeTimeoutMs ?? 10_000),
      ])
      registry.close()
    },
  }

  // Reconciliation first, the ticker second: the boot rules need only `finishCancel`, and a
  // tick landing mid-walk would race them for the same rows. A boot that throws owns its own
  // cleanup, since nothing is returned for anyone else to close.
  try {
    await reconcileAll(ctx)

    // The budget is enforced on active time only (dispatched/running/exporting), so a work order
    // parked on a person never expires. One command key per (id, revision) keeps the ticker's
    // cancel out of the command log's way when an operator cancel is already recorded.
    ticker = startBudgetTicker({
      store,
      now,
      tickMs: options.budgetTickMs ?? 1_000,
      // The ticker has no caller to reject to: anything escaping this callback would surface as
      // an unhandled rejection and leave its key in flight forever. So the whole body is
      // guarded — the row read, the command log, the transition and the worker calls — and a
      // tick that raced close() stops before it can touch a closing registry.
      onExhausted: async (id) => {
        if (closed) return
        let key: string | null = null
        try {
          const row = mustGet(id)
          key = `budget:${id}:${row.revision}`
          const begun = commands.begin(
            key,
            id,
            { command: "cancel", args: { cause: "budget" } },
            iso(),
          )
          if (begun.status !== "new") return
          try {
            transition(
              id,
              "budget_exhausted",
              { blockedReason: "budget_exhausted" },
              { maxActiveMs: row.maxActiveMs },
            )
          } catch (error) {
            commands.complete(key, {
              ok: false,
              message: `Budget cancel skipped: ${String(error)}`,
            })
            return
          }
          // As in cancel: the row is the outcome, and an unconfirmed cancel is not a cancel.
          const final = await finishCancel(id, "budget")
          const ok = final.state === "blocked" && final.blockedReason === "budget_exhausted"
          commands.complete(key, {
            ok,
            state: final.state,
            message: ok
              ? "Budget exhausted"
              : `Budget cancel not confirmed; work order is ${final.state}`,
          })
        } catch (error) {
          try {
            recordEvent(id, "budget_cancel_failed", { error: String(error) })
            if (key)
              commands.complete(key, {
                ok: false,
                message: `Budget cancel failed: ${String(error)}`,
              })
          } catch {
            // close() took the registry with it; there is nothing left to journal this on.
          }
        }
      },
    })
  } catch (error) {
    ticker?.stop()
    registry.close()
    throw error
  }

  return factory
}
