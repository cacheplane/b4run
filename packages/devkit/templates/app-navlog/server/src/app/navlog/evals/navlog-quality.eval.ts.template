import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { custom, defineEval, gate, llmJudge, toolCalled } from "@b4run/evals"
import { script } from "@b4run/testing"
import { z } from "zod"

const JUDGE_CRITERIA =
  "The answer opens with a GO, CAUTION or NO-GO bottom line, states the ETE, fuel burned and the reserve at destination, lists its assumptions, and cites at least one POH figure."
// The scripted judge turn is matched by a substring of the judge's prompt, so
// derive it from the criteria rather than restating it.
const JUDGE_MATCH = JUDGE_CRITERIA.slice(0, 32)

// The workspace the cited POH files live in, resolved from this file.
const WORKSPACE = fileURLToPath(new URL("../../../../workspace/", import.meta.url))
const CITATION = /\[(poh\/[a-z-]+\.md)/g
const BOTTOM_LINE = /^Bottom line: (GO|CAUTION|NO-GO) — /
// What a planning answer must never contain: an echoed tool call, the todo
// list's statuses, a workspace path, or ETE mislabelled as engine time.
const NEVER_IN_ANSWER = [
  /\brecall\(/,
  /\[(completed|pending|in_progress)\]/,
  /reports\//,
  /aircraft\//,
  /engine-on/i,
]

const DIRECT_INPUT =
  "Plan a VFR flight from KSTP to KRST at 4500 feet, departing 1400Z. My airplane is N738ZU, a 172N, cruise 2400 RPM, 50 gallons usable."
const VIA_OWA_INPUT =
  "Plan KSTP to KRST via KOWA at 4500, departing 1500Z, in N738ZU (172N, 2400 RPM, 50 gal usable)."
const NO_FILING_INPUT =
  "Plan KSTP to KRST at 4500 departing 1400Z in N738ZU (172N, 2400 RPM, 50 gal usable). Do not file it."

const legSchema = z.object({
  magneticHeading: z.number(),
  groundspeedKt: z.number().positive(),
  eteMin: z.number().nonnegative(),
  fuelGal: z.number().nonnegative(),
})
const navlogSchema = z.object({
  legs: z.array(legSchema).min(1),
  totals: z.object({
    eteMin: z.number(),
    fuelGal: z.number(),
    reserveMin: z.number(),
    reserveOk: z.boolean(),
  }),
  flightPlan: z.object({ item7: z.string(), item13: z.string(), item16: z.string() }),
})

/**
 * The value computeNavlog returned, parsed from its tool message. The offload
 * threshold in b4.config.ts keeps a navlog inline, so the content is the JSON.
 */
const navlogResult = (run: {
  toolResults: ReadonlyArray<{ name: string; content: unknown }>
}): unknown => {
  // The last call is the one the brief is based on, if the model retried.
  const content = [...run.toolResults]
    .reverse()
    .find((entry) => entry.name === "computeNavlog")?.content
  if (typeof content !== "string") return undefined
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

// FAA airport records (lookupAirport), field elevation in feet, variation signed east.
const KSTP = {
  id: "KSTP",
  kind: "airport",
  lat: 44.9346,
  lon: -93.0603,
  elevationFt: 705,
  magneticVariationDeg: 0,
}
const KOWA = {
  id: "KOWA",
  kind: "airport",
  lat: 44.1234,
  lon: -93.2606,
  elevationFt: 1145,
  magneticVariationDeg: 0,
}
const KRST = {
  id: "KRST",
  kind: "airport",
  lat: 43.9083,
  lon: -92.49,
  elevationFt: 1317,
  magneticVariationDeg: 0,
}
const AIRCRAFT = { tailNumber: "N738ZU", cruiseRpm: 2400, usableFuelGal: 50 }
const BASELINE_AIRCRAFT = { tailNumber: "N734ST", cruiseRpm: 2400, usableFuelGal: 50 }
const BASELINE_INPUT = "Plan KSTP to KRST at 4500 departing 1400Z. Do not file it."
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
 * thread, matched by their own first message.
 */
function planFixtures(plan: PlanScript) {
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
    .user(JUDGE_MATCH)
    .replies('{"score":1,"reason":"names categories now and at ETA, fuel, reserve, cites 5-7"}')
}

export default defineEval({
  name: "navlog quality",
  dataset: [
    {
      name: "stp to rst",
      input: DIRECT_INPUT,
      fixtures: planFixtures({
        input: DIRECT_INPUT,
        departureTimeUtc: "2026-10-06T14:00:00Z",
        waypoints: [KSTP, KRST],
        navlogTable:
          "| From | To | Segment | MH | GS | Dist | ETE | Fuel |\n|---|---|---|---|---|---|---|---|\n| KSTP | KRST | climb | 158 | 80 | 8 | 6 | 2.3 |\n| KSTP | KRST | cruise | 161 | 129 | 58 | 27 | 3.2 |\n\nTotals: 66 nm, 33 min, 5.5 gal, reserve 380 min.\n",
        brief: [
          "Bottom line: GO — KSTP and KRST are VFR now and at the 1433Z ETA, with no advisory during the flight.",
          "Watch for: none during the flight; a convective SIGMET expires before departure.",
          "Numbers: 66 nm, ETE 33 min, 5.5 gal burned (includes 1.1 gal for start, taxi and takeoff), 44.5 gal at landing, reserve 380 min at 2400 RPM, 7.0 GPH [poh/cruise-performance.md, Figure 5-7].",
          "Assumptions: departure 1400Z 6 Oct 2026; 1 person on board assumed — tell me if different.",
          "Want me to file the plan, try another altitude, or re-brief closer to departure?",
        ].join("\n"),
      }),
    },
    {
      name: "stp to rst via owa",
      input: VIA_OWA_INPUT,
      fixtures: planFixtures({
        input: VIA_OWA_INPUT,
        departureTimeUtc: "2026-10-06T15:00:00Z",
        waypoints: [KSTP, KOWA, KRST],
        navlogTable:
          "| From | To | Segment | MH | GS | Dist | ETE | Fuel |\n|---|---|---|---|---|---|---|---|\n| KSTP | KOWA | climb | 190 | 80 | 8 | 6 | 2.3 |\n| KSTP | KOWA | cruise | 198 | 122 | 41 | 20 | 2.3 |\n| KOWA | KRST | cruise | 106 | 127 | 36 | 17 | 2.0 |\n\nTotals: 85 nm, 43 min, 6.6 gal, reserve 371 min.\n",
        brief: [
          "Bottom line: GO — KSTP, KOWA and KRST are VFR now and through the 1543Z ETA, with no advisory during the flight.",
          "Watch for: none during the flight; a convective SIGMET expires before departure.",
          "Numbers: 85 nm, ETE 43 min, 6.6 gal burned (includes 1.1 gal for start, taxi and takeoff), 43.4 gal at landing, reserve 371 min at 2400 RPM, 7.0 GPH [poh/cruise-performance.md, Figure 5-7].",
          "Assumptions: departure 1500Z 6 Oct 2026; 1 person on board assumed — tell me if different.",
          "Want me to file the plan, try another altitude, or re-brief closer to departure?",
        ].join("\n"),
      }),
    },
    {
      // b4 eval runs each case once and cannot resume an approval interrupt,
      // so this case asks for the plan only and checks nothing was filed.
      name: "plan without filing",
      input: NO_FILING_INPUT,
      fixtures: planFixtures({
        input: NO_FILING_INPUT,
        departureTimeUtc: "2026-10-06T14:00:00Z",
        waypoints: [KSTP, KRST],
        navlogTable:
          "| From | To | Segment | MH | GS | Dist | ETE | Fuel |\n|---|---|---|---|---|---|---|---|\n| KSTP | KRST | climb | 158 | 80 | 8 | 6 | 2.3 |\n| KSTP | KRST | cruise | 161 | 129 | 58 | 27 | 3.2 |\n\nTotals: 66 nm, 33 min, 5.5 gal, reserve 380 min.\n",
        brief: [
          "Bottom line: GO — KSTP and KRST are VFR now and at the 1433Z ETA, with no advisory during the flight.",
          "Watch for: none during the flight.",
          "Numbers: 66 nm, ETE 33 min, 5.5 gal burned (includes 1.1 gal for start, taxi and takeoff), 44.5 gal at landing, reserve 380 min [poh/cruise-performance.md, Figure 5-7].",
          "Assumptions: departure 1400Z 6 Oct 2026; 1 person on board assumed — tell me if different.",
          "As asked, I have not filed it; I can try another altitude or re-brief closer to departure.",
        ].join("\n"),
      }),
    },
    {
      // No aircraft in the request: the plan runs on the workspace baseline, N734ST.
      name: "plan on the baseline aircraft",
      input: BASELINE_INPUT,
      fixtures: planFixtures({
        input: BASELINE_INPUT,
        aircraft: BASELINE_AIRCRAFT,
        departureTimeUtc: "2026-10-06T14:00:00Z",
        waypoints: [KSTP, KRST],
        navlogTable:
          "| From | To | Segment | MH | GS | Dist | ETE | Fuel |\n|---|---|---|---|---|---|---|---|\n| KSTP | KRST | climb | 158 | 80 | 8 | 6 | 2.3 |\n| KSTP | KRST | cruise | 161 | 129 | 58 | 27 | 3.2 |\n\nTotals: 66 nm, 33 min, 5.5 gal, reserve 380 min.\n",
        brief: [
          "Bottom line: GO — KSTP and KRST are VFR now and at the 1433Z ETA, with no advisory during the flight.",
          "Watch for: none during the flight.",
          "Numbers: 66 nm, ETE 33 min, 5.5 gal burned (includes 1.1 gal for start, taxi and takeoff), 44.5 gal at landing, reserve 380 min [poh/cruise-performance.md, Figure 5-7].",
          "Assumptions: departure 1400Z 6 Oct 2026; 1 person on board assumed — tell me if different; demo aircraft N734ST, 50 gal usable, 2400 RPM.",
          "As asked, I have not filed it; I can try another altitude or re-brief closer to departure.",
        ].join("\n"),
      }),
    },
  ],
  scorers: [
    toolCalled("computeNavlog", { threshold: 1 }),
    toolCalled("task", { withArgs: { subagent: "weather" }, threshold: 1 }),
    toolCalled("task", { withArgs: { subagent: "performance" }, threshold: 1 }),
    custom((run) => (navlogSchema.safeParse(navlogResult(run)).success ? 1 : 0), {
      name: "navlog-shape",
      threshold: 1,
    }),
    custom(
      (run) => {
        const parsed = navlogSchema.safeParse(navlogResult(run))
        if (!parsed.success) return 0
        const sum = parsed.data.legs.reduce((total, leg) => total + leg.fuelGal, 0)
        return Math.abs(sum - parsed.data.totals.fuelGal) < 0.11 && parsed.data.totals.reserveOk
          ? 1
          : 0
      },
      { name: "totals-add-up-and-reserve", threshold: 1 },
    ),
    custom(
      (run, testCase) => {
        if (testCase.input !== BASELINE_INPUT) return 1
        const parsed = navlogSchema.safeParse(navlogResult(run))
        return parsed.success && parsed.data.flightPlan.item7 === "N734ST" ? 1 : 0
      },
      { name: "baseline-aircraft", threshold: 1 },
    ),
    // At least one [poh/<file>.md citation, and every cited file exists.
    custom(
      (run) => {
        const cited = [...run.finalMessage.matchAll(CITATION)].map((match) => match[1] ?? "")
        return cited.length > 0 && cited.every((path) => existsSync(`${WORKSPACE}${path}`)) ? 1 : 0
      },
      { name: "cites-poh", threshold: 1 },
    ),
    custom((run) => (BOTTOM_LINE.test(run.finalMessage) ? 1 : 0), {
      name: "opens-with-bottom-line",
      threshold: 1,
    }),
    custom((run) => (NEVER_IN_ANSWER.some((pattern) => pattern.test(run.finalMessage)) ? 0 : 1), {
      name: "no-echoes-or-paths",
      threshold: 1,
    }),
    custom(
      (run, testCase) => {
        const filed = run.toolCalls.some((call) => call.name === "fileFlightPlan")
        const asked = /file the flight plan/i.test(String(testCase.input))
        return filed === asked ? 1 : 0
      },
      { name: "files-only-when-asked", threshold: 1 },
    ),
    // Answered by the scripted judge turn in replay and by the real model under --live.
    llmJudge({ criteria: JUDGE_CRITERIA, model: "gpt-5-mini", threshold: 0.7 }),
  ],
  gate: gate.all(gate.passRate(1), gate.perScorer()),
})
