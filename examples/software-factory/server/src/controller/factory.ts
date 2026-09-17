import { createHash, randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { ACTIVE_STATES, nextState, type TransitionEvent } from "../domain/states.js"
import type { CommandOutcome, FactoryEvent, WorkOrderRow } from "../domain/work-order.js"
import { TASK_PROMPTS } from "../prompts.js"
import { type CommandLog, createCommandLog } from "../registry/commands.js"
import { openRegistry } from "../registry/db.js"
import { createWorkOrderStore, type WorkOrderPatch } from "../registry/work-orders.js"
import type { WorkerClient } from "../worker/client.js"
import {
  classifyDone,
  isExportGate,
  PREPARE_TOOL,
  parsePrepareReviewOutput,
  type StreamFrame,
} from "../worker/wire.js"
import type { ControllerContext } from "./context.js"
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

const isRunState = (state: WorkOrderRow["state"]) => state === "dispatched" || state === "running"

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
      const updated = store.update(id, row.revision, { ...accounting, ...patch, state: to }, iso())
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

  const settleRun = async (id: string, timeoutMs: number) => {
    const run = runs.get(id)
    if (!run) return
    await Promise.race([run, sleep(timeoutMs)])
  }

  const denyPending = async (id: string) => {
    const row = mustGet(id)
    if (!row.workerThreadId) return
    const pending = await options.worker.pendingInterrupts(row.workerThreadId)
    if (pending.length === 0) return
    recordEvent(id, "pending_denied", { interruptIds: pending.map((p) => p.interruptId) })
    const frames = await options.worker.resume(
      row.workerThreadId,
      options.workerRoute,
      pending.map((p) => ({ interruptId: p.interruptId, payload: "deny" as const })),
      abort.signal,
    )
    await consumeTurn(frames, {})
  }

  /**
   * The worker's single turn (spec: "Where the candidate digest comes from" and the
   * dispatched/running rows of the transition table). Every handler re-reads the row and
   * acts only while the work order is still in a run state, so a concurrent cancel wins.
   */
  async function observeRun(id: string, frames: AsyncIterable<StreamFrame>): Promise<void> {
    const result = await consumeTurn(frames, {
      onFirstFrame: async () => {
        if (mustGet(id).state === "dispatched") transition(id, "run_started")
      },
      onToolResult: async (name, output) => {
        if (name !== PREPARE_TOOL) return
        const row = mustGet(id)
        if (!isRunState(row.state)) return
        try {
          const parsed = parsePrepareReviewOutput(output)
          store.update(
            id,
            row.revision,
            {
              candidateDigest: parsed.candidate.receiptDigest,
              candidateVerified: parsed.verification.passed,
            },
            iso(),
          )
          recordEvent(id, "candidate_observed", {
            digest: parsed.candidate.receiptDigest,
            verified: parsed.verification.passed,
            candidate: parsed.candidate,
          })
        } catch (error) {
          recordEvent(id, "candidate_unparseable", { error: String(error) })
        }
      },
      onInterrupt: async (frame) => {
        const row = mustGet(id)
        if (!isRunState(row.state)) return
        if (!isExportGate(frame)) {
          transition(
            id,
            "unexpected_interrupt",
            { interruptId: frame.interruptId, blockedReason: "unexpected_interrupt" },
            { interruptId: frame.interruptId, kind: frame.kind },
          )
          return
        }
        if (row.candidateDigest && row.candidateVerified === true) {
          transition(
            id,
            "candidate_interrupt",
            { interruptId: frame.interruptId, awaitingSince: iso() },
            { interruptId: frame.interruptId, candidateDigest: row.candidateDigest },
          )
          return
        }
        transition(
          id,
          "candidate_interrupt_without_digest",
          { interruptId: frame.interruptId, blockedReason: "candidate_digest_unknown" },
          { interruptId: frame.interruptId, verified: row.candidateVerified },
        )
      },
      onDone: async (data) => {
        const row = mustGet(id)
        if (!isRunState(row.state)) return
        const { error, cancelled } = classifyDone(data)
        if (cancelled) return
        if (error) {
          transition(id, "run_failed", { failureReason: "route_error" }, { error })
          return
        }
        transition(
          id,
          "run_ended_without_candidate",
          { failureReason: "ended_without_candidate" },
          { verified: row.candidateVerified },
        )
      },
    })
    if (result.ended === "lost") {
      recordEvent(id, "stream_lost", { phase: "run", error: result.error ?? null })
    }
  }

  async function finishCancel(_id: string, _cause: "operator" | "budget"): Promise<WorkOrderRow> {
    throw new Error("finishCancel is implemented in Task 14")
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
    observeRun,
    denyPending,
    finishCancel: (id, cause) => finishCancel(id, cause),
    settleRun,
    track,
  }
  void ctx

  async function startRun(id: string): Promise<void> {
    const row = mustGet(id)
    if (!row.workerThreadId) return
    let frames: AsyncIterable<StreamFrame>
    try {
      frames = await options.worker.startRun(
        row.workerThreadId,
        options.workerRoute,
        tasks[row.taskId] ?? "",
        abort.signal,
      )
    } catch (error) {
      recordEvent(id, "stream_lost", { phase: "run_start", error: String(error) })
      return
    }
    await observeRun(id, frames)
  }

  const factory: Factory = {
    async create({ taskId, operationKey }) {
      if (!(taskId in tasks)) throw new UnknownTaskError(taskId)
      const id = operationKey
        ? `wo-${createHash("sha256").update(operationKey).digest("hex").slice(0, 16)}`
        : `wo-${randomUUID()}`
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
      recordEvent(id, "thread_created", { threadId })
      const dispatched = transition(id, "dispatch_committed", { workerThreadId: threadId })
      const outcome = finish(key, { ok: true, state: dispatched.state, message: "Dispatched" })
      track(id, startRun(id))
      return outcome
    },

    async approve() {
      throw new Error("approve is implemented in Task 13")
    },
    async deny() {
      throw new Error("deny is implemented in Task 13")
    },
    async cancel() {
      throw new Error("cancel is implemented in Task 14")
    },

    show: (id) => store.get(id),
    list: () => store.list(),
    events: (id) => store.events(id),

    async waitFor(id, predicate, timeoutMs = 10_000) {
      const deadline = now() + timeoutMs
      while (true) {
        const row = mustGet(id)
        if (predicate(row)) return row
        if (now() >= deadline) throw new Error(`Timed out waiting for ${id}; state is ${row.state}`)
        await sleep(20)
      }
    },

    async close() {
      abort.abort()
      await Promise.allSettled([...runs.values()])
      registry.close()
    },
  }

  return factory
}
