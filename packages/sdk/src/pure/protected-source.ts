import type {
  RuntimeProtectedSourceRecord,
  RuntimeRunRecord,
  RuntimeStoppedSourceProof,
  RuntimeStoppedSourceWitness,
} from "../agent-protocol/storage.js"
import { sha256Hex } from "./hash.js"
import { canonicalRuntimeValue } from "./runtime-identity.js"

/** Fixed-field digest for the private immutable native source identity. */
export function protectedSourceDigest(
  record: Omit<RuntimeProtectedSourceRecord, "digest">,
): string {
  return sha256Hex(
    JSON.stringify([
      record.v,
      record.kind,
      record.aliasId,
      record.threadId,
      record.generation,
      record.runId,
      record.preRunCheckpointId,
      record.sourceRunId,
      record.sourceCheckpointId,
      record.checkpointOwnerRunId,
      record.stoppedSource === null
        ? null
        : JSON.parse(canonicalRuntimeValue(record.stoppedSource)),
      record.sourceDigest,
      record.sourceRunIds,
      record.agents,
    ]),
  )
}

export function protectedSourceId(threadId: string, generation: string, runId: string): string {
  return `source:${sha256Hex(JSON.stringify([threadId, generation, runId]))}`
}

/** Structural/digest validation follows current authorization of known Agents. */
export function isProtectedSource(value: unknown): value is RuntimeProtectedSourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as RuntimeProtectedSourceRecord
  const keys = [
    "v",
    "kind",
    "aliasId",
    "threadId",
    "generation",
    "runId",
    "preRunCheckpointId",
    "sourceRunId",
    "sourceCheckpointId",
    "checkpointOwnerRunId",
    "stoppedSource",
    "sourceDigest",
    "sourceRunIds",
    "agents",
    "digest",
  ]
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return (
    record.v === 1 &&
    record.kind === "protected_source" &&
    Object.keys(record).every((key) => keys.includes(key)) &&
    [
      record.threadId,
      record.generation,
      record.runId,
      record.preRunCheckpointId,
      record.sourceRunId,
      record.sourceCheckpointId,
      record.checkpointOwnerRunId,
    ].every((id) => typeof id === "string" && uuid.test(id)) &&
    (record.stoppedSource === null
      ? record.checkpointOwnerRunId === record.sourceRunId
      : isStoppedSourceProof(
          record.stoppedSource,
          record.sourceRunId,
          record.checkpointOwnerRunId,
          record.threadId,
          record.generation,
        )) &&
    record.aliasId === protectedSourceId(record.threadId, record.generation, record.runId) &&
    record.digest === protectedSourceDigest(record) &&
    (record.sourceDigest === null || /^[a-f0-9]{64}$/.test(record.sourceDigest)) &&
    Array.isArray(record.agents) &&
    record.agents.length > 0 &&
    record.agents.every((id) => typeof id === "string" && !!id.length) &&
    new Set(record.agents).size === record.agents.length &&
    Array.isArray(record.sourceRunIds) &&
    record.sourceRunIds[0] === record.sourceRunId &&
    !record.sourceRunIds.includes(record.runId) &&
    new Set(record.sourceRunIds).size === record.sourceRunIds.length &&
    record.sourceRunIds.every((id) => typeof id === "string" && uuid.test(id))
  )
}

export function isStoppedSourceProof(
  value: unknown,
  logicalRunId: string,
  checkpointOwnerRunId: string,
  threadId: string,
  generation: string,
): value is RuntimeStoppedSourceProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const proof = value as RuntimeStoppedSourceProof
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const fields = [
    "v",
    "kind",
    "creatorMethod",
    "path",
    ...(proof.kind === "started_unwound"
      ? ["execution", "startedAt", "unwoundAt"]
      : proof.kind === "ownership_lost"
        ? ["execution", "startedAt", "ownershipLoss"]
        : []),
  ]
  if (
    proof.v !== 1 ||
    !["accepted_not_started", "started_unwound", "ownership_lost"].includes(proof.kind) ||
    !["run.create", "input.respond"].includes(proof.creatorMethod) ||
    Object.keys(proof).some((key) => !fields.includes(key)) ||
    !Array.isArray(proof.path) ||
    !proof.path.length ||
    proof.path[0]?.runId !== logicalRunId ||
    logicalRunId === checkpointOwnerRunId
  )
    return false
  const iso = (value: unknown) =>
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  if (proof.kind !== "accepted_not_started") {
    if (
      !proof.execution ||
      Object.keys(proof.execution).some((key) => !["ownerId", "fence"].includes(key)) ||
      typeof proof.execution.ownerId !== "string" ||
      !proof.execution.ownerId ||
      !Number.isSafeInteger(proof.execution.fence) ||
      proof.execution.fence < 1 ||
      !iso(proof.startedAt)
    )
      return false
    if (proof.kind === "started_unwound") {
      if (!iso(proof.unwoundAt)) return false
    } else if (
      !proof.ownershipLoss ||
      Object.keys(proof.ownershipLoss).some(
        (key) => !["ownerId", "fence", "detectedAt", "effectsUncertain"].includes(key),
      ) ||
      proof.ownershipLoss.ownerId !== proof.execution.ownerId ||
      proof.ownershipLoss.fence !== proof.execution.fence ||
      proof.ownershipLoss.effectsUncertain !== true ||
      !iso(proof.ownershipLoss.detectedAt)
    )
      return false
  }
  const ids = new Set<string>()
  for (const [index, entry] of proof.path.entries()) {
    if (
      !entry ||
      Object.keys(entry).some(
        (key) =>
          !["runId", "previousRunId", "receiptId", "selectedHead", "protectedSource"].includes(key),
      ) ||
      !uuid.test(entry.runId) ||
      !uuid.test(entry.selectedHead) ||
      !/^[0-9a-f]{64}$/.test(entry.receiptId) ||
      ids.has(entry.runId) ||
      entry.runId === checkpointOwnerRunId
    )
      return false
    ids.add(entry.runId)
    if (proof.creatorMethod === "input.respond") {
      if (
        entry.protectedSource !== null ||
        entry.previousRunId !== (proof.path[index + 1]?.runId ?? checkpointOwnerRunId)
      )
        return false
    } else if (
      proof.path.length !== 1 ||
      entry.previousRunId !== null ||
      !entry.protectedSource ||
      Object.keys(entry.protectedSource).some((key) => !["aliasId", "digest"].includes(key)) ||
      entry.protectedSource.aliasId !== protectedSourceId(threadId, generation, logicalRunId) ||
      !/^[0-9a-f]{64}$/.test(entry.protectedSource.digest)
    )
      return false
  }
  return true
}

/** Used only when sealing a NEW source under its native writer. Historical
 * immutable identities do not require old payloads or currently usable grants. */
export function stoppedSourceMatchesRun(
  proof: RuntimeStoppedSourceProof,
  run: RuntimeRunRecord,
  currentFence: number,
): boolean {
  if (
    run.run.run_id !== proof.path[0]?.runId ||
    run.metadata.phase !== "settled" ||
    run.metadata.continuation !== "closed"
  )
    return false
  if (proof.kind === "accepted_not_started")
    return (
      run.metadata.startedAt === undefined &&
      run.execution === undefined &&
      !run.ownershipLoss &&
      !!run.unwoundAt &&
      ["user_stop", "client_disconnect", "server_shutdown", "deadline"].includes(
        run.metadata.reason ?? "",
      )
    )
  if (run.metadata.startedAt !== proof.startedAt) return false
  return proof.kind === "started_unwound"
    ? run.unwoundAt === proof.unwoundAt &&
        !run.ownershipLoss &&
        canonicalRuntimeValue(run.execution) === canonicalRuntimeValue(proof.execution) &&
        proof.execution.fence + 1 === currentFence
    : canonicalRuntimeValue(run.ownershipLoss) === canonicalRuntimeValue(proof.ownershipLoss) &&
        !!run.execution &&
        run.execution.fence > proof.ownershipLoss.fence &&
        run.execution.fence + 1 === currentFence
}

/** Copies canonical private witnesses; callers still require the native writer,
 * no current owner, exact selected path and current policy before using it. */
export function runtimeStoppedSourceWitness(
  run: RuntimeRunRecord,
): RuntimeStoppedSourceWitness | undefined {
  const iso = (value: unknown): value is string =>
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  const execution = run.execution
  if (run.metadata.startedAt !== undefined) {
    if (
      !iso(run.metadata.startedAt) ||
      !execution ||
      typeof execution.ownerId !== "string" ||
      !execution.ownerId ||
      !Number.isSafeInteger(execution.fence) ||
      execution.fence < 1
    )
      return undefined
    if (run.ownershipLoss) {
      const loss = run.ownershipLoss
      if (
        typeof loss.ownerId !== "string" ||
        !loss.ownerId ||
        !Number.isSafeInteger(loss.fence) ||
        loss.fence < 1 ||
        execution.fence <= loss.fence ||
        loss.effectsUncertain !== true ||
        !iso(loss.detectedAt)
      )
        return undefined
      return {
        kind: "ownership_lost",
        execution: { ownerId: loss.ownerId, fence: loss.fence },
        startedAt: run.metadata.startedAt,
        ownershipLoss: { ...loss },
      }
    }
    if (!iso(run.unwoundAt)) return undefined
    return {
      kind: "started_unwound",
      execution: { ...execution },
      startedAt: run.metadata.startedAt,
      unwoundAt: run.unwoundAt,
    }
  }
  return execution === undefined && !run.ownershipLoss && iso(run.unwoundAt)
    ? { kind: "accepted_not_started" }
    : undefined
}
