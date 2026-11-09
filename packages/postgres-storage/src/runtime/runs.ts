import type { RuntimeRunRecord } from "@b4run/sdk/agent-protocol"
import { type RecordSpec, requireSame } from "./transaction.js"
export const runSpec: RecordSpec<RuntimeRunRecord> = {
  table: "runs",
  async fields(row, access) {
    requireSame(row.run.thread_id, access.scope.threadId)
    requireSame(row.metadata.generation, access.scope.generation)
    await access.reference("runs", row.metadata.previousRunId ?? null)
    await access.reference("runs", row.metadata.turnId)
    await access.reference("checkpoints", row.preRunCheckpointId)
    if (row.result?.run) {
      requireSame(row.result.run.run_id, row.run.run_id)
      requireSame(row.result.run.thread_id, access.scope.threadId)
    }
    return {
      id: row.run.run_id,
      ownerRunId: row.run.run_id,
      namespace: row.namespace,
      turnId: row.metadata.turnId,
      previousRunId: row.metadata.previousRunId ?? null,
      preRunCheckpointId: row.preRunCheckpointId,
      status: row.run.status,
    }
  },
  async afterPut(row, access) {
    await access.query(
      "INSERT INTO run_identities(id,thread_id,generation) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
      [row.run.run_id, access.scope.threadId, access.scope.generation],
    )
  },
}
