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
  | { readonly type: "token"; readonly data: string }
  | { readonly type: "tool_call"; readonly data: B4ToolCallData }
  | { readonly type: "tool_result"; readonly data: B4ToolResultData }
  | { readonly type: "interrupt"; readonly data: unknown }
  | { readonly type: "done"; readonly data?: unknown }
  | { readonly type: string; readonly data?: unknown }

export interface B4ToolCallData {
  readonly id?: string | undefined
  readonly name: string
  readonly input: unknown
}

export interface B4ToolResultData {
  readonly id?: string | undefined
  readonly name: string
  readonly output: unknown
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

/** Validates and narrows a `tool_result` chunk's `data`. Returns null if malformed. */
export function asToolResultData(data: unknown): B4ToolResultData | null {
  if (!isRecord(data) || typeof data.name !== "string") return null
  return {
    id: typeof data.id === "string" ? data.id : undefined,
    name: data.name,
    output: data.output,
  }
}
