import { describe, expect, it } from "vitest"
import { isToolDenial, TOOL_DENIAL, toolDenial } from "../src/tool-denial.ts"

describe("toolDenial", () => {
  it("brands the reason under a symbol and keeps `result` as the only enumerable key", () => {
    const denial = toolDenial("[B4_E3001] Permission denied by user: tool deployProd")
    expect(denial.result).toBe("[B4_E3001] Permission denied by user: tool deployProd")
    expect(denial[TOOL_DENIAL]).toBe(true)
    expect(Object.keys(denial)).toEqual(["result"])
    expect(isToolDenial(denial)).toBe(true)
  })

  it("is the same brand across module copies (Symbol.for)", () => {
    expect(isToolDenial({ [Symbol.for("b4run.toolDenial")]: true, result: "no" })).toBe(true)
  })

  it("rejects the unbranded wrapper shape, plain strings and a non-string result", () => {
    expect(isToolDenial({ result: "Permission denied" })).toBe(false)
    expect(isToolDenial("Permission denied")).toBe(false)
    expect(isToolDenial({ [TOOL_DENIAL]: true, result: 42 })).toBe(false)
    expect(isToolDenial({ [TOOL_DENIAL]: "true", result: "no" })).toBe(false)
    expect(isToolDenial(null)).toBe(false)
    expect(isToolDenial(undefined)).toBe(false)
  })
})
