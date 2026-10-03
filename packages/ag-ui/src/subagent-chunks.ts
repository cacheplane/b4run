import type { B4AgentStreamChunk } from "./types.js"

const IDENTITY_KEYS: ReadonlySet<string> = new Set(["call_id", "subagent", "route_id", "depth"])
/** Handled by their own paths (lifecycle, usage), never unwrapped. */
const NOT_UNWRAPPED: ReadonlySet<string> = new Set([
  "subagent.start",
  "subagent.end",
  "subagent.usage",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A child's chunk as the root chunk it mirrors, plus its owner: the `call_id`
 * that is also its AG-UI `subagentRunId`. The langchain adapter builds
 * `subagent.<type>` by spreading the identity into the root chunk's `data`
 * (a string payload moves under a `data` key beside its `messageId`), so this
 * is the exact inverse. Lifecycle chunks and `usage` return null, as does
 * anything without a `call_id`.
 */
export function unwrapSubagentChunk(
  chunk: B4AgentStreamChunk,
): { readonly owner: string; readonly chunk: B4AgentStreamChunk } | null {
  if (!chunk.type.startsWith("subagent.") || NOT_UNWRAPPED.has(chunk.type)) return null
  if (!isRecord(chunk.data)) return null
  const owner = chunk.data.call_id
  if (typeof owner !== "string" || owner === "") return null
  const inner = chunk.type.slice("subagent.".length)
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(chunk.data)) {
    if (!IDENTITY_KEYS.has(key)) rest[key] = value
  }
  if (inner === "token" || inner === "reasoning") {
    const { data, messageId } = rest
    return {
      owner,
      chunk: {
        type: inner,
        data: typeof data === "string" ? data : "",
        ...(typeof messageId === "string" ? { messageId } : {}),
      } as B4AgentStreamChunk,
    }
  }
  return { owner, chunk: { type: inner, data: rest } as B4AgentStreamChunk }
}

/** What `subagent.start` announces. */
export interface SubagentStartData {
  readonly callId: string
  readonly name: string
  readonly depth: number
  /** The call that dispatched this child's parent; absent when the parent is root. */
  readonly parentCallId?: string
  readonly description?: string
}

export function asSubagentStartData(data: unknown): SubagentStartData | null {
  if (!isRecord(data)) return null
  const { call_id, subagent, depth, parent_call_id, description } = data
  if (typeof call_id !== "string" || call_id === "") return null
  if (typeof subagent !== "string" || subagent.trim() === "") return null
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) return null
  return {
    callId: call_id,
    name: subagent,
    depth,
    ...(typeof parent_call_id === "string" && parent_call_id !== ""
      ? { parentCallId: parent_call_id }
      : {}),
    ...(typeof description === "string" && description.trim() !== "" ? { description } : {}),
  }
}

/** What `subagent.end` reports: a result, an error, or neither. */
export interface SubagentEndData {
  readonly callId: string
  readonly result?: string
  readonly error?: string
}

export function asSubagentEndData(data: unknown): SubagentEndData | null {
  if (!isRecord(data)) return null
  const { call_id, final_message, error } = data
  if (typeof call_id !== "string" || call_id === "") return null
  if (final_message !== undefined && typeof final_message !== "string") return null
  if (error !== undefined && typeof error !== "string") return null
  return {
    callId: call_id,
    ...(typeof final_message === "string" ? { result: final_message } : {}),
    ...(typeof error === "string" ? { error } : {}),
  }
}
