import type { RuntimeThreadRecord, RuntimeTransaction } from "@b4run/sdk/agent-protocol"
import { type Access, requireSame } from "./transaction.js"
export function makeThread(access: Access): RuntimeTransaction["thread"] {
  const { scope } = access
  return {
    async get() {
      const result = await access.query<{ payload: string }>(
        "SELECT payload FROM threads WHERE thread_id=? AND generation=?",
        [scope.threadId, scope.generation],
      )
      return result.rows[0]
        ? (JSON.parse(result.rows[0].payload) as RuntimeThreadRecord)
        : undefined
    },
    async put(row) {
      access.check()
      requireSame(row.thread.thread_id, scope.threadId)
      requireSame(row.generation, scope.generation)
      if (!Number.isSafeInteger(row.revision) || row.revision < 0)
        throw new Error("Invalid runtime revision")
      await access.reference("runs", row.currentRunId)
      await access.reference("checkpoints", row.headCheckpointId)
      await access.query(
        "INSERT INTO threads(thread_id,generation,revision,head_checkpoint_id,current_run_id,paused_generation,payload) VALUES (?,?,?,?,?,?,?) ON CONFLICT(thread_id,generation) DO UPDATE SET revision=excluded.revision,head_checkpoint_id=excluded.head_checkpoint_id,current_run_id=excluded.current_run_id,paused_generation=excluded.paused_generation,payload=excluded.payload",
        [
          scope.threadId,
          scope.generation,
          row.revision,
          row.headCheckpointId,
          row.currentRunId,
          row.pausedGeneration,
          JSON.stringify(row),
        ],
      )
    },
  }
}
