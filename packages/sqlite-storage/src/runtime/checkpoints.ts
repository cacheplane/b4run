import type { RuntimeCheckpointRecord } from "@b4run/sdk/agent-protocol"
import { type RecordSpec, requireSame } from "./transaction.js"
export const checkpointSpec: RecordSpec<RuntimeCheckpointRecord> = {
  table: "checkpoints",
  fields(row, access) {
    access.reference("runs", row.ownerRunId)
    access.reference("checkpoints", row.parentCheckpointId)
    for (const lineage of row.lineage) {
      requireSame(lineage.threadId, access.scope.threadId)
      requireSame(lineage.generation, access.scope.generation)
      access.reference("checkpoints", lineage.checkpointId)
      access.reference("runs", lineage.runId)
    }
    return {
      id: row.state.checkpoint.checkpoint_id,
      ownerRunId: row.ownerRunId,
      namespace: row.namespace,
      parentCheckpointId: row.parentCheckpointId,
    }
  },
  afterPut(row, access) {
    const { db, scope } = access
    const id = row.state.checkpoint.checkpoint_id
    db.prepare("INSERT INTO checkpoint_identities VALUES (?,?,?) ON CONFLICT(id) DO NOTHING").run(
      id,
      scope.threadId,
      scope.generation,
    )
    db.prepare(
      "DELETE FROM checkpoint_lineage WHERE thread_id=? AND generation=? AND checkpoint_id=?",
    ).run(scope.threadId, scope.generation, id)
    for (const [position, lineage] of row.lineage.entries())
      db.prepare("INSERT INTO checkpoint_lineage VALUES (?,?,?,?,?,?,?,?,?,?)").run(
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
      )
  },
}
