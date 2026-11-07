import { THREAD_ACCESS_METADATA_KEY, type ThreadAccessPolicy } from "@b4run/sdk"
import type {
  B4RunStream,
  ReceiptV1,
  Run,
  RuntimeOperationContext,
  RuntimeReceiptRecord,
  RuntimeThreadRecord,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
import { requestPrincipal } from "../dev/auth.js"
import type { AgentCatalog } from "../dev/protocol/catalog.js"
import { ProtocolError } from "../dev/protocol/errors.js"
import {
  normalizeProtocolInput,
  normalizeProtocolInputIdentity,
  type ProtocolBoundaryOptions,
} from "../dev/protocol/input.js"
import { mergePublicMessages, parsePublicMessages } from "../dev/protocol/messages.js"
import {
  matchesLiteralFilters,
  type ProtocolConfigPolicy,
  parseRequestMetadata,
  parseRunSearchMetadata,
  protocolRecord,
} from "../dev/protocol/metadata.js"
import { parseProtocolRequest } from "../dev/protocol/validate.js"
import type { RuntimeRegistryEntry } from "../dev/runtime-registry-core.js"
import { createThreadAccessContext } from "../dev/thread-access.js"
import { makeProtocolThreadGate } from "../dev/thread-gate.js"
import {
  type AdmissionResult,
  authorizeRetainedOperation,
  authorizeSavedPermissionAgents,
  canonical,
  exactRunPermissionAgents,
  hash,
  knownRunPermissionAgents,
  operationAuthorityFacts,
  operationPayload,
  rememberAdmissionBinding,
  replayOperationFacts,
  replayOperationReceipt,
  subject,
  validateRetainedOperationCut,
  validateRetainedPermissionMap,
} from "./operation-ledger.js"
import { retireSupersededControls } from "./ownership.js"
import {
  closeRuntimeAdmission,
  type RuntimeStorageHost,
  runtimeAdmissionOpen,
  runtimeStorageRegistration,
  temporaryCleanupPreparation,
} from "./storage-host.js"

export type { AdmissionResult } from "./operation-ledger.js"

const services = new WeakSet<AdmissionService>()
/** Internal boot/request bridge; structural request objects are never services. */
export function isAdmissionService(value: AdmissionService): boolean {
  return services.has(value)
}

export interface AdmissionServiceOptions {
  readonly storage: RuntimeStorageHost
  readonly deploymentId: string
  readonly policy?: ThreadAccessPolicy
  readonly catalog: (request: Request) => Promise<AgentCatalog>
  readonly authorizeAgent: (request: Request, originalAgentId: string) => Promise<void>
  readonly resolveAgent: (route: RuntimeRegistryEntry) => Promise<{
    readonly boundary: ProtocolBoundaryOptions
    readonly config?: ProtocolConfigPolicy
    readonly defaults?: Readonly<Record<string, unknown>>
  }>
  readonly now?: () => string
  /** Internal failure injection at the actual transaction/ack boundary. */
  readonly failpoint?: (point: "beforeCommit" | "afterCommit") => void | Promise<void>
}
export interface AdmissionService {
  admit(request: Request, body: unknown): Promise<AdmissionResult>
  /** Server-selected creation entrypoints; current HTTP/native assembly is B1. */
  admitRestCreation(request: Request, body: unknown): Promise<AdmissionResult>
  admitNativeCreation(request: Request, body: unknown): Promise<AdmissionResult>
  searchRuns(request: Request, query: unknown): Promise<readonly Run[]>
  /** Stop accepting new work; exact already-committed receipts remain readable. */
  close(): void
}
function deterministicThread(key: string): string {
  const bytes = hash(key).slice(0, 32).split("")
  bytes[12] = "4"
  bytes[16] = "8"
  const h = bytes.join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
const mechanicalKeys = ["on_disconnect", "on_completion", "if_not_exists", "stream_mode"] as const
/** Compare protocol semantics before adapter/schema processing, using the
 * original target and defaults. The separate resolved execution input remains
 * immutable but is never used as a substitute for normalizing this candidate. */
function protocolOperationIdentity(
  incoming: B4RunStream,
  raw: Record<string, unknown>,
  original: Readonly<Record<string, unknown>>,
  facts: RuntimeOperationContext["normalization"],
): Record<string, unknown> {
  const { input: _input, messages: _messages, config: _config, ...fields } = incoming
  return operationPayload({
    ...fields,
    ...Object.fromEntries(
      mechanicalKeys.map((key) => [
        key,
        Object.hasOwn(raw, key) ? incoming[key] : facts.mechanicalDefaults[key],
      ]),
    ),
    agent_id: incoming.agent_id ?? original.agent_id,
    thread_id: incoming.thread_id ?? original.thread_id,
    input: normalizeProtocolInputIdentity(incoming.input, {
      messagesSupported: facts.messages,
      ...(incoming.messages !== undefined ? { messages: incoming.messages } : {}),
    }),
    config: { ...facts.configDefaults, ...(incoming.config ?? {}) },
  })
}
async function replayReceipt(
  tx: RuntimeTransaction,
  record: RuntimeReceiptRecord,
  incoming: B4RunStream,
  raw: Record<string, unknown>,
  ownerKey: string,
  storage: RuntimeStorageHost,
): Promise<AdmissionResult> {
  return rememberAdmissionBinding(
    await replayOperationReceipt(tx, record, ownerKey, (operation) =>
      protocolOperationIdentity(incoming, raw, operation.resolved, operation.normalization),
    ),
    storage,
    tx.scope.generation,
    record.operation?.binding,
  )
}
function publicRun(row: import("@b4run/sdk/agent-protocol").RuntimeRunRecord): Run {
  const { lookup: _lookup, ...metadata } = row.metadata
  return { ...row.run, metadata: { ...row.run.metadata, b4: metadata } }
}
/** All accepted work is durable before acknowledgement. No model, graph,
 * provider or transport publication runs inside this service. */
export function createAdmissionService(options: AdmissionServiceOptions): AdmissionService {
  const backend = runtimeStorageRegistration(options.storage)
  const now = options.now ?? (() => new Date().toISOString())
  const scopeKey = (request: Request) =>
    hash(createThreadAccessContext(options.deploymentId, requestPrincipal(request)))
  async function admit(
    request: Request,
    body: unknown,
    bindingKind: NonNullable<RuntimeOperationContext["binding"]>["kind"],
  ): Promise<AdmissionResult> {
    const raw = protocolRecord(body)
    // Protected config/wire shape is always checked, independently of mutable
    // route schema/defaults. Reconciliation later uses original resolved data.
    const configurable =
      raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)
        ? (raw.config as Record<string, unknown>).configurable
        : undefined
    const safePolicy = {
      allowedKeys:
        configurable && typeof configurable === "object" ? Object.keys(configurable) : [],
    }
    const normalized = parseProtocolRequest("run", body, { config: safePolicy })
    // Detached wire facts cannot be changed by new-operation schema/adapter
    // callbacks, including while another request commits its receipt.
    const identityRequest: B4RunStream = JSON.parse(JSON.stringify(normalized))
    const rawShape = Object.fromEntries(Object.keys(raw).map((key) => [key, true]))
    const metadata = normalized.metadata ?? {}
    const envelope =
      metadata.b4 === undefined ? { v: 1 as const } : parseRequestMetadata(metadata.b4)
    const token = envelope.submissionId ?? crypto.randomUUID()
    const ownerKey = scopeKey(request)
    const principal = requestPrincipal(request)
    const requestedThread = normalized.thread_id
    const operationId = hash([ownerKey, "run.create", requestedThread ?? null, token])
    const threadId = requestedThread ?? deterministicThread(operationId)
    const receiptId = hash([ownerKey, "run.create", threadId, token])
    const gate = makeProtocolThreadGate(options.policy, request, {
      deploymentId: options.deploymentId,
    })
    const reconcile = async (): Promise<AdmissionResult | undefined> => {
      const candidates = await backend.searchOperations({
        scopeKey: ownerKey,
        submissionId: token,
        submissionKind: "b4",
        operationThreadId: threadId,
        method: "run.create",
      })
      const existing = candidates.find((candidate) => candidate.receiptId === receiptId)
      if (!existing) return undefined
      const authorizeCandidate = async (minimal: typeof existing) => {
        if (minimal.agentId) await options.authorizeAgent(request, minimal.agentId)
        const decision = await gate({
          action: "update",
          operation: "run.create",
          threadId,
          ...subject(minimal.thread ?? minimal.retainedSubject, minimal.provenance),
        })
        if (!decision.ok) throw new ProtocolError("not_found")
      }
      const replayRetained = async (minimal: typeof existing): Promise<AdmissionResult> => {
        if (!minimal.retainedSubject || minimal.scope.threadId !== threadId)
          throw new ProtocolError("not_found")
        await authorizeCandidate(minimal)
        await authorizeRetainedOperation(
          threadId,
          minimal.agentId,
          minimal.operationAuthority,
          minimal.retainedSubject,
          (id) => options.authorizeAgent(request, id),
          async () =>
            (
              await gate({
                action: "update",
                operation: "run.create",
                threadId,
                ...subject(minimal.retainedSubject, minimal.provenance),
              })
            ).ok,
        )
        const facts = await backend.temporary?.readOperation({
          threadId,
          generation: minimal.scope.generation,
          receiptId,
        })
        if (!facts) throw new ProtocolError("receipt_expired")
        if (
          !(
            await gate({
              action: "update",
              operation: "run.create",
              threadId,
              ...subject(facts.subject),
            })
          ).ok
        )
          throw new ProtocolError("not_found")
        await authorizeRetainedOperation(
          threadId,
          typeof facts.receipt.operation?.resolved.agent_id === "string"
            ? facts.receipt.operation.resolved.agent_id
            : undefined,
          operationAuthorityFacts(facts.receipt),
          facts.subject,
          (id) => options.authorizeAgent(request, id),
          async () =>
            (
              await gate({
                action: "update",
                operation: "run.create",
                threadId,
                ...subject(facts.subject),
              })
            ).ok,
        )
        validateRetainedOperationCut(minimal, facts, ownerKey)
        return rememberAdmissionBinding(
          replayOperationFacts(facts.scope, facts.receipt, facts.run, ownerKey, (operation) =>
            protocolOperationIdentity(
              identityRequest,
              rawShape,
              operation.resolved,
              operation.normalization,
            ),
          ),
          options.storage,
          facts.scope.generation,
          facts.receipt.operation?.binding,
        )
      }
      if (existing.retainedSubject) return replayRetained(existing)
      await authorizeCandidate(existing)
      // Discovery exposes no receipt. Current C5 and original Agent authority
      // precede the authoritative scope binding and private receipt read.
      const store = await backend.openThread(threadId, false, existing.scope.generation)
      if (!store) {
        const fresh = (
          await backend.searchOperations({
            scopeKey: ownerKey,
            submissionId: token,
            submissionKind: "b4",
            operationThreadId: threadId,
            method: "run.create",
          })
        ).find(
          (candidate) =>
            candidate.receiptId === existing.receiptId &&
            candidate.scope.threadId === threadId &&
            candidate.scope.generation === existing.scope.generation,
        )
        if (fresh?.retainedSubject) return replayRetained(fresh)
        throw new ProtocolError("submission_target_gone")
      }
      return store.transaction(async (tx) => {
        const row = await tx.thread.get()
        const auth = await gate({
          action: "update",
          operation: "run.create",
          threadId,
          ...subject(row, existing.provenance),
        })
        if (!auth.ok) throw new ProtocolError("not_found")
        if (tx.scope.generation !== existing.scope.generation)
          throw new ProtocolError("submission_target_gone")
        const record = await tx.receipts.get(receiptId)
        if (!record) throw new ProtocolError("receipt_expired")
        return replayReceipt(tx, record, identityRequest, rawShape, ownerKey, options.storage)
      })
    }
    const previous = await reconcile()
    if (previous) {
      await options.failpoint?.("afterCommit")
      return previous
    }
    let result: AdmissionResult
    try {
      if (!runtimeAdmissionOpen(options.storage)) throw new ProtocolError("storage_unavailable")
      const current = await backend.readThread(threadId)
      const decision = await gate({
        action: current ? "update" : "create",
        operation: "run.create",
        threadId,
        ...subject(current),
      })
      if (!decision.ok) throw new ProtocolError("not_found")
      if (!current && requestedThread && normalized.if_not_exists !== "create")
        throw new ProtocolError("not_found")
      if (normalized.webhook !== undefined) throw new ProtocolError("not_supported")
      const catalog = await options.catalog(request)
      const route = catalog.select(normalized.agent_id)
      const resolvedAgent = await options.resolveAgent(route)
      const originalMechanicalDefaults = parseProtocolRequest(
        "run",
        requestedThread === undefined ? {} : { thread_id: requestedThread },
      )
      const normalization: RuntimeOperationContext["normalization"] = {
        messages: resolvedAgent.boundary.adapter.messages !== undefined,
        mechanicalDefaults: Object.fromEntries(
          mechanicalKeys.map((key) => [key, originalMechanicalDefaults[key]]),
        ),
        configDefaults: JSON.parse(JSON.stringify(resolvedAgent.defaults ?? {})),
      }
      let identity: string
      try {
        identity = canonical(
          protocolOperationIdentity(
            identityRequest,
            rawShape,
            { agent_id: route.assistantId, thread_id: threadId },
            normalization,
          ),
        )
      } catch {
        throw new ProtocolError("invalid_argument")
      }
      if (normalized.config)
        parseProtocolRequest("run", body, {
          ...(resolvedAgent.config ? { config: resolvedAgent.config } : {}),
        })
      let input: unknown
      try {
        input = normalizeProtocolInput(normalized.input, {
          ...resolvedAgent.boundary,
          ...(normalized.messages ? { messages: normalized.messages } : {}),
        })
      } catch {
        throw new ProtocolError("invalid_argument")
      }
      const durableInput: Exclude<Run["input"], undefined> =
        input === undefined ? null : JSON.parse(JSON.stringify(input))
      const resolved = {
        ...normalized,
        agent_id: route.assistantId,
        thread_id: threadId,
        input: durableInput,
        config: { ...(resolvedAgent.defaults ?? {}), ...(normalized.config ?? {}) },
      }
      if (
        resolved.on_completion === "delete" &&
        (!backend.temporary || !temporaryCleanupPreparation(options.storage))
      )
        throw new ProtocolError("not_supported")
      const store = await backend.openThread(threadId, true)
      if (!store) throw new ProtocolError("storage_unavailable")
      result = await store.transaction(async (tx): Promise<AdmissionResult> => {
        const row = await tx.thread.get()
        const recheck = await gate({
          action: row ? "update" : "create",
          operation: "run.create",
          threadId,
          ...subject(row),
        })
        if (!recheck.ok) throw new ProtocolError("not_found")
        const existingReceipt = await tx.receipts.get(receiptId)
        if (existingReceipt) {
          const originalAgent = existingReceipt.operation?.resolved.agent_id
          if (typeof originalAgent === "string")
            await options.authorizeAgent(request, originalAgent)
          return replayReceipt(
            tx,
            existingReceipt,
            identityRequest,
            rawShape,
            ownerKey,
            options.storage,
          )
        }
        if (!runtimeAdmissionOpen(options.storage)) throw new ProtocolError("storage_unavailable")
        if (await tx.executionOwner()) throw new ProtocolError("thread_busy")
        const expected = envelope.expected
        if (
          (expected?.generation && expected.generation !== tx.scope.generation) ||
          (expected?.runId && expected.runId !== row?.currentRunId) ||
          (expected?.pausedGeneration && expected.pausedGeneration !== row?.pausedGeneration)
        )
          throw new ProtocolError("stale_generation")
        if (row?.currentRunId) {
          const active = await tx.runs.get(row.currentRunId)
          if (
            active &&
            (active.metadata.phase !== "settled" || active.metadata.continuation === "waiting")
          )
            throw new ProtocolError("thread_busy")
        }
        const timestamp = now(),
          runId = crypto.randomUUID()
        const correlation = {
          v: 1 as const,
          generation: tx.scope.generation,
          turnId: runId,
          phase: "accepted" as const,
          continuation: "none" as const,
          submissionId: token,
          submissionKind: "b4" as const,
          acceptedAt: timestamp,
          effectsUncertain: false,
        }
        const callerMetadata = Object.fromEntries(
          Object.entries(metadata).filter(([key]) => key !== "b4"),
        )
        const run: Run = {
          ...resolved,
          run_id: runId,
          created_at: timestamp,
          updated_at: timestamp,
          status: "pending",
          metadata: callerMetadata,
        }
        await tx.runs.put({
          run,
          metadata: correlation,
          namespace: [],
          preRunCheckpointId: row?.headCheckpointId ?? null,
          result: null,
        })
        const trustedProvenance = {
          deploymentId: options.deploymentId,
          ...(principal ? { principalId: principal.id } : {}),
          agentId: route.assistantId,
          namespace: [],
        }
        const messages = resolvedAgent.boundary.adapter.messages
          ? parsePublicMessages(
              Array.isArray((input as Record<string, unknown> | null)?.messages)
                ? (input as Record<string, unknown>).messages
                : (normalized.messages ?? []),
            )
          : []
        const thread: RuntimeThreadRecord = {
          thread: {
            ...(row?.thread ?? {
              thread_id: threadId,
              created_at: timestamp,
              metadata: decision.stamp ? { [THREAD_ACCESS_METADATA_KEY]: decision.stamp } : {},
            }),
            updated_at: timestamp,
            status: "busy",
            messages: mergePublicMessages(
              parsePublicMessages(row?.thread.messages ?? []),
              messages,
            ),
          },
          generation: tx.scope.generation,
          revision: (row?.revision ?? 0) + 1,
          headCheckpointId: row?.headCheckpointId ?? null,
          currentRunId: runId,
          pausedGeneration: null,
          protectedMetadata: row?.protectedMetadata ?? { provenance: trustedProvenance },
          cleanupIntent: {
            intentId: crypto.randomUUID(),
            onCompletion: resolved.on_completion ?? "keep",
          },
        }
        await tx.thread.put(thread)
        // Recheck the actual stamped subject before committing a create.
        const createdGate = await gate({
          action: "update",
          operation: "run.create",
          threadId,
          ...subject(thread),
        })
        if (!createdGate.ok) throw new ProtocolError("not_found")
        if (row?.currentRunId)
          await retireSupersededControls(tx, row.currentRunId, tx.scope.generation)
        await tx.inbox.put({
          entryId: crypto.randomUUID(),
          kind: "dispatch",
          runId,
          namespace: [],
          status: "accepted",
          payload: resolved,
          createdAt: timestamp,
        })
        const acceptedEvent = await tx.journal.append({
          eventId: crypto.randomUUID(),
          ownerRunId: runId,
          namespace: [],
          event: {
            type: "event",
            method: "custom",
            params: {
              namespace: [],
              timestamp: Date.parse(timestamp),
              data: {
                name: "b4.run",
                payload: { ...correlation, runId, agentId: route.assistantId, status: "pending" },
              },
            },
          },
        })
        let sourceSeq = acceptedEvent.seq
        for (const message of messages) {
          const next = ++sourceSeq
          await tx.journal.append({
            eventId: crypto.randomUUID(),
            ownerRunId: runId,
            namespace: [],
            event: {
              type: "event",
              method: "custom",
              params: {
                namespace: [],
                timestamp: Date.parse(timestamp),
                data: {
                  name: "b4.activity",
                  payload: {
                    v: 1,
                    id: message.id ?? crypto.randomUUID(),
                    namespace: [],
                    turnId: runId,
                    runId,
                    type: "message",
                    state: "completed",
                    payload: message,
                    sourceSeq: next,
                    effectsUncertain: false,
                  },
                },
              },
            },
          })
        }
        const receipt: ReceiptV1 = {
          submissionId: token,
          submissionKind: "b4",
          runId,
          turnId: runId,
          acceptedAt: timestamp,
          replayed: false,
          disposition: "accepted",
        }
        await tx.receipts.put({
          receiptId,
          fingerprint: hash([ownerKey, "run.create", identity, tx.scope.generation]),
          receipt,
          state: "accepted",
          operation: {
            binding: { kind: bindingKind, onDisconnect: resolved.on_disconnect ?? "cancel" },
            scopeKey: ownerKey,
            method: "run.create",
            operationThreadId: threadId,
            targetRunId: runId,
            normalization,
            resolved,
            provenance: trustedProvenance,
          },
        })
        await options.failpoint?.("beforeCommit")
        if (!runtimeAdmissionOpen(options.storage)) throw new ProtocolError("storage_unavailable")
        return rememberAdmissionBinding(
          { runId, threadId, responseMeta: { b4: { v: 1, receipt } } },
          options.storage,
          tx.scope.generation,
          { kind: bindingKind, onDisconnect: resolved.on_disconnect ?? "cancel" },
        )
      })
    } catch (error) {
      // Another transaction may have accepted the exact request while this
      // one awaited a mutable catalog/schema/default/head preflight. Its
      // receipt takes precedence over that now-obsolete failure.
      const accepted = await reconcile()
      if (!accepted) throw error
      result = accepted
    }
    await options.failpoint?.("afterCommit")
    return result
  }
  const service: AdmissionService = {
    close() {
      closeRuntimeAdmission(options.storage)
    },
    admit: (request, body) => admit(request, body, "background"),
    admitRestCreation: (request, body) => admit(request, body, "rest_creation"),
    admitNativeCreation: (request, body) => admit(request, body, "native_creation"),
    async searchRuns(request, value) {
      const query = parseProtocolRequest("run.search", value)
      const { lookup, filters } = parseRunSearchMetadata(query.metadata ?? {})
      const gate = makeProtocolThreadGate(options.policy, request, {
        deploymentId: options.deploymentId,
      })
      const rows = new Map<string, Run>()
      const matches = (run: Run) =>
        (!query.thread_id || query.thread_id === run.thread_id) &&
        (!query.agent_id || query.agent_id === run.agent_id) &&
        (!query.status || query.status === run.status) &&
        matchesLiteralFilters(run.metadata as Record<string, unknown>, filters)
      if (lookup) {
        const candidates = await backend.searchOperations({
          scopeKey: scopeKey(request),
          ...lookup,
        })
        // Current authorization precedes receipt reads, diagnostics, ambiguity
        // and pagination. Neither private candidate handles nor grants escape.
        const authorized = []
        for (const candidate of candidates) {
          if (candidate.retainedSubject) {
            try {
              await authorizeRetainedOperation(
                candidate.scope.threadId,
                candidate.agentId,
                candidate.operationAuthority,
                candidate.retainedSubject,
                (id) => options.authorizeAgent(request, id),
                async () =>
                  (
                    await gate({
                      action: "read",
                      operation: "run.receipt",
                      threadId: candidate.scope.threadId,
                      ...subject(candidate.retainedSubject, candidate.provenance),
                    })
                  ).ok,
              )
              authorized.push(candidate)
            } catch (error) {
              if (
                !(
                  error &&
                  typeof error === "object" &&
                  "code" in error &&
                  error.code === "not_found"
                )
              )
                throw error
            }
            continue
          }

          if (candidate.agentId) {
            try {
              await options.authorizeAgent(request, candidate.agentId)
            } catch (error) {
              if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "not_found"
              )
                continue
              throw error
            }
          }
          const decision = await gate({
            action: "read",
            operation: "run.receipt",
            threadId: candidate.scope.threadId,
            ...subject(candidate.thread ?? candidate.retainedSubject, candidate.provenance),
          })
          if (decision.ok) authorized.push(candidate)
        }
        type LookupOutcome = {
          readonly identity: string
          readonly facts?: string
          readonly gone?: true
          readonly unavailable?: true
          readonly run?: Run
        }
        const operations = new Map<string, LookupOutcome>()
        let inconsistent = false
        for (const candidate of authorized) {
          // The storage scope is the actual Run's Thread, including for forks.
          // It can constrain that standard filter without collapsing distinct
          // original command targets that share this destination scope.
          if (query.thread_id && query.thread_id !== candidate.scope.threadId) continue
          const opaqueGone: LookupOutcome = {
            identity: canonical(["unavailable", candidate.scope, candidate.receiptId]),
            gone: true,
          }
          const lookupFacts = async (
            receipt: RuntimeReceiptRecord,
            actual: import("@b4run/sdk/agent-protocol").RuntimeRunRecord | undefined,
          ): Promise<LookupOutcome | undefined> => {
            const operation = receipt.operation
            if (!operation?.method || !operation.operationThreadId || !operation.targetRunId)
              return { ...opaqueGone, unavailable: true }
            if (
              operation.method === "input.respond" &&
              operation.resolved.permissionAgents !== undefined
            ) {
              try {
                await authorizeSavedPermissionAgents(receipt, (id) =>
                  options.authorizeAgent(request, id),
                )
              } catch (error) {
                if (
                  error &&
                  typeof error === "object" &&
                  "code" in error &&
                  error.code === "not_found"
                )
                  return undefined
                throw error
              }
            }
            const identity = canonical([
              "operation",
              operation.method,
              operation.operationThreadId,
              operation.targetRunId,
            ])
            const { receiptId: _id, ...logicalFacts } = receipt
            // Compare receipt facts only. Two reads of the same Run may
            // legitimately observe different lifecycle projections.
            const facts = canonical(logicalFacts)
            if (!actual || receipt.state === "retired") return { identity, facts, gone: true }
            const run = publicRun(actual)
            const state =
              receipt.state === "accepted"
                ? {
                    state: "accepted" as const,
                    receipt: { ...receipt.receipt, replayed: true },
                  }
                : { state: "expired" as const }
            return {
              identity,
              facts,
              run: {
                ...run,
                metadata: {
                  ...run.metadata,
                  b4: {
                    ...actual.metadata,
                    lookup: {
                      submissionId: lookup.submissionId,
                      submissionKind: lookup.submissionKind,
                      ...state,
                    },
                  },
                },
              },
            }
          }
          const readRetained = async (
            minimal: typeof candidate,
          ): Promise<LookupOutcome | undefined> => {
            if (!minimal.retainedSubject) return opaqueGone
            try {
              const check = (
                value: import("@b4run/sdk/agent-protocol").RuntimeRetainedSubject,
                agentId = minimal.agentId,
                authority = minimal.operationAuthority,
              ) =>
                authorizeRetainedOperation(
                  minimal.scope.threadId,
                  agentId,
                  authority,
                  value,
                  (id) => options.authorizeAgent(request, id),
                  async () =>
                    (
                      await gate({
                        action: "read",
                        operation: "run.receipt",
                        threadId: minimal.scope.threadId,
                        ...subject(value),
                      })
                    ).ok,
                )
              await check(minimal.retainedSubject)
              const facts = await backend.temporary?.readOperation({
                threadId: minimal.scope.threadId,
                generation: minimal.scope.generation,
                receiptId: minimal.receiptId,
              })
              if (!facts) return opaqueGone
              await check(
                facts.subject,
                typeof facts.receipt.operation?.resolved.agent_id === "string"
                  ? facts.receipt.operation.resolved.agent_id
                  : undefined,
                operationAuthorityFacts(facts.receipt),
              )
              validateRetainedOperationCut(minimal, facts, scopeKey(request))
              return lookupFacts(facts.receipt, facts.run)
            } catch (error) {
              if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "not_found"
              )
                return undefined
              throw error
            }
          }
          let result: LookupOutcome | undefined
          if (candidate.retainedSubject) result = await readRetained(candidate)
          else {
            const store = await backend.openThread(
              candidate.scope.threadId,
              false,
              candidate.scope.generation,
            )
            if (store)
              result = await store.transaction(async (tx): Promise<LookupOutcome | undefined> => {
                const row = await tx.thread.get()
                const decision = await gate({
                  action: "read",
                  operation: "run.receipt",
                  threadId: candidate.scope.threadId,
                  ...subject(row, candidate.provenance),
                })
                if (!decision.ok) return undefined
                if (tx.scope.generation !== candidate.scope.generation) return opaqueGone
                const receipt = await tx.receipts.get(candidate.receiptId)
                if (!receipt) return undefined
                return lookupFacts(receipt, await tx.runs.get(receipt.receipt.runId))
              })
            else {
              const fresh = (
                await backend.searchOperations({
                  scopeKey: scopeKey(request),
                  ...lookup,
                })
              ).find(
                (row) =>
                  row.receiptId === candidate.receiptId &&
                  row.scope.threadId === candidate.scope.threadId &&
                  row.scope.generation === candidate.scope.generation,
              )
              result = fresh?.retainedSubject ? await readRetained(fresh) : opaqueGone
            }
          }
          if (!result) continue
          const previous = operations.get(result.identity)
          if (previous && previous.facts !== result.facts) inconsistent = true
          operations.set(result.identity, {
            ...previous,
            ...result,
            ...(previous?.gone ? { gone: true } : {}),
          })
        }
        // Reconciliation is about logical operations, not display rows. Decide
        // ambiguity before selecting accepted/expired/gone, applying mutable
        // per-Run filters, deduplicating public Runs or paginating.
        if (operations.size > 1) throw new ProtocolError("submission_ambiguous")
        if (inconsistent) throw new ProtocolError("storage_unavailable")
        for (const operation of operations.values()) {
          if (operation.unavailable) throw new ProtocolError("storage_unavailable")
          if (operation.gone) throw new ProtocolError("submission_target_gone")
          if (operation.run && matches(operation.run)) rows.set(operation.run.run_id, operation.run)
        }
      } else {
        for (const thread of await backend.listThreads()) {
          const id = thread.thread.thread_id
          if (query.thread_id && query.thread_id !== id) continue
          const auth = await gate({
            action: "read",
            operation: "run.search",
            threadId: id,
            ...subject(thread),
          })
          if (!auth.ok) continue
          const store = await backend.openThread(id, false)
          if (!store) continue
          await store.transaction(async (tx) => {
            const actual = await tx.thread.get()
            const recheck = await gate({
              action: "read",
              operation: "run.search",
              threadId: id,
              ...subject(actual),
            })
            if (!recheck.ok) return
            const permissionReceipts = (await tx.receipts.list()).filter(
              (receipt) =>
                receipt.operation?.method === "input.respond" &&
                receipt.operation.resolved.permissionAgents !== undefined,
            )
            for (const row of await tx.runs.list()) {
              if (typeof row.run.agent_id !== "string") continue
              try {
                await options.authorizeAgent(request, row.run.agent_id)
                for (const receipt of permissionReceipts.filter(
                  (receipt) => receipt.receipt.runId === row.run.run_id,
                ))
                  await authorizeSavedPermissionAgents(receipt, (id) =>
                    options.authorizeAgent(request, id),
                  )
              } catch (error) {
                if (
                  error &&
                  typeof error === "object" &&
                  "code" in error &&
                  error.code === "not_found"
                )
                  continue
                throw error
              }
              const run = publicRun(row)
              if (matches(run)) rows.set(run.run_id, run)
            }
          })
        }
      }
      if (!lookup && backend.temporary)
        for (const retained of await backend.temporary.listRuns()) {
          const row = retained.record,
            id = retained.scope.threadId
          if (query.thread_id && query.thread_id !== id) continue
          if (!row.run.agent_id || !backend.findRun) continue
          const candidate = await backend.findRun(row.run.run_id)
          if (
            candidate?.location !== "retained" ||
            candidate.scope.threadId !== id ||
            candidate.scope.generation !== retained.scope.generation ||
            candidate.agentId !== row.run.agent_id ||
            row.run.thread_id !== id ||
            row.metadata.generation !== retained.scope.generation
          )
            continue
          const allowedThread = async () =>
            (
              await gate({
                action: "read",
                operation: "run.search",
                threadId: id,
                ...subject(candidate.subject),
              })
            ).ok &&
            (
              await gate({
                action: "read",
                operation: "run.search",
                threadId: id,
                ...subject(retained.subject),
              })
            ).ok
          try {
            await options.authorizeAgent(request, row.run.agent_id)
            let agents: readonly string[]
            try {
              agents = knownRunPermissionAgents(candidate.authority)
            } catch {
              if (!(await allowedThread())) continue
              throw new ProtocolError("storage_unavailable")
            }
            for (const agent of agents) await options.authorizeAgent(request, agent)
            try {
              exactRunPermissionAgents(id, row.run.run_id, candidate.authority)
              exactRunPermissionAgents(id, row.run.run_id, {
                ...candidate.authority,
                turnId: row.metadata.turnId,
                previousRunId: row.metadata.previousRunId ?? null,
              })
              validateRetainedPermissionMap(id, row.run.run_id, agents, candidate.subject)
              validateRetainedPermissionMap(id, row.run.run_id, agents, retained.subject)
            } catch (error) {
              if (error instanceof ProtocolError && error.code === "not_found") continue
              if (!(await allowedThread())) continue
              throw new ProtocolError("storage_unavailable")
            }
            if (!(await allowedThread())) continue
          } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "not_found")
              continue
            throw error
          }
          const run = publicRun(row)
          if (matches(run)) rows.set(run.run_id, run)
        }
      const offset = query.offset ?? 0
      return [...rows.values()]
        .sort(
          (a, b) =>
            Date.parse(b.created_at) - Date.parse(a.created_at) || a.run_id.localeCompare(b.run_id),
        )
        .slice(offset, offset + (query.limit ?? 10))
    },
  }
  services.add(service)
  return Object.freeze(service)
}
