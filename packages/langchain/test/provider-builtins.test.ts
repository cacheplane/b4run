import { AIMessage } from "@langchain/core/messages"
import { MemorySaver } from "@langchain/langgraph"
import { expect, test } from "vitest"
import { type AgentStreamChunk, streamAgent } from "../src/agent-adapter.ts"
import { answerDanglingToolCalls } from "../src/agent-middleware.ts"
import { createChatModel } from "../src/chat-model-factory.ts"
import { persistProviderMessage } from "../src/provider-message.ts"

function event(kind: string, chunk: unknown, run_id = "owner") {
  return {
    event: `on_chat_model_${kind}`,
    run_id,
    name: "model",
    data: { [kind === "end" ? "output" : "chunk"]: chunk },
  }
}

function stream(events: unknown[]) {
  return streamAgent({
    entry: {
      invoke: async () => ({}),
      async *streamEvents() {
        yield* events
      },
    },
    checkpointer: new MemorySaver(),
    input: {},
    tools: [],
    routeParamNames: [],
    signal: new AbortController().signal,
  })
}

async function collect(events: unknown[]) {
  const chunks: AgentStreamChunk[] = []
  for await (const chunk of stream(events)) chunks.push(chunk)
  return chunks
}

const progress = {
  id: "native-message",
  content: "",
  response_metadata: {
    tool_outputs: { id: "search", type: "web_search_call", status: "in_progress" },
  },
}
const failed = {
  id: "native-message",
  content: "",
  additional_kwargs: {
    tool_outputs: [
      {
        id: "search",
        type: "web_search_call",
        status: "failed",
        error: { message: "Unavailable" },
      },
    ],
  },
}

test("announces native provider identity before consuming the next model chunk", async () => {
  let advanced = false
  const iterator = streamAgent({
    entry: {
      invoke: async () => ({}),
      async *streamEvents() {
        yield event("stream", progress)
        advanced = true
        yield event("end", failed)
      },
    },
    checkpointer: new MemorySaver(),
    input: {},
    tools: [],
    routeParamNames: [],
    signal: new AbortController().signal,
  })

  const step = await iterator.next()
  const start = await iterator.next()
  await iterator.return(undefined)

  expect(advanced).toBe(false)
  expect(step.value).toMatchObject({
    type: "step",
    data: { toolCallId: "search", kind: "provider", status: "running" },
  })
  expect(start.value).toEqual({
    type: "tool_call_args",
    data: { id: "search", name: "web_search", delta: "", messageId: "owner" },
  })
})

test("reconciles native failure once and keeps same-name application calls", async () => {
  const chunks = await collect([
    event("stream", {
      ...progress,
      tool_call_chunks: [
        { id: "search", name: "web_search", index: 0, args: "" },
        { id: "app", name: "web_search", index: 1, args: '{"query":"app"}' },
      ],
    }),
    event("stream", failed),
    event("end", {
      ...failed,
      tool_calls: [
        { id: "search", name: "web_search", args: {} },
        { id: "app", name: "web_search", args: { query: "app" } },
      ],
    }),
  ])

  expect(chunks.filter((chunk) => chunk.type === "tool_result")).toEqual([
    {
      type: "tool_result",
      data: {
        id: "search",
        name: "web_search",
        output: "Unavailable",
        step: expect.objectContaining({
          kind: "provider",
          status: "failed",
          error: { message: "Unavailable", code: "failed" },
        }),
      },
    },
  ])
  expect(chunks.filter((chunk) => chunk.type === "tool_call")).toHaveLength(2)
  expect(
    chunks.filter(
      (chunk) => chunk.type === "tool_call_args" && (chunk.data as { id: string }).id === "search",
    ),
  ).toHaveLength(1)
})

test("retains Anthropic input fragments by native block index without leaking them as app calls", async () => {
  const chunks = await collect([
    event("stream", {
      id: "anthropic",
      content: [{ type: "server_tool_use", id: "native", name: "web_search", input: {}, index: 2 }],
      tool_call_chunks: [{ id: "native", name: "web_search", index: 2, args: "" }],
    }),
    event("stream", {
      content: [{ type: "input_json_delta", index: 2, partial_json: '{"query":' }],
      tool_call_chunks: [{ index: 2, args: '{"query":' }],
    }),
    event("stream", {
      content: [{ type: "input_json_delta", index: 2, partial_json: '"hello"}' }],
      tool_call_chunks: [{ index: 2, args: '"hello"}' }],
    }),
    event("end", { id: "anthropic", content: "" }),
  ])

  expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([
    {
      type: "tool_call",
      data: { id: "native", name: "web_search", input: { query: "hello" }, messageId: "owner" },
    },
  ])
  expect(chunks.filter((chunk) => chunk.type === "tool_result")).toEqual([])
  expect(
    chunks
      .filter((chunk) => chunk.type === "tool_call_args")
      .map((chunk) => (chunk.data as { delta: string }).delta)
      .join(""),
  ).toBe('{"query":"hello"}')
})

test("emits call-less Google annotations with canonical identities before message end", async () => {
  const chunks = await collect([
    event("stream", { id: "google-native", content: "" }),
    event("end", {
      id: "google-native",
      content: "",
      response_metadata: {
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://example.com", title: "Source" } }],
          searchEntryPoint: { renderedContent: "<p>Google</p>" },
        },
      },
    }),
  ])

  expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([])
  expect(chunks.map((chunk) => chunk.type)).toEqual(["message_annotations", "message_end", "done"])
  expect(chunks[0]).toMatchObject({
    data: { messageId: "owner", answer: { sources: [{ id: "google-native:source:0" }] } },
  })
})

test("persists normalized metadata immutably while preserving native replay fields", () => {
  const usage: Record<string, unknown> = {
    usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
  }
  const message = new AIMessage({
    ...failed,
    ...usage,
    response_metadata: { retained: true },
    tool_calls: [
      { id: "search", name: "web_search", args: {} },
      { id: "app", name: "web_search", args: { query: "app" } },
    ],
  })
  const before = JSON.stringify(message)

  const result = persistProviderMessage(message)

  expect(JSON.stringify(message)).toBe(before)
  expect(result).not.toBe(message)
  expect(result.toDict().data).not.toHaveProperty("lc_kwargs")
  expect(result.toDict().data).not.toHaveProperty("lc_serializable")
  expect(result.additional_kwargs.b4_steps).toMatchObject({
    search: { kind: "provider", status: "failed" },
  })
  expect(result.additional_kwargs.tool_outputs).toEqual(message.additional_kwargs.tool_outputs)
  expect(result.response_metadata).toEqual(message.response_metadata)
  expect(result.usage_metadata).toEqual(message.usage_metadata)
  expect(result.tool_calls?.map((call) => call.id)).toEqual(["app"])
})

test.each([
  ["openai", "ChatOpenAI", "gpt-5-mini"],
  ["anthropic", "ChatAnthropic", "claude-sonnet-4-6"],
  ["google", "ChatGoogleGenerativeAI", "gemini-2.5-flash"],
  ["mistral", "ChatMistralAI", "mistral-large-latest"],
  ["groq", "ChatGroq", "llama-3.3-70b-versatile"],
  ["ollama", "ChatOllama", "llama3.2"],
  ["xai", "ChatXAI", "grok-4"],
  ["openrouter", "ChatOpenRouter", "openai/gpt-5-mini"],
] as const)(
  "pins %s model construction to native v0 messages",
  async (provider, exportName, modelId) => {
    class Model {
      constructor(readonly options: unknown) {}
    }

    const model = await createChatModel({
      provider,
      model: modelId,
      importer: async () => ({ [exportName]: Model }),
    })

    expect((model as Model).options).toMatchObject({ outputVersion: "v0" })
  },
)

test("provider arguments remain complete when native objects grow and JSON deltas contain whitespace", async () => {
  const chunks = await collect([
    event("stream", {
      ...progress,
      response_metadata: {
        tool_outputs: { ...progress.response_metadata.tool_outputs, action: { type: "search" } },
      },
    }),
    event("end", {
      id: "native-message",
      content: "",
      additional_kwargs: {
        tool_outputs: [
          {
            id: "search",
            type: "web_search_call",
            status: "completed",
            action: { type: "search", query: "weather" },
          },
        ],
      },
    }),
    event(
      "stream",
      {
        id: "anthropic",
        content: [
          { type: "server_tool_use", id: "native", name: "web_search", input: {}, index: 2 },
        ],
      },
      "other",
    ),
    event(
      "stream",
      { content: [{ type: "input_json_delta", index: 2, input: '{ "query" : ' }] },
      "other",
    ),
    event(
      "stream",
      { content: [{ type: "input_json_delta", index: 2, input: '"hello" }' }] },
      "other",
    ),
    event("end", { id: "anthropic", content: "" }, "other"),
  ])

  const args = (id: string) =>
    chunks
      .filter(
        (chunk) => chunk.type === "tool_call_args" && (chunk.data as { id: string }).id === id,
      )
      .map((chunk) => (chunk.data as { delta: string }).delta)
      .join("")

  expect(JSON.parse(args("search"))).toEqual({ type: "search", query: "weather" })
  expect(JSON.parse(args("native"))).toEqual({ query: "hello" })
})

test("interleaved model owners isolate native indices, call status, and Google derived identities", async () => {
  const chunks = await collect([
    event("stream", { id: "g1", content: [{ executableCode: { code: "1+1" } }] }, "one"),
    event("stream", { id: "g2", content: [{ executableCode: { code: "2+2" } }] }, "two"),
    event(
      "stream",
      { content: [{ codeExecutionResult: { outcome: "OUTCOME_OK", output: "4" } }] },
      "two",
    ),
    event("end", { id: "g1", content: "" }, "one"),
    event("end", { id: "g2", content: "" }, "two"),
  ])

  expect(
    chunks.filter((chunk) => chunk.type === "tool_call").map((chunk) => chunk.data),
  ).toMatchObject([
    { id: "g2:code:0", messageId: "two" },
    { id: "g1:code:0", messageId: "one" },
  ])
  expect(chunks.filter((chunk) => chunk.type === "tool_result")).toMatchObject([
    { data: { id: "g2:code:0", output: "4" } },
  ])
  expect(
    chunks
      .filter(
        (chunk) =>
          chunk.type === "step" &&
          (chunk.data as { toolCallId: string }).toolCallId === "g1:code:0",
      )
      .every((chunk) => (chunk.data as { status: string }).status === "running"),
  ).toBe(true)
})

test.each(["error", "cancel"])("%s leaves a native invocation unsettled", async (reason) => {
  const controller = new AbortController()
  const chunks: AgentStreamChunk[] = []
  const entry = {
    invoke: async () => ({}),
    async *streamEvents() {
      yield event("stream", progress)
      if (reason === "cancel") controller.abort()
      throw new Error(reason)
    },
  }
  let failure: unknown

  try {
    for await (const chunk of streamAgent({
      entry,
      checkpointer: new MemorySaver(),
      input: {},
      tools: [],
      routeParamNames: [],
      signal: controller.signal,
    }))
      chunks.push(chunk)
  } catch (error) {
    failure = error
  }

  expect(failure).toBeInstanceOf(Error)
  expect(chunks.filter((chunk) => chunk.type === "tool_result")).toEqual([])
  expect(chunks.find((chunk) => chunk.type === "step")).toMatchObject({
    data: { status: "running" },
  })
})

test("canonical stamping retains other stored steps and gives call-less native messages stable source ownership", () => {
  const message = new AIMessage({
    content: "",
    additional_kwargs: {
      b4_steps: { app: { v: 1, kind: "server", status: "completed", label: "App" } },
    },
    response_metadata: {
      groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com" } }] },
    },
  })

  const persisted = persistProviderMessage(message)
  const restored = persistProviderMessage(persisted)

  expect(persisted.id).toBeTypeOf("string")
  expect(persisted.additional_kwargs.b4_steps).toEqual(message.additional_kwargs.b4_steps)
  expect(
    (persisted.additional_kwargs.b4_answer as { sources: { id: string }[] }).sources[0]?.id,
  ).toBe(`${persisted.id}:source:0`)
  expect(restored.additional_kwargs).toEqual(persisted.additional_kwargs)
})

test("subagent native frames retain call ownership while a root invocation remains running", async () => {
  const metadata = {
    b4: {
      subagent_stack: [{ callId: "child", name: "researcher", routeId: "/research#researcher" }],
    },
  }

  const chunks = await collect([
    event("stream", progress),
    { ...event("stream", progress, "child-model"), metadata },
    { ...event("end", failed, "child-model"), metadata },
    event("end", progress),
  ])

  expect(chunks.filter((chunk) => chunk.type === "tool_result")).toEqual([])
  expect(chunks.find((chunk) => chunk.type === "subagent.tool_result")).toMatchObject({
    data: {
      id: "search",
      call_id: "child",
      subagent: "researcher",
      step: { kind: "provider", status: "failed" },
    },
  })
  expect(chunks.find((chunk) => chunk.type === "subagent.step")).toMatchObject({
    data: { toolCallId: "search", call_id: "child", kind: "provider" },
  })
})

test("OpenAI completed progress waits for the full terminal output item before ending arguments", async () => {
  const completedProgress = {
    ...progress,
    response_metadata: {
      tool_outputs: { id: "search", type: "web_search_call", status: "completed" },
    },
  }
  const terminal = {
    id: "native-message",
    content: "",
    additional_kwargs: {
      tool_outputs: [
        {
          id: "search",
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "weather" },
        },
      ],
    },
  }

  const chunks = await collect([
    event("stream", progress),
    event("stream", completedProgress),
    event("stream", terminal),
    event("end", terminal),
  ])

  const args = chunks
    .filter((chunk) => chunk.type === "tool_call_args")
    .map((chunk) => (chunk.data as { delta: string }).delta)
    .join("")
  expect(JSON.parse(args)).toEqual({ type: "search", query: "weather" })
  expect(chunks.filter((chunk) => chunk.type === "tool_call")).toMatchObject([
    { data: { input: { type: "search", query: "weather" } } },
  ])
  expect(chunks.filter((chunk) => chunk.type === "tool_result")).toHaveLength(1)
})

test("dangling-call repair excludes native provider ids while retaining same-name app calls", () => {
  const native = new AIMessage({
    ...failed,
    tool_calls: [
      { id: "search", name: "web_search", args: {} },
      { id: "app", name: "web_search", args: {} },
    ],
  })

  const repaired = answerDanglingToolCalls([native])

  expect(repaired).toHaveLength(2)
  expect(repaired[1]).toMatchObject({ tool_call_id: "app", status: "error" })
})
