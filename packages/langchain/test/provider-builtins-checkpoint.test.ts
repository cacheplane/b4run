import { normalizeProviderMessage } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, type BaseMessage, HumanMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { expect, test } from "vitest"
import { type AgentStreamChunk, streamAgent } from "../src/agent-adapter.ts"
import { createB4AgentMiddleware } from "../src/agent-middleware.ts"
import { executeWithToolLoop } from "../src/tool-loop.ts"

class NativeModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = []
  constructor() {
    super({ outputVersion: "v0" })
  }
  bindTools() {
    return this
  }
  _llmType() {
    return "scripted-provider"
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages)
    return {
      generations: [
        {
          text: "answer",
          message: new AIMessage({
            id: "canonical",
            content: "answer",
            additional_kwargs: {
              tool_outputs: [{ id: "native-search", type: "web_search_call", status: "completed" }],
            },
          }),
        },
      ],
    }
  }
  async *_streamResponseChunks(messages: BaseMessage[]) {
    this.seen.push(messages)
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({
        id: "canonical",
        content: "",
        response_metadata: {
          tool_outputs: { id: "native-search", type: "web_search_call", status: "in_progress" },
        },
      }),
    })
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({
        id: "canonical",
        content: "",
        response_metadata: {
          tool_outputs: { id: "native-search", type: "web_search_call", status: "completed" },
        },
      }),
    })
    yield new ChatGenerationChunk({
      text: "answer",
      message: new AIMessageChunk({
        id: "canonical",
        content: "answer",
        additional_kwargs: {
          tool_outputs: [
            {
              id: "native-search",
              type: "web_search_call",
              status: "completed",
              action: {
                query: "weather",
                sources: [{ url: "https://example.com", title: "Weather" }],
              },
            },
          ],
        },
      }),
    })
  }
}

test("real createAgent checkpoints stamped canonical native messages and replays them on the next turn", async () => {
  const model = new NativeModel()
  const checkpointer = new MemorySaver()
  const graph = createAgent({
    model,
    tools: [],
    checkpointer,
    middleware: createB4AgentMiddleware({
      systemPrompt: "",
      promptFragments: [],
      stateFieldNames: [],
      returnDirectToolNames: new Set(),
    }),
  })
  const config = { configurable: { thread_id: "native-checkpoint" } }
  const chunks: AgentStreamChunk[] = []

  for await (const chunk of streamAgent({
    entry: graph,
    checkpointer,
    input: { messages: [new HumanMessage("go")] },
    tools: [],
    routeParamNames: [],
    threadId: "native-checkpoint",
    signal: new AbortController().signal,
  }))
    chunks.push(chunk)
  const checkpoint: { values: { messages: BaseMessage[] } } = await graph.getState(config)
  const stored = (checkpoint.values.messages as BaseMessage[]).find((message) =>
    AIMessage.isInstance(message),
  ) as AIMessage
  await graph.invoke({ messages: [new HumanMessage("again")] }, config)

  expect(stored).toBeDefined()
  expect(stored.id).toBe("canonical")
  expect(stored.content).toBe("answer")
  expect(stored.additional_kwargs.tool_outputs).toMatchObject([
    { id: "native-search", action: { query: "weather" } },
  ])
  expect(stored.additional_kwargs.b4_steps).toMatchObject({
    "native-search": { kind: "provider", status: "completed" },
  })
  expect(stored.tool_calls ?? []).toEqual([])
  expect(model.seen[1]?.find((message) => message.id === "canonical")?.additional_kwargs).toEqual(
    stored.additional_kwargs,
  )
  expect(chunks.filter((chunk) => chunk.type === "tool_result")).toHaveLength(1)
  expect(normalizeProviderMessage(stored, { messageId: stored.id ?? "" }).calls[0]?.step).toEqual(
    (chunks.find((chunk) => chunk.type === "tool_result")?.data as { step: unknown } | undefined)
      ?.step,
  )
})

test("independent tool loop stamps provider results before returning without executing them", async () => {
  let calls = 0
  const native = new AIMessage({
    id: "loop-native",
    content: "",
    additional_kwargs: {
      tool_outputs: [{ id: "native", type: "web_search_call", status: "completed" }],
    },
    tool_calls: [{ id: "native", name: "web_search", args: {} }],
  })

  const result = (await executeWithToolLoop({
    chain: { invoke: async () => native },
    input: [],
    tools: [
      {
        name: "web_search",
        run: () => {
          calls++
          return "app"
        },
      },
    ],
    signal: new AbortController().signal,
  })) as AIMessage

  expect(calls).toBe(0)
  expect(result.additional_kwargs.b4_steps).toMatchObject({
    native: { kind: "provider", status: "completed" },
  })
  expect(result.tool_calls).toEqual([])
  expect(native.tool_calls).toHaveLength(1)
})

test("Anthropic native chunk concatenation preserves canonical inputs and failure in checkpoints", async () => {
  class AnthropicModel extends NativeModel {
    async *_streamResponseChunks(messages: BaseMessage[]) {
      this.seen.push(messages)
      const content = [
        [
          {
            type: "server_tool_use",
            id: "anthropic-search",
            name: "web_search",
            input: "",
            index: 1,
          },
        ],
        [{ type: "input_json_delta", index: 1, input: '{"query":' }],
        [{ type: "input_json_delta", index: 1, input: '"hello"}' }],
        [
          {
            type: "web_search_tool_result",
            index: 2,
            tool_use_id: "anthropic-search",
            content: { type: "web_search_tool_result_error", error_code: "unavailable" },
          },
        ],
      ]
      for (const block of content)
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({ id: "anthropic-native", content: block }),
        })
    }
  }
  const model = new AnthropicModel()
  const checkpointer = new MemorySaver()
  const graph = createAgent({
    model,
    tools: [],
    checkpointer,
    middleware: createB4AgentMiddleware({
      systemPrompt: "",
      promptFragments: [],
      stateFieldNames: [],
      returnDirectToolNames: new Set(),
    }),
  })
  const chunks: AgentStreamChunk[] = []

  for await (const chunk of streamAgent({
    entry: graph,
    checkpointer,
    input: { messages: [new HumanMessage("go")] },
    tools: [],
    routeParamNames: [],
    threadId: "anthropic-checkpoint",
    signal: new AbortController().signal,
  }))
    chunks.push(chunk)
  const checkpoint: { values: { messages: BaseMessage[] } } = await graph.getState({
    configurable: { thread_id: "anthropic-checkpoint" },
  })
  const stored = checkpoint.values.messages.find((message) =>
    AIMessage.isInstance(message),
  ) as AIMessage

  expect(
    normalizeProviderMessage(stored, { messageId: "anthropic-native" }).calls[0],
  ).toMatchObject({ input: { query: "hello" }, step: { status: "failed" } })
  expect(chunks.filter((chunk) => chunk.type === "tool_call")).toMatchObject([
    { data: { input: { query: "hello" } } },
  ])
  expect(chunks.filter((chunk) => chunk.type === "tool_result")).toHaveLength(1)
})
