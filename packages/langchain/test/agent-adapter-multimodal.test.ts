// packages/langchain/test/agent-adapter-multimodal.test.ts
import { agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetMaterializedAgentsForTests,
  type AgentStreamChunk,
  executeAgentTurn,
  streamAgent,
} from "../src/agent-adapter.ts"

const seenMessages: BaseMessage[][] = []
let fakeProfile: Record<string, unknown> = {}

class ProfiledChatModel extends BaseChatModel {
  constructor(_options: Record<string, unknown>) {
    super({})
  }
  get profile(): Record<string, unknown> {
    return fakeProfile
  }
  _llmType(): string {
    return "profiled-fake"
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    seenMessages.push(messages)
    const message = new AIMessage({ content: "seen" })
    return { generations: [{ text: "seen", message }] }
  }
  // biome-ignore lint/suspicious/noExplicitAny: loose bindTools in the hierarchy
  bindTools(): any {
    return this
  }
}

const png = {
  type: "image",
  source: { type: "data", value: "AAAA", mimeType: "image/png" },
} as const
const wav = {
  type: "audio",
  source: { type: "data", value: "UklG", mimeType: "audio/wav" },
} as const

const describeAgent = agent({ model: "gpt-5-mini", systemPrompt: "Describe." })

function options(
  content: unknown,
  overrides: { readonly checkpointer?: MemorySaver; readonly entry?: unknown } = {},
) {
  return {
    checkpointer: overrides.checkpointer ?? new MemorySaver(),
    entry: overrides.entry ?? describeAgent,
    input: { messages: [{ role: "user", content }] },
    routeParamNames: [],
    signal: new AbortController().signal,
    threadId: `t-${Math.random()}`,
    tools: [],
  }
}

async function withFakeModel<T>(body: () => Promise<T>): Promise<T> {
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ProfiledChatModel }))
  try {
    return await body()
  } finally {
    vi.doUnmock("@langchain/openai")
  }
}

async function run(
  content: unknown,
  overrides: { readonly checkpointer?: MemorySaver; readonly entry?: unknown } = {},
): Promise<AgentStreamChunk[]> {
  return withFakeModel(async () => {
    const chunks: AgentStreamChunk[] = []
    for await (const chunk of streamAgent(options(content, overrides))) {
      chunks.push(chunk)
    }
    return chunks
  })
}

function dropChunk(chunks: readonly AgentStreamChunk[]): AgentStreamChunk | undefined {
  return chunks.find((c) => c.type === "content_parts_dropped")
}

function humanMessage(): BaseMessage | undefined {
  return seenMessages.at(-1)?.find((m) => m.getType() === "human")
}

/** Constructed with the blocks under `content:`, the message's `content` is the block array itself. */
function humanContent(): unknown {
  return humanMessage()?.content
}

describe("multimodal user input", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    seenMessages.length = 0
    fakeProfile = {}
    __resetMaterializedAgentsForTests()
  })

  it("carries supported parts to the model as standard blocks", async () => {
    fakeProfile = { imageInputs: true, audioInputs: true }
    const chunks = await run([{ type: "text", text: "what is this" }, png, wav])
    expect(humanContent()).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "audio", data: "UklG", mimeType: "audio/wav" },
    ])
    // The v1 mark is what the provider converters key on to translate standard blocks.
    expect(humanMessage()?.response_metadata).toMatchObject({ output_version: "v1" })
    // Serialized, the blocks stay under `kwargs.content` — where every stored-message reader looks.
    const serialized = JSON.parse(JSON.stringify(humanMessage()))
    expect(serialized.kwargs.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "audio", data: "UklG", mimeType: "audio/wav" },
    ])
    expect(serialized.kwargs.response_metadata).toMatchObject({ output_version: "v1" })
    expect(chunks.some((c) => c.type === "content_parts_dropped")).toBe(false)
  })

  it("drops what the profile refuses, runs anyway, and announces the drop before the model turn", async () => {
    fakeProfile = { imageInputs: true }
    const chunks = await run([{ type: "text", text: "listen" }, wav, png])
    expect(humanContent()).toEqual([
      { type: "text", text: "listen" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
    const dropIndex = chunks.findIndex((c) => c.type === "content_parts_dropped")
    expect(dropIndex).toBeGreaterThanOrEqual(0)
    expect(chunks[dropIndex]?.data).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
      parts: [{ index: 1, type: "audio", source: "data", reason: "modality_unsupported" }],
    })
    expect(chunks.findIndex((c) => c.type === "done")).toBeGreaterThan(dropIndex)
  })

  it("a plain string is unchanged and array content no longer degrades to [object Object]", async () => {
    await run("plain")
    expect(humanContent()).toBe("plain")
    seenMessages.length = 0
    await run([{ type: "text", text: "only text" }])
    expect(humanContent()).toEqual([{ type: "text", text: "only text" }])
  })

  it("the message the model sees converts to an OpenAI Chat Completions image_url part", async () => {
    fakeProfile = { imageInputs: true }
    await run([{ type: "text", text: "what is this" }, png])
    const human = humanMessage()
    expect(human).toBeDefined()
    // The real converter (exported from the package root), not the mocked module.
    const { convertMessagesToCompletionsMessageParams } =
      await vi.importActual<typeof import("@langchain/openai")>("@langchain/openai")
    const params = convertMessagesToCompletionsMessageParams({
      messages: [human as BaseMessage],
      model: "gpt-5-mini",
    })
    const user = params.find((p) => p.role === "user")
    expect(user?.content).toEqual(
      expect.arrayContaining([
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ]),
    )
  })

  it("the non-streaming path logs the drop as the developer warning", async () => {
    fakeProfile = { imageInputs: true }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await withFakeModel(() => executeAgentTurn(options([{ type: "text", text: "listen" }, wav])))
    const messages = warn.mock.calls.map((call) => String(call[0]))
    const warning = messages.find((m) => m.includes("audio/data (modality_unsupported)"))
    expect(warning).toBeDefined()
    expect(warning).toContain("openai/gpt-5-mini")
  })

  it("a malformed entry drops on its own instead of stringifying the whole list", async () => {
    const chunks = await run([
      { type: "text", text: "a" },
      { type: "image", source: { type: "blob", value: "x" } },
    ])
    expect(humanContent()).toEqual([{ type: "text", text: "a" }])
    expect(dropChunk(chunks)?.data).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
      parts: [{ index: 1, type: "image", reason: "malformed_part" }],
    })
  })

  it("drop indices stay positions in the original list around a malformed entry", async () => {
    fakeProfile = { imageInputs: true }
    const chunks = await run([{ type: "bogus" }, { type: "text", text: "a" }, wav, png])
    expect(dropChunk(chunks)?.data).toMatchObject({
      parts: [
        { index: 0, type: "bogus", reason: "malformed_part" },
        { index: 2, type: "audio", source: "data", reason: "modality_unsupported" },
      ],
    })
  })

  it("a raw runnable announces drops without provider or model", async () => {
    const seenInputs: unknown[] = []
    const entry = {
      invoke: async (input: unknown) => {
        seenInputs.push(input)
        return { messages: [] }
      },
    }
    const chunks = await run([{ type: "text", text: "listen" }, wav], { entry })
    expect(dropChunk(chunks)?.data).toEqual({
      parts: [{ index: 1, type: "audio", source: "data", reason: "modality_unsupported" }],
    })
    expect(seenInputs).toHaveLength(1)
  })

  it("a cached agent keeps its modality", async () => {
    fakeProfile = { imageInputs: true }
    const checkpointer = new MemorySaver()
    const first = await run([{ type: "text", text: "one" }, wav], { checkpointer })
    const second = await run([{ type: "text", text: "two" }, wav], { checkpointer })
    for (const chunks of [first, second]) {
      expect(dropChunk(chunks)?.data).toMatchObject({
        provider: "openai",
        parts: [{ index: 1, type: "audio", reason: "modality_unsupported" }],
      })
    }
  })
})
