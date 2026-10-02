import { afterEach, describe, expect, test, vi } from "vitest"
import { createChatModel } from "../src/chat-model-factory.ts"
import { defaultModelImporter } from "../src/default-model-importer.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

type OpenAIRequestParams = {
  readonly reasoning_effort?: string
  readonly reasoning?: { readonly effort?: string }
}
type Requester = { invocationParams(options: Record<string, unknown>): OpenAIRequestParams }

/** The effort a request would carry, for either OpenAI API shape. */
const effortOf = (params: OpenAIRequestParams) =>
  params.reasoning_effort ?? params.reasoning?.effort

describe("createChatModel reasoning effort", () => {
  // The installed ChatOpenAI, constructed offline: an agent's
  // `reasoning.effort` must reach the request it sends, through both inner
  // models (Chat Completions and Responses). The constructor reads
  // `reasoning`; `reasoningEffort` is only a per-call option, so passing it
  // to the constructor is silently ignored.
  test.each(["minimal", "low", "high"] as const)(
    "the installed @langchain/openai sends effort %s",
    async (effort) => {
      vi.stubEnv("OPENAI_API_KEY", "test-key-not-used")

      const model = (await createChatModel({
        model: "gpt-5-mini",
        provider: "openai",
        reasoning: { effort },
        importer: defaultModelImporter,
      })) as Requester & { completions: Requester; responses: Requester }

      expect(effortOf(model.invocationParams({}))).toBe(effort)
      expect(effortOf(model.completions.invocationParams({}))).toBe(effort)
      expect(effortOf(model.responses.invocationParams({}))).toBe(effort)
    },
  )

  test("without a reasoning config, the request carries no effort", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-used")

    const model = (await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      importer: defaultModelImporter,
    })) as Requester

    expect(effortOf(model.invocationParams({}))).toBeUndefined()
  })
})
