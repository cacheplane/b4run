import { EMPTY_TURNS, reduceTurns, type TurnsView } from "@b4run/ag-ui/view"
import { describe, expect, test } from "vitest"
import { latestNavlogResult, navlogAnswerText } from "./navlog-selectors"
import { SAMPLE_NAVLOG } from "./navlog-types"
import {
  advisoryLabel,
  advisorySeverity,
  isPreliminary,
  latestWeatherBriefText,
  parseAdvisory,
  parseVerdictText,
  parseWeatherBrief,
  parseWindsLine,
  windsSummary,
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

describe("advisories", () => {
  test("parses the field form", () => {
    expect(
      parseAdvisory(
        "G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight",
      ),
    ).toEqual({
      product: "G-AIRMET",
      hazard: "FZLVL",
      altitudes: "freezing level 4,000 ft",
      valid: "2100Z–0300Z 07",
      relevance: "during flight",
      lowestFt: 4000,
      raw: "G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight",
    })
    const sigmet = parseAdvisory(
      "SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | expires before departure",
    )
    expect(sigmet.relevance).toBe("expires before departure")
    expect(sigmet.lowestFt).toBe(29000)
  })
  test("a free-text advisory keeps its text and has no relevance", () => {
    const free = parseAdvisory("AIRMET Sierra for mountain obscuration north of the route")
    expect(free.relevance).toBeNull()
    expect(free.raw).toBe("AIRMET Sierra for mountain obscuration north of the route")
  })
  test("severity: during flight is amber, red for icing or convection at or below cruise, else muted", () => {
    const fz = parseAdvisory(
      "G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight",
    )
    expect(advisorySeverity(fz, 5500)).toBe("warn")
    const ice = parseAdvisory(
      "G-AIRMET ICE | 3,000 ft to FL180 | valid 2100Z–0300Z 07 | during flight",
    )
    expect(advisorySeverity(ice, 5500)).toBe("danger")
    expect(advisorySeverity(ice, 2500)).toBe("warn")
    const later = parseAdvisory(
      "SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | starts after arrival",
    )
    expect(advisorySeverity(later, 5500)).toBe("muted")
    expect(advisorySeverity(parseAdvisory("something vague"), 5500)).toBe("muted")
  })
  test("labels read as words", () => {
    expect(
      advisoryLabel(
        parseAdvisory(
          "G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight",
        ),
      ),
    ).toBe("Freezing level 4,000 ft")
    expect(
      advisoryLabel(
        parseAdvisory(
          "SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | expires before departure",
        ),
      ),
    ).toBe("SIGMET Convective tops FL290")
  })
})

describe("winds aloft", () => {
  test("the older, wordy line reads compactly and drops temp NA", () => {
    const raw =
      "leg 1: 318/26, temp NA at 5,500 ft, MSP, based on 060000Z, valid 070000Z (FB chi region, 24-hour forecast used)"
    expect(parseWindsLine(raw)).toMatchObject({
      leg: 1,
      dir: 318,
      kt: 26,
      tempC: null,
      altitudeFt: 5500,
      station: "MSP",
      forecastHours: 24,
    })
    expect(windsSummary(raw)).toBe("Winds 5,500 ft: 318° at 26 kt (MSP, 24 h forecast)")
  })
  test("the contract line keeps its temperature", () => {
    expect(windsSummary("leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z")).toBe(
      "Winds 4,500 ft: 320° at 29 kt, −3 °C (MSP)",
    )
    expect(windsSummary("leg 2: 090/05 at 3000 ft")).toBe("Winds 3,000 ft: 090° at 5 kt")
  })
  test("an unparseable line passes through", () => {
    expect(windsSummary("winds unavailable")).toBe("winds unavailable")
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
