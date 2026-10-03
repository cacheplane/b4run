import { describe, expect, test } from "vitest"
import { resolveReasoningConfig } from "../src/reasoning-config.ts"

describe("resolveReasoningConfig", () => {
  test("no config: nothing forwarded, nothing streams", () => {
    expect(resolveReasoningConfig("openai", undefined)).toEqual({
      constructorOptions: {},
      streams: false,
    })
  })

  test("openai effort alone reasons but does not stream", () => {
    expect(resolveReasoningConfig("openai", { openai: { effort: "high" } })).toEqual({
      constructorOptions: { reasoning: { effort: "high" } },
      streams: false,
    })
  })

  test("openai summary streams and selects the Responses API", () => {
    expect(
      resolveReasoningConfig("openai", { openai: { effort: "low", summary: "auto" } }),
    ).toEqual({
      constructorOptions: { reasoning: { effort: "low", summary: "auto" }, useResponsesApi: true },
      streams: true,
    })
  })

  test("anthropic budgetTokens enables thinking and streams", () => {
    expect(resolveReasoningConfig("anthropic", { anthropic: { budgetTokens: 2048 } })).toEqual({
      constructorOptions: { thinking: { type: "enabled", budget_tokens: 2048 } },
      streams: true,
    })
  })

  test("a sub-object for a provider the route does not resolve to is an error", () => {
    expect(() => resolveReasoningConfig("anthropic", { openai: { effort: "high" } })).toThrowError(
      'agent() reasoning.openai is set, but the route resolves to the "anthropic" provider; set reasoning.anthropic instead.',
    )
    expect(() =>
      resolveReasoningConfig("openai", { anthropic: { budgetTokens: 2048 } }),
    ).toThrowError(
      'agent() reasoning.anthropic is set, but the route resolves to the "openai" provider; set reasoning.openai instead.',
    )
  })

  test("a provider with no reasoning controls rejects any sub-object", () => {
    expect(() => resolveReasoningConfig("ollama", { openai: { effort: "low" } })).toThrowError(
      'agent() reasoning.openai is set, but the route resolves to the "ollama" provider, which has no reasoning controls in B4.run.',
    )
  })

  test("unknown keys are rejected, naming the valid ones", () => {
    expect(() => resolveReasoningConfig("openai", { effort: "high" } as never)).toThrowError(
      'agent() reasoning has an unknown key "effort"; valid keys are openai, anthropic.',
    )
    expect(() =>
      resolveReasoningConfig("openai", { openai: { efort: "high" } } as never),
    ).toThrowError(
      'agent() reasoning.openai has an unknown key "efort"; valid keys are effort, summary.',
    )
  })

  test("budgetTokens must be a whole number of at least 1024", () => {
    for (const bad of [1023, 1.5, Number.NaN, -1]) {
      expect(() =>
        resolveReasoningConfig("anthropic", { anthropic: { budgetTokens: bad } }),
      ).toThrowError(
        `agent() reasoning.anthropic.budgetTokens must be a whole number of at least 1024, got ${String(bad)}.`,
      )
    }
  })

  test("non-object shapes are rejected", () => {
    expect(() => resolveReasoningConfig("openai", null as never)).toThrowError(
      "agent() reasoning must be an object with openai and/or anthropic, got null.",
    )
    expect(() => resolveReasoningConfig("openai", { openai: "high" } as never)).toThrowError(
      "agent() reasoning.openai must be an object, got string high.",
    )
  })
})
