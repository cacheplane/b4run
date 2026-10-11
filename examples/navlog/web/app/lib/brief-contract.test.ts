import { EMPTY_TURNS, reduceTurns, type TurnsView } from "@b4run/ag-ui/view"
import { describe, expect, test } from "vitest"
import { latestNavlogResult, navlogAnswerText } from "./navlog-selectors"
import { SAMPLE_NAVLOG } from "./test-fixtures"
import {
  isPreliminary,
  latestWeatherBriefText,
  parseVerdictText,
  parseWeatherBrief,
} from "./weather-selectors"

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

/** The weather brief in the verdict contract: verdict and horizon first, advisories as fields. */
const NEW_BRIEF = `Verdict: CAUTION — the freezing level is 4,000 ft, below the 5,500 ft cruise.
Forecast horizon: Departure is 37 hours out; TAFs and winds aloft do not reach it yet, so this brief is preliminary.
Airports:
KFCM: VFR now, VFR at ETA, ceiling none, visibility 10 mi, wind 300 at 8. METAR KFCM 061553Z 30008KT 10SM CLR 08/M02 A3012 TAF KFCM 061120Z …
KDLH: VFR now, VFR at ETA, ceiling 6000 ft, visibility 10 mi, wind 310 at 12. METAR KDLH 061555Z 31012KT 10SM BKN060 04/M03 A3009 TAF KDLH 061120Z …
Winds per leg:
leg 1: 318/26 -4C at 5,500 ft, MSP, valid 070000Z
Advisories:
G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight
SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | expires before departure
Go/no-go note: Plan a lower cruise or wait for the freezing level to rise.`

describe("the verdict contract", () => {
  test("reads the verdict, its reason and the horizon", () => {
    const brief = parseWeatherBrief(NEW_BRIEF)
    expect(brief.verdict).toEqual({
      level: "CAUTION",
      reason: "The freezing level is 4,000 ft, below the 5,500 ft cruise.",
    })
    expect(brief.horizon).toMatch(/^Departure is 37 hours out/)
    expect(isPreliminary(brief.horizon)).toBe(true)
    expect(brief.airports.map((a) => a.id)).toEqual(["KFCM", "KDLH"])
    expect(brief.advisories).toHaveLength(2)
    expect(brief.note).toBe("Plan a lower cruise or wait for the freezing level to rise.")
  })
  test("a brief without the new lines parses as before, with no verdict or horizon", () => {
    const old = NEW_BRIEF.split("\n").slice(2).join("\n")
    const brief = parseWeatherBrief(old)
    expect(brief.verdict).toBeUndefined()
    expect(brief.horizon).toBeUndefined()
    expect("verdict" in brief).toBe(false)
    expect(brief.airports).toHaveLength(2)
  })
  test("a bold, bulleted verdict still reads", () => {
    const brief = parseWeatherBrief(
      `- **Verdict:** **NO-GO** - icing in the clouds.\nAirports:\nKSTP: VFR now, VFR at ETA`,
    )
    expect(brief.verdict).toEqual({ level: "NO-GO", reason: "Icing in the clouds." })
  })
  test("verdict words: GO, CAUTION, NO-GO, NO GO, NOGO; anything else is null", () => {
    expect(parseVerdictText("GO — clear skies")?.level).toBe("GO")
    expect(parseVerdictText("caution: gusts")?.level).toBe("CAUTION")
    expect(parseVerdictText("No go - storms")?.level).toBe("NO-GO")
    expect(parseVerdictText("NOGO")?.level).toBe("NO-GO")
    expect(parseVerdictText("GOOD to go")).toBeNull()
    expect(parseVerdictText("Probably fine")).toBeNull()
  })
  test("a horizon inside the forecasts is not preliminary", () => {
    expect(isPreliminary("Departure is within TAF and winds-aloft coverage.")).toBe(false)
    expect(isPreliminary(undefined)).toBe(false)
  })
})

describe("the brief after a restore", () => {
  test("reads the weather brief from the nested weather subagent's result", () => {
    const view = fold([
      runStart,
      ...subagent("p", "performance", "Cruise 2400 RPM…"),
      ...subagent("w", "weather", NEW_BRIEF),
    ])
    const text = latestWeatherBriefText(view)
    expect(text).toBe(NEW_BRIEF)
    expect(parseWeatherBrief(text as string).airports[0]?.id).toBe("KFCM")
  })
  test("the latest weather run wins and a JSON-encoded result is unwrapped", () => {
    const view = fold([
      runStart,
      ...subagent("a", "weather", NEW_BRIEF.replace("KFCM", "KSTP")),
      ...subagent("b", "weather", JSON.stringify(NEW_BRIEF)),
      ...subagent("c", "weather", "getMetar failed; no brief."),
    ])
    expect(latestWeatherBriefText(view)).toBe(NEW_BRIEF)
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
