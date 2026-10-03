import { afterEach, describe, expect, test, vi } from "vitest"
import { createChatModel } from "../src/chat-model-factory.ts"
import { defaultModelImporter } from "../src/default-model-importer.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

type OpenAIRequestParams = {
  readonly reasoning_effort?: string
  readonly reasoning?: { readonly effort?: string; readonly summary?: string }
}
type Requester = { invocationParams(options: Record<string, unknown>): OpenAIRequestParams }

/** The effort a request would carry, for either OpenAI API shape. */
const effortOf = (params: OpenAIRequestParams) =>
  params.reasoning_effort ?? params.reasoning?.effort

describe("createChatModel reasoning, through the installed providers", () => {
  // The installed ChatOpenAI, constructed offline: the agent's controls must
  // reach the request it sends, through both inner models (Chat Completions
  // and Responses). The constructor reads `reasoning`; `reasoningEffort` is
  // only a per-call option, so passing it to the constructor was silently
  // ignored and every OpenAI agent ran at the model's default effort.
  test.each(["minimal", "low", "high"] as const)(
    "@langchain/openai sends effort %s on both inner models",
    async (effort) => {
      vi.stubEnv("OPENAI_API_KEY", "test-key-not-used")
      const model = (await createChatModel({
        model: "gpt-5-mini",
        provider: "openai",
        reasoning: { openai: { effort } },
        importer: defaultModelImporter,
      })) as Requester & { completions: Requester; responses: Requester }
      expect(effortOf(model.invocationParams({}))).toBe(effort)
      expect(effortOf(model.completions.invocationParams({}))).toBe(effort)
      expect(effortOf(model.responses.invocationParams({}))).toBe(effort)
    },
  )

  test("@langchain/openai sends the summary request on the Responses API", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-used")
    const model = (await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      reasoning: { openai: { effort: "low", summary: "auto" } },
      importer: defaultModelImporter,
    })) as Requester & { useResponsesApi?: boolean }
    expect(model.useResponsesApi).toBe(true)
    expect(model.invocationParams({}).reasoning).toEqual({ effort: "low", summary: "auto" })
  })

  test("without a reasoning config, the request carries no effort", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-used")
    const model = (await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      importer: defaultModelImporter,
    })) as Requester
    expect(effortOf(model.invocationParams({}))).toBeUndefined()
  })

  test("@langchain/anthropic sends extended thinking with the budget", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-used")
    const model = (await createChatModel({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      reasoning: { anthropic: { budgetTokens: 2048 } },
      importer: defaultModelImporter,
    })) as { invocationParams(options: Record<string, unknown>): { thinking?: unknown } }
    expect(model.invocationParams({}).thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
  })
})
