import type { RuntimeInboxRecord } from "@b4run/sdk/agent-protocol"
import type { RecordSpec } from "./transaction.js"
export const inboxSpec: RecordSpec<RuntimeInboxRecord> = {
  table: "inbox",
  fields(row, access) {
    access.reference("runs", row.runId)
    return { id: row.entryId, ownerRunId: row.runId, namespace: row.namespace, status: row.status }
  },
}
