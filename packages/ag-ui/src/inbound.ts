import type { Message, RunAgentInput } from "@ag-ui/core"
import { type B4MessageContent, isContentPart } from "@b4run/sdk"
import { type B4ResumeRequest, fromAguiResume } from "./interrupts.js"

export interface B4Message {
  readonly role: "user" | "assistant" | "system" | "developer" | "tool"
  /** Plain text, or the ordered content parts the client sent (AG-UI 1.0). */
  readonly content: B4MessageContent
  readonly id?: string
  readonly toolCallId?: string
}

export interface B4RunInput {
  readonly messages: B4Message[]
  readonly resume?: B4ResumeRequest[]
  /** The untouched AG-UI input, so a consumer can reach tools/state/context. */
  readonly raw: RunAgentInput
}

type AguiToolMessage = Extract<Message, { role: "tool" }>

/**
 * A message's content. 1.0 content is `string | ContentPart[]`; a string is
 * kept as is and a part list is kept as parts — the runtime decides what the
 * model can take (`toLangChainContent`), so nothing is flattened here.
 * Entries that are not valid parts are dropped, so an unvalidated list cannot
 * throw downstream; a list with nothing left is empty text. Any other shape
 * becomes its JSON, as before. Media parts are carried through; the runtime
 * drops what the route's model cannot take and announces it.
 */
function coerceMessageContent(content: unknown): B4MessageContent {
  if (typeof content === "string") return content
  if (content === undefined || content === null) return ""
  if (Array.isArray(content)) {
    const parts = content.filter(isContentPart)
    return parts.length === 0 ? "" : parts
  }
  try {
    const json = JSON.stringify(content)
    return typeof json === "string" ? json : String(content)
  } catch {
    return String(content)
  }
}

function toB4ToolMessage(message: AguiToolMessage, content: B4MessageContent): B4Message {
  return {
    role: "tool",
    content,
    id: message.id,
    toolCallId: message.toolCallId,
  }
}

/**
 * `null` for history that is not conversation: a `reasoning` message is the
 * client's stored artefact of an earlier turn, and an `activity` message is a
 * progress snapshot. Neither is something the assistant said, so neither is
 * replayed to the model as if it were.
 */
function toB4Message(message: Message): B4Message | null {
  switch (message.role) {
    case "tool":
      return toB4ToolMessage(message, coerceMessageContent(message.content))
    case "user":
    case "assistant":
    case "system":
    case "developer":
      return { role: message.role, content: coerceMessageContent(message.content), id: message.id }
    case "activity":
    case "reasoning":
      return null
  }
}

/**
 * Map an AG-UI `RunAgentInput` to a B4.run run input. Messages are translated
 * structurally (`reasoning`/`activity` history is dropped, not replayed as
 * assistant speech); a `resume` array becomes vocabulary-agnostic B4.run resume
 * requests (see `fromAguiResume`). `tools`/`state`/`context` are not
 * interpreted in v1 - reach them via `raw`.
 */
export function fromRunAgentInput(input: RunAgentInput): B4RunInput {
  const messages = input.messages.flatMap((message) => {
    const mapped = toB4Message(message)
    return mapped === null ? [] : [mapped]
  })
  const resume = input.resume && input.resume.length > 0 ? fromAguiResume(input.resume) : undefined
  return { messages, ...(resume ? { resume } : {}), raw: input }
}
