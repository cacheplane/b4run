import { createHash, randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import {
  ACTIVE_STATES,
  IllegalTransitionError,
  isTerminal,
  nextState,
  type TransitionEvent,
} from "../domain/states.js"
import type { CommandOutcome, FactoryEvent, WorkOrderRow } from "../domain/work-order.js"
import { TASK_PROMPTS } from "../prompts.js"
import { type CommandLog, createCommandLog } from "../registry/commands.js"
import { openRegistry } from "../registry/db.js"
import { createWorkOrderStore, type WorkOrderPatch } from "../registry/work-orders.js"
import type { WorkerClient } from "../worker/client.js"
import { receiptPath, waitForReceipt } from "../worker/outbox.js"
import { classifyDone, type StreamFrame } from "../worker/wire.js"
import { startBudgetTicker } from "./budget.js"
import type { ControllerContext } from "./context.js"
import { denyPending, observeRun } from "./run-observer.js"
import { consumeTurn } from "./turns.js"

export interface FactoryOptions {
  readonly registryPath: string
  readonly worker: WorkerClient
  readonly workerRoute: string
  readonly outboxDir: string
  /** Task id to prompt. Defaults to TASK_PROMPTS. */
  readonly tasks?: Readonly<Record<string, string>>
  readonly approvalTtlMs?: number
  readonly maxActiveMs?: number
  readonly receiptWaitMs?: number
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
    input: { revision: number; candidateDigest: string; operationKey?: string },
  ): Promise<CommandOutcome>
  deny(id: string, operationKey?: string): Promise<CommandOutcome>
  cancel(id: string, operationKey?: string): Promise<CommandOutcome>
  show(id: string): WorkOrderRow | null
  list(): WorkOrderRow[]
  events(id: string): FactoryEvent[]
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
  const tasks = options.tasks ?? TASK_PROMPTS
  const now = options.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  const log = options.log ?? (() => {})
  const abort = new AbortController()
  const runs = new Map<string, Promise<void>>()
  let closed = false

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
      .catch((error) => recordEvent(id, "run_observer_error", { error: String(error) }))
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
   * Resolve the worker's parked exportForReview gate with `once` and wait for the receipt
   * named by the approved digest. Called only from approve (after the approval row is
   * committed) and from reconciliation of an `exporting` work order. Ends in exported or
   * blocked; never leaves `exporting`.
   */
  async function confirmExport(id: string): Promise<void> {
    const row = mustGet(id)
    if (
      row.state !== "exporting" ||
      !row.workerThreadId ||
      !row.candidateDigest ||
      !row.interruptId
    )
      return
    const { workerThreadId: threadId, candidateDigest: digest, interruptId } = row
    const block = (reason: string, extra: Record<string, unknown> = {}) => {
      if (mustGet(id).state === "exporting")
        transition(
          id,
          "export_unconfirmed",
          { blockedReason: "export_unconfirmed" },
          { reason, ...extra },
        )
    }

    let frames: AsyncIterable<StreamFrame>
    try {
      frames = await options.worker.resume(
        threadId,
        options.workerRoute,
        [{ interruptId, payload: "once" }],
        abort.signal,
      )
    } catch (error) {
      block("resume failed", { error: String(error) })
      return
    }
    recordEvent(id, "export_gate_resolved", { interruptId })
    let routeError: string | null = null
    const result = await consumeTurn(frames, {
      onDone: async (data) => {
        routeError = classifyDone(data).error
      },
    })
    if (result.ended === "lost")
      recordEvent(id, "stream_lost", { phase: "export_resume", error: result.error ?? null })
    else if (result.ended === "handler_error") {
      recordEvent(id, "run_observer_error", {
        phase: "export_resume",
        error: result.error ?? null,
      })
      block("observer error", { error: result.error ?? null })
      return
    }
    if (routeError) {
      block("resume ended with error", { error: routeError })
      return
    }
    const receipt = await waitForReceipt(options.outboxDir, digest, {
      timeoutMs: ctx.receiptWaitMs,
      signal: abort.signal,
    })
    if (!receipt) {
      block("receipt not observed", { expected: receiptPath(options.outboxDir, digest) })
      return
    }
    if (mustGet(id).state !== "exporting") return
    store.transaction(() => {
      store.recordDelivery({
        workOrderId: id,
        candidateDigest: digest,
        receiptPath: receipt,
        observedAt: iso(),
      })
      recordEvent(id, "delivery_observed", { receiptPath: receipt })
      transition(id, "receipt_observed")
    })
  }

  /**
   * Is there a turn on `threadId` for the cancel to interrupt? The worker is the authority,
   * not the controller's in-memory `runs` map: after a restart that map is empty, and while a
   * run is draining its last frames the map still holds a promise for a turn that has parked.
   * An unreadable status is treated as live — cancelling a parked thread is a tolerated 409,
   * whereas skipping the cancel of a live one leaks a run.
   */
  async function turnIsLive(id: string, threadId: string): Promise<boolean> {
    try {
      return (await options.worker.getThread(threadId))?.status === "busy"
    } catch (error) {
      recordEvent(id, "thread_status_unknown", { error: String(error) })
      return true
    }
  }

  /**
   * Shared by the cancel command, the budget ticker, and reconciliation. Cancels a live run,
   * denies whatever prompt is still parked, and applies the terminal cancel row for `cause`.
   */
  async function finishCancel(id: string, cause: "operator" | "budget"): Promise<WorkOrderRow> {
    const row = mustGet(id)
    if (row.workerThreadId) {
      let result: string | null = null
      if (await turnIsLive(id, row.workerThreadId)) {
        try {
          result = await options.worker.cancel(row.workerThreadId)
        } catch (error) {
          result = `error: ${String(error)}`
        }
        recordEvent(id, "worker_cancel", { result })
        await settleRun(id, 10_000)
      }
      if (result !== "thread_not_found") {
        try {
          await denyPending(ctx, id)
        } catch (error) {
          recordEvent(id, "pending_deny_failed", { error: String(error) })
        }
      }
    }
    return cause === "budget"
      ? transition(id, "run_ended_after_budget", { blockedReason: "budget_exhausted" })
      : transition(id, "run_ended_after_cancel")
  }

  // Assembled here so Tasks 14 and 15 (cancel, reconciliation) receive it unchanged.
  const ctx: ControllerContext = {
    store,
    commands,
    worker: options.worker,
    workerRoute: options.workerRoute,
    outboxDir: options.outboxDir,
    receiptWaitMs: options.receiptWaitMs ?? 180_000,
    signal: abort.signal,
    now,
    iso,
    mustGet,
    recordEvent,
    transition,
    observeRun: (id, frames) => observeRun(ctx, id, frames),
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
  }

  // The budget is enforced on active time only (dispatched/running/exporting), so a work order
  // parked on a person never expires. One command key per (id, revision) keeps the ticker's
  // cancel out of the command log's way when an operator cancel is already recorded.
  const ticker = startBudgetTicker({
    store,
    now,
    tickMs: options.budgetTickMs ?? 1_000,
    onExhausted: async (id) => {
      const row = mustGet(id)
      const key = `budget:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "cancel", args: { cause: "budget" } }, iso())
      if (begun.status !== "new") return
      try {
        transition(
          id,
          "budget_exhausted",
          { blockedReason: "budget_exhausted" },
          { maxActiveMs: row.maxActiveMs },
        )
      } catch (error) {
        commands.complete(key, { ok: false, message: `Budget cancel skipped: ${String(error)}` })
        return
      }
      try {
        const final = await finishCancel(id, "budget")
        commands.complete(key, { ok: true, state: final.state, message: "Budget exhausted" })
      } catch (error) {
        // The ticker has no caller to reject to: an escaping error here would surface as an
        // unhandled rejection and leave this key in flight forever.
        recordEvent(id, "budget_cancel_failed", { error: String(error) })
        commands.complete(key, { ok: false, message: `Budget cancel failed: ${String(error)}` })
      }
    },
  })

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
      if (begun.status === "done") return mustGet(id)
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
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
      const dispatched = transition(id, "dispatch_committed", { workerThreadId: threadId })
      const outcome = finish(key, { ok: true, state: dispatched.state, message: "Dispatched" })
      track(id, startRun(id))
      return outcome
    },

    async approve(id, { revision, candidateDigest, operationKey }) {
      const row = mustGet(id)
      // The default key carries the digest as well as the revision: two approvals of the same
      // revision with different digests are different intents, and one key cannot hold both.
      const key = operationKey ?? `approve:${id}:${revision}:${candidateDigest}`
      const begun = commands.begin(
        key,
        id,
        { command: "approve", args: { revision, candidateDigest } },
        iso(),
      )
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      const refuse = (message: string) =>
        finish(key, { ok: false, state: mustGet(id).state, message })
      if (row.state !== "awaiting_approval") return refuse(`Cannot approve from ${row.state}`)
      if (row.revision !== revision)
        return refuse(`Stale revision ${revision}; work order is at ${row.revision}`)
      if (row.candidateDigest !== candidateDigest)
        return refuse("Candidate digest does not match the recorded candidate")
      const since = row.awaitingSince ? Date.parse(row.awaitingSince) : Number.NaN
      const ttl = options.approvalTtlMs ?? 900_000
      if (!Number.isFinite(since) || now() > since + ttl)
        return refuse("Candidate has expired; deny or cancel it")
      if (!row.workerThreadId || !row.interruptId) return refuse("Work order has no recorded gate")

      // The gate must still be pending on the worker before any authority is recorded.
      const pending = await options.worker.pendingInterrupts(row.workerThreadId)
      // Re-read after the await: a cancel (operator or budget) may have moved the row while
      // this approve was talking to the worker, and neither `interrupt_vanished` nor `approve`
      // is a legal move from where it left it.
      if (mustGet(id).state !== "awaiting_approval")
        return refuse("Work order changed state while approving")
      if (pending.length !== 1 || pending[0]?.interruptId !== row.interruptId) {
        transition(
          id,
          "interrupt_vanished",
          { blockedReason: "interrupt_vanished" },
          { expected: row.interruptId, pending: pending.map((p) => p.interruptId) },
        )
        return refuse("The worker's approval prompt is no longer pending")
      }

      try {
        store.transaction(() => {
          store.recordApproval({
            id: `ap-${randomUUID()}`,
            workOrderId: id,
            interruptId: row.interruptId as string,
            candidateDigest,
            decision: "approved",
            decidedBy: options.actor ?? "operator",
            decidedAt: iso(),
            expiresAt: new Date(since + ttl).toISOString(),
          })
          transition(id, "approve", {}, { candidateDigest, operationKey: key })
        })
      } catch (error) {
        // A cancel (operator or budget) moved the row while this approve awaited the worker.
        // The transaction rolled the authority record back; refuse rather than leave the
        // command key in flight, which would need a restart to reconcile.
        if (!(error instanceof IllegalTransitionError)) throw error
        return refuse("Work order changed state while approving")
      }
      const run = confirmExport(id)
      track(id, run)
      await run
      const final = mustGet(id)
      return finish(key, {
        ok: final.state === "exported",
        state: final.state,
        message:
          final.state === "exported"
            ? "Exported"
            : `Export not confirmed: ${final.blockedReason ?? final.state}`,
      })
    },

    async deny(id, operationKey) {
      const row = mustGet(id)
      const key = operationKey ?? `deny:${id}:${row.revision}`
      const begun = commands.begin(key, id, { command: "deny", args: {} }, iso())
      if (begun.status === "done") return begun.outcome
      if (begun.status === "in_flight") throw new CommandInFlightError(key)
      if (row.state !== "awaiting_approval" && row.state !== "blocked")
        return finish(key, {
          ok: false,
          state: row.state,
          message: `Cannot deny from ${row.state}`,
        })
      try {
        await ctx.denyPending(id)
      } catch (error) {
        recordEvent(id, "pending_deny_failed", { error: String(error) })
      }
      if (row.candidateDigest && row.interruptId)
        store.recordApproval({
          id: `ap-${randomUUID()}`,
          workOrderId: id,
          interruptId: row.interruptId,
          candidateDigest: row.candidateDigest,
          decision: "denied",
          decidedBy: options.actor ?? "operator",
          decidedAt: iso(),
          expiresAt: iso(),
        })
      const denied = transition(id, "deny", {}, { operationKey: key })
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
      transition(id, "cancel", {}, { operationKey: key })
      const final = await finishCancel(id, "operator")
      return finish(key, { ok: true, state: final.state, message: "Cancelled" })
    },

    show: (id) => store.get(id),
    list: () => store.list(),
    events: (id) => store.events(id),

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
      ticker.stop()
      abort.abort()
      // Bounded: a run whose stream ignores the abort must not hold the process open.
      await Promise.race([
        Promise.allSettled([...runs.values()]),
        sleep(options.closeTimeoutMs ?? 10_000),
      ])
      registry.close()
    },
  }

  return factory
}
