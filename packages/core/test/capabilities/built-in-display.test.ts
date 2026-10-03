import { describe, expect, it } from "vitest"
import { MEMORY_DISPLAY } from "../../src/capabilities/built-in/memory.js"
import { WRITE_TODOS_DISPLAY } from "../../src/capabilities/built-in/planning.js"
import { READ_SKILL_DISPLAY } from "../../src/capabilities/built-in/skills.js"
import { TASK_DISPLAY } from "../../src/capabilities/built-in/subagents.js"
import { WORKSPACE_DISPLAY } from "../../src/capabilities/built-in/workspace.js"

describe("built-in tool display", () => {
  it("workspace tools read as sentences", () => {
    expect(WORKSPACE_DISPLAY.readFile.running?.({ path: "corpus/a.md" })).toBe(
      "Reading corpus/a.md",
    )
    expect(WORKSPACE_DISPLAY.readFile.done?.({ path: "corpus/a.md" })).toBe("Read corpus/a.md")
    expect(WORKSPACE_DISPLAY.writeFile.done?.({ path: "r.md" })).toBe("Saved r.md")
    expect(WORKSPACE_DISPLAY.editFile.done?.({ path: "r.md" })).toBe("Edited r.md")
    expect(WORKSPACE_DISPLAY.listDir.done?.({ path: "corpus" })).toBe("Listed corpus")
    expect(WORKSPACE_DISPLAY.runBash.running?.({ command: "ls -la" })).toBe("Running ls -la")
    expect(WORKSPACE_DISPLAY.runBash.done?.({ command: "ls -la" })).toBe("Ran ls -la")
    expect(WORKSPACE_DISPLAY.runBash.done?.({ command: "ls\nrm -rf x" })).toBe("Ran ls")
    expect(WORKSPACE_DISPLAY.readFile.icon).toBe("read")
    expect(WORKSPACE_DISPLAY.runBash.icon).toBe("run")
  })

  it("memory, skills, plan and task read as sentences", () => {
    expect(MEMORY_DISPLAY.recall.running?.({ query: "agents" })).toBe(
      "Recalling \u201cagents\u201d",
    )
    expect(MEMORY_DISPLAY.recall.done?.({}, { result: "(no memories found)" })).toBe(
      "Checked memory, nothing relevant",
    )
    expect(MEMORY_DISPLAY.recall.done?.({}, { result: "a fact" })).toBe("Checked memory")
    expect(MEMORY_DISPLAY.remember.done?.()).toBe("Remembered this")
    expect(READ_SKILL_DISPLAY.icon).toBe("read")
    expect(READ_SKILL_DISPLAY.done?.({ name: "cite" })).toBe("Loaded the cite skill")
    expect(WRITE_TODOS_DISPLAY.done?.()).toBe("Updated the plan")
    expect(TASK_DISPLAY.running?.({ subagent: "researcher", input: "summarize ReAct" })).toBe(
      "Asking researcher to summarize ReAct",
    )
    expect(TASK_DISPLAY.done?.({ subagent: "researcher" })).toBe("Heard back from researcher")
    expect(TASK_DISPLAY.icon).toBe("agent")
  })

  it("running sentences", () => {
    const cases: Array<[string | undefined, string]> = [
      [MEMORY_DISPLAY.recall.running?.({}), "Checking memory"],
      [MEMORY_DISPLAY.remember.running?.(), "Remembering this"],
      [WRITE_TODOS_DISPLAY.running?.(), "Updating the plan"],
      [WORKSPACE_DISPLAY.writeFile.running?.({ path: "r.md" }), "Saving r.md"],
      [WORKSPACE_DISPLAY.editFile.running?.({ path: "r.md" }), "Editing r.md"],
      [WORKSPACE_DISPLAY.listDir.running?.({ path: "corpus" }), "Listing corpus"],
    ]
    for (const [actual, expected] of cases) expect(actual).toBe(expected)
  })

  it("every built-in display passes the SDK validator", async () => {
    const { describeToolDisplayProblem } = await import("@b4run/sdk")
    for (const display of [
      ...Object.values(WORKSPACE_DISPLAY),
      ...Object.values(MEMORY_DISPLAY),
      READ_SKILL_DISPLAY,
      WRITE_TODOS_DISPLAY,
      TASK_DISPLAY,
    ]) {
      expect(describeToolDisplayProblem(display)).toBeUndefined()
    }
  })
})
