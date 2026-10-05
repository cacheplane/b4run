import { describe, expect, test } from "vitest"
import { categoryOf, latestWeatherBrief, parseWeatherBrief } from "./weather-selectors"

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

describe("categoryOf", () => {
  test("normalizes category words and falls back to UNKNOWN", () => {
    expect(categoryOf("mvfr")).toBe("MVFR")
    expect(categoryOf("Lifr at ETA")).toBe("LIFR")
    expect(categoryOf("")).toBe("UNKNOWN")
  })
})

describe("latestWeatherBrief", () => {
  test("picks the most recent completed weather run", () => {
    const runs = [
      {
        id: "a",
        name: "weather",
        status: "completed" as const,
        result: "Airports:\nKSTP: VFR now, VFR at ETA, x. METAR a. TAF b\n",
        toolCalls: [],
      },
      {
        id: "b",
        name: "performance",
        status: "completed" as const,
        result: "Cruise…",
        toolCalls: [],
      },
      { id: "c", name: "weather", status: "running" as const, toolCalls: [] },
    ]
    expect(latestWeatherBrief(runs)?.airports[0]?.id).toBe("KSTP")
    expect(latestWeatherBrief([])).toBeNull()
  })
})
