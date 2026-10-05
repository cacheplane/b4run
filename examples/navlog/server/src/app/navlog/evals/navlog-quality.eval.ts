import { custom, defineEval, gate, llmJudge, toolCalled } from "@b4run/evals"
import { script } from "@b4run/testing"
import { z } from "zod"

const JUDGE_CRITERIA =
  "The brief names the flight category at every airport, states fuel burned and the reserve at destination, and cites at least one POH figure."

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
const WIND = { dirDegTrue: 320, speedKt: 20 }
const PROFILE = "aircraft profile and pilot preferences"
const PLAN_TODOS = {
  todos: [
    {
      content: "Recall the aircraft profile and parse the route, altitude and departure time",
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
}

/**
 * The tool sequence a live plan follows, scripted so replay is keyless and
 * deterministic: the parent recalls, records todos, dispatches both
 * subagents, looks up each airport, computes the navlog and saves it. The
 * tools run for real (computeNavlog's numbers are the code's, not the
 * script's); the weather child's METAR and lookupAirport reach
 * aviationweather.gov. Each subagent and the judge answer in their own
 * thread, matched by their own first message.
 */
function planFixtures(plan: PlanScript) {
  const ids = plan.waypoints.map((wp) => wp.id)
  const weatherInput = `Weather brief for ${ids.join(", ")} at 4500 ft, departure ${plan.departureTimeUtc}.`
  const performanceInput = `Performance for ${ids.join(", ")} at 4500 ft, cruise 2400 RPM.`
  let builder = script()
    .user(plan.input)
    .callsTool("recall", { query: PROFILE })
    .callsTool("writeTodos", PLAN_TODOS)
    .callsTool("task", { subagent: "weather", input: weatherInput })
    .callsTool("task", { subagent: "performance", input: performanceInput })
  for (const id of ids) builder = builder.callsTool("lookupAirport", { id })
  return builder
    .callsTool("computeNavlog", {
      aircraft: AIRCRAFT,
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
      `Airports: ${ids.map((id) => `${id} VFR now, VFR at ETA`).join("; ")}.\nWinds per leg: 320/20 at 4500 ft.\nAdvisories: none.\nGo/no-go note: VFR throughout.`,
    )
    .user(performanceInput)
    .callsTool("readDoc", { path: "poh/cruise-performance.md" })
    .replies(
      "Cruise at 4500 ft, 2400 RPM, standard temperature: 64% BHP at 4000 ft and 60% at 6000 ft, about 110 KTAS and 7.0 GPH interpolated [poh/cruise-performance.md, Figure 5-7].",
    )
    .user("names the flight category")
    .replies('{"score":1,"reason":"names categories now and at ETA, fuel, reserve, cites 5-7"}')
}

export default defineEval({
  name: "navlog quality",
  dataset: [
    {
      name: "stp to rst",
      input:
        "Plan a VFR flight from KSTP to KRST at 4500 feet, departing at 2026-10-06T14:00:00Z. My airplane is N738ZU, a 172N, cruise 2400 RPM, 50 gallons usable.",
      fixtures: planFixtures({
        input:
          "Plan a VFR flight from KSTP to KRST at 4500 feet, departing at 2026-10-06T14:00:00Z. My airplane is N738ZU, a 172N, cruise 2400 RPM, 50 gallons usable.",
        departureTimeUtc: "2026-10-06T14:00:00Z",
        waypoints: [KSTP, KRST],
        navlogTable:
          "| From | To | Segment | MH | GS | Dist | ETE | Fuel |\n|---|---|---|---|---|---|---|---|\n| KSTP | KRST | climb | 158 | 80 | 8 | 6 | 2.3 |\n| KSTP | KRST | cruise | 161 | 129 | 58 | 27 | 3.2 |\n\nTotals: 66 nm, 33 min, 5.5 gal, reserve 380 min.\n",
        brief:
          "KSTP is VFR now and VFR at departure; KRST is VFR now and VFR at the 1433Z ETA. Winds at 4500 ft are 320 at 20, a quartering tailwind. The flight is 66 nm and 33 minutes, burning 5.5 gal including start and taxi, leaving 44.5 gal, a reserve of 380 minutes at cruise burn. Cruise is 2400 RPM, about 110 KTAS at 7.0 GPH [poh/cruise-performance.md, Figure 5-7]. The navlog is saved in reports/KSTP-KRST.md; I have not filed a flight plan.",
      }),
    },
    {
      name: "stp to rst via owa",
      input:
        "Plan KSTP to KRST via KOWA at 4500, departing at 2026-10-06T15:00:00Z, in N738ZU (172N, 2400 RPM, 50 gal usable).",
      fixtures: planFixtures({
        input:
          "Plan KSTP to KRST via KOWA at 4500, departing at 2026-10-06T15:00:00Z, in N738ZU (172N, 2400 RPM, 50 gal usable).",
        departureTimeUtc: "2026-10-06T15:00:00Z",
        waypoints: [KSTP, KOWA, KRST],
        navlogTable:
          "| From | To | Segment | MH | GS | Dist | ETE | Fuel |\n|---|---|---|---|---|---|---|---|\n| KSTP | KOWA | climb | 190 | 80 | 8 | 6 | 2.3 |\n| KSTP | KOWA | cruise | 198 | 122 | 41 | 20 | 2.3 |\n| KOWA | KRST | cruise | 106 | 127 | 36 | 17 | 2.0 |\n\nTotals: 85 nm, 43 min, 6.6 gal, reserve 371 min.\n",
        brief:
          "KSTP is VFR now and at departure, KOWA is VFR now and at its 1526Z ETA, and KRST is VFR now and at the 1543Z ETA. Winds at 4500 ft are 320 at 20. The route is 85 nm and 43 minutes, burning 6.6 gal including start and taxi, leaving 43.4 gal, a reserve of 371 minutes at cruise burn. Cruise is 2400 RPM, about 110 KTAS at 7.0 GPH [poh/cruise-performance.md, Figure 5-7]. The navlog is saved in reports/KSTP-KRST.md; I have not filed a flight plan.",
      }),
    },
    {
      // b4 eval runs each case once and cannot resume an approval interrupt,
      // so this case asks for the plan only and checks nothing was filed.
      name: "plan without filing",
      input:
        "Plan KSTP to KRST at 4500 departing at 2026-10-06T14:00:00Z in N738ZU (172N, 2400 RPM, 50 gal usable). Do not file it.",
      fixtures: planFixtures({
        input:
          "Plan KSTP to KRST at 4500 departing at 2026-10-06T14:00:00Z in N738ZU (172N, 2400 RPM, 50 gal usable). Do not file it.",
        departureTimeUtc: "2026-10-06T14:00:00Z",
        waypoints: [KSTP, KRST],
        navlogTable:
          "| From | To | Segment | MH | GS | Dist | ETE | Fuel |\n|---|---|---|---|---|---|---|---|\n| KSTP | KRST | climb | 158 | 80 | 8 | 6 | 2.3 |\n| KSTP | KRST | cruise | 161 | 129 | 58 | 27 | 3.2 |\n\nTotals: 66 nm, 33 min, 5.5 gal, reserve 380 min.\n",
        brief:
          "KSTP is VFR now and VFR at departure; KRST is VFR now and VFR at the 1433Z ETA. The flight is 66 nm and 33 minutes, burning 5.5 gal including start and taxi, with a 380 minute reserve at cruise burn [poh/cruise-performance.md, Figure 5-7]. As asked, I have not filed a flight plan; the navlog is in reports/KSTP-KRST.md.",
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
    custom((run) => (/\[poh\/[a-z-]+\.md/.test(run.finalMessage) ? 1 : 0), {
      name: "cites-poh",
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
