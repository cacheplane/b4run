import { createHash, randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { exportApproved } from "../delivery/export.js"
import {
  ACTIVE_STATES,
  IllegalTransitionError,
  isTerminal,
  nextState,
  type TransitionEvent,
} from "../domain/states.js"
import type {
  Bundle,
  Candidate,
  CommandOutcome,
  FactoryEvent,
  Receipt,
  WorkOrderRow,
} from "../domain/work-order.js"
import { TASK_PROMPTS } from "../prompts.js"
import { type CommandLog, createCommandLog } from "../registry/commands.js"
import { openRegistry } from "../registry/db.js"
import { createEvidenceStore, type EvidenceStore } from "../registry/evidence.js"
import { createWorkOrderStore, type WorkOrderPatch } from "../registry/work-orders.js"
import { type ArtifactStore, createArtifactStore } from "../storage/artifacts.js"
import { loadPolicy } from "../verification/policy.js"
import type { Verifier } from "../verification/verifier.js"
import type { CancelResult, WorkerClient } from "../worker/client.js"
import type { InterruptFrame, StreamFrame } from "../worker/wire.js"
import type { WorkspaceReader } from "../worker/workspace-reader.js"
import { type BudgetTicker, startBudgetTicker } from "./budget.js"
import type { ControllerContext } from "./context.js"
import { reconcileAll } from "./reconcile.js"
import { denyPending, observeRun } from "./run-observer.js"
import { consumeTurn } from "./turns.js"
import { runVerification } from "./verify.js"

export interface FactoryOptions {
  readonly registryPath: string
  readonly worker: WorkerClient
  readonly workerRoute: string
  /** Where the approved bytes are written, and the bundle's destination identity. */
  readonly exportDir: string
  /** Content-addressed evidence store for candidate and check output. */
  readonly artifactsDir: string
  readonly verifier: Verifier
  readonly workspaceReader: WorkspaceReader
  /** The controller's own baseline for a task. Injected so tests need no container. */
  captureBaseline(
    taskId: string,
    signal: AbortSignal,
  ): Promise<{ readonly digest: string; readonly files: ReadonlyMap<string, string> }>
  readonly maxChangedBytes?: number
  /** Task id to prompt. Defaults to TASK_PROMPTS. */
  readonly tasks?: Readonly<Record<string, string>>
  readonly approvalTtlMs?: number
  readonly maxActiveMs?: number
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
  }
  waitFor(
    id: string,
    predicate: (row: WorkOrderRow) => boolean,
    timeoutMs?: number,
  ): Promise<WorkOrderRow>
  close(): Promise<void>
}

export class CommandInFlightError extends Error {
  constructor(readonly operationKey: string) {
    super(`Command ${operationKey} is still in flight; restart the factory to reconcile it`)
    this.name = "CommandInFlightError"
  }
}

export class UnknownTaskError extends Error {
  constructor(taskId: string) {
    super(`Unknown task ${taskId}`)
    this.name = "UnknownTaskError"
  }
}

export class UnknownWorkOrderError extends Error {
  constructor(id: string) {
    super(`Unknown work order ${id}`)
    this.name = "UnknownWorkOrderError"
  }
}

export async function createFactory(options: FactoryOptions): Promise<Factory> {
  const registry = openRegistry(options.registryPath)
  const store = createWorkOrderStore(registry.db)
  const commands: CommandLog = createCommandLog(registry.db)
  const evidenceStore: EvidenceStore = createEvidenceStore(registry.db)
  const artifacts: ArtifactStore = createArtifactStore(options.artifactsDir)
  const tasks = options.tasks ?? TASK_PROMPTS
  const now = options.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  const log = options.log ?? (() => {})
  const abort = new AbortController()
  const runs = new Map<string, Promise<void>>()
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

  const transition = (
    id: string,
    event: TransitionEvent,
    patch: WorkOrderPatch = {},
    payload: Record<string, unknown> = {},
  ): WorkOrderRow =>
    store.transaction(() => {
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
      return updated
    })

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
    threadId: string,
  ): Promise<"live" | "ended" | "missing" | "unknown"> {
    try {
      const thread = await options.worker.getThread(threadId)
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
      const liveness = await threadLiveness(id, threadId)
      let result: CancelResult | null = null
      if (liveness === "live" || liveness === "unknown") {
        try {
          result = await options.worker.cancel(threadId)
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
    workspaceReader: options.workspaceReader,
    worker: options.worker,
    workerRoute: options.workerRoute,
    exportDir: options.exportDir,
    maxChangedBytes: options.maxChangedBytes ?? 256 * 1024,
    signal: abort.signal,
    now,
    iso,
    mustGet,
    recordEvent,
    transition,
    observeRun: (id, frames, observeOptions) => observeRun(ctx, id, frames, observeOptions),
    captureBaseline: (taskId, signal) => options.captureBaseline(taskId, signal),
    runVerification: (id) => runVerification(ctx, id),
    denyPending: (id) => denyPending(ctx, id),
    finishCancel: (id, cause) => finishCancel(id, cause),
    settleRun,
    track,
  }

  async function startRun(id: string): Promise<void> {
    const row = mustGet(id)
    if (!row.workerThreadId) return
    // dispatch already refused an unknown task; re-checked here so this never sends an empty prompt.
    const prompt = tasks[row.taskId]
    if (prompt === undefined) {
      recordEvent(id, "prompt_missing", { taskId: row.taskId })
      return
    }
    let frames: AsyncIterable<StreamFrame>
    try {
      frames = await options.worker.startRun(
        row.workerThreadId,
        options.workerRoute,
        prompt,
        abort.signal,
      )
    } catch (error) {
      recordEvent(id, "stream_lost", { phase: "run_start", error: String(error) })
      return
    }
    await observeRun(ctx, id, frames)
    // The turn is over; what it left behind is now the controller's to judge.
    if (mustGet(id).state === "verifying") await runVerification(ctx, id)
  }

  const factory: Factory = {
    async create({ taskId, operationKey }) {
      if (!(taskId in tasks)) throw new UnknownTaskError(taskId)
      // A caller-supplied operationKey is also the work-order address: the same key always
      // names the same id, which is what makes create idempotent across a crash.
      const id = operationKey
        ? `wo-${createHash("sha256").update(operationKey).digest("hex").slice(0, 16)}`
        : `wo-${randomUUID().replace(/-/g, "").slice(0, 16)}`
      const key = operationKey ?? `create:${id}`
      const begun = commands.begin(key, id, { command: "create", args: { taskId } }, iso())
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
        taskId,
        workerRoute: options.workerRoute,
        workerThreadId: null,
        interruptId: null,
        candidateDigest: null,
        candidateVerified: null,
        bundleDigest: null,
        blockedReason: null,
        failureReason: null,
        maxCandidateAttempts: 1,
        maxActiveMs: options.maxActiveMs ?? 1_200_000,
        activeMs: 0,
        activeStartedAt: null,
        awaitingSince: null,
        createdAt: at,
        updatedAt: at,
      }
      store.transaction(() => {
        store.insert(row)
        recordEvent(id, "created", { taskId })
        // Only a fresh key has an outcome left to record; a replayed one already has its own.
        if (begun.status === "new")
          commands.complete(key, { ok: true, state: "received", message: "Created" })
      })
      return row
    },

    async dispatch(id, operationKey) {
      const row = mustGet(id)
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
      const prompt = tasks[row.taskId]
      // Refuse rather than send an empty prompt: a worker asked to fix nothing still burns a
      // thread and a run, and the resulting turn would fail in a way that looks like the worker.
      if (prompt === undefined)
        return finish(key, {
          ok: false,
          state: row.state,
          message: `Unknown task ${row.taskId}`,
        })
      let threadId: string
      try {
        threadId = await options.worker.createThread({ factoryWorkOrderId: id })
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
        dispatched = transition(id, "dispatch_committed", { workerThreadId: threadId })
      } catch (error) {
        // A cancel moved the row while the worker was creating the thread. The row cannot hold
        // the thread now, so end it here rather than leak a thread nothing observes.
        if (!(error instanceof IllegalTransitionError)) throw error
        recordEvent(id, "thread_orphaned", { threadId })
        try {
          await options.worker.cancel(threadId)
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
      track(id, startRun(id))
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
        let pending: InterruptFrame[]
        try {
          pending = row.workerThreadId
            ? await options.worker.pendingInterrupts(row.workerThreadId)
            : []
        } catch (error) {
          recordEvent(id, "pending_deny_failed", { error: String(error) })
          return refuse(`Deny could not be delivered to the worker: ${String(error)}`)
        }
        // Re-read after the await: a cancel (operator or budget) may have moved the row while
        // this deny was reading the worker, and `deny` is not legal from where it left it.
        if (mustGet(id).state !== row.state) return refuse("Work order changed state while denying")
        if (pending.length === 0)
          // A blocked work order with nothing parked (verification_failed, say) has no prompt
          // to deny; denying it would fake a decision the worker never heard.
          return refuse("Nothing is pending to deny; cancel the work order instead")

        const threadId = row.workerThreadId as string
        try {
          recordEvent(id, "pending_denied", { interruptIds: pending.map((p) => p.interruptId) })
          const frames = await options.worker.resume(
            threadId,
            options.workerRoute,
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
      return { candidate, receipt, bundle }
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
