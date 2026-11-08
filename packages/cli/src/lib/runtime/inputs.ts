import type { BackendActiveInput, BackendAdapter } from "@b4run/sdk"
import type {
  AspInputInjectParams,
  B4Message,
  InputReceiptResultV1,
  RuntimeInboxRecord,
  RuntimeNamespaceBinding,
  RuntimeReceiptRecord,
  RuntimeRunRecord,
  RuntimeSnapshot,
  RuntimeStore,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { requestPrincipal } from "../dev/auth.js"
import { ProtocolError } from "../dev/protocol/errors.js"
import { mergePublicMessages, parsePublicMessages } from "../dev/protocol/messages.js"
import { canonicalProtocolId, parseRequestMetadata } from "../dev/protocol/metadata.js"
import { parseProtocolRequest } from "../dev/protocol/validate.js"
import { createThreadAccessContext } from "../dev/thread-access.js"
import { makeProtocolThreadGate } from "../dev/thread-gate.js"
import type { AdmissionServiceOptions } from "./admission.js"
import {
  createRuntimeCheckpointSaver,
  inheritRuntimeChildContinuation,
  runtimeCheckpointOwner,
  runtimeChildCheckpointBinding,
} from "./checkpoint-saver.js"
import {
  authorizeCurrentOperation,
  authorizeRetainedOperation,
  canonical,
  exactRunPermissionAgents,
  hash,
  knownRunPermissionAgents,
  operationAuthorityFacts,
  operationRunAgents,
  replayOperationFacts,
  runAuthorityFacts,
  sameOperationAuthority,
  subject,
  validateOperationAuthority,
  validateOperationRunAuthority,
  validateRetainedOperationCut,
} from "./operation-ledger.js"
import { runtimeAdmissionOpen, runtimeStorageRegistration } from "./storage-host.js"

/** Called only after the existing guarded resolver selected/authorized child. */
export async function childInputExecution(
  parentSaver: BaseCheckpointSaver | undefined,
  agentId: string,
  config: { readonly configurable?: Record<string, unknown> },
) {
  const owner = runtimeCheckpointOwner(parentSaver)
  if (!owner) return undefined
  const { namespace, binding } = await runtimeChildCheckpointBinding(parentSaver!, agentId, config)
  const { namespaceGeneration } = binding
  const boundary = createActiveInputBoundary({ ...owner, namespace, namespaceGeneration })
  const checkpointer = createRuntimeCheckpointSaver({
    ...owner,
    namespace,
    binding,
    commitInputs: boundary.commitInputs,
  })
  await inheritRuntimeChildContinuation(parentSaver!, checkpointer)
  return {
    activeInput: boundary.activeInput,
    checkpointer,
    retire: (reason: string) =>
      owner.store.transaction(async (tx) => {
        await retireActiveInputs(tx, owner.runId, reason, { namespace, namespaceGeneration })
        const record = await tx.nativeNamespaces.get(
          `namespace:${hash([tx.scope.threadId, tx.scope.generation, owner.runId, namespace])}`,
        )
        const thread = await tx.thread.get()
        if (!record || !thread || record.namespaceGeneration !== namespaceGeneration)
          throw new ProtocolError("stale_generation")
        await tx.nativeNamespaces.put({
          ...record,
          status: reason === "namespace_parked" ? "parked" : "closed",
          revision: thread.revision + 1,
        })
        await tx.thread.put({ ...thread, revision: thread.revision + 1 })
      }),
  }
}

export interface InputServiceOptions
  extends Pick<AdmissionServiceOptions, "storage" | "deploymentId" | "policy" | "authorizeAgent"> {
  /** Pure trusted native namespace/Agent correspondence; no provider work. */
  readonly resolveTarget: (context: {
    readonly request: Request
    readonly run: RuntimeRunRecord
    readonly namespace: readonly string[]
    readonly snapshot: RuntimeSnapshot
    readonly namespaceBinding?: RuntimeNamespaceBinding
  }) => Promise<{
    readonly adapter: BackendAdapter
    readonly agentId: string
    readonly namespaceGeneration: string
    readonly systemInjection: boolean
  }>
  readonly authorizeSystemInput?: (
    request: Request,
    targetAgentId: string,
  ) => boolean | Promise<boolean>
  readonly limits?: { readonly entries: number; readonly bytes: number; readonly textBytes: number }
  readonly failpoint?: (point: "beforeCommit" | "afterCommit") => void | Promise<void>
}
interface InjectionPayload {
  readonly v: 1
  readonly generation: string
  readonly namespaceGeneration: string
  readonly order: number
  readonly receiptId: string
  readonly message: B4Message
  readonly reason?: string
}
export function injectionPayload(row: RuntimeInboxRecord): InjectionPayload {
  const payload = row.payload as InjectionPayload
  if (
    row.kind !== "inject" ||
    payload?.v !== 1 ||
    payload.message?.id !== row.entryId ||
    !Number.isSafeInteger(payload.order)
  )
    throw new ProtocolError("storage_unavailable")
  return payload
}
function inputIdentity(params: AspInputInjectParams) {
  const { b4, ...message } = params.message
  const envelope = b4 === undefined ? undefined : parseRequestMetadata(b4)
  return {
    namespace: params.namespace,
    message: {
      ...message,
      ...(envelope?.expected ? { b4: { v: 1, expected: envelope.expected } } : {}),
    },
  }
}
function injectionIdentity(
  params: AspInputInjectParams,
  threadId: string,
  runId: string,
  resolved: Readonly<Record<string, unknown>>,
) {
  return {
    threadId,
    runId,
    agentId: resolved.agent_id,
    injectionAgent: resolved.injectionAgent,
    namespaceGeneration: resolved.namespaceGeneration,
    input: inputIdentity(params),
  }
}
export function createActiveInputBoundary(options: {
  readonly store: RuntimeStore
  readonly runId: string
  readonly namespace: readonly string[]
  readonly namespaceGeneration: string
}) {
  let selected: readonly RuntimeInboxRecord[] = []
  async function current(tx: RuntimeTransaction) {
    const run = await tx.runs.get(options.runId),
      thread = await tx.thread.get()
    if (
      !run ||
      !thread ||
      thread.currentRunId !== options.runId ||
      thread.pausedGeneration ||
      run.metadata.phase !== "running" ||
      run.metadata.generation !== tx.scope.generation ||
      run.execution?.fence !== tx.scope.fence ||
      run.execution.ownerId !== (await tx.executionOwner()) ||
      (await tx.inbox.list()).some(
        (row) => row.kind === "control" && row.runId === options.runId && row.status === "accepted",
      )
    )
      throw new ProtocolError("stale_generation")
    return { run, thread }
  }
  const activeInput: BackendActiveInput = {
    async beforeModel() {
      return options.store.transaction(async (tx) => {
        await current(tx)
        selected = (await tx.inbox.list())
          .filter(
            (row) =>
              row.kind === "inject" &&
              row.runId === options.runId &&
              row.status === "accepted" &&
              canonical(row.namespace) === canonical(options.namespace) &&
              injectionPayload(row).generation === tx.scope.generation &&
              injectionPayload(row).namespaceGeneration === options.namespaceGeneration,
          )
          .sort((left, right) => injectionPayload(left).order - injectionPayload(right).order)
        return selected.length
          ? {
              messages: selected.map((row) => injectionPayload(row).message),
              inputIds: selected.map((row) => row.entryId),
            }
          : undefined
      })
    },
  }
  return {
    activeInput,
    async commitInputs(tx: RuntimeTransaction, ids: unknown) {
      if (ids === undefined || (Array.isArray(ids) && !ids.length)) return
      const { run, thread } = await current(tx)
      if (!Array.isArray(ids) || canonical(ids) !== canonical(selected.map((row) => row.entryId)))
        throw new ProtocolError("storage_unavailable")
      const durable = await Promise.all(selected.map((row) => tx.inbox.get(row.entryId)))
      const applied = durable.every((row) => row?.status === "applied")
      if (!applied && !durable.every((row) => row?.status === "accepted"))
        throw new ProtocolError("stale_generation")
      for (const expected of selected) {
        const row = await tx.inbox.get(expected.entryId)
        if (
          !row ||
          row.runId !== options.runId ||
          canonical(row.namespace) !== canonical(options.namespace) ||
          canonical(row.payload) !== canonical(expected.payload) ||
          row.status !== (applied ? "applied" : "accepted")
        )
          throw new ProtocolError("stale_generation")
        const payload = injectionPayload(row),
          receipt = await tx.receipts.get(payload.receiptId)
        if (
          !receipt ||
          receipt.receipt.inputId !== row.entryId ||
          receipt.receipt.runId !== options.runId ||
          receipt.receipt.disposition !== (applied ? "applied" : "accepted")
        )
          throw new ProtocolError("storage_unavailable")
        if (applied) continue
        await tx.inbox.put({ ...row, status: "applied" })
        await tx.receipts.put({
          ...receipt,
          receipt: { ...receipt.receipt, disposition: "applied" },
        })
        await inputFact(tx, row, run.metadata.turnId, "applied")
      }
      if (!applied && options.namespace.length === 0) {
        await tx.thread.put({
          ...thread,
          revision: thread.revision + 1,
          thread: {
            ...thread.thread,
            messages: mergePublicMessages(
              parsePublicMessages(thread.thread.messages ?? []),
              selected.map((row) => injectionPayload(row).message),
            ),
          },
        })
      }
      // Do not flip local state before the enclosing native COMMIT can succeed.
      // Subsequent checkpoints recognize the durable row dispositions below.
    },
  }
}
async function inputFact(
  tx: RuntimeTransaction,
  row: RuntimeInboxRecord,
  turnId: string,
  disposition: "accepted" | "applied" | "not_applied",
  reason?: string,
) {
  await tx.journal.append({
    eventId: crypto.randomUUID(),
    namespace: row.namespace,
    ownerRunId: row.runId,
    event: {
      type: "event",
      method: "custom",
      params: {
        namespace: row.namespace,
        timestamp: Date.now(),
        data: {
          name: "b4.input",
          payload: {
            v: 1,
            inputId: row.entryId,
            runId: row.runId,
            turnId,
            disposition,
            ...(reason ? { reason } : {}),
          },
        },
      },
    },
  })
}
/** One exact Run only, including namespaces which never reached another model. */
export async function retireActiveInputs(
  tx: RuntimeTransaction,
  runId: string,
  reason: string,
  target?: { readonly namespace: readonly string[]; readonly namespaceGeneration: string },
): Promise<void> {
  const run = await tx.runs.get(runId)
  if (!run) return
  for (const row of await tx.inbox.list()) {
    if (row.kind !== "inject" || row.runId !== runId || row.status !== "accepted") continue
    if (
      target &&
      (canonical(row.namespace) !== canonical(target.namespace) ||
        injectionPayload(row).namespaceGeneration !== target.namespaceGeneration)
    )
      continue
    const payload = injectionPayload(row),
      receipt = await tx.receipts.get(payload.receiptId)
    if (!receipt || receipt.receipt.runId !== runId || receipt.receipt.inputId !== row.entryId)
      throw new ProtocolError("storage_unavailable")
    await tx.inbox.put({ ...row, status: "not_applied", payload: { ...payload, reason } })
    await tx.receipts.put({
      ...receipt,
      receipt: { ...receipt.receipt, disposition: "not_applied", reason },
    })
    await inputFact(tx, row, run.metadata.turnId, "not_applied", reason)
  }
}
export function createInputService(options: InputServiceOptions) {
  const backend = runtimeStorageRegistration(options.storage)
  const limits = options.limits ?? { entries: 128, bytes: 1048576, textBytes: 65536 }
  if (
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
    limits.entries > 128 ||
    limits.bytes > 1048576 ||
    limits.textBytes > 65536
  )
    throw new Error("Invalid injection inbox limits")
  async function inject(
    request: Request,
    threadId: string,
    runId: string,
    value: unknown,
  ): Promise<InputReceiptResultV1> {
    canonicalProtocolId(threadId)
    canonicalProtocolId(runId)
    const params: AspInputInjectParams = JSON.parse(
      JSON.stringify(
        parseProtocolRequest("command", { id: 0, method: "input.inject", params: value }).params,
      ),
    )
    const envelope =
      params.message.b4 === undefined ? { v: 1 as const } : parseRequestMetadata(params.message.b4)
    const token = envelope.submissionId ?? crypto.randomUUID()
    const ownerKey = hash(
      createThreadAccessContext(options.deploymentId, requestPrincipal(request)),
    )
    const receiptId = hash([ownerKey, "input.inject", threadId, runId, token])
    const gate = makeProtocolThreadGate(options.policy, request, {
      deploymentId: options.deploymentId,
    })
    async function reconcile(): Promise<InputReceiptResultV1 | undefined> {
      const candidates = await backend.searchOperations({
        scopeKey: ownerKey,
        submissionId: token,
        submissionKind: "b4",
        operationThreadId: threadId,
        targetRunId: runId,
        method: "input.inject",
      })
      const minimal = candidates.find((row) => row.receiptId === receiptId)
      if (!minimal) return undefined
      const checkRetained = (
        value: NonNullable<typeof minimal.retainedSubject>,
        agentId = minimal.agentId,
        facts = minimal.operationAuthority,
      ) =>
        authorizeRetainedOperation(
          threadId,
          agentId,
          facts,
          value,
          (id) => options.authorizeAgent(request, id),
          async () =>
            (
              await gate({
                action: "update",
                operation: "input.inject",
                threadId,
                ...subject(value),
              })
            ).ok,
        )
      async function retained(value: typeof minimal): Promise<InputReceiptResultV1> {
        if (!value?.retainedSubject) throw new ProtocolError("submission_target_gone")
        await checkRetained(value.retainedSubject, value.agentId, value.operationAuthority)
        const cut = await backend.temporary?.readOperation({
          threadId,
          generation: value.scope.generation,
          receiptId,
        })
        if (!cut) throw new ProtocolError("receipt_expired")
        await checkRetained(
          cut.subject,
          typeof cut.receipt.operation?.resolved.agent_id === "string"
            ? cut.receipt.operation.resolved.agent_id
            : undefined,
          operationAuthorityFacts(cut.receipt, cut.runAuthority),
        )
        validateRetainedOperationCut(value, cut, ownerKey)
        const result = replayOperationFacts(
          cut.scope,
          cut.receipt,
          cut.run,
          ownerKey,
          (operation) => injectionIdentity(params, threadId, runId, operation.resolved),
        )
        return { runId: result.runId, b4: result.responseMeta.b4 }
      }
      if (minimal.retainedSubject) return retained(minimal)
      if (!minimal.agentId) throw new ProtocolError("not_found")
      await options.authorizeAgent(request, minimal.agentId)
      for (const agent of operationRunAgents(minimal.operationAuthority))
        await options.authorizeAgent(request, agent)
      if (
        !(
          await gate({
            action: "update",
            operation: "input.inject",
            threadId,
            ...subject(minimal.thread, minimal.provenance),
          })
        ).ok
      )
        throw new ProtocolError("not_found")
      validateOperationRunAuthority(threadId, minimal.operationAuthority)
      const store = await backend.openThread(threadId, false, minimal.scope.generation)
      if (!store) {
        const fresh = (
          await backend.searchOperations({
            scopeKey: ownerKey,
            submissionId: token,
            submissionKind: "b4",
            operationThreadId: threadId,
            targetRunId: runId,
            method: "input.inject",
          })
        ).find(
          (row) => row.receiptId === receiptId && row.scope.generation === minimal.scope.generation,
        )
        return retained(fresh)
      }
      return store.transaction(async (tx) => {
        const thread = await tx.thread.get()
        if (
          !thread ||
          !(
            await gate({
              action: "update",
              operation: "input.inject",
              threadId,
              ...subject(thread, minimal.provenance),
            })
          ).ok
        )
          throw new ProtocolError("not_found")
        const receipt = await tx.receipts.get(receiptId),
          run = await tx.runs.get(runId)
        if (!receipt) throw new ProtocolError("receipt_expired")
        const facts = await authorizeCurrentOperation(tx, receipt, (id) =>
          options.authorizeAgent(request, id),
        )
        const root = receipt.operation?.resolved.agent_id
        if (typeof root !== "string") throw new ProtocolError("storage_unavailable")
        await options.authorizeAgent(request, root)
        for (const agent of operationRunAgents(facts)) await options.authorizeAgent(request, agent)
        validateOperationAuthority(threadId, facts)
        if (!sameOperationAuthority(facts, minimal.operationAuthority))
          throw new ProtocolError("storage_unavailable")
        const result = replayOperationFacts(tx.scope, receipt, run, ownerKey, (operation) =>
          injectionIdentity(params, threadId, runId, operation.resolved),
        )
        return { runId: result.runId, b4: result.responseMeta.b4 }
      })
    }
    const previous = await reconcile()
    if (previous) return previous
    const candidate = await backend.findRun?.(runId)
    if (!candidate || candidate.scope.threadId !== threadId) throw new ProtocolError("not_found")
    await options.authorizeAgent(request, candidate.agentId)
    for (const agent of knownRunPermissionAgents(candidate.authority))
      await options.authorizeAgent(request, agent)
    if (
      !(
        await gate({
          action: "update",
          operation: "input.inject",
          threadId,
          ...subject(candidate.subject),
        })
      ).ok
    )
      throw new ProtocolError("not_found")
    exactRunPermissionAgents(threadId, runId, candidate.authority)
    // Retained inject replay is enabled only with the full canonical contributor cut.
    if (candidate.location !== "live") throw new ProtocolError("not_supported")
    if (!Array.isArray(candidate.namespaceBindings)) throw new ProtocolError("storage_unavailable")
    const nativeTarget = params.namespace.length
      ? candidate.namespaceBindings.find(
          (binding) => canonical(binding.namespace) === canonical(params.namespace),
        )
      : undefined
    if (params.namespace.length) {
      if (!nativeTarget || typeof nativeTarget.agentId !== "string")
        throw new ProtocolError("not_found", { resource: "namespace" })
      await options.authorizeAgent(request, nativeTarget.agentId)
      canonicalProtocolId(nativeTarget.checkpointId)
      canonicalProtocolId(nativeTarget.parentCheckpointId)
      canonicalProtocolId(nativeTarget.namespaceGeneration)
      if (
        nativeTarget.status !== "running" ||
        (!nativeTarget.source &&
          params.namespace.at(-1)?.split(":").at(-1) !== nativeTarget.namespaceGeneration)
      )
        throw new ProtocolError("stale_generation")
    }
    const store = await backend.openThread(threadId, false, candidate.scope.generation)
    if (!store) throw new ProtocolError("submission_target_gone")
    async function authorize(tx: RuntimeTransaction) {
      const thread = await tx.thread.get(),
        run = await tx.runs.get(runId)
      if (
        !thread ||
        !run ||
        !run.run.agent_id ||
        tx.scope.generation !== candidate!.scope.generation
      )
        throw new ProtocolError("submission_target_gone")
      await options.authorizeAgent(request, run.run.agent_id)
      const facts = runAuthorityFacts(
        run,
        await tx.receipts.list(),
        await tx.nativeNamespaces.list(),
        await tx.protectedSources.list(),
      )
      for (const agent of knownRunPermissionAgents(facts))
        await options.authorizeAgent(request, agent)
      if (
        !(await gate({ action: "update", operation: "input.inject", threadId, ...subject(thread) }))
          .ok
      )
        throw new ProtocolError("not_found")
      exactRunPermissionAgents(threadId, runId, facts)
      return { thread, run }
    }
    const fingerprint = (resolved: Readonly<Record<string, unknown>>) =>
      hash([
        ownerKey,
        "input.inject",
        canonical(injectionIdentity(params, threadId, runId, resolved)),
        candidate.scope.generation,
      ])
    async function replay(
      tx: RuntimeTransaction,
      receipt: RuntimeReceiptRecord,
    ): Promise<InputReceiptResultV1> {
      await authorize(tx)
      const facts = await authorizeCurrentOperation(tx, receipt, (id) =>
        options.authorizeAgent(request, id),
      )
      for (const agent of Array.isArray(facts.permissionAgents) ? facts.permissionAgents : [])
        await options.authorizeAgent(request, agent)
      validateOperationAuthority(threadId, facts)
      if (receipt.operation?.scopeKey !== ownerKey || receipt.receipt.runId !== runId)
        throw new ProtocolError("not_found")
      if (!receipt.operation || receipt.fingerprint !== fingerprint(receipt.operation.resolved))
        throw new ProtocolError("submission_conflict")
      if (receipt.state !== "accepted") throw new ProtocolError("receipt_expired")
      return { runId, b4: { v: 1, receipt: { ...receipt.receipt, replayed: true } } }
    }
    const old = await store.transaction(async (tx) => {
      const receipt = await tx.receipts.get(receiptId)
      return receipt ? replay(tx, receipt) : undefined
    })
    if (old) return old
    if (!runtimeAdmissionOpen(options.storage)) throw new ProtocolError("storage_unavailable")
    const snapshot = await store.snapshot(),
      run = snapshot.runs.find((row) => row.run.run_id === runId)
    if (!run) throw new ProtocolError("not_found")
    const target = await options.resolveTarget({
      request,
      run,
      namespace: params.namespace,
      snapshot,
      ...(nativeTarget ? { namespaceBinding: nativeTarget } : {}),
    })
    if (target.adapter.protocol?.injection !== "before_model")
      throw new ProtocolError("not_supported", { feature: "injection" })
    await options.authorizeAgent(request, target.agentId)
    canonicalProtocolId(target.namespaceGeneration)
    const matchesNamespace = async (rows: RuntimeSnapshot["checkpoints"]) => {
      const row = rows.find(
        (row) => row.state.checkpoint.checkpoint_id === nativeTarget?.checkpointId,
      )
      const binding = (
        row?.payload as {
          binding?: { agentId?: string; namespaceGeneration?: string; status?: string }
        } | null
      )?.binding
      const selectedSource =
        nativeTarget?.source &&
        row?.ownerRunId &&
        row.state.checkpoint.checkpoint_id === nativeTarget.source.checkpointId &&
        (await store.transaction(async (tx) => {
          await authorize(tx)
          const original = await tx.nativeNamespaces.get(
            `namespace:${hash([tx.scope.threadId, tx.scope.generation, row.ownerRunId, row.namespace])}`,
          )
          return (
            original?.agentId === target.agentId &&
            original.checkpointId === row.state.checkpoint.checkpoint_id &&
            original.namespaceGeneration === binding?.namespaceGeneration
          )
        }))
      return (
        binding?.agentId === target.agentId &&
        (binding.namespaceGeneration === target.namespaceGeneration || selectedSource) &&
        binding.status === "running"
      )
    }
    if (
      nativeTarget &&
      (nativeTarget.agentId !== target.agentId ||
        nativeTarget.namespaceGeneration !== target.namespaceGeneration)
    )
      throw new ProtocolError("stale_generation")
    if (
      (!params.namespace.length &&
        (target.agentId !== run.run.agent_id || target.namespaceGeneration !== runId)) ||
      (params.namespace.length && !(await matchesNamespace(snapshot.checkpoints)))
    )
      throw new ProtocolError("not_found", { resource: "namespace" })
    if (params.message.role === "system") {
      if (!target.systemInjection || !options.authorizeSystemInput)
        throw new ProtocolError("not_supported", { feature: "systemInjection" })
      if ((await options.authorizeSystemInput(request, target.agentId)) !== true)
        throw new ProtocolError("permission_denied")
    }
    const bytes = new TextEncoder().encode(params.message.content).byteLength
    if (
      bytes > limits.textBytes ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 1048576
    )
      throw new ProtocolError("body_too_large")
    let result: InputReceiptResultV1
    try {
      result = await store.transaction(async (tx) => {
        const { thread, run } = await authorize(tx)
        await options.authorizeAgent(request, target.agentId)
        const existing = await tx.receipts.get(receiptId)
        if (existing) return replay(tx, existing)
        if (
          params.message.role === "system" &&
          (await options.authorizeSystemInput?.(request, target.agentId)) !== true
        )
          throw new ProtocolError("permission_denied")
        if (!runtimeAdmissionOpen(options.storage)) throw new ProtocolError("storage_unavailable")
        if (params.namespace.length) {
          const binding = await tx.nativeNamespaces.get(
            `namespace:${hash([tx.scope.threadId, tx.scope.generation, runId, params.namespace])}`,
          )
          if (
            !binding ||
            binding.agentId !== target.agentId ||
            binding.namespaceGeneration !== target.namespaceGeneration ||
            binding.status !== "running"
          )
            throw new ProtocolError("stale_generation")
        }
        if (
          thread.currentRunId !== runId ||
          !["accepted", "running"].includes(run.metadata.phase) ||
          thread.pausedGeneration ||
          run.ownershipLoss ||
          (envelope.expected?.generation && envelope.expected.generation !== tx.scope.generation) ||
          (envelope.expected?.runId && envelope.expected.runId !== runId) ||
          envelope.expected?.pausedGeneration
        )
          throw new ProtocolError("stale_generation")
        const inbox = (await tx.inbox.list()).filter(
          (row) => row.kind === "inject" && row.runId === runId,
        )
        const waiting = inbox.filter((row) => row.status === "accepted")
        const inputId = crypto.randomUUID(),
          acceptedAt = new Date().toISOString()
        const message: B4Message = {
          id: inputId,
          role: params.message.role,
          content: params.message.content,
          ...(params.message.name ? { name: params.message.name } : {}),
        }
        if (
          waiting.length >= limits.entries ||
          waiting.reduce(
            (total, row) =>
              total +
              new TextEncoder().encode(JSON.stringify(injectionPayload(row).message)).byteLength,
            0,
          ) +
            new TextEncoder().encode(JSON.stringify(message)).byteLength >
            limits.bytes
        )
          throw new ProtocolError("capacity_exceeded")
        const resolved = {
          agent_id: run.run.agent_id,
          thread_id: threadId,
          namespace: params.namespace,
          namespaceGeneration: target.namespaceGeneration,
          injectionAgent: target.agentId,
          permissionAgents: params.namespace.length ? [target.agentId] : [],
        }
        const receipt: RuntimeReceiptRecord = {
          receiptId,
          fingerprint: fingerprint(resolved),
          state: "accepted",
          receipt: {
            submissionId: token,
            submissionKind: "b4",
            runId,
            turnId: run.metadata.turnId,
            acceptedAt,
            replayed: false,
            disposition: "accepted",
            inputId,
          },
          operation: {
            scopeKey: ownerKey,
            method: "input.inject",
            operationThreadId: threadId,
            targetRunId: runId,
            normalization: { messages: true, mechanicalDefaults: {}, configDefaults: {} },
            resolved,
            provenance:
              (thread.protectedMetadata.provenance as Readonly<Record<string, unknown>>) ?? {},
          },
        }
        await tx.inbox.put({
          entryId: inputId,
          kind: "inject",
          runId,
          namespace: params.namespace,
          status: "accepted",
          createdAt: acceptedAt,
          payload: {
            v: 1,
            generation: tx.scope.generation,
            namespaceGeneration: target.namespaceGeneration,
            order: Math.max(0, ...inbox.map((row) => injectionPayload(row).order)) + 1,
            receiptId,
            message,
          } satisfies InjectionPayload,
        })
        await tx.receipts.put(receipt)
        const acceptedInput = await tx.inbox.get(inputId)
        if (!acceptedInput) throw new ProtocolError("storage_unavailable")
        await inputFact(tx, acceptedInput, run.metadata.turnId, "accepted")
        await options.failpoint?.("beforeCommit")
        return { runId, b4: { v: 1, receipt: receipt.receipt } }
      })
    } catch (error) {
      const accepted = await reconcile()
      if (!accepted) throw error
      result = accepted
    }
    await options.failpoint?.("afterCommit")
    return result
  }
  return { inject }
}
