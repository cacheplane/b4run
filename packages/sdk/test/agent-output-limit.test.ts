import { expect, test } from "vitest"
import { agent } from "../src/agent.ts"

test("agent retains a server-owned output token cap", () => {
  const config = { model: "gpt-5-mini" as const, systemPrompt: "ATC", maxOutputTokens: 4096 }

  const descriptor = agent(config)

  expect(descriptor.maxOutputTokens).toBe(4096)
  expect(config.maxOutputTokens).toBe(4096)
})

test("agent leaves output limits absent unless configured", () => {
  const descriptor = agent({ model: "gpt-5-mini", systemPrompt: "ATC" })

  expect(descriptor).not.toHaveProperty("maxOutputTokens")
})

test("agent rejects invalid output limits before runtime construction", () => {
  const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]

  for (const maxOutputTokens of invalid) {
    expect(() => agent({ model: "gpt-5-mini", systemPrompt: "ATC", maxOutputTokens })).toThrow(
      /maxOutputTokens.*positive safe integer/,
    )
  }
})
