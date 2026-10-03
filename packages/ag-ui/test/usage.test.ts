import { describe, expect, test } from "vitest"
import { asUsageData } from "../src/types.ts"
import { createUsageCollector } from "../src/usage.ts"

describe("asUsageData", () => {
  test("narrows a well-formed payload and drops bad labels", () => {
    expect(
      asUsageData({ provider: "openai", model: "gpt-5-mini", usage_metadata: { input_tokens: 1 } }),
    ).toEqual({ provider: "openai", model: "gpt-5-mini", usage_metadata: { input_tokens: 1 } })
    expect(asUsageData({ provider: 7, usage_metadata: { input_tokens: 1 } })).toEqual({
      usage_metadata: { input_tokens: 1 },
    })
  })

  test("rejects a payload without an object usage_metadata", () => {
    expect(asUsageData({ provider: "openai" })).toBeNull()
    expect(asUsageData({ usage_metadata: "lots" })).toBeNull()
    expect(asUsageData(null)).toBeNull()
  })
})

describe("createUsageCollector", () => {
  test("is empty until something usable arrives: terminal() spreads to nothing", () => {
    const usage = createUsageCollector()
    expect(usage.terminal()).toEqual({})
    usage.add({ usage_metadata: { not_a_count: "x" } })
    expect(usage.terminal()).toEqual({})
  })

  test("maps LangChain accounting through and aggregates per provider+model", () => {
    const usage = createUsageCollector()
    usage.add({
      provider: "openai",
      model: "gpt-5-mini",
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_token_details: { cache_read: 80 },
        output_token_details: { reasoning: 5 },
      },
    })
    usage.add({
      provider: "openai",
      model: "gpt-5-mini",
      usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    })
    usage.add({
      provider: "openai",
      model: "gpt-5-nano",
      usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    expect(usage.terminal()).toEqual({
      usage: [
        {
          provider: "openai",
          model: "gpt-5-mini",
          inputTokens: 110,
          outputTokens: 22,
          totalTokens: 132,
          cachedInputTokens: 80,
          reasoningTokens: 5,
        },
        {
          provider: "openai",
          model: "gpt-5-nano",
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      ],
    })
  })

  test("keeps unlabelled entries, and never reports a count nobody returned", () => {
    const usage = createUsageCollector()
    usage.add({ usage_metadata: { input_tokens: 3, output_tokens: 4 } })
    const { usage: entries } = usage.terminal()
    expect(entries).toHaveLength(1)
    expect(entries?.[0]).toMatchObject({ inputTokens: 3, outputTokens: 4 })
    expect(entries?.[0]).not.toHaveProperty("provider")
    expect(entries?.[0]?.totalTokens).toBeUndefined()
    expect(entries?.[0]?.reasoningTokens).toBeUndefined()
  })
})
