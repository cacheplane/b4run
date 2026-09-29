import type { BuiltInModelProviderId } from "@b4run/sdk"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createChatModel } from "../src/chat-model-factory.ts"
import { defaultModelImporter } from "../src/default-model-importer.ts"

class FakeModel {
  constructor(readonly options: Record<string, unknown>) {}
}

const providers: ReadonlyArray<{
  readonly provider: BuiltInModelProviderId
  readonly exportName: string
  readonly model: string
  readonly apiKeyEnv?: string
}> = [
  {
    provider: "openai",
    exportName: "ChatOpenAI",
    model: "gpt-5-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    provider: "anthropic",
    exportName: "ChatAnthropic",
    model: "claude-sonnet-4-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  {
    provider: "google",
    exportName: "ChatGoogleGenerativeAI",
    model: "gemini-2.5-flash",
    apiKeyEnv: "GOOGLE_API_KEY",
  },
  {
    provider: "mistral",
    exportName: "ChatMistralAI",
    model: "mistral-large-latest",
    apiKeyEnv: "MISTRAL_API_KEY",
  },
  {
    provider: "groq",
    exportName: "ChatGroq",
    model: "llama-3.3-70b-versatile",
    apiKeyEnv: "GROQ_API_KEY",
  },
  { provider: "ollama", exportName: "ChatOllama", model: "llama3.2" },
  { provider: "xai", exportName: "ChatXAI", model: "grok-4", apiKeyEnv: "XAI_API_KEY" },
  {
    provider: "openrouter",
    exportName: "ChatOpenRouter",
    model: "openai/gpt-5-mini",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
]

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("createChatModel maxRetries", () => {
  test.each(providers)("passes maxRetries to the $provider constructor", async (spec) => {
    for (const maxRetries of [0, 2]) {
      const model = (await createChatModel({
        model: spec.model,
        provider: spec.provider,
        maxRetries,
        importer: async () => ({ [spec.exportName]: FakeModel }),
      })) as FakeModel
      expect(model.options.maxRetries).toBe(maxRetries)
    }
  })

  test("leaves maxRetries unset when the caller passes none", async () => {
    const model = (await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      importer: async () => ({ ChatOpenAI: FakeModel }),
    })) as FakeModel
    expect("maxRetries" in model.options).toBe(false)
  })

  // The real provider classes, constructed offline: the value must reach the
  // AsyncCaller each one sends its requests through (ChatOpenAI delegates to
  // two inner models, and ChatMistralAI builds its caller per request from
  // its own `maxRetries` field).
  test.each(providers)(
    "the installed $provider package applies it to its request caller",
    async (spec) => {
      if (spec.apiKeyEnv) vi.stubEnv(spec.apiKeyEnv, "test-key-not-used")
      for (const maxRetries of [0, 2]) {
        const model = (await createChatModel({
          model: spec.model,
          provider: spec.provider,
          maxRetries,
          importer: defaultModelImporter,
        })) as Record<string, unknown> & { caller: { maxRetries: number } }
        expect(model.caller.maxRetries).toBe(maxRetries)
        for (const inner of ["completions", "responses"]) {
          const delegate = model[inner] as { caller: { maxRetries: number } } | undefined
          if (delegate) expect(delegate.caller.maxRetries).toBe(maxRetries)
        }
        if ("maxRetries" in model) expect(model.maxRetries).toBe(maxRetries)
      }
    },
  )
})
