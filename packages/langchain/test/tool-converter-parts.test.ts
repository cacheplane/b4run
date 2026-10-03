import { ToolMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ModalitySupport } from "../src/chat-model-factory.ts"
import { B4_CONTENT_PARTS_KEY, B4_STEP_KEY, convertToolToLangChain } from "../src/tool-converter.ts"

vi.mock("@langchain/core/callbacks/dispatch/web", () => ({ dispatchCustomEvent: vi.fn() }))

import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch/web"

const png = {
  type: "image",
  source: { type: "data", value: "AAAA", mimeType: "image/png" },
} as const
const wav = {
  type: "audio",
  source: { type: "data", value: "UklG", mimeType: "audio/wav" },
} as const
const ALL: ModalitySupport = {
  image: { data: true, url: true },
  pdf: { data: true, url: true },
  audio: true,
  video: true,
  toolResult: { image: true, pdf: true },
  file: { image: true, pdf: true },
}
const OPENAI = { support: ALL, provider: "openai", model: "gpt-5-mini" } as const
// `toolCall` is where LangGraph's ToolNode puts the call; the converter reads its id from there.
const config = { toolCall: { id: "call_1", name: "render", args: {}, type: "tool_call" as const } }

function tool(result: unknown) {
  return { name: "render", description: "d", run: async () => result }
}

beforeEach(() => {
  vi.mocked(dispatchCustomEvent).mockClear()
})

describe("tool results with content parts", () => {
  it("keeps the parts and the display step together in additional_kwargs", async () => {
    const parts = [{ type: "text", text: "x" }]
    const converted = convertToolToLangChain(
      { ...tool(parts), display: { icon: "read", done: () => "Read it" } },
      undefined,
      undefined,
      [],
      [],
      OPENAI,
    )
    const out = (await converted.invoke({}, config)) as ToolMessage
    expect(out.additional_kwargs[B4_CONTENT_PARTS_KEY]).toEqual(parts)
    expect(out.additional_kwargs[B4_STEP_KEY]).toEqual({ icon: "read", label: "Read it" })
  })

  it("returns a ToolMessage whose content is the model-visible blocks and whose kwargs keep every part", async () => {
    const converted = convertToolToLangChain(
      tool([{ type: "text", text: "here" }, png]),
      undefined,
      undefined,
      [],
      [],
      OPENAI,
    )
    const out = (await converted.invoke({}, config)) as ToolMessage
    expect(out).toBeInstanceOf(ToolMessage)
    expect(out.tool_call_id).toBe("call_1")
    expect(out.content).toEqual([
      { type: "text", text: "here" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
    expect(out.additional_kwargs[B4_CONTENT_PARTS_KEY]).toEqual([
      { type: "text", text: "here" },
      png,
    ])
    expect(dispatchCustomEvent).not.toHaveBeenCalled()
  })

  it("keeps media out of the model's view when the profile refuses it, and announces the drop", async () => {
    const converted = convertToolToLangChain(
      tool([{ type: "text", text: "here" }, png, wav]),
      undefined,
      undefined,
      [],
      [],
      { ...OPENAI, support: { ...ALL, toolResult: { image: false, pdf: false } } },
    )
    const out = (await converted.invoke({}, config)) as ToolMessage
    expect(out).toBeInstanceOf(ToolMessage)
    expect(out.content).toBe("here")
    expect(out.additional_kwargs.b4_content_parts).toEqual([
      { type: "text", text: "here" },
      png,
      wav,
    ])
    expect(dispatchCustomEvent).toHaveBeenCalledWith(
      "b4.capability",
      {
        event: "content_parts_dropped",
        data: {
          provider: "openai",
          model: "gpt-5-mini",
          toolCallId: "call_1",
          parts: [
            { index: 1, type: "image", source: "data", reason: "tool_result_media_unsupported" },
            { index: 2, type: "audio", source: "data", reason: "tool_result_media_unsupported" },
          ],
        },
      },
      expect.anything(),
    )
  })

  it("offload sees only the text; media parts bypass it", async () => {
    const offload = vi.fn(async (content: string) => `<stub for ${content.length} chars>`)
    const converted = convertToolToLangChain(
      tool([{ type: "text", text: "x".repeat(10) }, png]),
      undefined,
      offload,
      [],
      [],
      OPENAI,
    )
    const out = (await converted.invoke({}, config)) as ToolMessage
    expect(offload).toHaveBeenCalledWith("x".repeat(10), "render", "call_1", expect.anything())
    expect(out.content).toEqual([
      { type: "text", text: "<stub for 10 chars>" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
  })

  it("a string result is unchanged (no ToolMessage wrapping here)", async () => {
    // Without a tool call in the config, LangChain returns the func's value as is.
    const converted = convertToolToLangChain(
      tool({ result: "plain" }),
      undefined,
      undefined,
      [],
      [],
      OPENAI,
    )
    expect(await converted.invoke({})).toBe("plain")
    const plain = convertToolToLangChain(tool("plain"), undefined, undefined, [], [], OPENAI)
    expect(await plain.invoke({})).toBe('"plain"')
    // With one, LangChain wraps the string itself; B4 adds no parts key.
    const wrapped = (await converted.invoke({}, config)) as ToolMessage
    expect(wrapped.content).toBe("plain")
    expect(wrapped.additional_kwargs[B4_CONTENT_PARTS_KEY]).toBeUndefined()
  })

  it("the text keeps the place of the tool's first text part; media keep their order", async () => {
    const offload = vi.fn(async (content: string) => content)
    const converted = convertToolToLangChain(
      tool([png, { type: "text", text: "a" }, wav, { type: "text", text: "b" }]),
      undefined,
      offload,
      [],
      [],
      { ...OPENAI, support: { ...ALL, toolResult: { image: true, pdf: false } } },
    )
    const out = (await converted.invoke({}, config)) as ToolMessage
    expect(out.content).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "ab" },
    ])
    const ordered = convertToolToLangChain(
      tool([png, { type: "text", text: "after" }]),
      undefined,
      undefined,
      [],
      [],
      OPENAI,
    )
    const second = (await ordered.invoke({}, config)) as ToolMessage
    expect(second.content).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "after" },
    ])
  })

  it("serializes with the blocks under kwargs.content and the v1 mark", async () => {
    const converted = convertToolToLangChain(
      tool([{ type: "text", text: "here" }, png]),
      undefined,
      undefined,
      [],
      [],
      OPENAI,
    )
    const out = (await converted.invoke({}, config)) as ToolMessage
    const serialized = JSON.parse(JSON.stringify(out))
    expect(serialized.kwargs.content).toEqual([
      { type: "text", text: "here" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])
    expect(serialized.kwargs.response_metadata).toMatchObject({ output_version: "v1" })
    expect(serialized.kwargs.additional_kwargs[B4_CONTENT_PARTS_KEY]).toEqual([
      { type: "text", text: "here" },
      png,
    ])
  })

  it("a media-only result carries no empty text block and never calls offload", async () => {
    const offload = vi.fn(async (content: string) => content)
    const converted = convertToolToLangChain(tool([png]), undefined, offload, [], [], OPENAI)
    const out = (await converted.invoke({}, config)) as ToolMessage
    expect(out.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }])
    expect(offload).not.toHaveBeenCalled()
    expect(out.additional_kwargs.b4_content_parts).toEqual([png])
  })

  it("a wrapped part result with state carries the same ToolMessage inside the Command", async () => {
    const converted = convertToolToLangChain(
      tool({ result: [{ type: "text", text: "here" }, png], state: { n: 1 } }),
      undefined,
      undefined,
      [],
      [],
      OPENAI,
    )
    const out = (await converted.invoke({}, config)) as Command
    expect(out).toBeInstanceOf(Command)
    const update = out.update as { n: number; messages: ToolMessage[] }
    expect(update.n).toBe(1)
    expect(update.messages[0]).toBeInstanceOf(ToolMessage)
    expect(update.messages[0]?.additional_kwargs.b4_content_parts).toEqual([
      { type: "text", text: "here" },
      png,
    ])
  })

  it("OpenAI's Chat Completions converter accepts the tool message and keeps its text", async () => {
    const converted = convertToolToLangChain(
      tool([{ type: "text", text: "here" }, png]),
      undefined,
      undefined,
      [],
      [],
      OPENAI,
    )
    const out = (await converted.invoke({}, config)) as ToolMessage
    const { convertMessagesToCompletionsMessageParams } = await import("@langchain/openai")
    const params = convertMessagesToCompletionsMessageParams({
      messages: [out],
      model: "gpt-5-mini",
    })
    const toolParam = params.find((p) => p.role === "tool")
    expect(toolParam).toBeDefined()
    expect(JSON.stringify(toolParam?.content)).toContain("here")
  })
})
