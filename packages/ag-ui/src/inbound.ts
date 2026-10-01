import { contentToText, type Message, type RunAgentInput } from "@ag-ui/core"
import { type B4ResumeRequest, fromAguiResume } from "./interrupts.js"

export interface B4Message {
  readonly role: "user" | "assistant" | "system" | "developer" | "tool"
  readonly content: string
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
 * A message's text. 1.0 content is `string | ContentPart[]`; the text parts
 * concatenate in order via the SDK's own helper. Media parts never reach here:
 * the runtime refuses them at the envelope stage (`multimodal_not_supported`)
 * until it can carry them to the model.
 */
function coerceContent(content: unknown): string {
  if (typeof content === "string") return content
  if (content === undefined || content === null) return ""
  if (Array.isArray(content)) return contentToText(content as Parameters<typeof contentToText>[0])
  try {
    const json = JSON.stringify(content)
    return typeof json === "string" ? json : String(content)
  } catch {
    return String(content)
  }
}

function toB4ToolMessage(message: AguiToolMessage, content: string): B4Message {
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
      return toB4ToolMessage(message, coerceContent(message.content))
    case "user":
    case "assistant":
    case "system":
    case "developer":
      return { role: message.role, content: coerceContent(message.content), id: message.id }
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
