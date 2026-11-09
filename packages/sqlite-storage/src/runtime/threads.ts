import type { RuntimeThreadRecord, RuntimeTransaction } from "@b4run/sdk/agent-protocol"
import { type Access, requireSame } from "./transaction.js"
export function makeThread(access: Access): RuntimeTransaction["thread"] {
  const { db, scope } = access
  return {
    async get() {
      access.check()
      const row = db
        .prepare("SELECT payload FROM threads WHERE thread_id=? AND generation=?")
        .get(scope.threadId, scope.generation)
      return row ? (JSON.parse(String(row.payload)) as RuntimeThreadRecord) : undefined
    },
    async put(row) {
      access.check()
      requireSame(row.thread.thread_id, scope.threadId)
      requireSame(row.generation, scope.generation)
      if (!Number.isSafeInteger(row.revision) || row.revision < 0)
        throw new Error("Invalid runtime revision")
      access.reference("runs", row.currentRunId)
      access.reference("checkpoints", row.headCheckpointId)
      db.prepare(
        "INSERT INTO threads VALUES (?,?,?,?,?,?,?) ON CONFLICT(thread_id,generation) DO UPDATE SET revision=excluded.revision,head_checkpoint_id=excluded.head_checkpoint_id,current_run_id=excluded.current_run_id,paused_generation=excluded.paused_generation,payload=excluded.payload",
      ).run(
        scope.threadId,
        scope.generation,
        row.revision,
        row.headCheckpointId,
        row.currentRunId,
        row.pausedGeneration,
        JSON.stringify(row),
      )
    },
  }
}
