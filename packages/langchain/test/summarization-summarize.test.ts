import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { defaultSummarize } from "../src/summarization/summarize.js"

describe("defaultSummarize", () => {
  it("builds a prompt with previousSummary + messages and returns the model text", async () => {
    let seenPrompt = ""
    const result = await defaultSummarize({
      messages: [new HumanMessage("user asked about X"), new AIMessage("assistant answered Y")],
      model: "gpt-4o-mini",
      previousSummary: "Earlier: greeted.",
      signal: new AbortController().signal,
      invokeModel: async (prompt: string) => {
        seenPrompt = prompt
        return "Updated summary: greeted, discussed X then Y."
      },
    })
    expect(seenPrompt).toContain("Earlier: greeted.")
    expect(seenPrompt).toContain("user asked about X")
    expect(seenPrompt).toContain("assistant answered Y")
    expect(result).toBe("Updated summary: greeted, discussed X then Y.")
  })

  it("omits the previous-summary preamble when none is given", async () => {
    let seenPrompt = ""
    await defaultSummarize({
      messages: [new HumanMessage("just one message")],
      model: "gpt-4o-mini",
      signal: new AbortController().signal,
      invokeModel: async (prompt: string) => {
        seenPrompt = prompt
        return "summary"
      },
    })
    expect(seenPrompt).toContain("just one message")
    // no "Existing running summary" preamble
    expect(seenPrompt).not.toContain("Existing running summary")
  })

  it("renders media as a placeholder in the prompt, never its base64", async () => {
    let seenPrompt = ""
    const data = "A".repeat(200 * 1024)
    await defaultSummarize({
      messages: [
        new HumanMessage({
          content: [
            { type: "text", text: "look at this" },
            { type: "image", data, mimeType: "image/png" },
          ],
        }),
      ],
      model: "gpt-5-mini",
      signal: new AbortController().signal,
      invokeModel: async (prompt: string) => {
        seenPrompt = prompt
        return "summary"
      },
    })
    expect(seenPrompt).toContain("look at this[image]")
    expect(seenPrompt).not.toContain("AAAAAAAAAA")
  })

  it("keeps tool_use and reasoning blocks' text in the prompt", async () => {
    let seenPrompt = ""
    await defaultSummarize({
      messages: [
        new AIMessage({
          content: [
            { type: "tool_use", id: "tu-1", name: "search", input: { q: "quokkas" } },
            { type: "reasoning", reasoning: "think about marsupials" },
          ],
        }),
      ],
      model: "gpt-5-mini",
      signal: new AbortController().signal,
      invokeModel: async (prompt: string) => {
        seenPrompt = prompt
        return "summary"
      },
    })
    expect(seenPrompt).toContain("quokkas")
    expect(seenPrompt).toContain("think about marsupials")
    expect(seenPrompt).not.toContain("[media]")
  })
})
