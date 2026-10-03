import { describe, expect, it } from "vitest"
import {
  MAX_CLIENT_TOOL_BLOCK,
  MAX_CLIENT_TOOL_DEPTH,
  MAX_CLIENT_TOOLS,
  readClientToolDefinitions,
} from "../src/lib/dev/client-tool-definitions.js"

/** A chain of `levels` schema objects nested via `key` (top-level = level 1). */
function chain(levels: number, key: "properties" | "items"): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "object", properties: {} }
  for (let i = 1; i < levels; i++) {
    schema =
      key === "properties"
        ? { type: "object", properties: { x: schema } }
        : { type: "object", properties: {}, items: schema }
  }
  return schema
}

const tool = (over: Record<string, unknown> = {}) => ({
  name: "lookup",
  description: "Look a thing up",
  parameters: { type: "object", properties: { q: { type: "string" } } },
  ...over,
})

function reject(tools: unknown, code: string) {
  const result = readClientToolDefinitions(tools)
  expect(result).toMatchObject({ ok: false, code, status: 422 })
  return result
}

describe("readClientToolDefinitions", () => {
  it("accepts well-formed tools and preserves order", () => {
    const result = readClientToolDefinitions([tool({ name: "b" }), tool({ name: "a" })])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.tools.map((t) => t.name)).toEqual(["b", "a"])
  })

  it("defaults description and parameters; allows absent top-level type", () => {
    const result = readClientToolDefinitions([
      { name: "bare" },
      { name: "untyped", parameters: { properties: { q: { type: "string" } } } },
      { name: "noprops", parameters: { type: "object" } },
    ])
    expect(result).toEqual({
      ok: true,
      tools: [
        {
          name: "bare",
          description: "",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "untyped",
          description: "",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
        { name: "noprops", description: "", parameters: { type: "object", properties: {} } },
      ],
    })
  })

  it("rejects malformed shapes as invalid_client_tool", () => {
    reject("nope", "invalid_client_tool")
    reject([null], "invalid_client_tool")
    reject([{ name: 3 }], "invalid_client_tool")
    reject([tool({ description: 3 })], "invalid_client_tool")
    reject([tool({ parameters: [] })], "invalid_client_tool")
    reject([tool({ parameters: "x" })], "invalid_client_tool")
    reject([tool({ parameters: { type: "string" } })], "invalid_client_tool")
    reject([tool({ parameters: { type: "object", properties: [] } })], "invalid_client_tool")
  })

  it("rejects bad names", () => {
    reject([tool({ name: "has space" })], "invalid_client_tool_name")
    reject([tool({ name: "" })], "invalid_client_tool_name")
    reject([tool({ name: "a".repeat(65) })], "invalid_client_tool_name")
    reject([tool({ name: "client_x" })], "invalid_client_tool_name")
  })

  it("rejects duplicates", () => {
    reject([tool(), tool()], "duplicate_client_tool")
  })

  it("rejects oversize description and parameters", () => {
    reject([tool({ description: "a".repeat(1025) })], "client_tool_too_large")
    const result = reject(
      [
        tool({ description: "a".repeat(1024) }),
        tool({
          name: "big",
          parameters: {
            type: "object",
            properties: { p: { description: "z".repeat(9000) } },
          },
        }),
      ],
      "client_tool_too_large",
    )
    expect(JSON.stringify(result)).not.toContain("zzzz")
  })

  it("rejects more than 32 tools", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => tool({ name: `t${i}` }))
    expect(readClientToolDefinitions(many(MAX_CLIENT_TOOLS)).ok).toBe(true)
    reject(many(MAX_CLIENT_TOOLS + 1), "client_tool_budget_exceeded")
  })

  it("rejects a total over 32 KiB", () => {
    const tools = Array.from({ length: 32 }, (_, i) =>
      tool({
        name: `t${i}`,
        description: "d".repeat(1000),
        parameters: {
          type: "object",
          properties: { p: { description: "p".repeat(200) } },
        },
      }),
    )
    const total = tools.reduce(
      (n, t) => n + t.name.length + 1000 + JSON.stringify(t.parameters).length,
      0,
    )
    expect(total).toBeGreaterThan(MAX_CLIENT_TOOL_BLOCK)
    reject(tools, "client_tool_budget_exceeded")
  })

  it("pins the depth limit at 8 schema levels (top-level is level 1)", () => {
    expect(MAX_CLIENT_TOOL_DEPTH).toBe(8)
    for (const key of ["properties", "items"] as const) {
      const at = { name: "t", parameters: chain(MAX_CLIENT_TOOL_DEPTH, key) }
      const over = {
        name: "t",
        parameters: chain(MAX_CLIENT_TOOL_DEPTH + 1, key),
      }
      expect(readClientToolDefinitions([at]).ok).toBe(true)
      reject([over], "client_tool_too_deep")
    }
  })

  it("counts anyOf members and object additionalProperties as levels", () => {
    let s: Record<string, unknown> = { type: "string" }
    for (let i = 0; i < MAX_CLIENT_TOOL_DEPTH; i++) s = { anyOf: [s] }
    reject(
      [{ name: "t", parameters: { type: "object", properties: {}, ...s } }],
      "client_tool_too_deep",
    )
    let a: Record<string, unknown> = { type: "string" }
    for (let i = 0; i < MAX_CLIENT_TOOL_DEPTH; i++) a = { additionalProperties: a }
    reject([{ name: "t", parameters: { type: "object", ...a } }], "client_tool_too_deep")
    reject(
      [
        {
          name: "t",
          parameters: {
            type: "object",
            additionalProperties: true,
            properties: { x: chain(MAX_CLIENT_TOOL_DEPTH, "properties") },
          },
        },
      ],
      "client_tool_too_deep",
    )
  })

  it("accepts a 64-char name and rejects 65", () => {
    expect(readClientToolDefinitions([tool({ name: "a".repeat(64) })]).ok).toBe(true)
    reject([tool({ name: "a".repeat(65) })], "invalid_client_tool_name")
  })

  it("bounds parameters at exactly 8192 serialized characters", () => {
    const base = JSON.stringify({ type: "object", properties: { d: { description: "" } } }).length
    const withPad = (n: number) => ({
      type: "object",
      properties: { d: { description: "p".repeat(n) } },
    })
    const fit = 8192 - base
    expect(JSON.stringify(withPad(fit)).length).toBe(8192)
    expect(readClientToolDefinitions([tool({ parameters: withPad(fit) })]).ok).toBe(true)
    reject([tool({ parameters: withPad(fit + 1) })], "client_tool_too_large")
  })

  it("counts name length toward the block total", () => {
    const params = { type: "object", properties: {} }
    const paramLen = JSON.stringify(params).length
    const desc = "d".repeat(960)
    const mk = (nameLen: number) =>
      Array.from({ length: 32 }, (_, i) =>
        tool({
          name: `${String(i).padStart(2, "0")}${"n".repeat(nameLen - 2)}`,
          description: desc,
          parameters: params,
        }),
      )
    // Short names fit; 64-char names tip the same tools over the block budget.
    expect(32 * (2 + 960 + paramLen)).toBeLessThanOrEqual(MAX_CLIENT_TOOL_BLOCK)
    expect(32 * (64 + 960 + paramLen)).toBeGreaterThan(MAX_CLIENT_TOOL_BLOCK)
    expect(readClientToolDefinitions(mk(2)).ok).toBe(true)
    reject(mk(64), "client_tool_budget_exceeded")
  })
})
