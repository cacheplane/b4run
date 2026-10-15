import { EMPTY_TURNS, reduceTurns, type TurnsView } from "@b4run/ag-ui/view"
import { describe, expect, test } from "vitest"
import { readForecast } from "./forecast"
import { latestNavlogResult, navlogAnswerText, parseNavlog } from "./navlog-selectors"
import { SAMPLE_FORECAST, SAMPLE_NAVLOG } from "./test-fixtures"

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

describe("the forecast after a restore", () => {
  test("reads the forecast block from the latest computeNavlog result", () => {
    const withForecast = JSON.stringify({ ...SAMPLE_NAVLOG, forecast: SAMPLE_FORECAST })
    const view = fold([
      runStart,
      ...toolCall("n1", "computeNavlog", JSON.stringify(SAMPLE_NAVLOG)),
      ...toolCall("n2", "computeNavlog", withForecast),
    ])
    const ref = latestNavlogResult(view)
    expect(ref?.id).toBe("n2")
    const forecast = readForecast(parseNavlog(ref?.result ?? ""))
    expect(forecast).toEqual(SAMPLE_FORECAST)
    expect(forecast?.verdictFloor.level).toBe("CAUTION")
  })
  test("a navlog planned before the forecast block has none", () => {
    const view = fold([runStart, ...toolCall("n", "computeNavlog", JSON.stringify(SAMPLE_NAVLOG))])
    expect(readForecast(parseNavlog(latestNavlogResult(view)?.result ?? ""))).toBeNull()
  })
})

describe("navlogAnswerText", () => {
  const navlog = JSON.stringify(SAMPLE_NAVLOG)
  const call = (id: string) => ({
    id: `m-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [{ id, function: { name: "computeNavlog" } }],
  })
  const result = (id: string, content: string) => ({
    id: `r-${id}`,
    role: "tool",
    toolCallId: id,
    content,
  })
  test("is the answer after the result, not the preamble or a later reply", () => {
    const messages = [
      { id: "u1", role: "user", content: "Plan it" },
      { id: "a0", role: "assistant", content: 'recall({ query: "aircraft profile" })' },
      call("n"),
      result("n", navlog),
      { id: "a1", role: "assistant", content: "Bottom line: GO — VFR all the way." },
      { id: "u2", role: "user", content: "File it" },
      { id: "a2", role: "assistant", content: "Filed." },
    ]
    expect(navlogAnswerText(messages, "n")).toBe("Bottom line: GO — VFR all the way.")
  })
  test("a structured answer comes back whole, as the JSON the model wrote", () => {
    const structured = JSON.stringify({
      ui: [
        { BottomLine: { props: { level: "CAUTION", reason: "Gusts.", cite: [] } } },
        { Prose: { props: { markdown: 'recall({ query: "x" })\n\nWant me to file it?' } } },
      ],
    })
    const messages = [
      call("n"),
      result("n", navlog),
      { id: "a1", role: "assistant", content: structured },
      { id: "u2", role: "user", content: "File it" },
      { id: "a2", role: "assistant", content: JSON.stringify({ ui: [] }) },
    ]
    expect(navlogAnswerText(messages, "n")).toBe(structured)
    expect(JSON.parse(navlogAnswerText(messages, "n"))).toEqual(JSON.parse(structured))
  })
  test("is empty until the navlog turn answers, and when the id is not in the messages", () => {
    const messages = [
      { id: "u1", role: "user", content: "Plan it" },
      call("n"),
      result("n", navlog),
    ]
    expect(navlogAnswerText(messages, "n")).toBe("")
    expect(navlogAnswerText(messages, "missing")).toBe("")
  })
  test("follows a recomputed navlog (found in the turns) to its own turn", () => {
    const second = JSON.stringify({ ...SAMPLE_NAVLOG, altitudeFt: 6500 })
    const messages = [
      call("n1"),
      result("n1", navlog),
      { id: "a1", role: "assistant", content: "First answer." },
      { id: "u2", role: "user", content: "Try 6500" },
      call("n2"),
      result("n2", second),
      { id: "a2", role: "assistant", content: [{ type: "text", text: "Second answer." }] },
    ]
    const view = fold([
      runStart,
      ...toolCall("n1", "computeNavlog", navlog),
      ...toolCall("n2", "computeNavlog", second),
    ])
    const ref = latestNavlogResult(view)
    expect(ref?.id).toBe("n2")
    expect(navlogAnswerText(messages, ref?.id as string)).toBe("Second answer.")
  })
})
