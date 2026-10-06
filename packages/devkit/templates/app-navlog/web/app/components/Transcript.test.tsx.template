import type { SubagentRun } from "@b4run/ag-ui/react"
import { describe, expect, test, vi } from "vitest"

/** Importing CopilotKit for real pulls in CSS Node cannot load; nothing here uses it. */
vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotChatAssistantMessage: { MarkdownRenderer: () => null },
  useInterrupt: () => null,
  useRenderActivityMessage: () => ({ renderActivityMessage: () => null }),
  useRenderToolCall: () => () => null,
  useRenderTool: () => {},
  useSuggestions: () => ({ suggestions: [], reloadSuggestions: () => {} }),
}))

const { runsForToolCall } = await import("./Transcript")

function run(id: string, extra: Partial<SubagentRun> = {}): SubagentRun {
  return {
    subagentRunId: id,
    name: id,
    status: "completed",
    children: [],
    toolCalls: [],
    text: "",
    reasoning: "",
    ...extra,
  }
}

describe("subagents render where they ran", () => {
  const runs = new Map<string, SubagentRun>([
    ["w", run("w", { parentToolCallId: "call_task_weather", children: ["w-child"] })],
    ["w-child", run("w-child", { parentSubagentRunId: "w" })],
    ["p", run("p", { parentToolCallId: "call_task_perf" })],
  ])

  test("a task call gets its own run and everything nested under it", () => {
    expect([...runsForToolCall(runs, "call_task_weather").keys()]).toEqual(["w", "w-child"])
    expect([...runsForToolCall(runs, "call_task_perf").keys()]).toEqual(["p"])
  })

  test("a call that dispatched nothing gets nothing", () => {
    expect(runsForToolCall(runs, "call_other").size).toBe(0)
  })
})
