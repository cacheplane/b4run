import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { afterEach, describe, expect, test, vi } from "vitest"
import { buildSummarizationHook, type SummarizeFn } from "../src/summarization/hook.ts"
import { defaultSummarize } from "../src/summarization/summarize.ts"

let constructedWith: Record<string, unknown>[] = []

class FakeChatOpenAI {
  constructor(readonly options: Record<string, unknown>) {
    constructedWith.push(options)
  }
  async invoke(): Promise<{ content: string }> {
    return { content: "the summary" }
  }
}

afterEach(() => {
  vi.doUnmock("@langchain/openai")
  constructedWith = []
})

describe("defaultSummarize maxRetries", () => {
  test.each([0, 2, 4])("builds the summarizer model with maxRetries %i", async (maxRetries) => {
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: FakeChatOpenAI }))
    const summary = await defaultSummarize({
      messages: [new HumanMessage("where is order 6?")],
      model: "gpt-5-mini",
      signal: new AbortController().signal,
      maxRetries,
    })
    expect(summary).toBe("the summary")
    expect(constructedWith.at(-1)?.maxRetries).toBe(maxRetries)
  })

  test("leaves maxRetries to the provider when none is given", async () => {
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: FakeChatOpenAI }))
    await defaultSummarize({
      messages: [new HumanMessage("where is order 6?")],
      model: "gpt-5-mini",
      signal: new AbortController().signal,
    })
    expect("maxRetries" in (constructedWith.at(-1) ?? {})).toBe(false)
  })
})

describe("buildSummarizationHook maxRetries", () => {
  const messages = [new HumanMessage("u1"), new AIMessage("a1"), new HumanMessage("u2")]
  const config = {
    maxTokens: 1,
    keepRecentTurns: 1,
    model: "gpt-5-mini",
    tokenCounter: (text: string) => text.length,
  }

  test("hands maxRetries to every summarize call", async () => {
    const summarize = vi.fn<SummarizeFn>(async () => "S")
    const hook = buildSummarizationHook({ ...config, summarize }, { maxRetries: 4 })
    const first = await hook({ messages })
    // A later turn ages more messages out, so the hook summarizes again.
    await hook({
      messages: [...messages, new AIMessage("a2"), new HumanMessage("u3")],
      ...(first.runningSummary ? { runningSummary: first.runningSummary } : {}),
    })
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(summarize.mock.calls.map(([args]) => args.maxRetries)).toEqual([4, 4])
  })

  test("passes no maxRetries when the hook was given none", async () => {
    const summarize = vi.fn<SummarizeFn>(async () => "S")
    await buildSummarizationHook({ ...config, summarize })({ messages })
    expect("maxRetries" in (summarize.mock.calls[0]?.[0] ?? {})).toBe(false)
  })
})
