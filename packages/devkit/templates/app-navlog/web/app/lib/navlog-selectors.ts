import type { Navlog } from "./navlog-types"

/** The subset of an AG-UI message this selector reads. */
export interface MessageLike {
  readonly id: string
  readonly role: string
  readonly content?: unknown
  readonly toolCallId?: string
  readonly toolCalls?: readonly {
    readonly id: string
    readonly function: { readonly name: string }
  }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Parse a `computeNavlog` tool result (JSON text, or a `{ result }` envelope) into a Navlog, or null. */
export function parseNavlog(text: string): Navlog | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const candidate =
    isRecord(parsed) && "result" in parsed && isRecord(parsed.result) ? parsed.result : parsed
  if (!isRecord(candidate)) return null
  if (
    !Array.isArray(candidate.legs) ||
    !Array.isArray(candidate.waypoints) ||
    !isRecord(candidate.totals) ||
    !isRecord(candidate.flightPlan)
  ) {
    return null
  }
  return candidate as unknown as Navlog
}

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("")
  }
  return ""
}

/** The latest assistant prose in the thread, for the sheet's brief. */
export function lastAssistantText(messages: readonly MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "assistant") continue
    const text = contentText(message.content).trim()
    if (text.length > 0) return text
  }
  return ""
}

/**
 * The text of the most recent `computeNavlog` result that holds a navlog, or
 * null. A string on purpose: the shell memoizes the parse on it, so the map
 * sees one `Navlog` object per computation rather than a new one per streamed
 * token (each new object would refit the map).
 */
export function latestNavlogText(messages: readonly MessageLike[]): string | null {
  const callIds = new Set<string>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.function.name === "computeNavlog") callIds.add(call.id)
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "tool" || message.toolCallId === undefined) continue
    if (!callIds.has(message.toolCallId)) continue
    const text = contentText(message.content)
    // A failed call's error text is skipped, so the last good plan stays up.
    if (parseNavlog(text)) return text
  }
  return null
}

/** The most recent `computeNavlog` result in the thread, or null. */
export function latestNavlog(messages: readonly MessageLike[]): Navlog | null {
  const text = latestNavlogText(messages)
  return text === null ? null : parseNavlog(text)
}
