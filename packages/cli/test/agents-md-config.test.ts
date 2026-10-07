import { describe, expect, test } from "vitest"

import { resolveAgentsMdConfig } from "../src/lib/runtime/agents-md-config.js"

/**
 * `agentsMd` has no runtime schema behind it, so a near miss must fail with
 * B4_E1010 rather than read as configured while AGENTS.md stays writable.
 */

function rejection(agentsMd: unknown): unknown {
  try {
    resolveAgentsMdConfig({ agentsMd } as never)
  } catch (error) {
    return error
  }
  return undefined
}

describe("resolveAgentsMdConfig", () => {
  test.each([
    ["no config", undefined],
    ["a config without agentsMd", {}],
    ["an empty agentsMd", { agentsMd: {} }],
    ["writable: undefined", { agentsMd: { writable: undefined } }],
    ["writable: true", { agentsMd: { writable: true } }],
  ])("is writable with %s", (_label, config) => {
    expect(resolveAgentsMdConfig(config as never)).toEqual({ writable: true })
  })

  test("is read-only with writable: false", () => {
    expect(resolveAgentsMdConfig({ agentsMd: { writable: false } })).toEqual({ writable: false })
  })

  test.each([
    ["null", null],
    ["false", false],
    ["true", true],
    ["a string", "read-only"],
    ["an array", [false]],
  ])("rejects agentsMd as %s", (_label, agentsMd) => {
    const error = rejection(agentsMd)
    expect(error).toMatchObject({ code: "B4_E1010" })
    expect(String((error as Error).message)).toMatch(/agentsMd must be an object/)
  })

  test.each([
    ["writeable", { writeable: false }],
    ["Writable", { Writable: false }],
    ["readOnly", { readOnly: true }],
  ])("rejects the unknown key %s", (key, agentsMd) => {
    const error = rejection(agentsMd)
    expect(error).toMatchObject({ code: "B4_E1010" })
    expect(String((error as Error).message)).toContain(`Unknown agentsMd option(s): ${key}`)
  })

  test.each([
    ["the string false", "false"],
    ["0", 0],
    ["null", null],
  ])("rejects writable as %s", (_label, writable) => {
    const error = rejection({ writable })
    expect(error).toMatchObject({ code: "B4_E1010" })
    expect(String((error as Error).message)).toMatch(/agentsMd\.writable must be a boolean/)
  })

  test("names a function-valued writable instead of printing undefined", () => {
    const message = String((rejection({ writable: () => false }) as Error).message)
    expect(message).toContain("agentsMd.writable must be a boolean; received a function.")
    expect(message).not.toContain("undefined")
  })

  test("names an array-valued agentsMd", () => {
    const message = String((rejection([false]) as Error).message)
    expect(message).toContain("agentsMd must be an object; received an array.")
  })
})
