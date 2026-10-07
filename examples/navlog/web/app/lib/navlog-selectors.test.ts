import { EMPTY_TURNS, reduceTurns, type TurnsView } from "@b4run/ag-ui/view"
import { describe, expect, test } from "vitest"
import {
  isAwaitingApproval,
  latestNavlogResult,
  latestToolResult,
  parseNavlog,
} from "./navlog-selectors"
import { SAMPLE_NAVLOG } from "./navlog-types"

type BaseEvent = Parameters<typeof reduceTurns>[1]
const T = (type: string, rest: Record<string, unknown>) =>
  ({ type, ...rest }) as unknown as BaseEvent
/** Fold AG-UI events through the real reducer, as the activity does. */
const fold = (events: readonly BaseEvent[]): TurnsView =>
  events.reduce((view, event) => reduceTurns(view, event, { now: () => 1 }), EMPTY_TURNS)
const runStart = T("RUN_STARTED", { threadId: "th", runId: "r1" })
const toolCall = (id: string, name: string, result: string, owner?: string): BaseEvent[] => [
  T("TOOL_CALL_START", {
    toolCallId: id,
    toolCallName: name,
    ...(owner ? { subagentRunId: owner } : {}),
  }),
  T("TOOL_CALL_END", { toolCallId: id, ...(owner ? { subagentRunId: owner } : {}) }),
  T("TOOL_CALL_RESULT", {
    messageId: `r-${id}`,
    toolCallId: id,
    content: result,
    ...(owner ? { subagentRunId: owner } : {}),
  }),
]
const subagent = (id: string, name: string, result: unknown, outcome = "success"): BaseEvent[] => [
  T("SUBAGENT_STARTED", { subagentRunId: id, name, parentToolCallId: id }),
  T("SUBAGENT_FINISHED", {
    subagentRunId: id,
    outcome: { type: outcome },
    ...(result !== undefined ? { result } : {}),
  }),
]

const GOOD = JSON.stringify(SAMPLE_NAVLOG)

describe("parseNavlog", () => {
  test("accepts the server's Navlog JSON", () => {
    expect(parseNavlog(GOOD)?.totals.distanceNm).toBe(66)
  })
  test("unwraps a { result } envelope and rejects anything else", () => {
    expect(parseNavlog(JSON.stringify({ result: SAMPLE_NAVLOG }))?.legs).toHaveLength(2)
    expect(parseNavlog("not json")).toBeNull()
    expect(parseNavlog(JSON.stringify({ legs: "nope" }))).toBeNull()
  })
})

describe("latestNavlogResult", () => {
  test("returns the newest computeNavlog result with its tool-call id", () => {
    const older = JSON.stringify({
      ...SAMPLE_NAVLOG,
      totals: { ...SAMPLE_NAVLOG.totals, distanceNm: 1 },
    })
    const view = fold([
      runStart,
      ...toolCall("c1", "computeNavlog", older),
      ...toolCall("c2", "readDoc", '{"content":"x"}'),
      ...toolCall("c3", "computeNavlog", GOOD),
    ])
    expect(latestNavlogResult(view)).toEqual({ id: "c3", result: GOOD })
  })
  test("a later failed call leaves the last good navlog up", () => {
    const view = fold([
      runStart,
      ...toolCall("c1", "computeNavlog", GOOD),
      ...toolCall("c2", "computeNavlog", "Error: computeNavlog needs one wind entry per leg (1)"),
    ])
    expect(latestNavlogResult(view)).toEqual({ id: "c1", result: GOOD })
  })
  test("searches newer turns first and recurses into subagent turns", () => {
    const view = fold([
      runStart,
      ...subagent("sa", "performance", "ok"),
      ...toolCall("n1", "computeNavlog", GOOD, "sa"),
      T("RUN_FINISHED", { threadId: "th", runId: "r1" }),
    ])
    expect(latestNavlogResult(view)?.id).toBe("n1")
  })
  test("is null with no navlog, with a call still running, and for an empty view", () => {
    const running = fold([
      runStart,
      T("TOOL_CALL_START", { toolCallId: "c1", toolCallName: "computeNavlog" }),
    ])
    expect(latestNavlogResult(running)).toBeNull()
    expect(latestNavlogResult(EMPTY_TURNS)).toBeNull()
  })
  test("latestToolResult filters by name and accept", () => {
    const view = fold([
      runStart,
      ...toolCall("a", "readDoc", "one"),
      ...toolCall("b", "readDoc", "two"),
    ])
    expect(latestToolResult(view, "readDoc", () => true)?.id).toBe("b")
    expect(latestToolResult(view, "readDoc", (r) => r === "one")?.id).toBe("a")
    expect(latestToolResult(view, "other", () => true)).toBeNull()
  })
})

describe("isAwaitingApproval", () => {
  test("is true only when the last turn is awaiting", () => {
    expect(isAwaitingApproval(EMPTY_TURNS)).toBe(false)
    expect(isAwaitingApproval(fold([runStart]))).toBe(false)
    const awaiting = fold([
      runStart,
      T("RUN_FINISHED", {
        threadId: "th",
        runId: "r1",
        outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "tool", message: "ok?" }] },
      }),
    ])
    expect(isAwaitingApproval(awaiting)).toBe(true)
  })
})
