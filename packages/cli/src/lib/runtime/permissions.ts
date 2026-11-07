import type { PermissionsStore, RememberedRuleIntent } from "@b4run/permissions"
import {
  permissionCandidateForRequest,
  permissionRuleForRequest,
  RuleIntentConflictError,
} from "@b4run/permissions/internal/rule-coordinator"
import { createApprovalGrant } from "@b4run/sdk"
import type {
  AspInputRespondParams,
  PermissionPayloadV1,
  PermissionResponseV1,
  RuntimeOperationContext,
  RuntimePendingRecord,
  RuntimeRunRecord,
  RuntimeSnapshot,
  RuntimeThreadRecord,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
import { checkRuntimeApprovalGrant } from "../dev/approval-grants.js"
import { requestPrincipal } from "../dev/auth.js"
import { ProtocolError } from "../dev/protocol/errors.js"
import { canonicalProtocolId, parseRequestMetadata } from "../dev/protocol/metadata.js"
import { parseProtocolRequest } from "../dev/protocol/validate.js"
import { createThreadAccessContext } from "../dev/thread-access.js"
import { makeProtocolThreadGate } from "../dev/thread-gate.js"
import type { AdmissionServiceOptions } from "./admission.js"
import {
  type AdmissionResult,
  authorizeSavedPermissionAgents,
  canonical,
  hash,
  operationPayload,
  rememberAdmissionBinding,
  replayOperationFacts,
  replayOperationReceipt,
  subject,
} from "./operation-ledger.js"
import {
  completePermissionResponses,
  permissionResponseEntries as entries,
  permissionAddress as key,
  permissionResponse as response,
} from "./pending-interrupts.js"
import { runtimeAdmissionOpen, runtimeStorageRegistration } from "./storage-host.js"

export interface PermissionServiceOptions
  extends Pick<AdmissionServiceOptions, "storage" | "deploymentId" | "policy" | "authorizeAgent"> {
  readonly grants?: "off" | "optional" | "required"
  readonly resolvePermissions?: (context: {
    readonly thread: RuntimeThreadRecord
    readonly run: RuntimeRunRecord
    readonly pending: RuntimePendingRecord
  }) => Promise<PermissionsStore | undefined>
  readonly failpoint?: (
    point: "afterConsume" | "beforeCommit" | "afterCommit" | "afterRuleApply",
  ) => void | Promise<void>
}
export interface PermissionProposal {
  readonly agentId?: string
  readonly interruptId: string
  readonly namespace: readonly string[]
  readonly request: Readonly<Record<string, unknown>>
  readonly protectedProposal: unknown
  readonly allowAlways?: boolean
  readonly expiresAt?: string
}

function protectedProposalHash(item: RuntimePendingRecord): string {
  const payload = item.input.data.payload as PermissionPayloadV1
  return hash({
    ownerRunId: item.ownerRunId,
    namespace: item.namespace,
    inputId: item.input.data.interruptId,
    pausedGeneration: item.input.data.b4.pausedGeneration,
    request: payload.request,
    allowAlways: payload.allowAlways,
    expiresAt: item.input.data.b4.expiresAt ?? null,
    proposal: item.proposal,
  })
}
/** Safe-boundary hook for the adapter. The caller enlists its native checkpoint
 * in this same fenced transaction; this hook never invokes or owns a graph. */
export async function parkPermissions(
  tx: RuntimeTransaction,
  runId: string,
  proposals: readonly PermissionProposal[],
  grants: "off" | "optional" | "required" = "off",
): Promise<void> {
  const row = await tx.runs.get(runId),
    thread = await tx.thread.get()
  if (
    !row?.run.agent_id ||
    !thread ||
    thread.currentRunId !== runId ||
    row.metadata.phase !== "running" ||
    row.execution?.fence !== tx.scope.fence ||
    proposals.length === 0 ||
    new Set(proposals.map(key)).size !== proposals.length
  )
    throw new ProtocolError("stale_generation")
  const pausedGeneration = crypto.randomUUID(),
    timestamp = new Date().toISOString()
  const responseSchema = {
    type: "object",
    additionalProperties: false,
    properties: { decision: { enum: ["once", "always", "deny"] }, grant: { type: "string" } },
    required: ["decision"],
  }
  for (const proposal of proposals) {
    const expired =
      proposal.expiresAt !== undefined && Date.parse(proposal.expiresAt) <= Date.parse(timestamp)
    const minted = grants === "off" ? undefined : await createApprovalGrant()
    const payload: PermissionPayloadV1 = {
      type: "b4.permission",
      v: 1,
      request: proposal.request,
      responseSchema,
      allowedDecisions:
        proposal.allowAlways === false ? ["once", "deny"] : ["once", "always", "deny"],
      allowAlways: proposal.allowAlways !== false,
    }
    const pending: RuntimePendingRecord = {
      ownerRunId: runId,
      namespace: proposal.namespace,
      disposition: "pending",
      decision: null,
      proposal: {
        agentId: proposal.agentId ?? row.run.agent_id,
        value: proposal.protectedProposal,
        rule: permissionRuleForRequest(proposal.request),
      },
      input: {
        namespace: proposal.namespace,
        runId,
        turnId: row.metadata.turnId,
        data: {
          interruptId: proposal.interruptId,
          payload,
          b4: {
            v: 1,
            pausedGeneration,
            proposalHash: "",
            status: expired ? "expired" : "waiting",
            ...(proposal.expiresAt ? { expiresAt: proposal.expiresAt } : {}),
            ...(minted ? { grant: minted.grant } : {}),
          },
        },
      },
    }
    const proposalHash = protectedProposalHash(pending)
    await tx.pending.put({
      ...pending,
      input: {
        ...pending.input,
        data: { ...pending.input.data, b4: { ...pending.input.data.b4, proposalHash } },
      },
    })
    await tx.journal.append({
      eventId: crypto.randomUUID(),
      ownerRunId: runId,
      namespace: proposal.namespace,
      event: {
        type: "event",
        method: "input.requested",
        params: {
          namespace: proposal.namespace,
          timestamp: Date.parse(timestamp),
          data: {
            interruptId: proposal.interruptId,
            payload,
            b4: {
              v: 1,
              pausedGeneration,
              proposalHash,
              status: expired ? "expired" : "waiting",
              ...(proposal.expiresAt ? { expiresAt: proposal.expiresAt } : {}),
            },
          },
        },
      },
    })
    if (minted)
      await tx.grants.put({
        grantId: crypto.randomUUID(),
        tokenHash: minted.tokenHash,
        proposalHash,
        inputId: proposal.interruptId,
        ownerRunId: runId,
        pausedGeneration,
        namespace: proposal.namespace,
        expiresAt: proposal.expiresAt ?? null,
        consumedByRunId: null,
      })
  }
  const metadata = {
    ...row.metadata,
    phase: "settled" as const,
    reason: "permission" as const,
    continuation: "waiting" as const,
    settledAt: timestamp,
  }
  const run = { ...row.run, status: "interrupted" as const, updated_at: timestamp }
  await tx.runs.put({
    ...row,
    run,
    metadata,
    result: {
      ...row.result,
      run: {
        ...run,
        metadata: { ...run.metadata, b4: metadata },
      },
    },
  })
  await tx.thread.put({
    ...thread,
    pausedGeneration,
    revision: thread.revision + 1,
    thread: { ...thread.thread, updated_at: timestamp, status: "interrupted" },
  })
  await tx.journal.append({
    eventId: crypto.randomUUID(),
    ownerRunId: runId,
    namespace: row.namespace,
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
/** Retire only the exact current pause, preserving the historical permission
 * settlement. Stop/loss never answer a prompt, consume a grant or invoke a graph. */
export async function retirePermissionPause(
  tx: RuntimeTransaction,
  runId: string,
  timestamp: string,
): Promise<void> {
  const thread = await tx.thread.get(),
    run = await tx.runs.get(runId)
  if (
    !thread?.pausedGeneration ||
    thread.currentRunId !== runId ||
    !run ||
    run.metadata.continuation !== "waiting"
  )
    return
  const pause = thread.pausedGeneration
  for (const pending of await tx.pending.list())
    if (
      pending.ownerRunId === runId &&
      pending.input.data.b4.pausedGeneration === pause &&
      pending.disposition === "pending"
    ) {
      const { grant: _grant, ...metadata } = pending.input.data.b4
      await tx.pending.put({
        ...pending,
        disposition: "retired",
        input: {
          ...pending.input,
          data: { ...pending.input.data, b4: { ...metadata, status: "abandoned" } },
        },
      })
    }
  const metadata = { ...run.metadata, continuation: "closed" as const }
  await tx.runs.put({
    ...run,
    metadata,
    result: run.result
      ? { ...run.result, run: { ...run.run, metadata: { ...run.run.metadata, b4: metadata } } }
      : null,
  })
  await tx.thread.put({
    ...thread,
    pausedGeneration: null,
    revision: thread.revision + 1,
    thread: { ...thread.thread, status: "idle", updated_at: timestamp },
  })
  await tx.journal.append({
    eventId: crypto.randomUUID(),
    namespace: run.namespace,
    ownerRunId: runId,
    event: {
      type: "event",
      method: "custom",
      params: {
        namespace: run.namespace,
        timestamp: Date.parse(timestamp),
        data: {
          name: "b4.run",
          payload: { ...metadata, runId, agentId: run.run.agent_id, status: run.run.status },
        },
      },
    },
  })
}
function compareCanonical(a: unknown, b: unknown): number {
  const left = canonical(a),
    right = canonical(b)
  return left < right ? -1 : left > right ? 1 : 0
}
function identity(params: AspInputRespondParams, threadId: string, runId: string) {
  const {
    responses: _responses,
    namespace: _namespace,
    interruptId: _interruptId,
    response: _response,
    ...controls
  } = params as Record<string, unknown>
  return operationPayload({
    ...controls,
    thread_id: threadId,
    run_id: runId,
    responses: [...entries(params)].sort((a, b) =>
      compareCanonical([a.namespace, a.interruptId], [b.namespace, b.interruptId]),
    ),
  })
}
interface PreparedRuleBatch {
  readonly intent: RememberedRuleIntent
  readonly bindings: readonly { readonly pending: RuntimePendingRecord }[]
}
async function prepareRuleIntents(
  options: PermissionServiceOptions,
  request: Request,
  snapshot: RuntimeSnapshot,
  runId: string,
  params: AspInputRespondParams,
  receiptId: string,
): Promise<readonly PreparedRuleBatch[]> {
  const run = snapshot.runs.find((row) => row.run.run_id === runId),
    thread = snapshot.thread
  if (!run?.run.agent_id || !thread) throw new ProtocolError("not_found")
  await options.authorizeAgent(request, run.run.agent_id)
  for (const item of snapshot.pending.filter((item) => item.disposition === "pending")) {
    if (!item.proposal?.agentId) throw new ProtocolError("approval_changed")
    await options.authorizeAgent(request, item.proposal.agentId)
  }
  const grouped = new Map<
    string,
    { store: PermissionsStore; bindings: { pending: RuntimePendingRecord }[] }
  >()
  for (const answer of entries(params)) {
    const item = snapshot.pending.find(
      (row) =>
        row.disposition === "pending" &&
        key({ namespace: row.namespace, interruptId: row.input.data.interruptId }) === key(answer),
    )
    if (
      !item ||
      response(answer.response).decision !== "always" ||
      (item.input.data.payload as PermissionPayloadV1).allowAlways === false
    )
      continue
    if (!item.proposal || protectedProposalHash(item) !== item.input.data.b4.proposalHash)
      throw new ProtocolError("approval_changed")
    const store = await options.resolvePermissions?.({ thread, run, pending: item })
    if (!store?.rememberedRules) throw new ProtocolError("not_supported")
    await store.load()
    const discovery = await store.rememberedRules.prepare(
      hash([receiptId, "discover", key(answer)]),
      [item.proposal.rule],
    )
    const group = grouped.get(discovery.scopeId) ?? { store, bindings: [] }
    group.bindings.push({ pending: item })
    grouped.set(discovery.scopeId, group)
  }
  const batches: PreparedRuleBatch[] = []
  for (const [scopeId, group] of grouped) {
    const rules = [
      ...new Map(
        group.bindings.map(({ pending }) => {
          if (!pending.proposal) throw new ProtocolError("approval_changed")
          return [canonical(pending.proposal.rule), pending.proposal.rule] as const
        }),
      ).values(),
    ].sort(compareCanonical)
    const coordinator = group.store.rememberedRules
    if (!coordinator) throw new ProtocolError("not_supported")
    const intent = await coordinator.prepare(hash([receiptId, "rule", scopeId]), rules)
    if (intent.scopeId !== scopeId) throw new ProtocolError("approval_changed")
    batches.push({ intent, bindings: group.bindings })
  }
  return batches
}

/** Staged shared service; bindings are activated by R8 after old owners retire. */
export interface PermissionExecutionPreparation {
  readonly kind: "permission_preparation"
}
const services = new WeakSet<PermissionService>()
export function isPermissionService(service: PermissionService): boolean {
  return services.has(service)
}
interface RuleIntentPayload {
  readonly intent: RememberedRuleIntent
  readonly bindings: readonly {
    readonly inputId: string
    readonly ownerRunId: string
    readonly namespace: readonly string[]
    readonly proposalHash: string
  }[]
}
export interface PermissionService {
  respond(
    request: Request,
    threadId: string,
    runId: string,
    body: unknown,
  ): Promise<AdmissionResult>
  respondNativeCreation(
    request: Request,
    threadId: string,
    runId: string,
    body: unknown,
  ): Promise<AdmissionResult>
  prepareExecution(threadId: string): Promise<PermissionExecutionPreparation>
  completePreparation(
    tx: RuntimeTransaction,
    runId: string,
    preparation: PermissionExecutionPreparation,
  ): Promise<"ready" | "refused" | "deferred">
}
export function createPermissionService(options: PermissionServiceOptions): PermissionService {
  const backend = runtimeStorageRegistration(options.storage)
  const mode = options.grants ?? "off"
  const preparations = new WeakMap<
    PermissionExecutionPreparation,
    {
      threadId: string
      generation: string
      runId: string | null
      entries: ReadonlyMap<string, string>
      pendingFacts: string
      outcome: "ready" | "refused"
    }
  >()
  async function respond(
    request: Request,
    threadId: string,
    runId: string,
    body: unknown,
    bindingKind: NonNullable<RuntimeOperationContext["binding"]>["kind"],
  ): Promise<AdmissionResult> {
    canonicalProtocolId(threadId)
    canonicalProtocolId(runId)
    const command = parseProtocolRequest("command", body)
    if (command.method !== "input.respond") throw new ProtocolError("invalid_argument")
    const params: AspInputRespondParams = JSON.parse(JSON.stringify(command.params))
    const envelope =
      params.metadata?.b4 === undefined
        ? { v: 1 as const }
        : parseRequestMetadata(params.metadata.b4)
    const token = envelope.submissionId ?? crypto.randomUUID()
    const ownerKey = hash(
      createThreadAccessContext(options.deploymentId, requestPrincipal(request)),
    )
    const receiptId = hash([ownerKey, "input.respond", threadId, runId, token])
    const gate = makeProtocolThreadGate(options.policy, request, {
      deploymentId: options.deploymentId,
    })
    const reconcile = async (): Promise<AdmissionResult | undefined> => {
      const candidates = await backend.searchOperations({
        scopeKey: ownerKey,
        submissionId: token,
        submissionKind: "b4",
        operationThreadId: threadId,
        targetRunId: runId,
        method: "input.respond",
      })
      const candidate = candidates.find((row) => row.receiptId === receiptId)
      if (!candidate) return undefined
      if (candidate.agentId) await options.authorizeAgent(request, candidate.agentId)
      const decision = await gate({
        action: "update",
        operation: "input.respond",
        threadId,
        resuming: true,
        ...subject(candidate.thread ?? candidate.retainedSubject, candidate.provenance),
      })
      if (!decision.ok) throw new ProtocolError("not_found")
      if (candidate.retainedSubject) {
        const facts = await backend.temporary?.readOperation({
          threadId,
          generation: candidate.scope.generation,
          receiptId,
        })
        if (!facts) throw new ProtocolError("receipt_expired")
        if (
          !(
            await gate({
              action: "update",
              operation: "input.respond",
              threadId,
              resuming: true,
              ...subject(facts.subject, candidate.provenance),
            })
          ).ok
        )
          throw new ProtocolError("not_found")
        await authorizeSavedPermissionAgents(facts.receipt, (id) =>
          options.authorizeAgent(request, id),
        )
        return rememberAdmissionBinding(
          replayOperationFacts(facts.scope, facts.receipt, facts.run, ownerKey, () =>
            identity(params, threadId, runId),
          ),
          options.storage,
          facts.scope.generation,
          facts.receipt.operation?.binding,
        )
      }
      const store = await backend.openThread(threadId, false)
      if (!store) throw new ProtocolError("submission_target_gone")
      return store.transaction(async (tx) => {
        const thread = await tx.thread.get()
        if (
          !(
            await gate({
              action: "update",
              operation: "input.respond",
              threadId,
              resuming: true,
              ...subject(thread, candidate.provenance),
            })
          ).ok
        )
          throw new ProtocolError("not_found")
        if (tx.scope.generation !== candidate.scope.generation)
          throw new ProtocolError("submission_target_gone")
        const receipt = await tx.receipts.get(receiptId)
        if (!receipt) throw new ProtocolError("receipt_expired")
        await authorizeSavedPermissionAgents(receipt, (id) => options.authorizeAgent(request, id))
        return rememberAdmissionBinding(
          await replayOperationReceipt(tx, receipt, ownerKey, () =>
            identity(params, threadId, runId),
          ),
          options.storage,
          tx.scope.generation,
          receipt.operation?.binding,
        )
      })
    }
    const previousReceipt = await reconcile()
    if (previousReceipt) return previousReceipt
    if (!runtimeAdmissionOpen(options.storage)) throw new ProtocolError("storage_unavailable")
    let result: AdmissionResult
    try {
      const current = await backend.readThread(threadId)
      const decision = await gate({
        action: "update",
        operation: "input.respond",
        threadId,
        resuming: true,
        ...subject(current),
      })
      if (!decision.ok || !current) throw new ProtocolError("not_found", { resource: "input" })
      const store = await backend.openThread(threadId, false)
      if (!store) throw new ProtocolError("not_found", { resource: "input" })
      const prepared = await prepareRuleIntents(
        options,
        request,
        await store.snapshot(),
        runId,
        params,
        receiptId,
      )
      result = await store.transaction(async (tx): Promise<AdmissionResult> => {
        const thread = await tx.thread.get()
        const access = await gate({
          action: "update",
          operation: "input.respond",
          threadId,
          resuming: true,
          ...subject(thread),
        })
        if (!access.ok || !thread) throw new ProtocolError("not_found", { resource: "input" })
        const existing = await tx.receipts.get(receiptId)
        if (existing) {
          const agentId = existing.operation?.resolved.agent_id
          if (typeof agentId !== "string") throw new ProtocolError("receipt_expired")
          await options.authorizeAgent(request, agentId)
          await authorizeSavedPermissionAgents(existing, (id) =>
            options.authorizeAgent(request, id),
          )
          return rememberAdmissionBinding(
            await replayOperationReceipt(tx, existing, ownerKey, () =>
              identity(params, threadId, runId),
            ),
            options.storage,
            tx.scope.generation,
            existing.operation?.binding,
          )
        }
        const previous = await tx.runs.get(runId)
        if (!runtimeAdmissionOpen(options.storage)) throw new ProtocolError("storage_unavailable")
        if (!previous) throw new ProtocolError("not_found", { resource: "input" })
        if (!previous.run.agent_id) throw new ProtocolError("not_found")
        await options.authorizeAgent(request, previous.run.agent_id)
        if (await tx.executionOwner()) throw new ProtocolError("thread_busy")
        const expected = envelope.expected
        if (
          thread.currentRunId !== runId ||
          !thread.pausedGeneration ||
          previous.metadata.reason !== "permission" ||
          previous.metadata.continuation !== "waiting" ||
          (expected?.generation && expected.generation !== tx.scope.generation) ||
          (expected?.runId && expected.runId !== runId) ||
          (expected?.pausedGeneration && expected.pausedGeneration !== thread.pausedGeneration)
        )
          throw new ProtocolError("stale_generation", { resource: "input" })
        const pending = (await tx.pending.list()).filter((entry) => entry.disposition === "pending")
        const byAddress = completePermissionResponses(pending, params)
        if (params.update !== undefined || params.goto !== undefined || params.config !== undefined)
          throw new ProtocolError("approval_changed")
        const verified: {
          pending: RuntimePendingRecord
          decision: PermissionResponseV1["decision"]
          grantId?: string
        }[] = []
        const grants = await tx.grants.list()
        for (const item of pending) {
          if (
            item.ownerRunId !== runId ||
            item.input.data.b4.pausedGeneration !== thread.pausedGeneration
          )
            throw new ProtocolError("stale_generation", { resource: "input" })
          const payload = item.input.data.payload as PermissionPayloadV1
          if (payload?.type !== "b4.permission" || payload.v !== 1)
            throw new ProtocolError("not_supported")
          const answer = response(
            byAddress.get(
              key({ namespace: item.namespace, interruptId: item.input.data.interruptId }),
            )?.response,
          )
          const normalized =
            answer.decision === "always" && !payload.allowAlways ? "once" : answer.decision
          if (
            !item.proposal?.agentId ||
            protectedProposalHash(item) !== item.input.data.b4.proposalHash
          )
            throw new ProtocolError("approval_changed")
          await options.authorizeAgent(request, item.proposal.agentId)
          if (
            normalized === "always" &&
            !prepared.some((batch) =>
              batch.bindings.some((binding) => canonical(binding.pending) === canonical(item)),
            )
          )
            throw new ProtocolError("approval_changed")
          if (
            normalized !== "deny" &&
            item.input.data.b4.expiresAt &&
            Date.parse(item.input.data.b4.expiresAt) <= Date.now()
          )
            throw new ProtocolError("grant_expired")
          const grant = await checkRuntimeApprovalGrant({
            mode,
            pending: item,
            records: grants,
            response: { ...answer, decision: normalized },
          })
          verified.push({
            pending: item,
            decision: normalized,
            ...(grant && mode !== "off" ? { grantId: grant.grantId } : {}),
          })
        }
        const timestamp = new Date().toISOString(),
          continuationRunId = crypto.randomUUID()
        const metadata = {
          v: 1 as const,
          generation: tx.scope.generation,
          turnId: previous.metadata.turnId,
          previousRunId: runId,
          phase: "accepted" as const,
          continuation: "none" as const,
          submissionId: token,
          submissionKind: "b4" as const,
          acceptedAt: timestamp,
          effectsUncertain: false,
        }
        const run = {
          ...previous.run,
          run_id: continuationRunId,
          created_at: timestamp,
          updated_at: timestamp,
          status: "pending" as const,
        }
        await tx.runs.put({
          run,
          metadata,
          namespace: previous.namespace,
          preRunCheckpointId: thread.headCheckpointId,
          result: null,
        })
        for (const entry of verified) {
          if (entry.grantId) {
            if (
              !(await tx.grants.consume(
                entry.grantId,
                continuationRunId,
                entry.decision === "deny" ? "deny" : undefined,
              ))
            )
              throw new ProtocolError("grant_invalid")
            await options.failpoint?.("afterConsume")
          }
        }
        for (const entry of verified) {
          const { grant: _grant, ...pendingMetadata } = entry.pending.input.data.b4
          await tx.pending.put({
            ...entry.pending,
            disposition: "answered",
            decision: entry.decision,
            input: {
              ...entry.pending.input,
              data: {
                ...entry.pending.input.data,
                b4: {
                  ...pendingMetadata,
                  status:
                    entry.decision === "deny"
                      ? entry.pending.input.data.b4.expiresAt &&
                        Date.parse(entry.pending.input.data.b4.expiresAt) <= Date.now()
                        ? "abandoned"
                        : "denied"
                      : "resolved",
                },
              },
            },
          })
        }
        for (const batch of prepared)
          await tx.inbox.put({
            entryId: batch.intent.operationId,
            kind: "rule_intent",
            runId: continuationRunId,
            namespace: previous.namespace,
            status: "accepted",
            payload: {
              intent: batch.intent,
              bindings: batch.bindings.map(({ pending }) => ({
                inputId: pending.input.data.interruptId,
                ownerRunId: pending.ownerRunId,
                namespace: pending.namespace,
                proposalHash: pending.input.data.b4.proposalHash,
              })),
            } satisfies RuleIntentPayload,
            createdAt: timestamp,
          })
        const predecessorMetadata = { ...previous.metadata, continuation: "closed" as const }
        await tx.runs.put({
          ...previous,
          metadata: predecessorMetadata,
          result: previous.result
            ? {
                ...previous.result,
                run: {
                  ...previous.run,
                  metadata: { ...previous.run.metadata, b4: predecessorMetadata },
                },
              }
            : null,
        })
        await tx.thread.put({
          ...thread,
          currentRunId: continuationRunId,
          pausedGeneration: null,
          revision: thread.revision + 1,
          thread: { ...thread.thread, status: "busy", updated_at: timestamp },
        })
        await tx.journal.append({
          eventId: crypto.randomUUID(),
          ownerRunId: runId,
          namespace: previous.namespace,
          event: {
            type: "event",
            method: "custom",
            params: {
              namespace: previous.namespace,
              timestamp: Date.parse(timestamp),
              data: {
                name: "b4.run",
                payload: {
                  ...predecessorMetadata,
                  runId,
                  agentId: previous.run.agent_id,
                  status: previous.run.status,
                },
              },
            },
          },
        })
        const resolved = {
          ...previous.run,
          agent_id: previous.run.agent_id,
          permissionAgents: [
            ...new Set(verified.map((entry) => entry.pending.proposal?.agentId)),
          ].sort(),
          responses: verified.map((entry) => ({
            namespace: entry.pending.namespace,
            interruptId: entry.pending.input.data.interruptId,
            response: entry.decision,
          })),
        }
        await tx.inbox.put({
          entryId: crypto.randomUUID(),
          kind: "dispatch",
          runId: continuationRunId,
          namespace: previous.namespace,
          status: "accepted",
          payload: resolved,
          createdAt: timestamp,
        })
        await tx.journal.append({
          eventId: crypto.randomUUID(),
          ownerRunId: continuationRunId,
          namespace: previous.namespace,
          event: {
            type: "event",
            method: "custom",
            params: {
              namespace: previous.namespace,
              timestamp: Date.parse(timestamp),
              data: {
                name: "b4.run",
                payload: {
                  ...metadata,
                  runId: continuationRunId,
                  agentId: run.agent_id,
                  status: "pending",
                },
              },
            },
          },
        })
        const receipt = {
          submissionId: token,
          submissionKind: "b4" as const,
          runId: continuationRunId,
          turnId: previous.metadata.turnId,
          acceptedAt: timestamp,
          replayed: false,
          disposition: "accepted" as const,
        }
        await tx.receipts.put({
          receiptId,
          fingerprint: hash([
            ownerKey,
            "input.respond",
            canonical(identity(params, threadId, runId)),
            tx.scope.generation,
          ]),
          receipt,
          state: "accepted",
          operation: {
            binding: { kind: bindingKind, onDisconnect: previous.run.on_disconnect ?? "cancel" },
            scopeKey: ownerKey,
            method: "input.respond",
            operationThreadId: threadId,
            targetRunId: runId,
            normalization: { messages: false, mechanicalDefaults: {}, configDefaults: {} },
            resolved,
            provenance: thread.protectedMetadata.provenance as Readonly<Record<string, unknown>>,
          },
        })
        await options.failpoint?.("beforeCommit")
        if (!runtimeAdmissionOpen(options.storage)) throw new ProtocolError("storage_unavailable")
        return rememberAdmissionBinding(
          { runId: continuationRunId, threadId, responseMeta: { b4: { v: 1, receipt } } },
          options.storage,
          tx.scope.generation,
          { kind: bindingKind, onDisconnect: previous.run.on_disconnect ?? "cancel" },
        )
      })
    } catch (error) {
      const accepted = await reconcile()
      if (!accepted) throw error
      result = accepted
    }
    await options.failpoint?.("afterCommit")
    return result
  }
  const service: PermissionService = {
    async prepareExecution(threadId) {
      const store = await backend.openThread(threadId, false)
      if (!store) throw new ProtocolError("storage_unavailable")
      const snapshot = await store.snapshot(),
        thread = snapshot.thread
      const run = snapshot.runs.find((row) => row.run.run_id === thread?.currentRunId)
      const selected = snapshot.inbox.filter(
        (entry) => entry.kind === "rule_intent" && entry.runId === run?.run.run_id,
      )
      let outcome: "ready" | "refused" = "ready"
      const answered = snapshot.pending.filter(
        (item) =>
          item.ownerRunId === run?.metadata.previousRunId && item.disposition === "answered",
      )
      if (thread && run?.metadata.phase === "accepted")
        for (const pending of answered) {
          if (
            !pending.proposal ||
            protectedProposalHash(pending) !== pending.input.data.b4.proposalHash
          ) {
            outcome = "refused"
            break
          }
          if (pending.decision === "deny") continue
          const configured = await options.resolvePermissions?.({ thread, run, pending })
          if (configured) {
            await configured.load()
            if (
              configured.mode !== "bypass" &&
              configured.match(
                pending.proposal.rule.tool,
                permissionCandidateForRequest(
                  (pending.input.data.payload as PermissionPayloadV1).request,
                ),
              ) === "deny"
            ) {
              outcome = "refused"
              break
            }
          }
        }
      if (outcome === "ready" && thread && run?.metadata.phase === "accepted")
        for (const entry of selected) {
          const payload = entry.payload as RuleIntentPayload
          if (!payload?.intent || !Array.isArray(payload.bindings) || !payload.bindings.length) {
            outcome = "refused"
            break
          }
          for (const binding of payload.bindings) {
            const pending = snapshot.pending.find(
              (row) =>
                row.input.data.interruptId === binding.inputId &&
                row.ownerRunId === binding.ownerRunId &&
                canonical(row.namespace) === canonical(binding.namespace) &&
                row.input.data.b4.proposalHash === binding.proposalHash,
            )
            if (!pending?.proposal || protectedProposalHash(pending) !== binding.proposalHash) {
              outcome = "refused"
              break
            }
            const configured = await options.resolvePermissions?.({ thread, run, pending })
            if (!configured?.rememberedRules) {
              outcome = "refused"
              break
            }
            let applied: "applied" | "superseded"
            try {
              applied = await configured.rememberedRules.apply(payload.intent)
            } catch (error) {
              if (!(error instanceof RuleIntentConflictError)) throw error
              outcome = "refused"
              break
            }
            await options.failpoint?.("afterRuleApply")
            if (
              applied !== "applied" ||
              payload.intent.rules.some(
                (rule) =>
                  configured.mode !== "bypass" &&
                  configured.match(rule.tool, rule.pattern) !== "allow",
              )
            ) {
              outcome = "refused"
              break
            }
          }
          if (outcome === "refused") break
        }
      const proof = Object.freeze({ kind: "permission_preparation" as const })
      preparations.set(proof, {
        threadId,
        generation: snapshot.scope.generation,
        runId: run?.run.run_id ?? null,
        entries: new Map(selected.map((entry) => [entry.entryId, canonical(entry.payload)])),
        pendingFacts: canonical(answered),
        outcome,
      })
      return proof
    },
    async completePreparation(tx, runId, preparation) {
      const proof = preparations.get(preparation)
      if (
        !proof ||
        proof.threadId !== tx.scope.threadId ||
        proof.generation !== tx.scope.generation ||
        proof.runId !== runId
      )
        return "deferred"
      const run = await tx.runs.get(runId)
      const answered = (await tx.pending.list()).filter(
        (item) =>
          item.ownerRunId === run?.metadata.previousRunId && item.disposition === "answered",
      )
      if (proof.pendingFacts !== canonical(answered)) return "deferred"
      const entries = (await tx.inbox.list()).filter(
        (entry) => entry.kind === "rule_intent" && entry.runId === runId,
      )
      if (
        entries.length !== proof.entries.size ||
        entries.some((entry) => proof.entries.get(entry.entryId) !== canonical(entry.payload))
      )
        return "deferred"
      for (const entry of entries)
        await tx.inbox.put({
          ...entry,
          status: proof.outcome === "ready" ? "applied" : "not_applied",
        })
      return proof.outcome
    },
    respond: (request, threadId, runId, body) =>
      respond(request, threadId, runId, body, "background"),
    respondNativeCreation: (request, threadId, runId, body) =>
      respond(request, threadId, runId, body, "native_creation"),
  }
  services.add(service)
  return service
}
