import type {
  RunReason,
  RunStatus,
  RuntimeInboxRecord,
  RuntimeRetainedSubject,
  RuntimeRunAuthorityFacts,
  RuntimeRunRecord,
  RuntimeStore,
  RuntimeTransaction,
  RunWaitResponse,
} from "@b4run/sdk/agent-protocol"
import { ProtocolError } from "../dev/protocol/errors.js"
import { canonicalProtocolId } from "../dev/protocol/metadata.js"
import { parseProtocolRequest } from "../dev/protocol/validate.js"
import { makeProtocolThreadGate } from "../dev/thread-gate.js"
import {
  type AdmissionService,
  type AdmissionServiceOptions,
  isAdmissionService,
} from "./admission.js"
import {
  type AdmissionResult,
  admissionBinding,
  exactRunPermissionAgents,
  runAuthorityFacts,
  subject,
} from "./operation-ledger.js"
import {
  EXECUTION_HEARTBEAT_MS,
  EXECUTION_POLL_MS,
  type ExecutionClock,
  executionClock,
  executionStorage,
  type LiveExecution,
  retireSupersededControls,
  staleOwnership,
} from "./ownership.js"
import {
  isPermissionService,
  type PermissionExecutionPreparation,
  type PermissionService,
  retirePermissionPause,
} from "./permissions.js"
import {
  closeRuntimeAdmission,
  type RuntimeStorageHost,
  runtimeStorageRegistration,
  temporaryCleanupPreparation,
} from "./storage-host.js"

type StopReason = "user_stop" | "client_disconnect" | "server_shutdown" | "deadline"
interface StopPayload {
  readonly generation: string
  readonly reason: StopReason
}
function stopPayload(entry: RuntimeInboxRecord): StopPayload {
  return entry.payload as StopPayload
}
/** Exact-target selection and retirement share the same native Thread lock as
 * resume. No graph invocation, grant consumption or synthetic permission answer. */
async function acceptStop(
  tx: RuntimeTransaction,
  runId: string,
  reason: StopReason,
  timestamp: string,
) {
  const run = await tx.runs.get(runId),
    thread = await tx.thread.get()
  if (!run || !thread) throw new ProtocolError("not_found", { resource: "run" })
  const existing = (await tx.inbox.list()).find(
    (entry) => entry.kind === "control" && entry.runId === runId,
  )
  if (existing) return existing.entryId
  const entryId = crypto.randomUUID()
  let status: RuntimeInboxRecord["status"] = "accepted"
  if (
    thread.currentRunId !== runId ||
    (run.metadata.phase === "settled" && run.metadata.continuation !== "waiting")
  )
    status = "not_applied"
  else if (run.metadata.phase === "accepted" && run.metadata.startedAt === undefined) {
    for (const entry of await tx.inbox.list())
      if (entry.runId === runId && entry.status === "accepted")
        await tx.inbox.put({ ...entry, status: "not_applied" })
    await settleExecution(
      tx,
      runId,
      { status: reason === "deadline" ? "timeout" : "interrupted", reason },
      timestamp,
    )
    const retired = await tx.runs.get(runId)
    if (retired) await tx.runs.put({ ...retired, unwoundAt: timestamp })
    status = "applied"
  } else if (run.metadata.continuation === "waiting" && thread.pausedGeneration) {
    await retirePermissionPause(tx, runId, timestamp)
    if (run.unwoundAt || !run.metadata.startedAt) status = "applied"
  }
  await tx.inbox.put({
    entryId,
    kind: "control",
    runId,
    namespace: run.namespace,
    status,
    payload: { generation: tx.scope.generation, reason } satisfies StopPayload,
    createdAt: timestamp,
  })
  return entryId
}

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
  if (
    (row.execution && row.execution.fence !== tx.scope.fence) ||
    (!row.execution && row.metadata.startedAt !== undefined)
  )
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
        status: outcome.status === "error" ? "error" : "idle",
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
          payload: {
            ...metadata,
            runId,
            agentId: run.agent_id,
            status: run.status,
          },
        },
      },
    },
  })
}
export interface ExecutionHostOptions {
  readonly admission?: AdmissionService
  /** Host-configured execution deadline; never inferred from caller metadata. */
  readonly deadlineMs?: number
  readonly deploymentId?: AdmissionServiceOptions["deploymentId"]
  readonly policy?: AdmissionServiceOptions["policy"]
  readonly authorizeAgent?: AdmissionServiceOptions["authorizeAgent"]
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
  cancel(request: Request, threadId: string, runId: string, query: unknown): Promise<void>
  bindRestCreation(
    result: AdmissionResult,
    signal: AbortSignal,
  ): Promise<{ readonly closed: Promise<void>; dispose(): void }>
  bindNativeCreation(
    result: AdmissionResult,
    signal: AbortSignal,
  ): Promise<{ readonly closed: Promise<void>; dispose(): void }>
  close(options?: { readonly drainMs: number }): Promise<void>
}
/** Staged shared execution service. It does not activate HTTP/AG-UI bindings or
 * infer execution ownership from transports, registries or an empty live map. */
export function createExecutionHost(options: ExecutionHostOptions): ExecutionHost {
  if (options.admission && !isAdmissionService(options.admission))
    throw new Error("Unrecognized admission service")
  if (
    options.deadlineMs !== undefined &&
    (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0)
  )
    throw new Error("Execution deadline must be a positive integer")
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
  let closing: Promise<void> | undefined
  const report = (error: unknown) => {
    if (!staleOwnership(error)) failures.push(error)
  }
  const registration = runtimeStorageRegistration(options.storage)
  const stopped = new Map<string, StopReason>()
  const finalizing = new Map<string, Promise<void>>()
  const finalizationFailures = new Map<string, unknown>()
  async function reconcileSuperseded(
    threadId: string,
    runId: string,
    generation: string,
  ): Promise<void> {
    // Never open/create an archived or replacement generation to complete old work.
    const current = await registration.readThread(threadId)
    if (
      current?.generation !== generation ||
      (current.currentRunId === runId &&
        (current.cleanupIntent?.onCompletion === "delete" || current.thread.status === "busy"))
    )
      return
    const store = await registration.openThread(threadId, false, generation)
    if (store) await store.transaction((tx) => retireSupersededControls(tx, runId, generation))
  }
  function finalize(threadId: string, runId: string, generation: string): Promise<void> {
    const key = JSON.stringify([threadId, generation, runId])
    const existing = finalizing.get(key)
    if (existing) return existing
    finalizationFailures.delete(key)
    const work = (async () => {
      const plan = (await registration.temporary?.candidates())?.find(
        (p) => p.threadId === threadId && p.runId === runId && p.generation === generation,
      )
      if (!plan) {
        await reconcileSuperseded(threadId, runId, generation)
        return
      }
      const context = {
        installationId: options.storage.installationId,
        threadId,
        generation: plan.generation,
        cleanupIntentId: plan.cleanupIntentId,
      }
      const prepare = temporaryCleanupPreparation(options.storage)
      if (!prepare) throw new ProtocolError("not_supported")
      const provider = await prepare(context)
      if (!(await registration.temporary?.finalize({ ...plan, provider })))
        await reconcileSuperseded(threadId, runId, generation)
    })()
      .catch((error) => {
        finalizationFailures.set(key, error)
        throw error
      })
      .finally(() => {
        finalizing.delete(key)
      })
    finalizing.set(key, work)
    return work
  }
  async function observeControls() {
    for (const [key, entry] of live) {
      let control: RuntimeInboxRecord | undefined
      try {
        control = await entry.lease.store.transaction(async (tx) =>
          (await tx.inbox.list()).find(
            (row) =>
              row.kind === "control" &&
              row.runId === key &&
              row.status === "accepted" &&
              stopPayload(row).generation === tx.scope.generation,
          ),
        )
      } catch (error) {
        if (!staleOwnership(error)) throw error
        entry.controller.abort(error)
        continue
      }
      if (control && !stopped.has(key)) {
        stopped.set(key, stopPayload(control).reason)
        entry.controller.abort(new Error(stopPayload(control).reason))
      }
    }
  }
  async function bindCreation(
    result: AdmissionResult,
    signal: AbortSignal,
    kind: "rest_creation" | "native_creation",
  ) {
    const proof = admissionBinding(result, options.storage, kind)
    let resolve!: () => void,
      reject!: (error: unknown) => void,
      closed = false
    const completion = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    const disconnect = () => {
      if (closed) return
      closed = true
      signal.removeEventListener("abort", disconnect)
      void (async () => {
        if (kind === "native_creation" || proof.binding.onDisconnect === "cancel") {
          const candidate = await registration.findRun?.(proof.runId)
          if (candidate?.location === "live" && candidate.scope.generation === proof.generation) {
            const store = await registration.openThread(proof.threadId, false, proof.generation)
            if (store)
              await store.transaction(async (tx) => {
                if (tx.scope.generation === proof.generation)
                  await acceptStop(tx, proof.runId, "client_disconnect", clock.now())
              })
            await observeControls()
          }
        }
      })().then(resolve, reject)
    }
    if (signal.aborted) disconnect()
    else signal.addEventListener("abort", disconnect, { once: true })
    return {
      closed: completion,
      dispose() {
        if (closed) return
        closed = true
        signal.removeEventListener("abort", disconnect)
        resolve()
      },
    }
  }
  async function stopLive(runId: string, reason: StopReason) {
    const entry = live.get(runId)
    if (!entry) return
    await entry.lease.store.transaction((tx) => acceptStop(tx, runId, reason, clock.now()))
    await observeControls()
    // A committed terminal can precede actual provider unwind. Shutdown and
    // deadline still signal this same owned promise; settlement keeps its winner.
    if (!entry.controller.signal.aborted) entry.controller.abort(new Error(reason))
  }
  async function dispatch() {
    await observeControls()
    for (const threadId of await backend.listCandidates()) {
      if (closed) return
      let selected: RuntimeRunRecord | undefined
      let retiredBeforeStart: { runId: string; generation: string } | undefined
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
        if (!run) return
        const execution = { ownerId, fence: tx.scope.fence }
        if (run.metadata.startedAt !== undefined || run.metadata.phase !== "accepted") {
          if (!run.execution) throw new ProtocolError("storage_unavailable")
          const ownershipLoss = run.ownershipLoss ?? {
            detectedAt: clock.now(),
            ownerId: run.execution.ownerId,
            fence: run.execution.fence,
            effectsUncertain: true as const,
          }
          if (run.metadata.phase === "settled") {
            await retirePermissionPause(tx, run.run.run_id, clock.now())
            const historical = await tx.runs.get(run.run.run_id)
            if (!historical) throw new ProtocolError("storage_unavailable")
            await tx.runs.put({ ...historical, execution, ownershipLoss })
            const current = await tx.thread.get()
            if (current?.currentRunId === run.run.run_id)
              await tx.thread.put({
                ...current,
                revision: current.revision + 1,
                thread: { ...current.thread, status: "error" },
              })
            for (const entry of await tx.inbox.list())
              if (
                entry.kind === "control" &&
                entry.runId === run.run.run_id &&
                entry.status === "accepted"
              )
                await tx.inbox.put({ ...entry, status: "applied" })
            return
          }
          // Fencing was already applied under the same backend row lock. Even
          // a crash before the first actual effect must never replay this Run.
          await tx.runs.put({ ...run, execution, ownershipLoss })
          await settleExecution(
            tx,
            run.run.run_id,
            {
              status: "error",
              reason: "execution_lost",
              effectsUncertain: true,
            },
            clock.now(),
          )
          for (const entry of await tx.inbox.list())
            if (
              entry.kind === "control" &&
              entry.runId === run.run.run_id &&
              entry.status === "accepted"
            )
              await tx.inbox.put({ ...entry, status: "applied" })
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
              {
                status: "error",
                reason: "execution_error",
                effectsUncertain: false,
              },
              clock.now(),
            )
            retiredBeforeStart = {
              runId: run.run.run_id,
              generation: tx.scope.generation,
            }
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
          metadata: {
            ...run.metadata,
            phase: "running",
            startedAt: clock.now(),
          },
        }
        await tx.runs.put(selected)
        for (const entry of dispatches) await tx.inbox.put({ ...entry, status: "applied" })
      })
      if (!lease) continue
      if (!selected) {
        if (retiredBeforeStart) {
          const retired = retiredBeforeStart
          await lease.release(async (tx) => {
            const row = await tx.runs.get(retired.runId),
              dispatches = (await tx.inbox.list()).filter(
                (entry) => entry.kind === "dispatch" && entry.runId === retired.runId,
              )
            if (
              tx.scope.generation !== retired.generation ||
              !row ||
              row.metadata.phase !== "settled" ||
              row.metadata.reason !== "execution_error" ||
              row.metadata.continuation !== "closed" ||
              row.metadata.startedAt !== undefined ||
              row.ownershipLoss ||
              row.execution?.ownerId !== ownerId ||
              row.execution.fence !== tx.scope.fence ||
              (await tx.executionOwner()) !== ownerId ||
              dispatches.length !== 1 ||
              dispatches[0]?.status !== "not_applied"
            )
              throw Object.assign(
                new Error("Cannot prove exact never-started permission retirement"),
                { code: "stale_fence" },
              )
            await tx.runs.put({ ...row, unwoundAt: clock.now() })
          })
          await finalize(threadId, retired.runId, retired.generation)
        } else await lease.release()
        if (preparationError) throw preparationError
        continue
      }
      const run = selected,
        controller = new AbortController()
      const key = run.run.run_id
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
      const deadline =
        options.deadlineMs === undefined
          ? undefined
          : clock.setInterval(() => {
              clock.clearInterval(deadline)
              void stopLive(key, "deadline").catch(report)
            }, options.deadlineMs)
      // This continuation runs only AFTER the claim/started transaction commits.
      const work = Promise.resolve()
        .then(async () => {
          try {
            const result = await options.invoke({
              run,
              store: lease.store,
              signal: controller.signal,
            })
            await lease.store.transaction(async (tx) => {
              const control = (await tx.inbox.list()).find(
                (row) => row.kind === "control" && row.runId === key && row.status === "accepted",
              )
              const reason = control ? stopPayload(control).reason : undefined
              if (reason) await retirePermissionPause(tx, key, clock.now())
              await settleExecution(
                tx,
                run.run.run_id,
                reason
                  ? {
                      status: reason === "deadline" ? "timeout" : "interrupted",
                      reason,
                    }
                  : { status: "success", reason: "completed", result },
                clock.now(),
              )
            })
          } catch (error) {
            if (!staleOwnership(error))
              await lease.store.transaction(async (tx) => {
                const control = (await tx.inbox.list()).find(
                  (row) => row.kind === "control" && row.runId === key && row.status === "accepted",
                )
                const reason = control ? stopPayload(control).reason : undefined
                if (reason) await retirePermissionPause(tx, key, clock.now())
                await settleExecution(
                  tx,
                  run.run.run_id,
                  reason
                    ? {
                        status: reason === "deadline" ? "timeout" : "interrupted",
                        reason,
                      }
                    : { status: "error", reason: "execution_error" },
                  clock.now(),
                )
              })
          } finally {
            clock.clearInterval(heartbeat)
            if (deadline !== undefined) clock.clearInterval(deadline)
            await heartbeating
            try {
              await lease.release(async (tx) => {
                const row = await tx.runs.get(key)
                if (
                  row?.execution?.ownerId !== ownerId ||
                  row.execution.fence !== tx.scope.fence ||
                  (await tx.executionOwner()) !== ownerId
                )
                  throw Object.assign(
                    new Error("Cannot prove actual unwind for another execution"),
                    { code: "stale_fence" },
                  )
                await tx.runs.put({ ...row, unwoundAt: clock.now() })
                const thread = await tx.thread.get()
                if (thread?.cleanupIntent?.onCompletion !== "delete")
                  for (const entry of await tx.inbox.list())
                    if (
                      entry.kind === "control" &&
                      entry.runId === key &&
                      entry.status === "accepted"
                    )
                      await tx.inbox.put({ ...entry, status: "applied" })
              })
              await finalize(threadId, key, run.metadata.generation)
            } catch (error) {
              report(error)
            }
          }
        })
        .catch(report)
        .finally(() => {
          live.delete(key)
          stopped.delete(key)
        })
      live.set(key, { lease, controller, work })
    }
    for (const plan of (await registration.temporary?.candidates()) ?? [])
      await finalize(plan.threadId, plan.runId, plan.generation)
  }
  const host: ExecutionHost = {
    ownerId,
    bindRestCreation: (result, signal) => bindCreation(result, signal, "rest_creation"),
    bindNativeCreation: (result, signal) => bindCreation(result, signal, "native_creation"),
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
      await Promise.all([...finalizing.values()])
      if (failures.length) throw failures.shift()
    },
    async cancel(request, threadId, runId, query) {
      canonicalProtocolId(threadId)
      canonicalProtocolId(runId)
      const command = parseProtocolRequest("cancel", query)
      if (command.action !== "interrupt")
        throw new ProtocolError("not_supported", { feature: "rollback" })
      if (!options.deploymentId || !options.authorizeAgent)
        throw new Error("Exact Run control requires trusted authority wiring")
      const authorizeAgent = options.authorizeAgent
      const findRun = registration.findRun
      if (!findRun) throw new ProtocolError("not_supported")
      const candidate = await findRun(runId)
      if (!candidate || candidate.scope.threadId !== threadId) throw new ProtocolError("not_found")
      const gate = makeProtocolThreadGate(options.policy, request, {
        deploymentId: options.deploymentId,
      })
      const authorizeFacts = async (
        agentId: string,
        facts: RuntimeRunAuthorityFacts,
        value: RuntimeRetainedSubject,
        retained: boolean,
      ) => {
        await authorizeAgent(request, agentId)
        let children: readonly string[]
        try {
          children = exactRunPermissionAgents(threadId, runId, facts)
          if (retained) {
            const map = value.protectedMetadata.permissionAgentsByRun as
                | Record<string, unknown>
                | undefined,
              saved = map?.[runId]
            if (
              children.length
                ? !Array.isArray(saved) ||
                  saved.length !== children.length ||
                  saved.some((id) => typeof id !== "string") ||
                  [...saved].sort().some((id, index) => id !== [...children].sort()[index])
                : saved !== undefined
            )
              throw new ProtocolError("storage_unavailable")
          }
        } catch {
          // Bad private facts cannot reveal a storage distinction to a caller
          // denied the original Thread. Never bind or treat missing facts empty.
          if (
            !(
              await gate({ action: "update", operation: "run.cancel", threadId, ...subject(value) })
            ).ok
          )
            throw new ProtocolError("not_found")
          throw new ProtocolError("storage_unavailable")
        }
        for (const child of children) await authorizeAgent(request, child)
        if (
          !(await gate({ action: "update", operation: "run.cancel", threadId, ...subject(value) }))
            .ok
        )
          throw new ProtocolError("not_found")
        if (command.wait && !backend.controlProgress) throw new ProtocolError("not_supported")
      }
      const exactCandidate = async () => {
        const fresh = await findRun(runId)
        if (
          !fresh ||
          fresh.scope.threadId !== threadId ||
          fresh.scope.generation !== candidate.scope.generation ||
          fresh.agentId !== candidate.agentId
        )
          throw new ProtocolError("not_found")
        return fresh
      }
      const finishRetainedControl = async (
        fresh: NonNullable<Awaited<ReturnType<typeof findRun>>>,
      ) => {
        const retained = await registration.temporary?.readRun(runId)
        if (
          !retained ||
          retained.scope.threadId !== threadId ||
          retained.scope.generation !== candidate.scope.generation ||
          retained.record.run.run_id !== runId ||
          retained.record.run.agent_id !== fresh.agentId
        )
          throw new ProtocolError("not_found")
        await authorizeFacts(
          fresh.agentId,
          {
            ...fresh.authority,
            turnId: retained.record.metadata.turnId,
            previousRunId: retained.record.metadata.previousRunId ?? null,
          },
          retained.subject,
          true,
        )
        if (
          command.wait &&
          (retained.record.ownershipLoss || retained.record.metadata.reason === "execution_lost")
        )
          throw new ProtocolError("storage_unavailable", { executionLost: true })
        if (command.wait && !retained.record.unwoundAt)
          throw new ProtocolError("storage_unavailable")
      }
      const acceptExactControl = async (): Promise<string | undefined> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (request.signal.aborted) throw request.signal.reason
          const fresh = await exactCandidate()
          if (fresh.location === "retained") {
            await finishRetainedControl(fresh)
            return
          }
          await authorizeFacts(fresh.agentId, fresh.authority, fresh.subject, false)
          try {
            const store = await registration.openThread(threadId, false, candidate.scope.generation)
            if (!store) continue
            return await store.transaction(async (tx) => {
              const thread = await tx.thread.get(),
                run = await tx.runs.get(runId)
              if (
                tx.scope.generation !== candidate.scope.generation ||
                !run?.run.agent_id ||
                !thread
              )
                throw new ProtocolError("not_found")
              await authorizeFacts(
                run.run.agent_id,
                runAuthorityFacts(run, await tx.receipts.list()),
                thread,
                false,
              )
              return acceptStop(tx, runId, "user_stop", clock.now())
            })
          } catch (error) {
            if (!staleOwnership(error)) throw error
            // Only a known rolled-back native stale fence is retryable. Each
            // attempt rediscovers canonical facts and reauthorizes exact scope.
            if (attempt === 2) throw new ProtocolError("storage_unavailable")
          }
        }
        throw new ProtocolError("storage_unavailable")
      }
      const entryId = await acceptExactControl()
      if (entryId === undefined) return
      await observeControls()
      if (!command.wait) return
      void finalize(threadId, runId, candidate.scope.generation).catch(report)
      for (;;) {
        if (!backend.controlProgress) throw new ProtocolError("not_supported")
        const progress = await backend.controlProgress(candidate.scope, entryId, runId)
        if (progress === "execution_lost")
          throw new ProtocolError("storage_unavailable", {
            executionLost: true,
          })
        if (progress === "uncertain") throw new ProtocolError("storage_unavailable")
        if (progress === "completed") return
        const finalizationFailure = finalizationFailures.get(
          JSON.stringify([threadId, candidate.scope.generation, runId]),
        )
        if (finalizationFailure) throw finalizationFailure
        await new Promise<void>((resolve, reject) => {
          if (request.signal.aborted) {
            reject(request.signal.reason)
            return
          }
          const abort = () => {
            clearTimeout(timer)
            reject(request.signal.reason)
          }
          const timer = setTimeout(() => {
            request.signal.removeEventListener("abort", abort)
            resolve()
          }, EXECUTION_POLL_MS)
          request.signal.addEventListener("abort", abort, { once: true })
        })
      }
    },
    close(configuration) {
      if (closing) return closing
      const drainMs = configuration?.drainMs ?? 0
      if (!Number.isSafeInteger(drainMs) || drainMs < 0)
        return Promise.reject(new Error("Shutdown drain budget must be a nonnegative integer"))
      closed = true
      closeRuntimeAdmission(options.storage)
      options.admission?.close()
      if (poll !== undefined) clock.clearInterval(poll)
      closing = (async () => {
        await ticking
        if (drainMs > 0 && live.size) {
          let timer: unknown
          try {
            await Promise.race([
              host.idle(),
              new Promise<void>((resolve) => {
                timer = clock.setInterval(resolve, drainMs)
              }),
            ])
          } finally {
            if (timer !== undefined) clock.clearInterval(timer)
          }
        }
        for (const runId of live.keys()) await stopLive(runId, "server_shutdown")
        await host.idle()
      })()
      return closing
    },
  }
  return Object.freeze(host)
}
