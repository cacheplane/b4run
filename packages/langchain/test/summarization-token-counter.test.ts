import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { MEDIA_TOKEN_ESTIMATE, messageContentText } from "../src/summarization/message-text.js"
import { countMessagesTokens, defaultTokenCounter } from "../src/summarization/token-counter.js"

describe("defaultTokenCounter", () => {
  it("counts tokens for a plain string", async () => {
    const n = await defaultTokenCounter("hello world this is a test")
    expect(n).toBeGreaterThan(3)
    expect(n).toBeLessThan(15)
  })
})

describe("countMessagesTokens", () => {
  it("sums an injected counter across message contents incl. tool calls", async () => {
    const counter = (t: string) => t.length // chars as tokens, deterministic
    const messages = [
      new HumanMessage("abc"),
      new AIMessage({ content: "", tool_calls: [{ id: "1", name: "t", args: { k: "v" } }] }),
      new ToolMessage({ content: "result", tool_call_id: "1" }),
    ]
    const total = await countMessagesTokens(messages, counter)
    expect(total).toBeGreaterThan(9) // "abc"(3) + serialized tool_call + "result"(6)
  })

  it("awaits an async counter", async () => {
    const counter = async (t: string) => t.length
    const total = await countMessagesTokens([new HumanMessage("hello")], counter)
    expect(total).toBe(5)
  })

  it("counts a media block as its placeholder plus a fixed estimate, never its base64", async () => {
    const counter = (t: string) => t.length
    const data = "A".repeat(200 * 1024)
    const message = new HumanMessage({
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data, mimeType: "image/png" },
      ],
    })
    const total = await countMessagesTokens([message], counter)
    expect(total).toBe("what is this?[image]".length + MEDIA_TOKEN_ESTIMATE)
  })

  it("keeps a real-tokenizer count of an image message near text + estimate", async () => {
    const data = "A".repeat(200 * 1024)
    const message = new HumanMessage({
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data, mimeType: "image/png" },
      ],
    })
    const total = await countMessagesTokens([message], defaultTokenCounter)
    expect(total).toBeLessThan(MEDIA_TOKEN_ESTIMATE + 50)
    expect(total).toBeGreaterThan(MEDIA_TOKEN_ESTIMATE)
  })

  it("counts tool_use and reasoning blocks as their JSON text, with no media estimate", async () => {
    const counter = (t: string) => t.length
    const toolUse = { type: "tool_use", id: "tu-1", name: "search", input: { q: "x" } }
    const reasoning = { type: "reasoning", reasoning: "think it through" }
    const message = new AIMessage({ content: [toolUse, reasoning] })
    const jsonText = JSON.stringify(toolUse) + JSON.stringify(reasoning)
    expect(messageContentText(message.content)).toEqual({ text: jsonText, mediaCount: 0 })
    // The message's (empty) tool_calls serialize beside the content; no media estimate is added.
    const toolCalls = JSON.stringify(message.tool_calls)
    const total = await countMessagesTokens([message], counter)
    expect(total).toBe(`${jsonText}\n${toolCalls}`.length)
  })

  it("renders a legacy image_url block as [image] and adds the estimate", async () => {
    const counter = (t: string) => t.length
    const message = new HumanMessage({
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(4096)}` } },
      ],
    })
    const total = await countMessagesTokens([message], counter)
    expect(total).toBe("[image]".length + MEDIA_TOKEN_ESTIMATE)
  })

  it("passes string content through", () => {
    expect(messageContentText("plain")).toEqual({ text: "plain", mediaCount: 0 })
  })
})
