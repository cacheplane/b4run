import type { AssistantMessage, Message, ToolCall } from "@ag-ui/core"
import { isSubagentMessage } from "../../view/messages.js"

const toolOnly = (m: Message): m is AssistantMessage & { toolCalls: ToolCall[] } =>
  m.role === "assistant" &&
  (m.content === undefined ||
    m.content === "" ||
    (Array.isArray(m.content) && m.content.length === 0)) &&
  Array.isArray(m.toolCalls)

/**
 * `messageView.transformMessages` for `<CopilotChat>`: one tool-only assistant
 * row per turn (the row `TurnActivity` renders on), carrying the union of every
 * tool-only row's `toolCalls` in that turn, in order; tool results and prose
 * kept; subagent messages dropped (their text lives inside the nested turn).
 * A turn is the run of messages after each `user` message. Returns the input
 * array when nothing changes.
 */
export function mergeTurnMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  let row: number | undefined
  let changed = false
  for (const message of messages) {
    if (isSubagentMessage(message)) {
      changed = true
      continue
    }
    if (message.role === "user") row = undefined
    if (toolOnly(message)) {
      if (row !== undefined) {
        const kept = out[row] as AssistantMessage & { toolCalls: ToolCall[] }
        const seen = new Set(kept.toolCalls.map((c) => c.id))
        const added = message.toolCalls.filter((c) => !seen.has(c.id))
        if (added.length > 0) out[row] = { ...kept, toolCalls: [...kept.toolCalls, ...added] }
        changed = true
        continue
      }
      row = out.length
    }
    out.push(message)
  }
  return changed ? out : messages
}
