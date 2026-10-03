import { describe, expect, it } from "vitest"
import {
  describeToolDisplayProblem,
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
      sources: (results) => results.map((title) => ({ title })),
    }
    expect(describeToolDisplayProblem(full)).toBeUndefined()
    expect(describeToolDisplayProblem({})).toBeUndefined()
  })

  it("names the first problem it finds", () => {
    expect(describeToolDisplayProblem(null)).toBe("display must be an object")
    expect(describeToolDisplayProblem([])).toBe("display must be an object")
    expect(describeToolDisplayProblem({ icon: "nope" })).toBe(
      'display.icon must be one of search, read, write, run, web, memory, plan, agent, think, tool (got "nope")',
    )
    expect(describeToolDisplayProblem({ running: "Searching" })).toBe(
      "display.running must be a function (got string)",
    )
    expect(describeToolDisplayProblem({ sources: 1 })).toBe(
      "display.sources must be a function (got number)",
    )
    expect(describeToolDisplayProblem({ group: () => "" })).toBe(
      'display has an unknown key "group" (allowed: icon, running, done, sources)',
    )
  })
})
