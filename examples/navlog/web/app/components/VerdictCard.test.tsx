import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { type EffectiveVerdict, resolveVerdict } from "../lib/verdict"
import { parseAdvisory, parseWeatherBrief } from "../lib/weather-selectors"
import { NavlogSheet } from "./NavlogSheet"
import { PlanningBrief } from "./PlanningBrief"
import { partitionAdvisories, VerdictCard, VerdictPill } from "./VerdictCard"
import { WeatherTab } from "./WeatherTab"

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

/** The pill for a brief alone, resolved as the sheet resolves it. */
const pillFor = (verdict: EffectiveVerdict | null): string =>
  verdict === null ? "" : renderToStaticMarkup(<VerdictPill verdict={verdict} />)

describe("the verdict contract outside the card", () => {
  test("the pill resolves CAUTION from the brief's verdict", () => {
    expect(pillFor(resolveVerdict({ weather: BRIEF, cruiseFt: 5500 }))).toContain(
      'class="wb-verdict-pill" data-level="CAUTION"',
    )
  })
  test("the Weather tab shows hazard chips, readable winds and the preliminary note", () => {
    const html = renderToStaticMarkup(
      <WeatherTab weather={BRIEF} navlog={SAMPLE_NAVLOG} stations={[]} cruiseFt={5500} />,
    )
    expect(html).toContain("Freezing level 4,000 ft")
    expect(html).toContain('data-severity="warn"')
    expect(html).toContain("318° at 26 kt (MSP, 24 h forecast)")
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
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).toContain('aria-label="Verdict summary"')
    expect(html.indexOf("Verdict summary")).toBeLessThan(html.indexOf('aria-label="Totals"'))
    expect(html).toContain('aria-label="Go/no-go verdict"')
    expect(html).toContain("Freezing level 4,000 ft")
  })
  test("falls back to the planning answer's bottom line", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief={"Bottom line: GO — VFR all the way.\nWatch for:\n- Gusts at KRST"}
        open={true}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
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
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).not.toContain("Go/no-go verdict")
    expect(html).not.toContain("Verdict summary")
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
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).not.toContain("recall(")
    expect(html).not.toContain("[completed]")
    expect(html).toContain("<strong")
  })
  test("stat tiles carry the key totals, and the variation source is footnoted", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief=""
        open={true}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    for (const label of ["Distance", "ETE", "Fuel burned", "Fuel at landing", "Reserve"]) {
      expect(html).toContain(`<dt>${label}</dt>`)
    }
    expect(html).toContain("Variation from the FAA airport record")
  })
  test("on the phone the verdict strip comes first, and leg cards carry fuel remaining", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief=""
        weather={BRIEF}
        open={true}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
        variant="cards"
        collapsible={false}
      />,
    )
    expect(html).toMatch(/<section aria-label="Verdict summary"[^>]*wb-verdict-strip/)
    expect(html.indexOf("wb-verdict-strip")).toBeLessThan(html.indexOf("wb-leg-card"))
    expect(html).toContain("Fuel rem")
    expect(html).toContain("WCA")
  })
})

/** The live run's brief: the agent said GO over gusts to 25 kt and a preliminary forecast. */
const GUSTY_GO = parseWeatherBrief(`Verdict: GO — VFR at both ends and light winds aloft.
Forecast horizon: Departure is 21 hours out; the TAFs do not reach it yet, so this brief is preliminary.
Airports:
KFCM: VFR now, VFR at ETA, wind 300 at 15 gusting 25. METAR KFCM 061553Z 30015G25KT 10SM CLR 08/M02 A3012 TAF KFCM 061120Z 0612/0712 30014G24KT P6SM SKC
KDLH: VFR now, VFR at ETA, wind 310 at 14 gusting 25. METAR KDLH 061555Z 31014G25KT 10SM BKN060 04/M03 A3009 TAF KDLH 061120Z 0612/0712 31012G22KT P6SM BKN060
Winds per leg:
leg 1: 318/26 -4C at 5,500 ft, MSP, valid 070000Z
Advisories:
none
Go/no-go note: Expect a gusty crosswind on landing.`)
const PLANNER_GO = `Bottom line: GO — VFR the whole way at 4,500 ft.
Watch for:
- Gusty crosswind at KDLH
Assumptions:
- 2400 RPM
- Standard temperature

Would you like me to file the VFR flight plan now, try a different altitude, or re-brief closer to departure?`
const RAISED = {
  level: "CAUTION" as const,
  reason: "VFR at both ends and light winds aloft.",
  raisedFrom: "GO" as const,
  floorReasons: ["gusts 25 kt at KDLH", "forecast preliminary"],
}

describe("a verdict the floor raised", () => {
  test("the card shows the raised level, why, and the agent's call as secondary text", () => {
    const html = renderToStaticMarkup(<VerdictCard verdict={RAISED} />)
    expect(html).toContain('data-level="CAUTION"')
    expect(html).toContain(">CAUTION<")
    expect(html).toContain("<svg")
    expect(html).toContain("Raised from GO: gusts 25 kt at KDLH, forecast preliminary.")
    expect(html).toContain("The agent said GO:")
    expect(html).toContain("VFR at both ends and light winds aloft.")
    expect(html.indexOf("Raised from GO")).toBeLessThan(html.indexOf("The agent said GO"))
  })
  test("a call the floor did not raise renders as before, with no note", () => {
    const html = renderToStaticMarkup(
      <VerdictCard verdict={{ level: "NO-GO", reason: "Icing in the clouds." }} />,
    )
    expect(html).not.toContain("Raised from")
    expect(html).not.toContain("The agent said")
    expect(html).toContain("Icing in the clouds.")
  })
  test("a card from the floor alone says the brief's data set it", () => {
    const html = renderToStaticMarkup(
      <VerdictCard
        verdict={{
          level: "NO-GO",
          reason: "",
          raisedFrom: null,
          floorReasons: ["KDLH IFR at ETA"],
        }}
      />,
    )
    expect(html).toContain(">NO-GO<")
    expect(html).toContain("From the brief&#x27;s data: KDLH IFR at ETA.")
    expect(html).not.toContain("The agent said")
  })
  test("the pill shows the raised level as word and icon, says raised, and explains in its title", () => {
    const html = renderToStaticMarkup(<VerdictPill verdict={RAISED} />)
    expect(html).toContain('data-level="CAUTION"')
    expect(html).toContain('data-raised="true"')
    expect(html).toContain("<svg")
    expect(html).toContain(">CAUTION<")
    expect(html).toContain(">raised<")
    expect(html).toContain('title="Raised from GO: gusts 25 kt at KDLH, forecast preliminary.')
  })
  test("an unraised pill carries no raised marker", () => {
    const html = renderToStaticMarkup(<VerdictPill verdict={{ level: "GO", reason: "Fine." }} />)
    expect(html).not.toContain("raised")
  })
  test("the pill raises the live run's GO to CAUTION", () => {
    const html = pillFor(resolveVerdict({ weather: GUSTY_GO, cruiseFt: 4500 }))
    expect(html).toContain('class="wb-verdict-pill" data-level="CAUTION" data-raised="true"')
    expect(html).not.toContain('data-level="GO"')
  })
  test("the pill comes from the floor alone for an old-format brief", () => {
    const old = parseWeatherBrief("Airports:\nKDLH: VFR now, IFR at ETA. METAR KDLH 1")
    const html = pillFor(resolveVerdict({ weather: old }))
    expect(html).toContain('class="wb-verdict-pill" data-level="NO-GO"')
  })
  test("the sheet's card and the planning brief's bottom line agree on the raised level", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief={PLANNER_GO}
        weather={GUSTY_GO}
        open={true}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).toContain('class="wb-verdict" data-level="CAUTION"')
    expect(html).toContain(
      "Raised from GO: gusts 25 kt at KFCM, gusts 25 kt at KDLH, forecast preliminary.",
    )
    const brief = html.slice(html.indexOf('aria-label="Planning brief"'))
    expect(brief).toContain('class="wb-verdict-pill" data-level="CAUTION"')
    expect(brief).not.toContain('data-level="GO"')
    expect(brief).toContain("VFR the whole way at 4,500 ft.")
    expect(brief).not.toContain("GO — VFR the whole way")
    expect(brief).toContain("The planner said GO. Raised: gusts 25 kt at KFCM")
    // The closing question is not an assumption: it follows the sections, screen only.
    expect(brief).toContain("Standard temperature")
    expect(brief).toMatch(/class="wb-brief-closing[^"]*print:hidden[^"]*"/)
    const assumptions = brief.slice(
      brief.indexOf(">Assumptions<"),
      brief.indexOf("wb-brief-closing"),
    )
    expect(assumptions).not.toContain("Would you like me to file")
    expect(brief).toContain("Would you like me to file the VFR flight plan now")
  })
  test("a structured answer's bottom line agrees with the sheet's raised card", () => {
    const structured = JSON.stringify({
      ui: [
        {
          BottomLine: {
            props: { level: "GO", reason: "VFR the whole way at 4,500 ft.", cite: [] },
          },
        },
      ],
    })
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief={structured}
        weather={GUSTY_GO}
        open={true}
        onToggle={() => {}}
        tab="brief"
        onTabChange={() => {}}
      />,
    )
    expect(html).toContain('class="wb-verdict" data-level="CAUTION"')
    const brief = html.slice(html.indexOf('aria-label="Planning brief"'))
    expect(brief).toContain('data-level="CAUTION"')
    expect(brief).not.toContain('data-level="GO"')
    expect(brief).toContain("VFR the whole way at 4,500 ft.")
    expect(brief).toContain("The planner said GO. Raised: gusts 25 kt at KFCM")
  })
  test("a planner call as severe as the card keeps its own bottom line", () => {
    const html = renderToStaticMarkup(
      <PlanningBrief
        text={"Bottom line: CAUTION — gusty.\nWatch for:\n- Gusts"}
        verdict={RAISED}
      />,
    )
    expect(html).toContain("CAUTION — gusty.")
    expect(html).not.toContain("The planner said")
  })
  test("the collapsed sheet's pill is the raised one", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        brief={PLANNER_GO}
        weather={GUSTY_GO}
        open={false}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).toContain('class="wb-verdict-pill" data-level="CAUTION" data-raised="true"')
  })
  test("a short reserve makes the sheet NO-GO over a GO call", () => {
    const thirsty = {
      ...SAMPLE_NAVLOG,
      totals: { ...SAMPLE_NAVLOG.totals, reserveMin: 38, reserveOk: false },
    }
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={thirsty}
        brief={"Bottom line: GO — fine."}
        open={true}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).toContain('class="wb-verdict" data-level="NO-GO"')
    expect(html).toContain("Raised from GO: reserve 0:38, under 45 min.")
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
