import { agent } from "@b4run/sdk"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { afterEach, expect, it, vi } from "vitest"
import { agentBackendAdapter, materializeAgentGraph } from "../src/agent-adapter.ts"

afterEach(() => vi.doUnmock("@langchain/openai"))
it("the canonical agent adapter preserves actual token, tool and completion stream events", async () => {
  let calls = 0,
    actions = 0,
    boundaries = 0
  class StreamingModel extends BaseChatModel {
    constructor(_options: Record<string, unknown>) {
      super({})
    }
    _llmType() {
      return "canonical-stream"
    }
    bindTools() {
      return this
    }
    async _generate(): Promise<ChatResult> {
      throw new Error("Expected actual native model streaming")
    }
    async *_streamResponseChunks(
      _messages: BaseMessage[],
      _options: this["ParsedCallOptions"],
      runManager?: CallbackManagerForLLMRun,
    ) {
      calls++
      if (calls === 1)
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: "",
            tool_call_chunks: [{ id: "inspect-1", name: "inspect", args: "{}", index: 0 }],
          }),
        })
      else
        for (const text of ["hel", "lo"]) {
          const chunk = new ChatGenerationChunk({
            text,
            message: new AIMessageChunk({ content: text }),
          })
          yield chunk
          await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
            chunk,
          })
        }
    }
  }
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: StreamingModel }))
  const graph = await materializeAgentGraph({
    descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Stream." }),
    activeInput: {
      async beforeModel() {
        boundaries++
        return undefined
      },
    },
    tools: [
      {
        name: "inspect",
        description: "Inspect.",
        async run() {
          actions++
          return "observed"
        },
      },
    ],
  })
  const chunks: { type?: string; data?: unknown }[] = []
  for await (const chunk of agentBackendAdapter.stream(
    graph,
    { messages: [{ role: "user", content: "hello" }] },
    { signal: new AbortController().signal },
  ))
    chunks.push(chunk as { type?: string; data?: unknown })
  expect(chunks.map((chunk) => chunk.type)).toEqual(
    expect.arrayContaining(["token", "tool_call", "tool_result", "done"]),
  )
  expect(
    chunks
      .filter((chunk) => chunk.type === "token")
      .map((chunk) => chunk.data)
      .join(""),
  ).toBe("hello")
  expect(chunks.filter((chunk) => chunk.type === "tool_call")).toHaveLength(1)
  expect(chunks.filter((chunk) => chunk.type === "tool_result")).toHaveLength(1)
  expect(chunks.filter((chunk) => chunk.type === "done")).toHaveLength(1)
  expect(actions).toBe(1)
  expect(calls).toBe(2)
  expect(boundaries).toBe(2)
}, 30_000)
