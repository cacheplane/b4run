import { MemorySaver } from "@langchain/langgraph"
import { expect, test } from "vitest"
import { streamAgent } from "../src/agent-adapter.ts"

const modelEvent = (event: string, run_id: string, data: Record<string, unknown>) => ({
  event,
  run_id,
  name: "model",
  data,
})
async function collect(events: ReturnType<typeof modelEvent>[]) {
  const entry = {
    invoke: async () => ({}),
    async *streamEvents() {
      yield* events
    },
  }
  const chunks = []
  for await (const chunk of streamAgent({
    entry,
    checkpointer: new MemorySaver(),
    input: {},
    tools: [],
    routeParamNames: [],
    signal: new AbortController().signal,
  }))
    chunks.push(chunk)
  return chunks
}

test("model tokens carry invocation identity and completion precedes tool calls", async () => {
  const chunks = await collect([
    modelEvent("on_chat_model_stream", "a", { chunk: { content: "first" } }),
    modelEvent("on_chat_model_stream", "b", { chunk: { content: "second" } }),
    modelEvent("on_chat_model_end", "a", {
      output: { tool_calls: [{ id: "call", name: "lookup", args: {} }] },
    }),
    modelEvent("on_chat_model_end", "b", { output: {} }),
  ])

  expect(chunks).toEqual([
    { type: "token", messageId: "a", data: "first" },
    { type: "token", messageId: "b", data: "second" },
    { type: "message_end", data: { messageId: "a" } },
    { type: "tool_call", data: { id: "call", name: "lookup", input: {} } },
    { type: "message_end", data: { messageId: "b" } },
    { type: "done", data: undefined },
  ])
})

test("empty models and duplicate completions add no lifecycle events", async () => {
  const chunks = await collect([
    modelEvent("on_chat_model_stream", "empty", { chunk: { content: "" } }),
    modelEvent("on_chat_model_end", "empty", { output: {} }),
    modelEvent("on_chat_model_stream", "text", { chunk: { content: "hello" } }),
    modelEvent("on_chat_model_end", "text", { output: {} }),
    modelEvent("on_chat_model_end", "text", { output: {} }),
  ])

  expect(chunks).toEqual([
    { type: "token", messageId: "text", data: "hello" },
    { type: "message_end", data: { messageId: "text" } },
    { type: "done", data: undefined },
  ])
})
