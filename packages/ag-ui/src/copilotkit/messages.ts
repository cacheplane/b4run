import type { Message } from "@ag-ui/core"
import { isSubagentMessage } from "../view/subagent-runs.js"

const toolOnly = (m: Message): boolean =>
  m.role === "assistant" &&
  (m.content === undefined ||
    m.content === "" ||
    (Array.isArray(m.content) && m.content.length === 0)) &&
  Array.isArray(m.toolCalls)

/**
 * `messageView.transformMessages` for `<CopilotChat>`: one tool-only assistant
 * row per turn (the row `TurnActivity` renders on), tool results and prose kept,
 * subagent messages dropped (their text lives inside the nested turn). A turn
 * is the run of messages after each `user` message. Returns the input array
 * when nothing changes.
 */
export function mergeTurnMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  let seenToolRow = false
  let changed = false
  for (const message of messages) {
    if (isSubagentMessage(message)) {
      changed = true
      continue
    }
    if (message.role === "user") seenToolRow = false
    if (toolOnly(message)) {
      if (seenToolRow) {
        changed = true
        continue
      }
      seenToolRow = true
    }
    out.push(message)
  }
  return changed ? out : messages
}
