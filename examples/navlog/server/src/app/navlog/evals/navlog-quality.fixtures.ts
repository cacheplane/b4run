import { script } from "@b4run/testing"
import { parseUtcInstant } from "../../../lib/fpl.js"

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
const PROFILE = "pilot aircraft overrides and preferences"
const PLAN_TODOS = {
  todos: [
    {
      content:
        "Read the aircraft baseline, recall the pilot's overrides, and parse the route, altitude and departure time",
      status: "completed",
    },
    {
      content: "Find the weather stations along the route and look up POH performance",
      status: "in_progress",
    },
    {
      content: "Compute the navlog and its forecast and save it to the workspace",
      status: "pending",
    },
    { content: "Brief the pilot and file only on request", status: "pending" },
  ],
}

/**
 * A request's clock-time departure as resolveDeparture resolves it: the next
 * occurrence, from the moment the eval loads. computeNavlog fetches the live
 * winds, METARs, TAFs and advisories for the time the flight is flown, so a
 * fixed date would fall behind them; the next 1400Z is always within the
 * 24-hour winds product and the TAFs.
 */
export const departureAt = (clock: string): { iso: string; brief: string } => {
  const iso = parseUtcInstant(clock).toISOString()
  return { iso, brief: `${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}Z` }
}
export const DEPARTURE_1400Z = departureAt("1400Z")
export const DEPARTURE_1500Z = departureAt("1500Z")

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
 * numbers (computeNavlog's totals), so the scripted brief agrees with the
 * navlog the tools compute in replay.
 *
 * The level is NO-GO. computeNavlog's verdict floor is computed in replay from
 * the live forecast, which can be GO, CAUTION or NO-GO on any day, while this
 * answer is fixed text. NO-GO is at or above every floor, so the
 * bottom-line-respects-floor scorer checks the replayed run's real floor
 * against the answer without failing on the day's weather. The answer states
 * no weather fact for the same reason: it cannot know the day's forecast.
 */
export const planBrief = (brief: BriefScript): string =>
  JSON.stringify({
    ui: [
      { BottomLine: { props: { level: "NO-GO", reason: brief.reason, cite: [] } } },
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
      // The answer names no advisory, since it cannot know the day's forecast.
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
            items: [{ id: "c1", source: "poh/cruise-performance.md", locator: "Figure 5-7" }],
          },
        },
      },
      { Prose: { props: { markdown: brief.closing } } },
    ],
  })

export const DEPARTURE_1400 = {
  statement: `Departure ${DEPARTURE_1400Z.brief}`,
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
  departureUtc: DEPARTURE_1400Z.brief,
  reason: "Hold the flight until a re-brief closer to departure confirms KSTP and KRST VFR.",
  distanceNm: "66",
  ete: "0:33",
  fuelBurnedGal: "5.5",
  fuelAtLandingGal: "44.5",
  reserve: "6:20",
} as const

interface PlanScript {
  readonly input: string
  /** The departure as the pilot wrote it, a UTC clock time such as 1400Z. */
  readonly departure: string
  readonly waypoints: readonly (typeof KSTP)[]
  readonly navlogTable: string
  readonly brief: string
  readonly aircraft?: typeof AIRCRAFT
}

/**
 * The tool sequence a live plan follows, scripted so replay is keyless and
 * deterministic: the parent reads the baseline, recalls, resolves the
 * departure, records todos, looks up each airport, finds the stations along
 * the route, dispatches the performance subagent, computes the navlog and its
 * forecast, and saves it. The tools run for real (computeNavlog's numbers and
 * forecast are the code's, not the script's); lookupAirport,
 * findRouteStations and computeNavlog reach aviationweather.gov. The scripted
 * computeNavlog call passes no stations: the stations findRouteStations finds
 * are live, so a script cannot know them, and the floor then reads the origin
 * and destination only. The subagent and the judge answer in their own
 * thread, matched by their own first message; `judgeMatch` is the part of the
 * judge's prompt its scripted turn answers to.
 */
export function planFixtures(plan: PlanScript, judgeMatch: string) {
  const ids = plan.waypoints.map((wp) => wp.id)
  const performanceInput = `Performance for ${ids.join(", ")} at 4500 ft, cruise 2400 RPM.`
  let builder = script()
    .user(plan.input)
    .callsTool("readDoc", { path: "aircraft/c172n.md" })
    .callsTool("recall", { query: PROFILE })
    .callsTool("resolveDeparture", { departure: plan.departure })
    .callsTool("writeTodos", PLAN_TODOS)
  for (const id of ids) builder = builder.callsTool("lookupAirport", { id })
  return builder
    .callsTool("findRouteStations", {
      waypoints: plan.waypoints.map(({ id, kind }) => ({ id, kind })),
    })
    .callsTool("task", { subagent: "performance", input: performanceInput })
    .callsTool("computeNavlog", {
      aircraft: plan.aircraft ?? AIRCRAFT,
      altitudeFt: 4500,
      departureTimeUtc: departureAt(plan.departure).iso,
      waypoints: plan.waypoints,
      stations: [],
      personsOnBoard: 1,
    })
    .callsTool("writeFile", { path: "reports/KSTP-KRST.md", content: plan.navlogTable })
    .replies(plan.brief)
    .user(performanceInput)
    .callsTool("readDoc", { path: "poh/cruise-performance.md" })
    .replies(
      "Cruise at 4500 ft, 2400 RPM, standard temperature: 64% BHP at 4000 ft and 60% at 6000 ft, about 110 KTAS and 7.0 GPH interpolated [poh/cruise-performance.md, Figure 5-7].",
    )
    .user(judgeMatch)
    .replies(
      '{"score":1,"reason":"level at or above the floor, ETE, fuel burned, reserve, cites 5-7"}',
    )
}
