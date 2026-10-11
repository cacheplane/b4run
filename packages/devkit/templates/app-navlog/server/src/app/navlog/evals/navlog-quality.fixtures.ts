import { script } from "@b4run/testing"

/**
 * The scripted conversations `navlog-quality.eval.ts` replays: the airports,
 * the aircraft, the tool sequence a live plan follows, and the structured
 * brief the model answers with. Kept apart from the eval so the eval file
 * reads as its dataset and scorers. `b4 eval` loads only `*.eval.ts` files,
 * so this module is never run as an eval of its own.
 */

// FAA airport records (lookupAirport), field elevation in feet, variation signed east.
export const KSTP = {
  id: "KSTP",
  kind: "airport",
  lat: 44.9346,
  lon: -93.0603,
  elevationFt: 705,
  magneticVariationDeg: 0,
}
export const KOWA = {
  id: "KOWA",
  kind: "airport",
  lat: 44.1234,
  lon: -93.2606,
  elevationFt: 1145,
  magneticVariationDeg: 0,
}
export const KRST = {
  id: "KRST",
  kind: "airport",
  lat: 43.9083,
  lon: -92.49,
  elevationFt: 1317,
  magneticVariationDeg: 0,
}
const AIRCRAFT = { tailNumber: "N738ZU", cruiseRpm: 2400, usableFuelGal: 50 }
export const BASELINE_AIRCRAFT = { tailNumber: "N734ST", cruiseRpm: 2400, usableFuelGal: 50 }
const WIND = { dirDegTrue: 320, speedKt: 20 }
const PROFILE = "pilot aircraft overrides and preferences"
const PLAN_TODOS = {
  todos: [
    {
      content:
        "Read the aircraft baseline, recall the pilot's overrides, and parse the route, altitude and departure time",
      status: "completed",
    },
    { content: "Brief the weather and look up POH performance", status: "in_progress" },
    { content: "Compute the navlog and save it to the workspace", status: "pending" },
    { content: "Brief the pilot and file only on request", status: "pending" },
  ],
}

interface BriefScript {
  readonly via: readonly string[]
  readonly departureUtc: string
  readonly reason: string
  readonly distanceNm: string
  readonly ete: string
  readonly fuelBurnedGal: string
  readonly fuelAtLandingGal: string
  readonly reserve: string
  readonly assumptions: readonly { statement: string; origin: "pilot" | "memory" | "default" }[]
  readonly closing: string
}

/**
 * A planning answer as the model returns it under the brief schema
 * (`brief-schema.json`), shaped after
 * live gpt-5-mini answers to these prompts but carrying the scripted run's own
 * numbers (computeNavlog's totals for the scripted winds), so the scripted
 * brief agrees with the navlog the tools compute in replay.
 */
export const planBrief = (brief: BriefScript): string =>
  JSON.stringify({
    ui: [
      { BottomLine: { props: { level: "GO", reason: brief.reason, cite: ["c2"] } } },
      {
        RouteSummary: {
          props: {
            from: "KSTP",
            to: "KRST",
            via: brief.via,
            altitudeFt: 4500,
            departureUtc: brief.departureUtc,
          },
        },
      },
      // The brief's only advisory, a convective SIGMET, ends hours before
      // departure, so the prompt leaves it out: nothing to watch.
      { WatchFor: { props: { items: [] } } },
      {
        KeyNumbers: {
          props: {
            items: [
              { label: "Distance", value: brief.distanceNm, unit: "nm", cite: [] },
              { label: "ETE (takeoff to landing)", value: brief.ete, unit: null, cite: [] },
              {
                label: "Fuel burned (includes 1.1 gal for start, taxi and takeoff)",
                value: brief.fuelBurnedGal,
                unit: "gal",
                cite: ["c1"],
              },
              { label: "Fuel at landing", value: brief.fuelAtLandingGal, unit: "gal", cite: [] },
              { label: "Reserve", value: brief.reserve, unit: null, cite: [] },
            ],
          },
        },
      },
      { Assumptions: { props: { items: brief.assumptions } } },
      {
        Citations: {
          props: {
            items: [
              { id: "c1", source: "poh/cruise-performance.md", locator: "Figure 5-7" },
              { id: "c2", source: "METAR KRST", locator: "1353Z" },
            ],
          },
        },
      },
      { Prose: { props: { markdown: brief.closing } } },
    ],
  })

export const DEPARTURE_1400 = {
  statement: "Departure 2026-10-06 1400Z",
  origin: "pilot",
} as const
export const ONE_ON_BOARD = {
  statement: "1 person on board assumed — tell me if different",
  origin: "default",
} as const
export const OFFER =
  "Want me to file the plan, try another altitude, or re-brief closer to departure?"
export const NOT_FILED =
  "As asked, I have not filed it; I can try another altitude or re-brief closer to departure."
export const DIRECT = {
  via: [],
  departureUtc: "2026-10-06 1400Z",
  reason: "KSTP and KRST are VFR now and at the 1433Z ETA, with no advisory during the flight.",
  distanceNm: "66",
  ete: "0:33",
  fuelBurnedGal: "5.5",
  fuelAtLandingGal: "44.5",
  reserve: "6:20",
} as const

interface PlanScript {
  readonly input: string
  readonly departureTimeUtc: string
  readonly waypoints: readonly (typeof KSTP)[]
  readonly navlogTable: string
  readonly brief: string
  readonly aircraft?: typeof AIRCRAFT
}

/**
 * The tool sequence a live plan follows, scripted so replay is keyless and
 * deterministic: the parent recalls, records todos, looks up each
 * airport, dispatches both subagents, computes the navlog and saves it. The
 * tools run for real (computeNavlog's numbers are the code's, not the
 * script's); the weather child's METAR and lookupAirport reach
 * aviationweather.gov. Each subagent and the judge answer in their own
 * thread, matched by their own first message; `judgeMatch` is the part of
 * the judge's prompt its scripted turn answers to.
 */
export function planFixtures(plan: PlanScript, judgeMatch: string) {
  const ids = plan.waypoints.map((wp) => wp.id)
  const coordinates = plan.waypoints.map((wp) => `${wp.id} (${wp.lat}, ${wp.lon})`).join(", ")
  const weatherInput = `Weather brief for ${coordinates} at 4500 ft, departure ${plan.departureTimeUtc}.`
  const performanceInput = `Performance for ${ids.join(", ")} at 4500 ft, cruise 2400 RPM.`
  let builder = script()
    .user(plan.input)
    .callsTool("readDoc", { path: "aircraft/c172n.md" })
    .callsTool("recall", { query: PROFILE })
    .callsTool("writeTodos", PLAN_TODOS)
  for (const id of ids) builder = builder.callsTool("lookupAirport", { id })
  return builder
    .callsTool("task", { subagent: "weather", input: weatherInput })
    .callsTool("task", { subagent: "performance", input: performanceInput })
    .callsTool("computeNavlog", {
      aircraft: plan.aircraft ?? AIRCRAFT,
      altitudeFt: 4500,
      departureTimeUtc: plan.departureTimeUtc,
      waypoints: plan.waypoints,
      winds: plan.waypoints.slice(1).map(() => WIND),
    })
    .callsTool("writeFile", { path: "reports/KSTP-KRST.md", content: plan.navlogTable })
    .replies(plan.brief)
    .user(weatherInput)
    .callsTool("getMetar", { ids })
    .replies(
      [
        "Verdict: GO — VFR at every airport now and at the ETA, with no advisory during the flight.",
        "Forecast horizon: Departure is within TAF and winds-aloft coverage.",
        "Airports:",
        ...ids.map(
          (id) =>
            `${id}: VFR now, VFR at ETA, ceiling none, visibility 10 mi, wind 320 at 8. METAR ${id} … TAF ${id} …`,
        ),
        "Winds per leg:",
        ...ids.slice(1).map((_, n) => `leg ${n + 1}: 320/20 5C at 4500 ft, MSP, valid 1800Z`),
        "Advisories:",
        "SIGMET CONVECTIVE | tops FL290 | valid 2355Z–0155Z 06 | expires before departure",
        "Go/no-go note: VFR throughout; the convective SIGMET ends hours before departure.",
      ].join("\n"),
    )
    .user(performanceInput)
    .callsTool("readDoc", { path: "poh/cruise-performance.md" })
    .replies(
      "Cruise at 4500 ft, 2400 RPM, standard temperature: 64% BHP at 4000 ft and 60% at 6000 ft, about 110 KTAS and 7.0 GPH interpolated [poh/cruise-performance.md, Figure 5-7].",
    )
    .user(judgeMatch)
    .replies('{"score":1,"reason":"names categories now and at ETA, fuel, reserve, cites 5-7"}')
}
