import type {
  RunReason,
  RunStatus,
  RuntimeRunRecord,
  RuntimeStore,
  RuntimeTransaction,
  RunWaitResponse,
} from "@b4run/sdk/agent-protocol"
import {
  EXECUTION_HEARTBEAT_MS,
  EXECUTION_POLL_MS,
  type ExecutionClock,
  executionClock,
  executionStorage,
  type LiveExecution,
  staleOwnership,
} from "./ownership.js"
import {
  isPermissionService,
  type PermissionExecutionPreparation,
  type PermissionService,
} from "./permissions.js"
import type { RuntimeStorageHost } from "./storage-host.js"

export interface ExecutionOutcome {
  readonly status: Exclude<RunStatus, "pending">
  readonly reason: RunReason
  readonly result?: RunWaitResponse
  readonly effectsUncertain?: boolean
}
/** One terminal service for normal completion and recovery. A committed winner
 * is immutable; stale native/runtime handles fail the backend fence first. */
export async function settleExecution(
  tx: RuntimeTransaction,
  runId: string,
  outcome: ExecutionOutcome,
  timestamp = new Date().toISOString(),
): Promise<void> {
  const row = await tx.runs.get(runId)
  if (!row || row.metadata.phase === "settled") return
  if (!row.execution || row.execution.fence !== tx.scope.fence)
    throw Object.assign(new Error("Execution settlement has a stale owner fence"), {
      code: "stale_fence",
    })
  const metadata = {
    ...row.metadata,
    phase: "settled" as const,
    reason: outcome.reason,
    continuation: "closed" as const,
    settledAt: timestamp,
    effectsUncertain: outcome.effectsUncertain ?? false,
  }
  const run = { ...row.run, status: outcome.status, updated_at: timestamp }
  await tx.runs.put({
    ...row,
    run,
    metadata,
    result: {
      ...row.result,
      ...outcome.result,
      run: { ...run, metadata: { ...run.metadata, b4: metadata } },
    },
  })
  const thread = await tx.thread.get()
  if (thread?.currentRunId === runId)
    await tx.thread.put({
      ...thread,
      revision: thread.revision + 1,
      pausedGeneration: null,
      thread: {
        ...thread.thread,
        updated_at: timestamp,
        status: outcome.status === "success" ? "idle" : "error",
      },
    })
  await tx.journal.append({
    eventId: crypto.randomUUID(),
    namespace: row.namespace,
    ownerRunId: runId,
    event: {
      type: "event",
      method: "custom",
      params: {
        namespace: row.namespace,
        timestamp: Date.parse(timestamp),
        data: {
          name: "b4.run",
          payload: { ...metadata, runId, agentId: run.agent_id, status: run.status },
        },
      },
    },
  })
}
export interface ExecutionHostOptions {
  readonly permissions?: PermissionService
  readonly storage: RuntimeStorageHost
  /** R8 binds the shared adapter here only after retiring the legacy owners. */
  readonly invoke: (context: {
    readonly run: RuntimeRunRecord
    readonly store: RuntimeStore
    readonly signal: AbortSignal
  }) => Promise<RunWaitResponse>
  readonly clock?: ExecutionClock
}
export interface ExecutionHost {
  readonly ownerId: string
  start(): Promise<void>
  tick(): Promise<void>
  idle(): Promise<void>
  close(): Promise<void>
}
/** Staged shared execution service. It does not activate HTTP/AG-UI bindings or
 * infer execution ownership from transports, registries or an empty live map. */
export function createExecutionHost(options: ExecutionHostOptions): ExecutionHost {
  if (options.permissions && !isPermissionService(options.permissions))
    throw new Error("Unrecognized permission service")
  const backend = executionStorage(options.storage),
    clock = options.clock ?? executionClock
  const ownerId = crypto.randomUUID()
  const live = new Map<string, LiveExecution>()
  const failures: unknown[] = []
  let closed = false,
    poll: unknown,
    ticking: Promise<void> | undefined
  const report = (error: unknown) => {
    if (!staleOwnership(error)) failures.push(error)
  }
  async function dispatch() {
    for (const threadId of await backend.listCandidates()) {
      if (closed) return
      let selected: RuntimeRunRecord | undefined
      let preparation: PermissionExecutionPreparation | undefined, preparationError: unknown
      if (options.permissions) {
        try {
          preparation = await options.permissions.prepareExecution(threadId)
        } catch (error) {
          preparationError = error
        }
      }
      const lease = await backend.claim(threadId, ownerId, async (tx) => {
        const thread = await tx.thread.get()
        if (!thread?.currentRunId) return
        const run = await tx.runs.get(thread.currentRunId)
        if (!run || run.metadata.phase === "settled") return
        const execution = { ownerId, fence: tx.scope.fence }
        if (run.metadata.startedAt !== undefined || run.metadata.phase !== "accepted") {
          // Fencing was already applied under the same backend row lock. Even
          // a crash before the first actual effect must never replay this Run.
          await tx.runs.put({ ...run, execution })
          await settleExecution(
            tx,
            run.run.run_id,
            { status: "error", reason: "execution_lost", effectsUncertain: true },
            clock.now(),
          )
          return
        }
        const intents = (await tx.inbox.list()).filter(
          (entry) => entry.kind === "rule_intent" && entry.runId === run.run.run_id,
        )
        if (intents.length || run.metadata.previousRunId !== undefined) {
          if (preparationError) return
          if (!options.permissions || !preparation)
            throw new Error("Remembered rule execution requires its configured coordinator")
          const outcome = await options.permissions.completePreparation(
            tx,
            run.run.run_id,
            preparation,
          )
          if (outcome === "deferred") return
          if (outcome === "refused") {
            for (const entry of await tx.inbox.list()) {
              if (
                entry.kind === "dispatch" &&
                entry.runId === run.run.run_id &&
                entry.status === "accepted"
              )
                await tx.inbox.put({ ...entry, status: "not_applied" })
            }
            await tx.runs.put({ ...run, execution })
            await settleExecution(
              tx,
              run.run.run_id,
              { status: "error", reason: "execution_error", effectsUncertain: false },
              clock.now(),
            )
            return
          }
        }
        const dispatches = (await tx.inbox.list()).filter(
          (entry) =>
            entry.kind === "dispatch" &&
            entry.runId === run.run.run_id &&
            entry.status === "accepted",
        )
        if (dispatches.length !== 1) throw new Error("Accepted Run has no unique durable dispatch")
        selected = {
          ...run,
          execution,
          metadata: { ...run.metadata, phase: "running", startedAt: clock.now() },
        }
        await tx.runs.put(selected)
        for (const entry of dispatches) await tx.inbox.put({ ...entry, status: "applied" })
      })
      if (!lease) continue
      if (!selected) {
        await lease.release()
        if (preparationError) throw preparationError
        continue
      }
      const run = selected,
        controller = new AbortController()
      const key = JSON.stringify([run.run.run_id, ownerId])
      let heartbeating: Promise<void> | undefined
      const heartbeat = clock.setInterval(() => {
        if (heartbeating) return
        heartbeating = lease
          .heartbeat()
          .catch((error) => {
            controller.abort(error)
            report(error)
          })
          .finally(() => {
            heartbeating = undefined
          })
      }, EXECUTION_HEARTBEAT_MS)
      // This continuation runs only AFTER the claim/started transaction commits.
      const work = Promise.resolve()
        .then(async () => {
          try {
            const result = await options.invoke({
              run,
              store: lease.store,
              signal: controller.signal,
            })
            await lease.store.transaction((tx) =>
              settleExecution(
                tx,
                run.run.run_id,
                { status: "success", reason: "completed", result },
                clock.now(),
              ),
            )
          } catch (error) {
            if (!staleOwnership(error))
              await lease.store.transaction((tx) =>
                settleExecution(
                  tx,
                  run.run.run_id,
                  { status: "error", reason: "execution_error" },
                  clock.now(),
                ),
              )
          } finally {
            clock.clearInterval(heartbeat)
            await heartbeating
            try {
              await lease.release()
            } catch (error) {
              report(error)
            }
          }
        })
        .catch(report)
        .finally(() => {
          live.delete(key)
        })
      live.set(key, { lease, controller, work })
    }
  }
  const host: ExecutionHost = {
    ownerId,
    async start() {
      if (closed) throw new Error("Execution host is closed")
      if (poll !== undefined) return
      poll = clock.setInterval(() => {
        void host.tick().catch(report)
      }, EXECUTION_POLL_MS)
      await host.tick()
    },
    tick() {
      if (closed) return Promise.reject(new Error("Execution host is closed"))
      ticking ??= dispatch().finally(() => {
        ticking = undefined
      })
      return ticking
    },
    async idle() {
      await ticking
      await Promise.all([...live.values()].map((entry) => entry.work))
      if (failures.length) throw failures.shift()
    },
    async close() {
      if (closed) return
      closed = true
      if (poll !== undefined) clock.clearInterval(poll)
      await ticking
      for (const entry of live.values())
        entry.controller.abort(new Error("Execution host shutdown"))
      await host.idle()
    },
  }
  return Object.freeze(host)
}
