import type { ThreadStateForTurns } from "../../src/view/turns-from-state.ts"

/** Builders for decoded checkpoint histories, shared by the from-state suites. */
export const T0 = Date.parse("2026-10-05T00:00:00.000Z")
export const iso = (s: number) => new Date(T0 + s * 1000).toISOString()
export const env = (cls: string, kwargs: Record<string, unknown>) => ({
  lc: 1,
  type: "constructor",
  id: ["langchain_core", "messages", cls],
  kwargs,
})
export const human = (id: string, content: string) => env("HumanMessage", { id, content })
export const ai = (id: string, content: unknown, tool_calls: unknown[] = []) =>
  env("AIMessageChunk", { id, content, tool_calls, additional_kwargs: {} })
export const toolMsg = (
  tool_call_id: string,
  name: string,
  content: string,
  step: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  status?: string,
) =>
  env("ToolMessage", {
    tool_call_id,
    name,
    content,
    ...(status ? { status } : {}),
    additional_kwargs: { b4_step: step, ...extra },
  })
export const ckpt = (
  id: string,
  s: number,
  messages: unknown[],
  extra: { todos?: unknown; metadata?: Record<string, unknown> } = {},
) => ({
  id,
  ts: iso(s),
  metadata: { source: "loop", step: 0, parents: {}, ...(extra.metadata ?? {}) },
  values: { messages, ...(extra.todos ? { todos: extra.todos } : {}) },
})
export const base = (
  root: ReturnType<typeof ckpt>[],
  children: Record<string, ReturnType<typeof ckpt>[]> = {},
  pending: unknown[] = [],
  status: ThreadStateForTurns["status"] = "idle",
): ThreadStateForTurns => ({
  threadId: "t-1",
  status,
  root,
  children,
  pendingInterrupts: pending as never,
})
