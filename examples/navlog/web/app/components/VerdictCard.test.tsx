import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { parseAdvisory, parseWeatherBrief } from "../lib/weather-selectors"
import { NavlogSheet } from "./NavlogSheet"
import { partitionAdvisories, VerdictCard } from "./VerdictCard"
import { WeatherStrip } from "./WeatherStrip"

const FZLVL = "G-AIRMET FZLVL | freezing level 4,000 ft | valid 2100Z–0300Z 07 | during flight"
const SIGMET = "SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | expires before departure"
const BRIEF = parseWeatherBrief(`Verdict: CAUTION — the freezing level is below the cruise.
Forecast horizon: Departure is 37 hours out; TAFs and winds aloft do not reach it yet, so this brief is preliminary.
Airports:
KSTP: VFR now, VFR at ETA, ceiling none. METAR KSTP 1 TAF KSTP 2
KRST: VFR now, VFR at ETA, ceiling none. METAR KRST 1 TAF KRST 2
Winds per leg:
leg 1: 318/26, temp NA at 5,500 ft, MSP, based on 060000Z, valid 070000Z (FB chi region, 24-hour forecast used)
Advisories:
${SIGMET}
${FZLVL}
Go/no-go note: Fly lower.`)

describe("VerdictCard", () => {
  test("shows the level as a word with an icon, the reason, and hazards loudest first", () => {
    const html = renderToStaticMarkup(
      <VerdictCard
        verdict={{ level: "NO-GO", reason: "Icing in the clouds." }}
        advisories={[parseAdvisory(SIGMET), parseAdvisory(FZLVL)]}
        cruiseFt={5500}
      />,
    )
    expect(html).toContain('data-level="NO-GO"')
    expect(html).toContain(">NO-GO<")
    expect(html).toContain("<svg")
    expect(html).toContain("Icing in the clouds.")
    expect(html.indexOf("Freezing level 4,000 ft")).toBeLessThan(html.indexOf("SIGMET Convective"))
    expect(html).toContain('data-severity="warn"')
    expect(html).toContain('data-severity="muted"')
    expect(html).toContain("· expires before departure")
  })
  test("shows the horizon only when it says the brief is preliminary", () => {
    const verdict = { level: "GO" as const, reason: "" }
    expect(
      renderToStaticMarkup(
        <VerdictCard
          verdict={verdict}
          horizon="Departure is 37 hours out; this brief is preliminary."
        />,
      ),
    ).toContain("Preliminary.")
    expect(
      renderToStaticMarkup(
        <VerdictCard verdict={verdict} horizon="Departure is within TAF coverage." />,
      ),
    ).not.toContain("Preliminary.")
  })
})

describe("WeatherStrip with the verdict contract", () => {
  test("a verdict pill, hazard chips, readable winds and the preliminary note", () => {
    const html = renderToStaticMarkup(<WeatherStrip brief={BRIEF} cruiseFt={5500} />)
    expect(html).toContain('class="wb-verdict-pill" data-level="CAUTION"')
    expect(html).toContain("Freezing level 4,000 ft")
    expect(html).toContain('data-severity="warn"')
    expect(html).toContain("Winds 5,500 ft: 318° at 26 kt (MSP, 24 h forecast)")
    expect(html).not.toMatch(/<summary[^>]*>[^<]*temp NA/)
    // The raw line stays available in the disclosure.
    expect(html).toContain("temp NA at 5,500 ft")
    expect(html).toContain("Preliminary.")
  })
})

describe("NavlogSheet verdict", () => {
  test("the weather brief's verdict tops the sheet, before the totals", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief=""
        weather={BRIEF}
        open={true}
        onToggle={() => {}}
      />,
    )
    expect(html).toContain('aria-label="Go/no-go verdict"')
    expect(html.indexOf("Go/no-go verdict")).toBeLessThan(html.indexOf('aria-label="Totals"'))
    expect(html).toContain("Freezing level 4,000 ft")
  })
  test("falls back to the planning answer's bottom line", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief={"Bottom line: GO — VFR all the way.\nWatch for:\n- Gusts at KRST"}
        open={true}
        onToggle={() => {}}
      />,
    )
    expect(html).toContain('data-level="GO"')
    expect(html).toContain("Watch for")
    expect(html).toContain("Gusts at KRST")
  })
  test("an old brief and an old answer show no verdict card", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief="KSTP and KRST are VFR."
        weather={parseWeatherBrief("Airports:\nKSTP: VFR now, VFR at ETA")}
        open={true}
        onToggle={() => {}}
      />,
    )
    expect(html).not.toContain("Go/no-go verdict")
    expect(html).toContain("KSTP and KRST are VFR.")
  })
  test("the brief drops echoed tool calls and the plan checklist", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief={
          'recall({ query: "aircraft profile and pilot preferences" })\nPlan and todos\n[completed] Recall\nKSTP and KRST are **VFR**.'
        }
        open={true}
        onToggle={() => {}}
      />,
    )
    expect(html).not.toContain("recall(")
    expect(html).not.toContain("[completed]")
    expect(html).toContain("<strong")
  })
  test("stat tiles carry the key totals, and the variation source is footnoted", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet navlog={SAMPLE_NAVLOG} brief="" open={true} onToggle={() => {}} />,
    )
    for (const label of ["Distance", "ETE", "Fuel burned", "Fuel at landing", "Reserve"]) {
      expect(html).toContain(`<dt>${label}</dt>`)
    }
    expect(html).toContain("Variation from the FAA airport record")
  })
  test("on the phone the verdict card comes first, and leg cards carry fuel remaining", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief=""
        weather={BRIEF}
        open={true}
        onToggle={() => {}}
        variant="cards"
        collapsible={false}
      />,
    )
    expect(html.indexOf("Go/no-go verdict")).toBeLessThan(html.indexOf("KSTP → KRST"))
    expect(html).toContain("Fuel rem")
    expect(html).toContain("WCA")
  })
})

describe("partitionAdvisories", () => {
  const line = (text: string) => parseAdvisory(text)
  test("collapses repeats and moves advisories outside the flight window out of the way", () => {
    const { relevant, outside } = partitionAdvisories(
      [
        line("G-AIRMET ICE | 11,000–17,000 ft | valid 0000Z–0300Z 06 | expires before departure"),
        line("G-AIRMET ICE | 11,000–17,000 ft | valid 0300Z–0600Z 06 | expires before departure"),
        line("G-AIRMET FZLVL | freezing level 4,000 ft | valid 1200Z–1800Z 06 | during flight"),
        line("SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | expires before departure"),
      ],
      5500,
    )
    expect(relevant.map((a) => a.hazard)).toEqual(["FZLVL"])
    expect(outside.map((a) => a.hazard)).toEqual(["ICE", "CONVECTIVE"])
  })
  test("keeps an advisory with no relevance (an older brief) on its own chip", () => {
    const { relevant, outside } = partitionAdvisories([line("Freezing level near 4,000 ft")])
    expect(relevant).toHaveLength(1)
    expect(outside).toHaveLength(0)
  })
})
