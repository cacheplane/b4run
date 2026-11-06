import type { RuntimeMaintenanceRecord } from "@b4run/sdk/agent-protocol"
import type { RecordSpec } from "./transaction.js"
export const maintenanceSpec: RecordSpec<RuntimeMaintenanceRecord> = {
  table: "maintenance",
  async fields(row, access) {
    await access.reference("runs", row.runId)
    return { id: row.jobId, ownerRunId: row.runId, status: row.status }
  },
}
