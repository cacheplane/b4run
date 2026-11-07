import type {
  RuntimeGrantRecord,
  RuntimePendingRecord,
  RuntimeReceiptRecord,
  RuntimeStorageScope,
} from "@b4run/sdk/agent-protocol"
import { sha256Hex } from "@b4run/sdk/pure"
import { type RecordSpec, requireSame } from "./transaction.js"
/** Private physical key. Payload inputId remains the public namespace-local
 * interrupt ID; this exact projection also owns grant references and CAS. */
export function pendingKey(
  scope: RuntimeStorageScope,
  identity: Pick<
    RuntimeGrantRecord,
    "ownerRunId" | "pausedGeneration" | "namespace" | "inputId" | "proposalHash"
  >,
): string {
  return sha256Hex(
    JSON.stringify([
      scope.threadId,
      scope.generation,
      identity.ownerRunId,
      identity.pausedGeneration,
      identity.namespace,
      identity.inputId,
      identity.proposalHash,
    ]),
  )
}
export const grantSpec: RecordSpec<RuntimeGrantRecord> = {
  table: "grants",
  async fields(row, access) {
    await access.reference("runs", row.ownerRunId)
    await access.reference("runs", row.consumedByRunId)
    await access.reference("pending", pendingKey(access.scope, row))
    return {
      id: row.grantId,
      ownerRunId: row.ownerRunId,
      namespace: row.namespace,
      inputId: pendingKey(access.scope, row),
      pausedGeneration: row.pausedGeneration,
      consumedByRunId: row.consumedByRunId,
    }
  },
}
export const pendingSpec: RecordSpec<RuntimePendingRecord> = {
  table: "pending",
  async fields(row, access) {
    requireSame(row.input.namespace, row.namespace)
    requireSame(row.input.runId, row.ownerRunId)
    await access.reference("runs", row.ownerRunId)
    await access.reference("runs", row.input.turnId)
    return {
      id: pendingKey(access.scope, {
        ownerRunId: row.ownerRunId,
        namespace: row.namespace,
        inputId: row.input.data.interruptId,
        pausedGeneration: row.input.data.b4.pausedGeneration,
        proposalHash: row.input.data.b4.proposalHash,
      }),
      ownerRunId: row.ownerRunId,
      namespace: row.namespace,
      status: row.disposition,
      turnId: row.input.turnId,
    }
  },
}
export const receiptSpec: RecordSpec<RuntimeReceiptRecord> = {
  table: "receipts",
  async fields(row, access) {
    await access.reference("runs", row.receipt.runId)
    await access.reference("runs", row.receipt.turnId)
    return {
      id: row.receiptId,
      ownerRunId: row.receipt.runId,
      turnId: row.receipt.turnId,
      status: row.state,
    }
  },
}
