import type { RuntimeCheckpointRecord } from "@b4run/sdk/agent-protocol"
import { type RecordSpec, requireSame } from "./transaction.js"
export const checkpointSpec: RecordSpec<RuntimeCheckpointRecord> = {
  table: "checkpoints",
  async fields(row, access) {
    await access.reference("runs", row.ownerRunId)
    await access.reference("checkpoints", row.parentCheckpointId)
    for (const lineage of row.lineage) {
      requireSame(lineage.threadId, access.scope.threadId)
      requireSame(lineage.generation, access.scope.generation)
      await access.reference("checkpoints", lineage.checkpointId)
      await access.reference("runs", lineage.runId)
    }
    return {
      id: row.state.checkpoint.checkpoint_id,
      ownerRunId: row.ownerRunId,
      namespace: row.namespace,
      parentCheckpointId: row.parentCheckpointId,
    }
  },
  async afterPut(row, access) {
    const { scope } = access
    const id = row.state.checkpoint.checkpoint_id
    await access.query(
      "INSERT INTO checkpoint_identities(id,thread_id,generation) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
      [id, scope.threadId, scope.generation],
    )
    await access.query(
      "DELETE FROM checkpoint_lineage WHERE thread_id=? AND generation=? AND checkpoint_id=?",
      [scope.threadId, scope.generation, id],
    )
    for (const [position, lineage] of row.lineage.entries())
      await access.query(
        "INSERT INTO checkpoint_lineage(thread_id,generation,checkpoint_id,position,ancestor_thread_id,ancestor_generation,ancestor_checkpoint_id,ancestor_run_id,namespace,protected_metadata) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
          scope.threadId,
          scope.generation,
          id,
          position,
          lineage.threadId,
          lineage.generation,
          lineage.checkpointId,
          lineage.runId,
          JSON.stringify(lineage.namespace),
          JSON.stringify(lineage.protectedMetadata),
        ],
      )
  },
}
