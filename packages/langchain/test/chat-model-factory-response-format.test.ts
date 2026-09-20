import { describe, expect, test, vi } from "vitest"

import {
  createChatModel,
  JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS,
  type JsonSchemaResponseFormat,
  supportsJsonSchemaResponseFormat,
  unsupportedResponseFormatMessage,
} from "../src/chat-model-factory.ts"

/** A provider class that records what `withConfig` was handed, like a LangChain chat model. */
class FakeModel {
  bound: Record<string, unknown> | undefined
  constructor(readonly options: Record<string, unknown>) {}
  withConfig(config: Record<string, unknown>): {
    readonly bound: FakeModel
    readonly config: unknown
  } {
    this.bound = config
    return { bound: this, config }
  }
}

const responseFormat: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "hashbrown_response",
  schema: {
    type: "object",
    properties: { ui: { type: "array", items: { type: "string" } } },
    required: ["ui"],
    additionalProperties: false,
  },
}

describe("createChatModel with a JSON-schema response format", () => {
  test("OpenAI: bound as a strict json_schema response_format call option", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatOpenAI: FakeModel })

    const model = (await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      responseFormat,
      importer,
    })) as { bound: FakeModel; config: Record<string, unknown> }

    expect(model.bound.options).toEqual({ model: "gpt-5-mini" })
    expect(model.config).toEqual({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "hashbrown_response",
          schema: responseFormat.schema,
          strict: true,
        },
      },
    })
  })

  test("Anthropic: bound as a json_schema output format call option", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatAnthropic: FakeModel })

    const model = (await createChatModel({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      responseFormat,
      importer,
    })) as { bound: FakeModel; config: Record<string, unknown> }

    expect(model.bound.options).toEqual({ model: "claude-sonnet-4-5" })
    expect(model.config).toEqual({
      outputConfig: { format: { type: "json_schema", schema: responseFormat.schema } },
    })
  })

  test("a provider without a schema-constrained output hook is rejected, not ignored", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatGoogleGenerativeAI: FakeModel })

    await expect(
      createChatModel({ model: "gemini-2.5-flash", provider: "google", responseFormat, importer }),
    ).rejects.toThrow(unsupportedResponseFormatMessage("google"))
    // Nothing was constructed on the way to the rejection.
    expect(importer).not.toHaveBeenCalled()
  })

  test("without a response format the model is returned unbound", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatOpenAI: FakeModel })

    const model = await createChatModel({ model: "gpt-5-mini", provider: "openai", importer })

    expect(model).toBeInstanceOf(FakeModel)
    expect((model as FakeModel).bound).toBeUndefined()
  })

  test("the supported-provider list is what the runtime preflight consults", () => {
    expect([...JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS]).toEqual(["openai", "anthropic"])
    expect(supportsJsonSchemaResponseFormat("openai")).toBe(true)
    expect(supportsJsonSchemaResponseFormat("anthropic")).toBe(true)
    for (const provider of ["google", "mistral", "groq", "ollama", "xai", "openrouter"] as const) {
      expect(supportsJsonSchemaResponseFormat(provider)).toBe(false)
      expect(unsupportedResponseFormatMessage(provider)).toContain(`"${provider}"`)
      expect(unsupportedResponseFormatMessage(provider)).toContain("openai, anthropic")
    }
  })
})
