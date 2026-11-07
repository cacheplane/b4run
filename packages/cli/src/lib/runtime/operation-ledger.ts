import type { ThreadAccessRequest } from "@b4run/sdk"
import type {
  ReceiptV1,
  RuntimeOperationContext,
  RuntimeReceiptRecord,
  RuntimeRetainedSubject,
  RuntimeRunAuthorityFacts,
  RuntimeRunRecord,
  RuntimeStorageScope,
  RuntimeThreadRecord,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
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

export function canonical(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}
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
    if (!Array.isArray(facts.permissionResponses)) throw new Error("Missing authority facts")
    if (facts.previousRunId === null) {
      if (facts.turnId !== runId || facts.permissionResponses.length !== 0)
        throw new Error("Invalid initial Run authority")
      return []
    }
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
    const agents = receipt.permissionAgents
    if (
      !Array.isArray(agents) ||
      !agents.length ||
      agents.some((agent) => typeof agent !== "string" || !agent.length) ||
      new Set(agents).size !== agents.length
    )
      throw new Error("Incomplete permission authority")
    return agents
  } catch {
    throw new ProtocolError("storage_unavailable")
  }
}

export function runAuthorityFacts(
  run: RuntimeRunRecord,
  receipts: readonly RuntimeReceiptRecord[],
): RuntimeRunAuthorityFacts {
  return {
    turnId: run.metadata.turnId,
    previousRunId: run.metadata.previousRunId ?? null,
    permissionResponses: receipts
      .filter(
        (receipt) =>
          receipt.receipt.runId === run.run.run_id && receipt.operation?.method === "input.respond",
      )
      .map((receipt) => ({
        runId: receipt.receipt.runId,
        turnId: receipt.receipt.turnId,
        operationThreadId: receipt.operation?.operationThreadId ?? "",
        targetRunId: receipt.operation?.targetRunId ?? "",
        permissionAgents: receipt.operation?.resolved.permissionAgents,
      })),
  }
}
