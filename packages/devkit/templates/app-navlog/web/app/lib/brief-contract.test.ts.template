import { describe, expect, test } from "vitest"
import { navlogAnswerText } from "./navlog-selectors"
import { SAMPLE_NAVLOG } from "./navlog-types"
import {
  advisoryLabel,
  advisorySeverity,
  isPreliminary,
  parseAdvisory,
  parseVerdictText,
  parseWeatherBrief,
  parseWindsLine,
  weatherBriefTextFromMessages,
  windsSummary,
} from "./weather-selectors"

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
      reason: "the freezing level is 4,000 ft, below the 5,500 ft cruise.",
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
    expect(brief.verdict).toEqual({ level: "NO-GO", reason: "icing in the clouds." })
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

const call = (id: string, name: string, args: unknown) => ({
  id: `m-${id}`,
  role: "assistant",
  content: "",
  toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
})
const result = (id: string, content: string) => ({
  id: `r-${id}`,
  role: "tool",
  toolCallId: id,
  content,
})

describe("weather after a reload", () => {
  test("reads the weather brief from the parent's task call result", () => {
    const messages = [
      { id: "u", role: "user", content: "Plan KFCM to KDLH" },
      call("t1", "task", { subagent: "performance", input: "cruise numbers" }),
      result("t1", "Cruise 2400 RPM…"),
      call("t2", "task", { subagent: "weather", input: "brief the route" }),
      result("t2", NEW_BRIEF),
    ]
    const text = weatherBriefTextFromMessages(messages)
    expect(text).toBe(NEW_BRIEF)
    expect(parseWeatherBrief(text as string).airports[0]?.id).toBe("KFCM")
  })
  test("the latest weather task wins, a JSON-encoded result is unwrapped, and no task is null", () => {
    const older = NEW_BRIEF.replace("KFCM", "KSTP")
    const messages = [
      call("a", "task", { subagent: "weather", input: "x" }),
      result("a", older),
      call("b", "task", { subagent: "weather", input: "y" }),
      result("b", JSON.stringify(NEW_BRIEF)),
      call("c", "task", { subagent: "weather", input: "z" }),
      result("c", "getMetar failed; no brief."),
    ]
    expect(weatherBriefTextFromMessages(messages)).toBe(NEW_BRIEF)
    expect(weatherBriefTextFromMessages([])).toBeNull()
  })
})

describe("navlogAnswerText", () => {
  const navlog = JSON.stringify(SAMPLE_NAVLOG)
  test("is the planning answer of the turn that computed the navlog, not a later reply", () => {
    const messages = [
      { id: "u1", role: "user", content: "Plan it" },
      { id: "a0", role: "assistant", content: 'recall({ query: "aircraft profile" })' },
      call("n", "computeNavlog", {}),
      result("n", navlog),
      { id: "a1", role: "assistant", content: "Bottom line: GO — VFR all the way." },
      { id: "u2", role: "user", content: "File it" },
      { id: "a2", role: "assistant", content: "Filed." },
    ]
    expect(navlogAnswerText(messages)).toBe("Bottom line: GO — VFR all the way.")
  })
  test("is empty until the navlog turn answers, and with no navlog", () => {
    expect(
      navlogAnswerText([
        { id: "u1", role: "user", content: "Plan it" },
        call("n", "computeNavlog", {}),
        result("n", navlog),
      ]),
    ).toBe("")
    expect(navlogAnswerText([{ id: "a", role: "assistant", content: "Hi" }])).toBe("")
  })
  test("follows a recomputed navlog to its own turn", () => {
    const messages = [
      call("n1", "computeNavlog", {}),
      result("n1", navlog),
      { id: "a1", role: "assistant", content: "First answer." },
      { id: "u2", role: "user", content: "Try 6500" },
      call("n2", "computeNavlog", {}),
      result("n2", JSON.stringify({ ...SAMPLE_NAVLOG, altitudeFt: 6500 })),
      { id: "a2", role: "assistant", content: "Second answer." },
    ]
    expect(navlogAnswerText(messages)).toBe("Second answer.")
  })
})
