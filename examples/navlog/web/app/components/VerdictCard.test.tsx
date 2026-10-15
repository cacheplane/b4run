// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { type AdvisoryFact, advisoryLine, type Forecast } from "../lib/forecast"
import { SAMPLE_FORECAST, SAMPLE_NAVLOG } from "../lib/test-fixtures"
import { type EffectiveVerdict, resolveVerdict } from "../lib/verdict"
import { NavlogSheet } from "./NavlogSheet"
import { VerdictCard, VerdictPill } from "./VerdictCard"
import { WeatherTab } from "./WeatherTab"

const FZLVL = SAMPLE_FORECAST.advisories[0] as AdvisoryFact
const ICE: AdvisoryFact = {
  product: "AIRMET",
  hazard: "ICE",
  lowestFt: 6000,
  highestFt: 14000,
  validFromUtc: "2026-10-12T18:00:00.000Z",
  validToUtc: "2026-10-13T00:00:00.000Z",
  relevance: "during-flight",
}
const SIGMET: AdvisoryFact = {
  product: "SIGMET",
  hazard: "CONVECTIVE",
  lowestFt: null,
  highestFt: 29000,
  validFromUtc: "2026-10-12T12:00:00.000Z",
  validToUtc: "2026-10-12T14:00:00.000Z",
  relevance: "before-departure",
}
const FLOOR_REASON = "freezing level 8,000 ft during the flight, below the 9,500 ft cruise"
const PRELIMINARY: Forecast = {
  ...SAMPLE_FORECAST,
  coverage: {
    preliminary: true,
    reasons: ["the KBDN TAF ends at 1200Z and does not cover the 1315Z ETA"],
  },
}

/** The text a reader sees, tags dropped. */
const text = (html: string): string => {
  const host = document.createElement("div")
  host.innerHTML = html
  return host.textContent ?? ""
}

/** A structured answer that is only a `BottomLine`: the planner's call. */
const bottomLine = (level: "GO" | "CAUTION" | "NO-GO", reason: string): string =>
  JSON.stringify({ ui: [{ BottomLine: { props: { level, reason, cite: [] } } }] })

describe("VerdictCard", () => {
  test("shows the level as a word with an icon, the reason, and the during-flight hazards", () => {
    const html = renderToStaticMarkup(
      <VerdictCard
        verdict={{ level: "NO-GO", reason: "Icing in the clouds." }}
        advisories={[SIGMET, FZLVL, ICE]}
        cruiseFt={9500}
      />,
    )
    expect(html).toContain('data-level="NO-GO"')
    expect(html).toContain(">NO-GO<")
    expect(html).toContain("<svg")
    expect(html).toContain("Icing in the clouds.")
    expect(html).toContain(advisoryLine(FZLVL))
    expect(html).toContain(advisoryLine(ICE))
    // Icing at or below the cruise is red; a freezing level is amber.
    expect(html).toContain('data-severity="danger"')
    expect(html).toContain('data-severity="warn"')
    expect(html.indexOf(advisoryLine(ICE))).toBeLessThan(html.indexOf(advisoryLine(FZLVL)))
    // An advisory outside the flight earns no chip on the card.
    expect(html).not.toContain(advisoryLine(SIGMET))
    expect(html).not.toContain('data-severity="muted"')
  })
  test("shows the preliminary note only when the forecast's coverage says so", () => {
    const verdict = { level: "GO" as const, reason: "" }
    expect(
      text(renderToStaticMarkup(<VerdictCard verdict={verdict} coverage={PRELIMINARY.coverage} />)),
    ).toContain("Preliminary: the KBDN TAF ends at 1200Z and does not cover the 1315Z ETA")
    expect(
      renderToStaticMarkup(<VerdictCard verdict={verdict} coverage={SAMPLE_FORECAST.coverage} />),
    ).not.toContain("Preliminary")
  })
})

/** The pill for a forecast alone, resolved as the sheet resolves it. */
const pillFor = (verdict: EffectiveVerdict | null): string =>
  verdict === null ? "" : renderToStaticMarkup(<VerdictPill verdict={verdict} />)

describe("the verdict contract outside the card", () => {
  test("the pill resolves CAUTION from the forecast's floor", () => {
    expect(pillFor(resolveVerdict({ forecast: SAMPLE_FORECAST }))).toContain(
      'class="wb-verdict-pill" data-level="CAUTION"',
    )
  })
  test("the Weather tab shows the advisory line, the winds and the preliminary note", () => {
    const html = renderToStaticMarkup(
      <WeatherTab forecast={PRELIMINARY} navlog={SAMPLE_NAVLOG} stations={[]} />,
    )
    expect(html).toContain(advisoryLine(FZLVL))
    expect(html).toContain("028° at 17 kt")
    expect(text(html)).toContain("Preliminary: the KBDN TAF ends at 1200Z")
  })
})

describe("NavlogSheet verdict", () => {
  test("the forecast's floor tops the sheet, before the totals", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        planningAnswer=""
        forecast={SAMPLE_FORECAST}
        open={true}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).toContain('aria-label="Verdict summary"')
    expect(html.indexOf("Verdict summary")).toBeLessThan(html.indexOf('aria-label="Totals"'))
    expect(html).toContain('aria-label="Go/no-go verdict"')
    expect(html).toContain(advisoryLine(FZLVL))
  })
  test("falls back to the planning answer's bottom line", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        planningAnswer={bottomLine("GO", "VFR all the way.")}
        open={true}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).toContain('class="wb-verdict" data-level="GO"')
    expect(html).toContain("VFR all the way.")
  })
  test("no forecast and a markdown answer show no verdict card and no planning brief", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        planningAnswer="KSTP and KRST are VFR."
        forecast={null}
        open={true}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).not.toContain("Go/no-go verdict")
    expect(html).not.toContain("Verdict summary")
    // A markdown answer stays in the chat: the sheet shows only a structured one.
    expect(html).not.toContain('aria-label="Planning brief"')
    expect(html).not.toContain("KSTP and KRST are VFR.")
  })
  test("stat tiles carry the key totals, and the variation source is footnoted", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        planningAnswer=""
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
        planningAnswer=""
        forecast={SAMPLE_FORECAST}
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

const PLANNER_GO = bottomLine("GO", "VFR the whole way at 9,500 ft.")
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
  test("a card from the floor alone says the computed forecast set it", () => {
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
    expect(html).toContain("From the computed forecast: KDLH IFR at ETA.")
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
  test("the pill raises the planner's GO to the floor's CAUTION", () => {
    const html = pillFor(resolveVerdict({ forecast: SAMPLE_FORECAST, answer: PLANNER_GO }))
    expect(html).toContain('class="wb-verdict-pill" data-level="CAUTION" data-raised="true"')
    expect(html).not.toContain('data-level="GO"')
  })
  test("the pill comes from the floor alone when there is no planner call", () => {
    const ifr: Forecast = {
      ...SAMPLE_FORECAST,
      verdictFloor: { level: "NO-GO", reasons: ["KBDN IFR at the 1905Z ETA"] },
    }
    const html = pillFor(resolveVerdict({ forecast: ifr }))
    expect(html).toContain('class="wb-verdict-pill" data-level="NO-GO"')
  })
  test("the sheet's card and the planning brief's bottom line agree on the raised level", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        planningAnswer={PLANNER_GO}
        forecast={SAMPLE_FORECAST}
        open={true}
        onToggle={() => {}}
        tab="brief"
        onTabChange={() => {}}
      />,
    )
    expect(html).toContain('class="wb-verdict" data-level="CAUTION"')
    expect(html).toContain(`Raised from GO: ${FLOOR_REASON}.`)
    const brief = html.slice(html.indexOf('aria-label="Planning brief"'))
    expect(brief).toContain('data-level="CAUTION"')
    expect(brief).not.toContain('data-level="GO"')
    expect(brief).toContain("VFR the whole way at 9,500 ft.")
    expect(brief).toContain(`The planner said GO. Raised: ${FLOOR_REASON}.`)
  })
  test("the collapsed sheet's pill is the raised one", () => {
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        planningAnswer={PLANNER_GO}
        forecast={SAMPLE_FORECAST}
        open={false}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).toContain('class="wb-verdict-pill" data-level="CAUTION" data-raised="true"')
  })
  test("a NO-GO floor (a short reserve) makes the sheet NO-GO over a GO call", () => {
    const thirsty: Forecast = {
      ...SAMPLE_FORECAST,
      verdictFloor: { level: "NO-GO", reasons: ["reserve 38 min, under 45"] },
    }
    const html = renderToStaticMarkup(
      <NavlogSheet
        navlog={SAMPLE_NAVLOG}
        planningAnswer={bottomLine("GO", "Fine.")}
        forecast={thirsty}
        open={true}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
      />,
    )
    expect(html).toContain('class="wb-verdict" data-level="NO-GO"')
    expect(html).toContain("Raised from GO: reserve 38 min, under 45.")
  })
})
