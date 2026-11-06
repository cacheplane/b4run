import type {
  RuntimeGrantRecord,
  RuntimePendingRecord,
  RuntimeReceiptRecord,
} from "@b4run/sdk/agent-protocol"
import { type RecordSpec, requireSame } from "./transaction.js"
export const grantSpec: RecordSpec<RuntimeGrantRecord> = {
  table: "grants",
  async fields(row, access) {
    await access.reference("runs", row.ownerRunId)
    await access.reference("runs", row.consumedByRunId)
    await access.reference("pending", row.inputId)
    return {
      id: row.grantId,
      ownerRunId: row.ownerRunId,
      namespace: row.namespace,
      inputId: row.inputId,
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
      id: row.input.data.interruptId,
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
