import { expect, test } from "vitest"
import { agent, type BuiltInToolsConfig } from "../src/index.ts"

test("agent preserves provider-specific built-in tool configuration", () => {
  const builtInTools = {
    openai: { webSearch: { search_context_size: "high" }, codeExecution: true },
  } as const satisfies BuiltInToolsConfig

  const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "Help", builtInTools })

  expect(descriptor.builtInTools).toBe(builtInTools)
})
