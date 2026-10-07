import type { Message } from "@ag-ui/core"

/** Narrow a transcript message to one a subagent produced. */
export function isSubagentMessage(
  message: Message,
): message is Message & { subagentRunId: string } {
  return typeof (message as { subagentRunId?: unknown }).subagentRunId === "string"
}
