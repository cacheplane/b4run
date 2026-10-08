import type { AssistantMessage, Message, ToolCall } from "@ag-ui/core"
import { isSubagentMessage } from "../../view/messages.js"

type CallingMessage = AssistantMessage & { toolCalls: ToolCall[] }

const calling = (m: Message): m is CallingMessage =>
  m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length > 0

const toolOnly = (m: CallingMessage): boolean =>
  m.content === undefined ||
  m.content === "" ||
  (Array.isArray(m.content) && m.content.length === 0)

/**
 * `messageView.transformMessages` for `<CopilotChat>`: one activity row per
 * turn — the turn's first assistant message that carries tool calls, which
 * `TurnActivity` renders on — holding the union of every tool call in that
 * turn, in order. B4.run files each call under the model message that
 * announced it (`parentMessageId`), so a row may carry the model's text too:
 * a later message's text is kept without its calls, a later tool-only
 * message is dropped. Tool results and prose are kept; subagent messages are
 * dropped (their text lives inside the nested turn). A turn is the run of
 * messages after each `user` message. Returns the input array when nothing
 * changes.
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
    if (calling(message)) {
      if (row !== undefined) {
        const kept = out[row] as CallingMessage
        const seen = new Set(kept.toolCalls.map((c) => c.id))
        const added = message.toolCalls.filter((c) => !seen.has(c.id))
        if (added.length > 0) out[row] = { ...kept, toolCalls: [...kept.toolCalls, ...added] }
        changed = true
        if (!toolOnly(message)) {
          const { toolCalls: _moved, ...text } = message
          out.push(text)
        }
        continue
      }
      row = out.length
    }
    out.push(message)
  }
  return changed ? out : messages
}
