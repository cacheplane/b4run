import type { ThreadAccessRequest } from "@b4run/sdk"
import type {
  ReceiptV1,
  RuntimeNamespaceRecord,
  RuntimeOperationAuthorityFacts,
  RuntimeOperationCandidate,
  RuntimeOperationContext,
  RuntimeProtectedSourceRecord,
  RuntimeReceiptRecord,
  RuntimeRetainedOperation,
  RuntimeRetainedSubject,
  RuntimeRunAuthorityFacts,
  RuntimeRunRecord,
  RuntimeStorageScope,
  RuntimeThreadRecord,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
import { canonicalRuntimeValue, isProtectedSource } from "@b4run/sdk/internal/runtime-identity"
import { sha256Hex } from "@b4run/sdk/pure"
import { ProtocolError } from "../dev/protocol/errors.js"
import { canonicalProtocolId } from "../dev/protocol/metadata.js"
import { snapshotThreadProvenance } from "../dev/thread-access.js"
import type { RuntimeStorageHost } from "./storage-host.js"

export interface AdmissionResult {
  readonly runId: string
  /** Internal target for observers; run.start's closed result remains {runId}. */
  readonly threadId: string
  readonly responseMeta: { readonly b4: { readonly v: 1; readonly receipt: ReceiptV1 } }
}
const executionBindings = new WeakMap<
  AdmissionResult,
  {
    storage: RuntimeStorageHost
    threadId: string
    runId: string
    generation: string
    binding: NonNullable<RuntimeOperationContext["binding"]>
  }
>()
/** Internal acceptance bridge only. A returned wire-shaped copy is not proof. */
export function rememberAdmissionBinding(
  result: AdmissionResult,
  storage: RuntimeStorageHost,
  generation: string,
  binding: RuntimeOperationContext["binding"],
): AdmissionResult {
  executionBindings.set(result, {
    storage,
    threadId: result.threadId,
    runId: result.runId,
    generation,
    binding: binding ?? { kind: "background", onDisconnect: "continue" },
  })
  return result
}
export function admissionBinding(
  result: AdmissionResult,
  storage: RuntimeStorageHost,
  kind: "rest_creation" | "native_creation",
) {
  const proof = executionBindings.get(result)
  if (!proof || proof.storage !== storage || proof.binding.kind !== kind)
    throw new Error("Unrecognized owning stream")
  return proof
}

export const canonical = canonicalRuntimeValue
export function hash(value: unknown): string {
  return sha256Hex(canonical(value))
}

function provenance(
  row: RuntimeThreadRecord | RuntimeRetainedSubject | undefined,
): NonNullable<ThreadAccessRequest["provenance"]> | undefined {
  const value = row?.protectedMetadata.provenance
  return value && typeof value === "object"
    ? snapshotThreadProvenance(value as NonNullable<ThreadAccessRequest["provenance"]>)
    : undefined
}
export function subject(
  row: RuntimeThreadRecord | RuntimeRetainedSubject | undefined,
  original?: Readonly<Record<string, unknown>>,
): {
  readonly thread?: RuntimeThreadRecord["thread"]
  readonly provenance?: NonNullable<ThreadAccessRequest["provenance"]>
} {
  const origin = original ? snapshotThreadProvenance(original) : provenance(row)
  return { ...(row ? { thread: row.thread } : {}), ...(origin ? { provenance: origin } : {}) }
}
/** Correlation/transport members never change the operation's identity. Caller
 * annotations and expected generation/head remain part of the fingerprint. */
export function operationPayload(value: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, trace_id: _traceId, trace: _trace, ...payload } = value
  const metadata = { ...((payload.metadata ?? {}) as Record<string, unknown>) }
  if (metadata.b4 && typeof metadata.b4 === "object") {
    const { submissionId: _token, ...b4 } = metadata.b4 as Record<string, unknown>
    if (b4.expected !== undefined) metadata.b4 = b4
    else delete metadata.b4
  }
  return { ...payload, metadata }
}

/** The common durable operation ledger. Callers authorize the original Agent
 * and stored Thread/provenance before reading a receipt. Identity callbacks use
 * saved pure normalization facts, never current executable route callbacks. */
export async function replayOperationReceipt(
  tx: RuntimeTransaction,
  record: RuntimeReceiptRecord,
  ownerKey: string,
  identity: (operation: RuntimeOperationContext) => Record<string, unknown>,
): Promise<AdmissionResult> {
  return replayOperationFacts(
    tx.scope,
    record,
    await tx.runs.get(record.receipt.runId),
    ownerKey,
    identity,
  )
}
/** The same original-normalization evaluator for live and independently retained
 * immutable facts. No deleted-generation writer binding or synthetic TX. */
export function replayOperationFacts(
  scope: Pick<RuntimeStorageScope, "threadId" | "generation">,
  record: RuntimeReceiptRecord,
  run: RuntimeRunRecord | undefined,
  ownerKey: string,
  identity: (operation: RuntimeOperationContext) => Record<string, unknown>,
): AdmissionResult {
  const operation = record.operation
  if (
    !operation ||
    operation.scopeKey !== ownerKey ||
    !operation.normalization ||
    typeof operation.normalization.messages !== "boolean"
  )
    throw new ProtocolError("receipt_expired")
  let fingerprint: string
  try {
    fingerprint = hash([
      ownerKey,
      operation.method,
      canonical(identity(operation)),
      scope.generation,
    ])
  } catch {
    throw new ProtocolError("submission_conflict")
  }
  if (fingerprint !== record.fingerprint) throw new ProtocolError("submission_conflict")
  if (!run) throw new ProtocolError("submission_target_gone")
  if (record.state !== "accepted") throw new ProtocolError("receipt_expired")
  return {
    runId: record.receipt.runId,
    threadId: scope.threadId,
    responseMeta: { b4: { v: 1, receipt: { ...record.receipt, replayed: true } } },
  }
}

/** Additional namespace/Agent facts are private server-derived receipt state.
 * Current root Agent and actual Thread/provenance authorization precede this
 * read-owner check; no caller metadata or configuration supplies these facts. */
export async function authorizeSavedPermissionAgents(
  receipt: RuntimeReceiptRecord,
  authorize: (agentId: string) => Promise<void>,
): Promise<void> {
  const agents = receipt.operation?.resolved.permissionAgents
  if (!Array.isArray(agents) || !agents.length || agents.some((agent) => typeof agent !== "string"))
    throw new ProtocolError("receipt_expired")
  for (const agent of agents) await authorize(agent)
}

/** Validate the same canonical facts before a writer bind and again in its TX.
 * A permission continuation cannot degrade to root-only when receipts expire,
 * disappear or contain malformed/cross-target authority facts. */
export function exactRunPermissionAgents(
  threadId: string,
  runId: string,
  facts: RuntimeRunAuthorityFacts,
): readonly string[] {
  try {
    canonicalProtocolId(facts.turnId)
    if (
      !Array.isArray(facts.permissionResponses) ||
      !Array.isArray(facts.inputInjections) ||
      !Array.isArray(facts.nativeNamespaces)
    )
      throw new Error("Missing authority facts")
    const agents: string[] = [...sourceAgents(threadId, runId, facts.protectedSource)]
    const namespaces = new Set<string>()
    for (const binding of facts.nativeNamespaces) {
      if (
        binding.v !== 1 ||
        binding.kind !== "native_namespace" ||
        binding.runId !== runId ||
        !Array.isArray(binding.namespace) ||
        !binding.namespace.length ||
        binding.namespace.some((part: unknown) => typeof part !== "string" || !part.length) ||
        typeof binding.agentId !== "string" ||
        !binding.agentId ||
        namespaces.has(canonical(binding.namespace))
      )
        throw new Error("Invalid native namespace authority")
      canonicalProtocolId(binding.parentCheckpointId)
      canonicalProtocolId(binding.namespaceGeneration)
      if (binding.source) {
        const source = binding.source
        if (
          source.v !== 1 ||
          source.kind !== "permission_continuation" ||
          source.threadId !== threadId ||
          source.runId !== facts.previousRunId ||
          source.parentCheckpointId !== binding.parentCheckpointId ||
          source.namespaceGeneration === binding.namespaceGeneration ||
          source.aliasId !==
            `namespace:${hash([threadId, source.generation, source.runId, binding.namespace])}` ||
          !/^[0-9a-f]{64}$/.test(source.receiptId)
        )
          throw new Error("Invalid native continuation source")
        for (const id of [
          source.generation,
          source.runId,
          source.namespaceGeneration,
          source.checkpointId,
          source.parentCheckpointId,
        ])
          canonicalProtocolId(id)
        if (
          Object.keys(source).some(
            (key) =>
              ![
                "v",
                "kind",
                "threadId",
                "generation",
                "runId",
                "aliasId",
                "namespaceGeneration",
                "checkpointId",
                "parentCheckpointId",
                "receiptId",
              ].includes(key),
          )
        )
          throw new Error("Invalid native continuation source fields")
      } else if (binding.namespace.at(-1)?.split(":").at(-1) !== binding.namespaceGeneration)
        throw new Error("Native namespace generation mismatch")
      namespaces.add(canonical(binding.namespace))
      agents.push(binding.agentId)
    }
    if (facts.previousRunId === null) {
      if (facts.turnId !== runId || facts.permissionResponses.length !== 0)
        throw new Error("Invalid initial Run authority")
    } else {
      canonicalProtocolId(facts.previousRunId)
      if (
        facts.previousRunId === runId ||
        facts.turnId === runId ||
        facts.permissionResponses.length !== 1
      )
        throw new Error("Invalid continuation authority")
      const receipt = facts.permissionResponses[0]
      if (
        !receipt ||
        receipt.runId !== runId ||
        receipt.turnId !== facts.turnId ||
        receipt.operationThreadId !== threadId ||
        receipt.targetRunId !== facts.previousRunId
      )
        throw new Error("Cross-target authority")
      agents.push(...authorityChildren(receipt.permissionAgents, false))
    }
    for (const receipt of facts.inputInjections) {
      if (
        receipt.runId !== runId ||
        receipt.targetRunId !== runId ||
        receipt.turnId !== facts.turnId ||
        receipt.operationThreadId !== threadId
      )
        throw new Error("Cross-target injection authority")
      agents.push(...injectionChildren(receipt))
    }
    return [...new Set(agents)]
  } catch {
    throw new ProtocolError("storage_unavailable")
  }
}
function authorityChildren(value: unknown, empty: boolean): string[] {
  if (
    !Array.isArray(value) ||
    (!empty && !value.length) ||
    value.some((id) => typeof id !== "string" || !id.length) ||
    new Set(value).size !== value.length
  )
    throw new ProtocolError("storage_unavailable")
  return value
}
function injectionChildren(
  facts: Pick<
    RuntimeOperationAuthorityFacts,
    "permissionAgents" | "namespace" | "namespaceGeneration" | "injectionAgent"
  >,
): string[] {
  const agents = authorityChildren(facts.permissionAgents, true)
  if (
    !Array.isArray(facts.namespace) ||
    facts.namespace.some((part) => typeof part !== "string" || !part.length) ||
    typeof facts.injectionAgent !== "string" ||
    !facts.injectionAgent.length
  )
    throw new ProtocolError("storage_unavailable")
  canonicalProtocolId(facts.namespaceGeneration)
  if (
    facts.namespace.length
      ? agents.length !== 1 || agents[0] !== facts.injectionAgent
      : agents.length !== 0
  )
    throw new ProtocolError("storage_unavailable")
  return agents
}

export function runAuthorityFacts(
  run: RuntimeRunRecord,
  receipts: readonly RuntimeReceiptRecord[],
  namespaces: readonly RuntimeNamespaceRecord[],
  sources: readonly RuntimeProtectedSourceRecord[],
): RuntimeRunAuthorityFacts {
  return authorityFor(
    run.run.run_id,
    run.metadata.turnId,
    run.metadata.previousRunId ?? null,
    receipts,
    namespaces,
    sources,
  )
}
/** Canonical creator skeletons remain genuine after Run-payload removal. */
export function receiptRunAuthorityFacts(
  runId: string,
  receipts: readonly RuntimeReceiptRecord[],
  namespaces: readonly RuntimeNamespaceRecord[],
  sources: readonly RuntimeProtectedSourceRecord[],
): RuntimeRunAuthorityFacts {
  const creators = new Map(
    receipts
      .filter(
        (row) =>
          row.receipt.runId === runId &&
          ["run.create", "input.respond"].includes(row.operation?.method ?? ""),
      )
      .map((row) => {
        const facts = {
          method: row.operation?.method,
          turnId: row.receipt.turnId,
          threadId: row.operation?.operationThreadId,
          targetRunId: row.operation?.targetRunId,
        }
        return [canonical(facts), facts] as const
      }),
  )
  if (creators.size !== 1) throw new ProtocolError("storage_unavailable")
  const creator = [...creators.values()][0]!
  return authorityFor(
    runId,
    creator.turnId,
    creator.method === "input.respond" ? String(creator.targetRunId) : null,
    receipts,
    namespaces,
    sources,
  )
}
function authorityFor(
  runId: string,
  turnId: string,
  previousRunId: string | null,
  receipts: readonly RuntimeReceiptRecord[],
  namespaces: readonly RuntimeNamespaceRecord[],
  sources: readonly RuntimeProtectedSourceRecord[],
): RuntimeRunAuthorityFacts {
  const facts: RuntimeRunAuthorityFacts = {
    turnId: turnId,
    previousRunId: previousRunId,
    protectedSource: {
      reference: (() => {
        const references = new Map(
          receipts
            .filter(
              (row) =>
                row.receipt.runId === runId &&
                ["run.create", "input.respond"].includes(row.operation?.method ?? ""),
            )
            .map((row) => [
              canonical(row.operation?.protectedSource ?? null),
              row.operation?.protectedSource ?? null,
            ]),
        )
        return references.size === 1 ? [...references.values()][0] : "invalid_creator"
      })(),
      records: sources.filter((row) => row.runId === runId),
    },
    nativeNamespaces: namespaces
      .filter((row) => row.runId === runId)
      .map(
        ({
          v,
          kind,
          runId,
          namespace,
          agentId,
          namespaceGeneration,
          parentCheckpointId,
          source,
        }) => ({
          v,
          kind,
          runId,
          namespace,
          agentId,
          namespaceGeneration,
          parentCheckpointId,
          source: source ?? null,
        }),
      ),
    inputInjections: receipts
      .filter(
        (receipt) =>
          receipt.receipt.runId === runId && receipt.operation?.method === "input.inject",
      )
      .map((receipt) => ({
        runId: receipt.receipt.runId,
        turnId: receipt.receipt.turnId,
        operationThreadId: receipt.operation?.operationThreadId ?? "",
        targetRunId: receipt.operation?.targetRunId ?? "",
        permissionAgents: receipt.operation?.resolved.permissionAgents,
        namespace: receipt.operation?.resolved.namespace,
        namespaceGeneration: receipt.operation?.resolved.namespaceGeneration,
        injectionAgent: receipt.operation?.resolved.injectionAgent,
      })),
    permissionResponses: receipts
      .filter(
        (receipt) =>
          receipt.receipt.runId === runId && receipt.operation?.method === "input.respond",
      )
      .map((receipt) => ({
        runId: receipt.receipt.runId,
        turnId: receipt.receipt.turnId,
        operationThreadId: receipt.operation?.operationThreadId ?? "",
        targetRunId: receipt.operation?.targetRunId ?? "",
        permissionAgents: receipt.operation?.resolved.permissionAgents,
      })),
  }
  const unique = <T>(items: readonly T[]) => [
    ...new Map(items.map((item) => [canonical(item), item])).values(),
  ]
  return { ...facts, inputInjections: unique(facts.inputInjections) }
}

/** Known canonical child identities must be checked before secondary stored
 * lineage/map faults can disclose a diagnostic. Full validation is mandatory. */
export function knownRunPermissionAgents(facts: RuntimeRunAuthorityFacts): readonly string[] {
  const agents: string[] = []
  for (const collection of [facts?.permissionResponses, facts?.inputInjections]) {
    if (!Array.isArray(collection)) continue
    for (const receipt of collection) {
      const saved = receipt?.permissionAgents
      if (Array.isArray(saved))
        for (const agent of saved) if (typeof agent === "string" && agent) agents.push(agent)
    }
  }
  if (Array.isArray(facts?.nativeNamespaces))
    for (const binding of facts.nativeNamespaces)
      if (typeof binding?.agentId === "string" && binding.agentId) agents.push(binding.agentId)
  if (Array.isArray(facts?.protectedSource?.records))
    for (const proof of facts.protectedSource.records)
      if (Array.isArray(proof?.agents))
        for (const agent of proof.agents) if (typeof agent === "string" && agent) agents.push(agent)
  return [...new Set(agents)]
}

function sourceAgents(
  threadId: string,
  runId: string,
  source: RuntimeRunAuthorityFacts["protectedSource"],
): readonly string[] {
  if (!source || !Array.isArray(source.records)) throw new ProtocolError("storage_unavailable")
  if (source.reference === null && source.records.length === 0) return []
  if (source.records.length !== 1 || !source.reference || typeof source.reference !== "object")
    throw new ProtocolError("storage_unavailable")
  const proof = source.records[0]!,
    reference = source.reference as { aliasId?: unknown; digest?: unknown }
  if (
    !isProtectedSource(proof) ||
    proof.threadId !== threadId ||
    proof.runId !== runId ||
    reference.aliasId !== proof.aliasId ||
    reference.digest !== proof.digest
  )
    throw new ProtocolError("storage_unavailable")
  return authorityChildren(proof.agents, false)
}

export function validateRetainedPermissionMap(
  threadId: string,
  runId: string,
  children: readonly string[],
  value: RuntimeRetainedSubject,
): void {
  if (value.thread?.thread_id !== threadId) throw new ProtocolError("not_found")
  const map = value.protectedMetadata.permissionAgentsByRun as Record<string, unknown> | undefined,
    saved = map?.[runId],
    sorted = [...children].sort()
  if (
    children.length
      ? !Array.isArray(saved) ||
        saved.length !== children.length ||
        saved.some((id) => typeof id !== "string") ||
        [...saved].sort().some((id, i) => id !== sorted[i])
      : saved !== undefined
  )
    throw new ProtocolError("storage_unavailable")
}

export function operationAuthorityFacts(
  receipt: RuntimeReceiptRecord,
  runAuthority: RuntimeRunAuthorityFacts | null,
): RuntimeOperationAuthorityFacts {
  return {
    runId: receipt.receipt.runId,
    turnId: receipt.receipt.turnId,
    method: receipt.operation?.method ?? null,
    operationThreadId: receipt.operation?.operationThreadId ?? null,
    targetRunId: receipt.operation?.targetRunId ?? null,
    permissionAgents: receipt.operation?.resolved.permissionAgents ?? null,
    namespace: receipt.operation?.resolved.namespace ?? null,
    namespaceGeneration: receipt.operation?.resolved.namespaceGeneration ?? null,
    injectionAgent: receipt.operation?.resolved.injectionAgent ?? null,
    runAuthority,
  }
}
function operationChildren(facts: RuntimeOperationAuthorityFacts): readonly string[] {
  if (facts?.method === "run.create") return []
  if (facts?.method === "input.inject") return injectionChildren(facts)
  if (facts?.method !== "input.respond") throw new ProtocolError("storage_unavailable")
  return authorityChildren(facts.permissionAgents, false)
}

function operationRunChildren(facts: RuntimeOperationAuthorityFacts): readonly string[] {
  const saved = Array.isArray(facts?.permissionAgents)
    ? facts.permissionAgents.filter((id): id is string => typeof id === "string" && !!id)
    : []
  return [
    ...new Set([
      ...saved,
      ...knownRunPermissionAgents(facts?.runAuthority as RuntimeRunAuthorityFacts),
    ]),
  ]
}
export const operationRunAgents = operationRunChildren
function normalizedOperationAuthority(facts: RuntimeOperationAuthorityFacts) {
  const authority = facts.runAuthority
  const sorted = <T>(items: readonly T[]) =>
    [...items].sort((a, b) => canonical(a).localeCompare(canonical(b)))
  return {
    ...facts,
    runAuthority: authority
      ? {
          ...authority,
          nativeNamespaces: sorted(authority.nativeNamespaces),
          inputInjections: sorted(authority.inputInjections),
          permissionResponses: sorted(authority.permissionResponses),
        }
      : null,
  }
}
export function sameOperationAuthority(
  left: RuntimeOperationAuthorityFacts,
  right: RuntimeOperationAuthorityFacts,
): boolean {
  return (
    canonical(normalizedOperationAuthority(left)) === canonical(normalizedOperationAuthority(right))
  )
}
export async function authorizeCurrentOperation(
  tx: RuntimeTransaction,
  receipt: RuntimeReceiptRecord,
  authorize: (agentId: string) => Promise<void>,
): Promise<RuntimeOperationAuthorityFacts> {
  const root = receipt.operation?.resolved.agent_id
  if (typeof root !== "string") throw new ProtocolError("storage_unavailable")
  await authorize(root)
  const receipts = await tx.receipts.list(),
    namespaces = await tx.nativeNamespaces.list(),
    sources = await tx.protectedSources.list(),
    run = await tx.runs.get(receipt.receipt.runId)
  const authority = run
    ? runAuthorityFacts(run, receipts, namespaces, sources)
    : receiptRunAuthorityFacts(receipt.receipt.runId, receipts, namespaces, sources)
  const facts = operationAuthorityFacts(receipt, authority)
  for (const agent of operationRunAgents(facts)) await authorize(agent)
  validateOperationRunAuthority(tx.scope.threadId, facts)
  return facts
}
export function validateOperationRunAuthority(
  threadId: string,
  facts: RuntimeOperationAuthorityFacts,
): void {
  if (facts?.method === null) throw new ProtocolError("receipt_expired")
  if (!facts?.runAuthority || facts.turnId !== facts.runAuthority.turnId)
    throw new ProtocolError("storage_unavailable")
  exactRunPermissionAgents(threadId, facts.runId, facts.runAuthority)
}
export function validateOperationAuthority(
  threadId: string,
  facts: RuntimeOperationAuthorityFacts,
): void {
  try {
    canonicalProtocolId(facts.runId)
    canonicalProtocolId(facts.turnId)
    canonicalProtocolId(facts.operationThreadId)
    canonicalProtocolId(facts.targetRunId)
    if (facts.operationThreadId !== threadId) throw new Error("Cross-thread operation")
    if (!facts.runAuthority || facts.runAuthority.turnId !== facts.turnId)
      throw new Error("Missing canonical Run authority")
    exactRunPermissionAgents(threadId, facts.runId, facts.runAuthority)
    if (facts.method === "run.create") {
      if (
        facts.runId !== facts.turnId ||
        facts.targetRunId !== facts.runId ||
        facts.runAuthority.previousRunId !== null ||
        (facts.permissionAgents !== undefined && facts.permissionAgents !== null)
      )
        throw new Error("Invalid initial operation")
    } else if (facts.method === "input.respond") {
      if (
        facts.runId === facts.turnId ||
        facts.targetRunId === facts.runId ||
        facts.runAuthority.previousRunId !== facts.targetRunId
      )
        throw new Error("Invalid continuation operation")
      operationChildren(facts)
    } else if (facts.method === "input.inject") {
      if (facts.targetRunId !== facts.runId) throw new Error("Cross-target injection operation")
      injectionChildren(facts)
    } else throw new Error("Unsupported retained operation proof")
  } catch {
    throw new ProtocolError("storage_unavailable")
  }
}
/** Existing common service plumbing; discovery facts alone grant no authority. */
export async function authorizeRetainedOperation(
  threadId: string,
  agentId: string | undefined,
  facts: RuntimeOperationAuthorityFacts,
  value: RuntimeRetainedSubject,
  authorizeAgent: (id: string) => Promise<void>,
  authorizeThread: () => Promise<boolean>,
): Promise<void> {
  if (!agentId || value.thread?.thread_id !== threadId) throw new ProtocolError("not_found")
  await authorizeAgent(agentId)
  const fail = async () => {
    if (!(await authorizeThread())) throw new ProtocolError("not_found")
    throw new ProtocolError("storage_unavailable")
  }
  let children: readonly string[]
  try {
    children = operationRunChildren(facts)
  } catch {
    return fail()
  }
  for (const child of children) await authorizeAgent(child)
  const savedMap = value.protectedMetadata.permissionAgentsByRun as
    | Record<string, unknown>
    | undefined
  const savedChildren = savedMap?.[facts?.runId]
  if (Array.isArray(savedChildren))
    for (const child of savedChildren)
      if (typeof child === "string" && child && !children.includes(child))
        await authorizeAgent(child)
  try {
    validateOperationAuthority(threadId, facts)
    validateRetainedPermissionMap(threadId, facts.runId, children, value)
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "not_found") throw error
    return fail()
  }
  if (!(await authorizeThread())) throw new ProtocolError("not_found")
}
export function validateRetainedOperationCut(
  candidate: RuntimeOperationCandidate,
  cut: RuntimeRetainedOperation,
  ownerKey: string,
): void {
  if (
    cut.scope.threadId !== candidate.scope.threadId ||
    cut.scope.generation !== candidate.scope.generation ||
    cut.subject.thread?.thread_id !== candidate.scope.threadId ||
    cut.receipt.receiptId !== candidate.receiptId ||
    cut.receipt.operation?.resolved.agent_id !== candidate.agentId
  )
    throw new ProtocolError("not_found")
  if (
    cut.receipt.operation?.scopeKey !== ownerKey ||
    !sameOperationAuthority(
      operationAuthorityFacts(cut.receipt, cut.runAuthority),
      candidate.operationAuthority,
    ) ||
    canonical(cut.receipt.operation?.provenance) !== canonical(candidate.provenance) ||
    canonical(cut.subject.protectedMetadata.provenance) !==
      canonical(candidate.retainedSubject?.protectedMetadata.provenance)
  )
    throw new ProtocolError("storage_unavailable")
  if (cut.run) {
    if (
      cut.run.run.run_id !== candidate.operationAuthority.runId ||
      cut.run.run.agent_id !== candidate.agentId ||
      cut.run.run.thread_id !== candidate.scope.threadId ||
      cut.run.metadata.generation !== candidate.scope.generation
    )
      throw new ProtocolError("not_found")
    if (
      !cut.runAuthority ||
      cut.run.metadata.turnId !== cut.runAuthority.turnId ||
      (cut.run.metadata.previousRunId ?? null) !== cut.runAuthority.previousRunId
    )
      throw new ProtocolError("storage_unavailable")
    exactRunPermissionAgents(candidate.scope.threadId, cut.run.run.run_id, cut.runAuthority)
  }
}
