import { expect, test, vi } from "vitest"
import { resolveBuiltInTools } from "../src/built-in-tools-config.ts"
import { createChatModel } from "../src/chat-model-factory.ts"

test("resolves OpenAI tools and the response activity includes", () => {
  const config = {
    openai: { webSearch: true, codeExecution: true, imageGeneration: true },
  } as const

  const result = resolveBuiltInTools("openai", config)

  expect(result.tools).toEqual([
    { type: "web_search" },
    { type: "code_interpreter", container: { type: "auto" } },
    { type: "image_generation" },
  ])
  expect(result.constructorOptions).toEqual({ useResponsesApi: true })
  expect(result.callOptions).toEqual({
    include: ["web_search_call.action.sources", "code_interpreter_call.outputs"],
  })
})

test("preserves provider-native configuration without mutating it", () => {
  const native = Object.freeze({
    search_context_size: "high",
    filters: { allowed_domains: ["example.com"] },
  })

  const result = resolveBuiltInTools("openai", { openai: { webSearch: native } })

  expect(result.tools).toEqual([{ type: "web_search", ...native }])
  expect(native).not.toHaveProperty("type")
})

test("resolves Anthropic and Google native definitions", () => {
  const anthropic = resolveBuiltInTools("anthropic", { anthropic: { webSearch: { max_uses: 3 } } })
  const google = resolveBuiltInTools("google", {
    google: { webSearch: true, webFetch: true, codeExecution: true },
  })

  expect(anthropic.tools).toEqual([
    { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  ])
  expect(google.tools).toEqual([{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }])
})

test.each([
  ["openai", { anthropic: { webSearch: true } }],
  ["groq", { openai: { webSearch: true } }],
  ["openai", { openai: { fileSearch: true } }],
  ["anthropic", { anthropic: { webFetch: true } }],
  ["anthropic", { anthropic: { codeExecution: true } }],
  ["google", { google: { webSearch: false } }],
  ["openai", { openai: { webSearch: [] } }],
  ["openai", { bedrock: {} }],
  ["openai", { mcp: {} }],
] as const)("rejects invalid built-ins before importing %s", async (provider, config) => {
  const importer = vi.fn()

  await expect(
    createChatModel({ model: "test", provider, builtInTools: config as never, importer }),
  ).rejects.toThrow(/builtInTools/)

  expect(importer).not.toHaveBeenCalled()
})

test.each([
  { openai: { webSearch: { type: "file_search" } } },
  { openai: { codeExecution: { type: "web_search" } } },
  { openai: { imageGeneration: { type: "code_interpreter" } } },
  { anthropic: { webSearch: { type: "code_execution_20250522" } } },
  { anthropic: { webSearch: { name: "local" } } },
])("rejects native discriminators that change the configured capability", (config) => {
  const provider = "openai" in config ? "openai" : "anthropic"

  expect(() => resolveBuiltInTools(provider, config as never)).toThrow(/builtInTools/)
})
