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

async function run(content: unknown): Promise<AgentStreamChunk[]> {
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ProfiledChatModel }))
  try {
    const chunks: AgentStreamChunk[] = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry: agent({ model: "gpt-5-mini", systemPrompt: "Describe." }),
      input: { messages: [{ role: "user", content }] },
      routeParamNames: [],
      signal: new AbortController().signal,
      threadId: `t-${Math.random()}`,
      tools: [],
    })) {
      chunks.push(chunk)
    }
    return chunks
  } finally {
    vi.doUnmock("@langchain/openai")
  }
}

function humanMessage(): BaseMessage | undefined {
  return seenMessages.at(-1)?.find((m) => m.getType() === "human")
}

/** Constructed via `contentBlocks:`, the message's `content` is the block array itself. */
function humanContent(): unknown {
  return humanMessage()?.content
}

describe("multimodal user input", () => {
  afterEach(() => {
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
    // `contentBlocks:` construction marks the message v1, which the provider converters key on.
    expect(humanMessage()?.response_metadata).toMatchObject({ output_version: "v1" })
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
})
