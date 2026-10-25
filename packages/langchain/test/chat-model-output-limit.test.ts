import { expect, test, vi } from "vitest"
import { createChatModel } from "../src/chat-model-factory.ts"
import { defaultModelImporter } from "../src/default-model-importer.ts"

class CapturedModel {
  constructor(readonly options: Record<string, unknown>) {}
}

test("OpenAI receives the output limit with reasoning controls", async () => {
  const options = {
    model: "gpt-5-mini",
    provider: "openai" as const,
    maxOutputTokens: 4096,
    reasoning: { openai: { effort: "low" as const } },
    importer: async () => ({ ChatOpenAI: CapturedModel }),
  }

  const model = (await createChatModel(options)) as CapturedModel

  expect(model.options.maxTokens).toBe(4096)
  expect(model.options.reasoning).toEqual({ effort: "low" })
})

test("invalid output limits fail before loading the provider", async () => {
  const importer = vi.fn(async () => ({ ChatOpenAI: CapturedModel }))
  const options = { model: "gpt-5-mini", provider: "openai" as const, maxOutputTokens: 0, importer }

  await expect(createChatModel(options)).rejects.toThrow(/maxOutputTokens.*positive safe integer/)

  expect(importer).not.toHaveBeenCalled()
})

test("output limits use each provider's supported constructor field", async () => {
  const providers = [
    { provider: "openai", model: "gpt-5-mini", name: "ChatOpenAI", field: "maxTokens" },
    {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      name: "ChatAnthropic",
      field: "maxTokens",
    },
    {
      provider: "google",
      model: "gemini-2.5-flash",
      name: "ChatGoogleGenerativeAI",
      field: "maxOutputTokens",
    },
    { provider: "ollama", model: "llama3.2", name: "ChatOllama", field: "numPredict" },
    {
      provider: "mistral",
      model: "mistral-large-latest",
      name: "ChatMistralAI",
      field: "maxTokens",
    },
    { provider: "groq", model: "llama-3.3-70b-versatile", name: "ChatGroq", field: "maxTokens" },
    { provider: "xai", model: "grok-4", name: "ChatXAI", field: "maxTokens" },
    {
      provider: "openrouter",
      model: "openai/gpt-5-mini",
      name: "ChatOpenRouter",
      field: "maxTokens",
    },
  ] as const

  for (const { provider, model, name, field } of providers) {
    const result = (await createChatModel({
      model,
      provider,
      maxOutputTokens: 4096,
      importer: async () => ({ [name]: CapturedModel }),
    })) as CapturedModel

    expect(result.options[field]).toBe(4096)
  }
})

test("the real OpenAI model applies the cap on both API paths", async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-not-used")

  try {
    for (const summary of [undefined, "auto"] as const) {
      const model = (await createChatModel({
        model: "gpt-5-mini",
        provider: "openai",
        maxOutputTokens: 4096,
        reasoning: { openai: { effort: "low", ...(summary ? { summary } : {}) } },
        importer: defaultModelImporter,
      })) as { invocationParams: () => Record<string, unknown> }

      const params = model.invocationParams()

      expect(params.max_completion_tokens ?? params.max_output_tokens ?? params.max_tokens).toBe(
        4096,
      )
    }
  } finally {
    vi.unstubAllEnvs()
  }
})
