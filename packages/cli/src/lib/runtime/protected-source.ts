import type {
  RuntimeProtectedSourceRecord,
  RuntimeStoppedSourceProof,
  RuntimeThreadRecord,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
import {
  isProtectedSource,
  protectedSourceDigest,
  protectedSourceId,
  runtimeStoppedSourceWitness,
  stoppedSourceMatchesRun,
} from "@b4run/sdk/internal/runtime-identity"
import { ProtocolError } from "../dev/protocol/errors.js"
import {
  canonical,
  exactRunPermissionAgents,
  knownRunPermissionAgents,
  runAuthorityFacts,
} from "./operation-ledger.js"

/** A stopped run.create can select only its already frozen accepted source. */
export async function acceptedInitialStoppedSource(tx: RuntimeTransaction, runId: string) {
  const run = await tx.runs.get(runId),
    thread = await tx.thread.get()
  const creators = (await tx.receipts.list()).filter(
    (receipt) =>
      receipt.receipt.runId === runId &&
      ["run.create", "input.respond"].includes(receipt.operation?.method ?? ""),
  )
  if (
    !run ||
    creators.length !== 1 ||
    run.metadata.previousRunId ||
    run.metadata.phase !== "settled" ||
    run.metadata.continuation !== "closed" ||
    (await tx.executionOwner()) !== null ||
    !thread?.headCheckpointId ||
    run.preRunCheckpointId !== thread.headCheckpointId
  )
    throw new ProtocolError("not_supported")
  const receipt = creators[0]!,
    source = await tx.protectedSources.get(
      protectedSourceId(tx.scope.threadId, tx.scope.generation, runId),
    )
  if (
    receipt.state !== "accepted" ||
    receipt.operation?.method !== "run.create" ||
    receipt.operation.operationThreadId !== tx.scope.threadId ||
    receipt.operation.targetRunId !== runId ||
    !source ||
    !isProtectedSource(source) ||
    source.preRunCheckpointId !== run.preRunCheckpointId ||
    canonical(receipt.operation.protectedSource) !==
      canonical({ aliasId: source.aliasId, digest: source.digest })
  )
    throw new ProtocolError("not_supported")
  const origin = await tx.checkpoints.get(source.sourceCheckpointId)
  if (!origin || origin.ownerRunId !== source.checkpointOwnerRunId || origin.namespace.length)
    throw new ProtocolError("storage_unavailable")
  const witness = runtimeStoppedSourceWitness(run)
  if (!witness || thread.pausedGeneration !== null) throw new ProtocolError("not_supported")
  const stoppedSource: RuntimeStoppedSourceProof = {
    v: 1,
    ...witness,
    creatorMethod: "run.create",
    path: [
      {
        runId,
        previousRunId: null,
        receiptId: receipt.receiptId,
        selectedHead: run.preRunCheckpointId,
        protectedSource: { aliasId: source.aliasId, digest: source.digest },
      },
    ],
  }
  if (!stoppedSourceMatchesRun(stoppedSource, run, tx.scope.fence))
    throw new ProtocolError("not_supported")
  if (witness.kind !== "accepted_not_started") {
    const selected = await tx.checkpoints.get(run.preRunCheckpointId),
      payload = selected?.payload as
        | {
            kind?: string
            v?: number
            writes?: {
              kind: "execution" | "administrative"
              ownerRunId: string
              taskId: string
              namespaceGeneration: string
              sourceCheckpointId: string | null
              fence: number
            }[]
          }
        | undefined
    const writes = payload?.writes?.filter(
      (write) => write.kind === "execution" && write.ownerRunId === runId,
    )
    if (
      payload?.kind !== "langgraph" ||
      payload.v !== 1 ||
      !writes?.length ||
      writes.some(
        (write) =>
          !write.taskId ||
          write.fence !== witness.execution.fence ||
          write.namespaceGeneration !== runId ||
          write.sourceCheckpointId !== run.preRunCheckpointId,
      )
    )
      throw new ProtocolError("not_supported")
  }
  return {
    checkpointId: source.sourceCheckpointId,
    checkpointOwnerRunId: source.checkpointOwnerRunId,
    stoppedSource,
  }
}

/** Capture only the actual selected closed root head. No arbitrary branch or
 * future Thread contributor is added to this immutable authority closure. */
export async function captureProtectedSource(
  tx: RuntimeTransaction,
  thread: RuntimeThreadRecord | undefined,
  runId: string,
  authorize: (agentId: string) => Promise<void>,
): Promise<RuntimeProtectedSourceRecord | null> {
  if (!thread?.headCheckpointId) return null
  const head = await tx.checkpoints.get(thread.headCheckpointId)
  if (!head || head.namespace.length) throw new ProtocolError("storage_unavailable")
  const payload = head.payload as {
    safeHead?: unknown
    reboundFrom?: {
      runId?: unknown
      checkpointId?: unknown
      checkpointOwnerRunId?: unknown
      stoppedSource?: RuntimeStoppedSourceProof | null
    }
  } | null
  const sourceRunId = head.ownerRunId ?? payload?.reboundFrom?.runId
  const sourceCheckpointId = head.ownerRunId
    ? thread.headCheckpointId
    : payload?.reboundFrom?.checkpointId
  const checkpointOwnerRunId = head.ownerRunId ?? payload?.reboundFrom?.checkpointOwnerRunId
  if (
    typeof sourceRunId !== "string" ||
    typeof sourceCheckpointId !== "string" ||
    typeof checkpointOwnerRunId !== "string" ||
    sourceRunId !== thread.currentRunId ||
    (head.ownerRunId === null && payload?.safeHead !== true)
  )
    throw new ProtocolError("storage_unavailable")
  const source = await tx.runs.get(sourceRunId)
  if (
    !source?.run.agent_id ||
    source.metadata.phase !== "settled" ||
    source.metadata.continuation !== "closed"
  )
    throw new ProtocolError("thread_busy")
  await authorize(source.run.agent_id)
  const sources = await tx.protectedSources.list()
  const facts = runAuthorityFacts(
    source,
    await tx.receipts.list(),
    await tx.nativeNamespaces.list(),
    sources,
  )
  for (const agent of knownRunPermissionAgents(facts)) await authorize(agent)
  const agents = [
    ...new Set([
      source.run.agent_id,
      ...exactRunPermissionAgents(tx.scope.threadId, sourceRunId, facts),
    ]),
  ].sort()
  const inherited = sources.find((row) => row.runId === sourceRunId)
  const identity = {
    v: 1 as const,
    kind: "protected_source" as const,
    aliasId: protectedSourceId(tx.scope.threadId, tx.scope.generation, runId),
    threadId: tx.scope.threadId,
    generation: tx.scope.generation,
    runId,
    preRunCheckpointId: thread.headCheckpointId,
    sourceRunId,
    sourceCheckpointId,
    checkpointOwnerRunId,
    stoppedSource: head.ownerRunId ? null : (payload?.reboundFrom?.stoppedSource ?? null),
    sourceDigest: inherited?.digest ?? null,
    sourceRunIds: [sourceRunId, ...(inherited?.sourceRunIds ?? [])],
    agents,
  }
  return { ...identity, digest: protectedSourceDigest(identity) }
}
