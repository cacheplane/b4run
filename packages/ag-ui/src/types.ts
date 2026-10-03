/** Run identity the consumer supplies; never synthesized by the mapper. */
export interface RunContext {
  readonly threadId: string
  readonly runId: string
}

/**
 * Structural B4.run agent stream shape consumed by the canonical AG-UI mapper.
 * The final member permits capability-contributed chunks without coupling this
 * package to B4.run core.
 */
export type B4AgentStreamChunk =
  | {
      readonly type: "token"
      readonly data: string
      /** Source model invocation identity; omitted by legacy producers. */
      readonly messageId?: string
    }
  | {
      readonly type: "reasoning"
      readonly data: string
      /** Source model invocation identity; shared with that invocation's tokens. */
      readonly messageId?: string
    }
  | { readonly type: "message_end"; readonly data: { readonly messageId: string } }
  | { readonly type: "tool_call"; readonly data: B4ToolCallData }
  | { readonly type: "tool_call_args"; readonly data: B4ToolCallArgsData }
  | { readonly type: "tool_result"; readonly data: B4ToolResultData }
  | { readonly type: "usage"; readonly data: B4UsageData }
  | { readonly type: "interrupt"; readonly data: unknown }
  | { readonly type: "done"; readonly data?: unknown }
  | { readonly type: string; readonly data?: unknown }

export interface B4ToolCallData {
  readonly id?: string | undefined
  readonly name: string
  readonly input: unknown
}

/**
 * One fragment of a tool call's arguments, streamed ahead of its `tool_call`
 * announce for display only. The announce still carries the complete input.
 */
export interface B4ToolCallArgsData {
  readonly id: string
  readonly name: string
  readonly delta: string
}

export interface B4ToolResultData {
  readonly id?: string | undefined
  readonly name: string
  readonly output: unknown
}

/**
 * One finished model call's token accounting, as the langchain adapter reports
 * it: the provider's own LangChain `usage_metadata` plus optional labels. The
 * mapper applies the protocol's rules; this package never invents a count.
 */
export interface B4UsageData {
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly usage_metadata: Readonly<Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Validates and narrows a `tool_call` chunk's `data`. Returns null if malformed. */
export function asToolCallData(data: unknown): B4ToolCallData | null {
  if (!isRecord(data) || typeof data.name !== "string") return null
  return {
    id: typeof data.id === "string" ? data.id : undefined,
    name: data.name,
    input: data.input,
  }
}

/** Validates and narrows a `tool_call_args` chunk's `data`. Returns null if malformed. */
export function asToolCallArgsData(data: unknown): B4ToolCallArgsData | null {
  if (!isRecord(data)) return null
  if (typeof data.id !== "string" || data.id === "") return null
  if (typeof data.name !== "string" || typeof data.delta !== "string") return null
  return { id: data.id, name: data.name, delta: data.delta }
}

/** Validates and narrows a `tool_result` chunk's `data`. Returns null if malformed. */
export function asToolResultData(data: unknown): B4ToolResultData | null {
  if (!isRecord(data) || typeof data.name !== "string") return null
  return {
    id: typeof data.id === "string" ? data.id : undefined,
    name: data.name,
    output: data.output,
  }
}

/** Validates and narrows a `usage` chunk's `data`. Returns null if malformed. */
export function asUsageData(data: unknown): B4UsageData | null {
  if (!isRecord(data) || !isRecord(data.usage_metadata)) return null
  return {
    ...(typeof data.provider === "string" && data.provider !== ""
      ? { provider: data.provider }
      : {}),
    ...(typeof data.model === "string" && data.model !== "" ? { model: data.model } : {}),
    usage_metadata: data.usage_metadata,
  }
}
