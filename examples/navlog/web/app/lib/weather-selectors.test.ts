import { EMPTY_TURNS, reduceTurns, type TurnsView } from "@b4run/ag-ui/view"
import { describe, expect, test } from "vitest"
import {
  categoryOf,
  latestWeatherBriefText,
  parseWeatherBrief,
  worstCategory,
} from "./weather-selectors"

type BaseEvent = Parameters<typeof reduceTurns>[1]
const T = (type: string, rest: Record<string, unknown>) =>
  ({ type, ...rest }) as unknown as BaseEvent
/** Fold AG-UI events through the real reducer, as the activity does. */
const fold = (events: readonly BaseEvent[]): TurnsView =>
  events.reduce((view, event) => reduceTurns(view, event, { now: () => 1 }), EMPTY_TURNS)
const runStart = T("RUN_STARTED", { threadId: "th", runId: "r1" })
const subagent = (id: string, name: string, result: unknown, outcome = "success"): BaseEvent[] => [
  T("SUBAGENT_STARTED", { subagentRunId: id, name, parentToolCallId: id }),
  T("SUBAGENT_FINISHED", {
    subagentRunId: id,
    outcome: { type: outcome },
    ...(result !== undefined ? { result } : {}),
  }),
]

const BRIEF = `Airports:
KSTP: VFR now, VFR at ETA, ceiling none, visibility 10 mi, wind 270 at 5. METAR KSTP 040253Z 27005KT 10SM CLR 14/12 A3008. TAF KSTP 040230Z ...
KRST: VFR now, MVFR at ETA, ceiling 8500 ft, visibility 9 mi, wind 260 at 11. METAR KRST 040254Z 26011KT 9SM OVC085 16/09 A3010. TAF KRST ...
Winds per leg:
leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z
Advisories: none
Go/no-go note: Rochester trends MVFR by 15Z; the 1400Z departure stays ahead of it.`

describe("parseWeatherBrief", () => {
  test("reads one row per airport with category now and at ETA", () => {
    const brief = parseWeatherBrief(BRIEF)
    expect(brief.airports).toEqual([
      {
        id: "KSTP",
        now: "VFR",
        atEta: "VFR",
        line: expect.stringContaining("ceiling none"),
        metar: "METAR KSTP 040253Z 27005KT 10SM CLR 14/12 A3008.",
        taf: "TAF KSTP 040230Z ...",
      },
      {
        id: "KRST",
        now: "VFR",
        atEta: "MVFR",
        line: expect.stringContaining("ceiling 8500 ft"),
        metar: "METAR KRST 040254Z 26011KT 9SM OVC085 16/09 A3010.",
        taf: "TAF KRST ...",
      },
    ])
  })
  test("reads the winds lines and the note", () => {
    const brief = parseWeatherBrief(BRIEF)
    expect(brief.winds).toEqual(["leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z"])
    expect(brief.note).toBe("Rochester trends MVFR by 15Z; the 1400Z departure stays ahead of it.")
  })
  test("a bulleted brief with bold headers parses to the same result", () => {
    const markdown = `**Airports:**
- KSTP, VFR now, VFR at ETA, ceiling none, visibility 10 mi, wind 270 at 5. METAR KSTP 040253Z 27005KT 10SM CLR 14/12 A3008. TAF KSTP 040230Z ...
- **KRST**: VFR now, MVFR at ETA, ceiling 8500 ft, visibility 9 mi, wind 260 at 11. METAR KRST 040254Z 26011KT 9SM OVC085 16/09 A3010. TAF KRST ...

**Winds per leg:**
- leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z

**Advisories:** none

## Go/no-go note:
Rochester trends MVFR by 15Z; the 1400Z departure stays ahead of it.`
    expect(parseWeatherBrief(markdown)).toEqual(parseWeatherBrief(BRIEF))
  })
  test("an airport may start on the Airports: line itself", () => {
    const brief = parseWeatherBrief(
      "Airports: KSTP: VFR now, VFR at ETA, clear. METAR KSTP 040253Z 27005KT 10SM CLR 14/12 A3008. TAF KSTP ...",
    )
    expect(brief.airports.map((a) => a.id)).toEqual(["KSTP"])
  })
  test("a SPECI is read as the raw report", () => {
    const brief = parseWeatherBrief(
      "Airports:\nKRST: MVFR now, IFR at ETA, ceiling 900 ft. SPECI KRST 041512Z 30015G25KT 3SM BR OVC009 12/11 A2992. TAF KRST ...",
    )
    expect(brief.airports[0]).toMatchObject({
      id: "KRST",
      now: "MVFR",
      atEta: "IFR",
      line: "MVFR now, IFR at ETA, ceiling 900 ft.",
      metar: "SPECI KRST 041512Z 30015G25KT 3SM BR OVC009 12/11 A2992.",
      taf: "TAF KRST ...",
    })
  })
  test("advisories other than none are kept, inline or bulleted", () => {
    const brief = parseWeatherBrief(
      "Advisories: AIRMET Sierra for IFR south of Rochester\n- PIREP light chop at 4500 ft",
    )
    expect(brief.advisories).toEqual([
      "AIRMET Sierra for IFR south of Rochester",
      "PIREP light chop at 4500 ft",
    ])
  })
  test("tolerates a brief that is not in the expected shape", () => {
    expect(parseWeatherBrief("nothing useful")).toEqual({
      airports: [],
      winds: [],
      advisories: [],
      note: "",
    })
  })
})

describe("worstCategory", () => {
  test("is the worse of now and at ETA, in either direction", () => {
    expect(worstCategory({ now: "VFR", atEta: "MVFR" })).toBe("MVFR")
    // Improving: MVFR now, VFR at ETA is still MVFR.
    expect(worstCategory({ now: "MVFR", atEta: "VFR" })).toBe("MVFR")
    expect(worstCategory({ now: "IFR", atEta: "LIFR" })).toBe("LIFR")
  })
  test("a known category beats UNKNOWN", () => {
    expect(worstCategory({ now: "VFR", atEta: "UNKNOWN" })).toBe("VFR")
    expect(worstCategory({ now: "UNKNOWN", atEta: "IFR" })).toBe("IFR")
    expect(worstCategory({ now: "UNKNOWN", atEta: "UNKNOWN" })).toBe("UNKNOWN")
  })
})

describe("categoryOf", () => {
  test("normalizes category words and falls back to UNKNOWN", () => {
    expect(categoryOf("mvfr")).toBe("MVFR")
    expect(categoryOf("Lifr at ETA")).toBe("LIFR")
    expect(categoryOf("")).toBe("UNKNOWN")
  })
})

describe("latestWeatherBriefText", () => {
  const AIRPORTS = "Airports:\nKSTP: VFR now, VFR at ETA, x. METAR a. TAF b\n"
  test("picks the newest done weather subagent, ignoring other names and unfinished runs", () => {
    const view = fold([
      runStart,
      ...subagent("a", "weather", AIRPORTS),
      ...subagent("b", "performance", "Cruise…"),
      T("SUBAGENT_STARTED", { subagentRunId: "c", name: "weather", parentToolCallId: "c" }),
    ])
    const text = latestWeatherBriefText(view)
    expect(text).toBe(AIRPORTS)
    expect(parseWeatherBrief(text as string).airports[0]?.id).toBe("KSTP")
  })
  test("skips a done weather run whose result has no airports, and a non-string result", () => {
    const view = fold([
      runStart,
      ...subagent("a", "weather", AIRPORTS),
      ...subagent("b", "weather", "getMetar failed; no brief."),
      ...subagent("c", "weather", { not: "text" }),
    ])
    expect(latestWeatherBriefText(view)).toBe(AIRPORTS)
  })
  test("unwraps a JSON-encoded result once, and finds a nested subagent", () => {
    const view = fold([
      runStart,
      ...subagent("outer", "planner", "plan"),
      T("SUBAGENT_STARTED", {
        subagentRunId: "w",
        name: "weather",
        parentSubagentRunId: "outer",
      }),
      T("SUBAGENT_FINISHED", {
        subagentRunId: "w",
        outcome: { type: "success" },
        result: JSON.stringify(AIRPORTS),
      }),
    ])
    expect(latestWeatherBriefText(view)).toBe(AIRPORTS)
  })
  test("is null for an empty view", () => {
    expect(latestWeatherBriefText(EMPTY_TURNS)).toBeNull()
  })
})

describe("parseWeatherBrief tolerates the markdown variants a model writes", () => {
  // A live run on 2026-10-07 drew no weather strip: the brief parsed to no
  // airports. These are the shapes a model plausibly used instead of the
  // contract's plain `KFCM: …` under a plain `Airports:` header.
  const metar = "METAR KFCM 071453Z 29013G23KT 10SM CLR 18/09 A2981"
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["bold header, colon outside the bold", `**Airports**:\n- KFCM: VFR now, VFR at ETA. ${metar}`],
    ["bold header, colon inside the bold", `**Airports:**\n- KFCM: VFR now, VFR at ETA. ${metar}`],
    ["heading marker", `### Airports\n- KFCM: VFR now, VFR at ETA. ${metar}`],
    ["em dash after the id", `Airports:\n- KFCM — VFR now, VFR at ETA. ${metar}`],
    ["en dash after the id", `Airports:\n- KFCM – VFR now, VFR at ETA. ${metar}`],
    ["hyphen after the id", `Airports:\n- KFCM - VFR now, VFR at ETA. ${metar}`],
    [
      "airport name in parentheses",
      `Airports:\n- KFCM (Flying Cloud): VFR now, VFR at ETA. ${metar}`,
    ],
    ["bold id and an em dash", `Airports:\n- **KFCM** — VFR now, VFR at ETA. ${metar}`],
    ["bullet dot", `Airports:\n• KFCM: VFR now, VFR at ETA. ${metar}`],
    ["numbered", `Airports:\n1. KFCM: VFR now, VFR at ETA. ${metar}`],
  ]
  for (const [name, text] of cases) {
    test(name, () => {
      const brief = parseWeatherBrief(text)
      expect(brief.airports.map((a) => [a.id, a.now, a.atEta])).toEqual([["KFCM", "VFR", "VFR"]])
      expect(brief.airports[0]?.metar).toBe(metar)
    })
  }
})
