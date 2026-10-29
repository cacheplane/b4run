import { describe, expect, it, test } from "vitest"
import {
  describeToolDisplayProblem,
  isToolDisplayIcon,
  TOOL_DISPLAY_ICONS,
  TOOL_DISPLAY_LABEL_MAX,
  type ToolDisplay,
} from "../src/tool-display.ts"

describe("ToolDisplay", () => {
  it("lists the fixed icon set", () => {
    expect(TOOL_DISPLAY_ICONS).toEqual([
      "search",
      "read",
      "write",
      "run",
      "web",
      "memory",
      "plan",
      "agent",
      "think",
      "tool",
    ])
    expect(TOOL_DISPLAY_LABEL_MAX).toBe(120)
  })

  it("accepts a complete display and an empty one", () => {
    const full: ToolDisplay<{ query: string }, string[]> = {
      icon: "search",
      running: ({ query }) => `Searching for ${query}`,
      done: ({ query }, results) => `Found ${results.length} results for ${query}`,
      failed: ({ query }, error) => `Couldn't search for ${query}: ${error}`,
      sources: (results) => results.map((title) => ({ title })),
    }
    expect(describeToolDisplayProblem(full)).toBeUndefined()
    expect(describeToolDisplayProblem({})).toBeUndefined()
  })

  it("names the first problem it finds", () => {
    expect(describeToolDisplayProblem(null)).toBe("display must be an object")
    expect(describeToolDisplayProblem([])).toBe("display must be an object")
    expect(describeToolDisplayProblem({ icon: "" })).toBe(
      'display.icon must be a nonempty string (got "")',
    )
    expect(describeToolDisplayProblem({ running: "Searching" })).toBe(
      'display.running must be a function (got "Searching")',
    )
    expect(describeToolDisplayProblem({ failed: "Broke" })).toBe(
      'display.failed must be a function (got "Broke")',
    )
    expect(describeToolDisplayProblem({ sources: 1 })).toBe(
      "display.sources must be a function (got number)",
    )
    expect(describeToolDisplayProblem({ group: () => "" })).toBe(
      'display has an unknown key "group" (allowed: icon, running, done, failed, sources)',
    )
  })

  it("reports unknown keys before other problems", () => {
    expect(describeToolDisplayProblem({ group: 1, icon: "nope" })).toBe(
      'display has an unknown key "group" (allowed: icon, running, done, failed, sources)',
    )
  })

  it("names value types without throwing", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const prefix = "display.icon must be a nonempty string"
    expect(describeToolDisplayProblem({ icon: 1n })).toBe(`${prefix} (got bigint)`)
    expect(describeToolDisplayProblem({ icon: circular })).toBe(`${prefix} (got object)`)
    expect(describeToolDisplayProblem({ icon: () => 1 })).toBe(`${prefix} (got function)`)
    expect(describeToolDisplayProblem({ running: null })).toBe(
      "display.running must be a function (got null)",
    )
  })

  it("quotes invalid label values as prose, escaping quotes and control characters", () => {
    const prefix = "display.running must be a function"
    expect(describeToolDisplayProblem({ running: 'say "hi"\\' })).toBe(
      `${prefix} (got "say \\"hi\\"\\\\")`,
    )
    expect(describeToolDisplayProblem({ running: "a\nb\u0000" })).toBe(
      `${prefix} (got "a\\u000ab\\u0000")`,
    )
    expect(describeToolDisplayProblem({ running: "x".repeat(80) })).toBe(
      `${prefix} (got "${"x".repeat(60)}…")`,
    )
  })

  it("never throws on a hostile object", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom")
        },
      },
    )
    expect(describeToolDisplayProblem(hostile)).toBe("display could not be read")
  })

  it("narrows icon names", () => {
    expect(isToolDisplayIcon("search")).toBe(true)
    expect(isToolDisplayIcon("nope")).toBe(false)
    expect(isToolDisplayIcon(1)).toBe(false)
  })
})

test("accepts opaque nonempty icon names without changing authored input", () => {
  const displays = [
    "weather-radar",
    "constructor",
    "__proto__",
    " ",
    'say "hi"\\',
    "a\nb\u0000",
    "x".repeat(80),
  ].map((icon) => Object.freeze({ icon }))

  const problems = displays.map(describeToolDisplayProblem)

  expect(problems).toEqual(displays.map(() => undefined))
  expect(displays[0]).toEqual({ icon: "weather-radar" })
})

test("rejects empty and non-string authored icon values", () => {
  const icons = ["", null, 42, {}, [], true]

  const problems = icons.map((icon) => describeToolDisplayProblem({ icon }))

  expect(
    problems.every((problem) => problem?.startsWith("display.icon must be a nonempty string")),
  ).toBe(true)
})

test("keeps known-glyph membership separate from icon authoring validity", () => {
  const custom = ["weather-radar", "constructor", "__proto__", " "]

  const known = TOOL_DISPLAY_ICONS.map(isToolDisplayIcon)
  const opaque = custom.map(isToolDisplayIcon)

  expect(known).toEqual(TOOL_DISPLAY_ICONS.map(() => true))
  expect(opaque).toEqual(custom.map(() => false))
})
