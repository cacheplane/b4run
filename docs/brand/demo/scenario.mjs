import { script } from "../../../packages/testing/dist/index.js"

/**
 * The deterministic navlog demo: the two prompts, every scripted model turn
 * (aimock) and the weather the loopback AWC stub serves, all derived from one
 * clock reading.
 *
 * Why a clock: the prompt says "1400Z", which the route's `resolveDeparture`
 * tool resolves to its next occurrence from the wall clock. Every later value
 * that carries the date (computeNavlog's departure and the forecast it
 * computes, the flight plan's DOF, the brief) must agree with what that tool
 * returns during the capture, so the scenario is built from `now`, not frozen.
 * Only the date moves: the departure is always 1400Z, so the navlog's numbers
 * never change.
 *
 * Nothing here runs the template's TypeScript. The navlog numbers and the
 * flight plan's fixed items are the values the template's `computeNavlog`
 * returns for `navlogInput` (`lib/navlog.ts`, `lib/fpl.ts`); `demo.test.mjs`
 * recomputes them from the template sources (through tsx) for clocks either
 * side of 1400Z and across month and year ends, so a template change that moves
 * a number fails the test rather than the video.
 *
 * One clock, built once. The capture must call `demoScenario({ now })` once and
 * pass that same `now` to `startAwcStub({ now })` and the scenario's
 * `fixtures` to aimock: the stub's METAR, TAF and FB times, the forecast
 * computeNavlog builds from them and the scripted brief that cites them are
 * all derived from it.
 *
 * Two ways the scenario goes stale while a capture runs:
 *
 * - The 1400Z straddle. The scenario resolves "1400Z" at build time; the live
 *   `resolveDeparture` resolves it again from the wall clock when the run
 *   reaches it. If 1400Z passes in between, the tool returns tomorrow and every
 *   scripted date is a day early. `assertScenarioCurrent(scenario)` throws in
 *   that case; the capture calls it right before it sends the prompt, and a
 *   capture should not start in the minutes before 1400Z.
 * - hoursAhead drift. `hoursAhead` is the resolveDeparture result to a tenth
 *   of an hour as of build time, while the live tool computes it when it runs,
 *   so a run that starts minutes after the build can show a value 0.1 h lower
 *   in the resolveDeparture step. No scripted input quotes it, and it changes
 *   no verdict, coverage or number; it is the one value that is allowed to lag.
 */

// The Workbench titles a thread with its first message cut to 80 characters,
// and the capture finds the thread, its rail row and its heading by that title,
// so the prompt must fit whole. It states the aircraft fact the route
// remembers: the tail number and long-range tanks (50 gal usable, as the
// route's aircraft baseline gives for long-range tanks), so the scripted
// `remember` call and the tail number in the brief come from what the pilot
// said, which overrides the baseline's N734ST.
export const DEMO_PROMPT =
  "Plan a VFR flight KSTP to KRST at 4500 ft, 1400Z. N738ZU has long-range tanks."

/** The second turn: the route files only when the pilot asks. */
export const DEMO_FILE_PROMPT = "File the flight plan."

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const DEPARTURE_HOUR_UTC = 14
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const BASELINE_PATH = "aircraft/c172n.md"
const PROFILE_QUERY = "pilot aircraft overrides and preferences"
const AIRCRAFT = Object.freeze({ tailNumber: "N738ZU", cruiseRpm: 2400, usableFuelGal: 50 })
const ALTITUDE_FT = 4500

/**
 * The FAA airport records the stub serves (`elev` in meters, as AWC sends
 * it). KSTP is the template test's sample record; the variation is zero at
 * both ends, as in the scaffold eval.
 */
const AIRPORT_RECORDS = Object.freeze({
  KSTP: Object.freeze({
    icaoId: "KSTP",
    name: "ST PAUL/ST PAUL DOWNTOWN HOLMAN FLD ",
    state: "MN",
    lat: 44.9346,
    lon: -93.0603,
    elev: 215,
    magdec: "00E",
    freqs: "ATIS,118.35;LCL/P,119.1",
    runways: [{ id: "14/32", dimension: "6491x150", surface: "A", alignment: 146 }],
  }),
  KRST: Object.freeze({
    icaoId: "KRST",
    name: "ROCHESTER INTL",
    state: "MN",
    lat: 43.9083,
    lon: -92.49,
    elev: 401,
    magdec: "00E",
    runways: [
      { id: "02/20", dimension: "9033x150", surface: "C", alignment: 23 },
      { id: "13/31", dimension: "7301x150", surface: "C", alignment: 136 },
    ],
  }),
})
const ROUTE = ["KSTP", "KRST"]

/** What lookupAirport returns for each record, as computeNavlog's waypoints. */
const WAYPOINTS = Object.freeze(
  ROUTE.map((id) => {
    const record = AIRPORT_RECORDS[id]
    return Object.freeze({
      id,
      kind: "airport",
      lat: record.lat,
      lon: record.lon,
      // lookupAirport: meters to feet, rounded.
      elevationFt: Math.round(record.elev * 3.28084),
      magneticVariationDeg: 0,
    })
  }),
)

/**
 * The FB winds at MSP, the station computeNavlog picks for the leg (the
 * nearest to its midpoint in data/winds-stations.json that the product
 * carries): 320/20 at 3,000 and 6,000 ft.
 */
const WINDS_STATION = "MSP"
const WINDS = Object.freeze([Object.freeze({ dirDegTrue: 320, speedKt: 20 })])

/**
 * computeNavlog's output for `navlogInput`, whatever the date (pinned by
 * demo.test.mjs against the template): two segments of the one leg, the
 * totals, the POH cruise row at 4500 ft and 2400 RPM interpolated between
 * the 4000 and 6000 ft rows (Figure 5-7), and the endurance in item 19.
 */
const NAVLOG = Object.freeze({
  tasKt: 109.75,
  gph: 7.0249999999999995,
  legs: Object.freeze([
    Object.freeze({
      segment: "climb",
      magneticHeading: 158,
      groundspeedKt: 80,
      distanceNm: 8,
      eteMin: 6,
      fuelGal: 2.3,
    }),
    Object.freeze({
      segment: "cruise",
      magneticHeading: 161,
      groundspeedKt: 129,
      distanceNm: 58,
      eteMin: 27,
      fuelGal: 3.2,
    }),
  ]),
  totals: Object.freeze({
    distanceNm: 66,
    eteMin: 33,
    fuelGal: 5.5,
    fuelRemainingGal: 44.5,
    reserveMin: 380,
    reserveOk: true,
  }),
})

/** The route's FPL items that do not depend on the date (lib/fpl.ts buildFlightPlan). */
const FLIGHT_PLAN_ITEMS = Object.freeze({
  item7: "N738ZU",
  item8: "VG",
  item9: "C172/L",
  item10: "SG/C",
  item15: "N0110VFR DCT",
  item16: "KRST0033",
  item19: "E/0707 P/1",
})

const PLAN_TODOS = Object.freeze([
  {
    content:
      "Read the aircraft baseline, recall the pilot's overrides, and parse the route, altitude and departure time",
    status: "completed",
  },
  {
    content: "Find the weather stations along the route and look up POH performance",
    status: "in_progress",
  },
  { content: "Compute the navlog and its forecast and save it to the workspace", status: "pending" },
  { content: "Brief the pilot and file only on request", status: "pending" },
])

const MEMORY = Object.freeze({
  data: Object.freeze({
    subject: "N738ZU",
    predicate: "has",
    value: "long-range tanks, 50 gal usable",
  }),
  content: "N738ZU has long-range tanks: 50 gal usable.",
})

const PERFORMANCE_BRIEF =
  "Cruise at 4500 ft, 2400 RPM, standard temperature: 64% BHP at 4000 ft and 60% at 6000 ft, about 110 KTAS and 7.0 GPH interpolated [poh/cruise-performance.md, Figure 5-7]."

const pad2 = (n) => String(n).padStart(2, "0")
/** `DDHHMM`, the day-hour-minute group METARs, TAFs and FB headers use. */
const ddhhmm = (ms) => {
  const d = new Date(ms)
  return `${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`
}
const hhmm = (ms) => ddhhmm(ms).slice(2)
const ddhh = (ms) => ddhhmm(ms).slice(0, 4)
const floorTo = (ms, step) => Math.floor(ms / step) * step
/** A duration in minutes as `h:mm`, the way the brief's KeyNumbers show ETE and reserve. */
const hMm = (min) => `${Math.floor(min / 60)}:${pad2(min % 60)}`

/** The next 1400Z at or after `now`, as lib/fpl.ts parseUtcInstant resolves "1400Z". */
function nextDeparture(now) {
  const day = new Date(now)
  const today = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    DEPARTURE_HOUR_UTC,
  )
  return today < now ? today + DAY_MS : today
}

/**
 * Throws when the live `resolveDeparture` would now resolve "1400Z" to a
 * different instant than the scenario scripted (1400Z has passed since the
 * scenario was built). The capture calls it right before sending the prompt.
 */
export function assertScenarioCurrent(scenario, now = Date.now()) {
  const departureUtc = new Date(nextDeparture(now)).toISOString()
  if (departureUtc !== scenario.departureUtc) {
    throw new Error(
      `The demo scenario is stale: "1400Z" now resolves to ${departureUtc}, but the scenario scripted ${scenario.departureUtc}. Rebuild it with demoScenario({ now }) and restart aimock and the AWC stub with the same now.`,
    )
  }
}

/** FB data is published about two hours after its six-hourly data time. */
const WINDS_PUBLISH_DELAY_MS = 2 * HOUR_MS

/** The latest FB data time (00, 06, 12, 18Z) whose products are out by `now`. */
const windsCycle = (now) => floorTo(now - WINDS_PUBLISH_DELAY_MS, 6 * HOUR_MS)

/**
 * Each FB product's FOR USE window, in hours after its data time, as AWC
 * publishes them (data 0000Z: 06 h for 0200-0900Z, 12 h for 0900-1800Z,
 * 24 h for 1800-0600Z). Together they run from 2 to 30 hours after the data time.
 */
const FB_FOR_USE = Object.freeze({ 6: [2, 9], 12: [9, 18], 24: [18, 30] })

/** The FB header for one product of the cycle `basedOn`, with its absolute FOR USE window. */
function windsHeader(basedOn, fcst) {
  const [from, to] = FB_FOR_USE[fcst]
  const forUseFrom = basedOn + from * HOUR_MS
  const forUseTo = basedOn + to * HOUR_MS
  return {
    basedOn: `${ddhhmm(basedOn)}Z`,
    validAt: `${ddhhmm(basedOn + fcst * HOUR_MS)}Z`,
    forUse: `${hhmm(forUseFrom)}-${hhmm(forUseTo)}Z`,
    forUseFrom,
    forUseTo,
  }
}

/**
 * The FB product (6, 12 or 24) of the cycle published by `now` whose FOR USE
 * window holds the departure (`from <= departure < to`), or null when none
 * does or its window ends before the ETA. When it reaches the ETA it also
 * holds the leg's mid-time, so it is the product computeNavlog picks for the
 * leg, and the forecast calls the leg covered for the whole flight. For a 1400Z departure one always qualifies (the cycle is at most 26
 * hours before the departure, its products cover 2 to 30 hours after it with
 * no gaps, and every window edge is on the hour); demo.test.mjs sweeps a full
 * day to hold that.
 */
export function demoWindsProduct(now, departure, eta) {
  const basedOn = windsCycle(now)
  for (const fcst of [6, 12, 24]) {
    const header = windsHeader(basedOn, fcst)
    if (header.forUseFrom <= departure && departure < header.forUseTo) {
      return eta <= header.forUseTo ? { fcst, ...header } : null
    }
  }
  return null
}

/**
 * The weather the AWC stub serves for a clock reading, in the shapes AWC sends
 * and the template's computeNavlog parses (see the template's forecast and
 * winds-aloft tests): both fields VFR, clear, 10 SM, wind 320 at 8; a TAF that
 * covers the next 30 hours, so it always reaches the 1400Z flight; FB winds
 * 320/20 at 3,000 and 6,000 ft at MSP; no AIRMET, SIGMET or G-AIRMET.
 */
export function demoAwcData(now) {
  // The routine observation at :53 past the hour, the latest one before now.
  let observed = floorTo(now, HOUR_MS) + 53 * 60_000
  if (observed > now) observed -= HOUR_MS
  // TAFs are issued 40 minutes before each six-hourly cycle and run 30 hours.
  const tafFrom = floorTo(now, 6 * HOUR_MS)
  const tafTo = tafFrom + 30 * HOUR_MS
  const tafIssued = tafFrom - 40 * 60_000
  const surface = { KSTP: { temp: 12, dewp: 3, altim: 1020, a: "A3012" } }
  surface.KRST = { temp: 11, dewp: 2, altim: 1020.3, a: "A3013" }
  const metars = {}
  const tafs = {}
  for (const id of ROUTE) {
    const s = surface[id]
    metars[id] = {
      icaoId: id,
      // AWC stamps a routine report with the hour it is for.
      reportTime: new Date(observed + 7 * 60_000).toISOString(),
      obsTime: Math.floor(observed / 1000),
      temp: s.temp,
      dewp: s.dewp,
      wdir: 320,
      wspd: 8,
      visib: "10+",
      altim: s.altim,
      rawOb: `METAR ${id} ${ddhhmm(observed)}Z 32008KT 10SM CLR ${pad2(s.temp)}/${pad2(s.dewp)} ${s.a}`,
      clouds: [{ cover: "CLR" }],
      fltCat: "VFR",
    }
    tafs[id] = {
      icaoId: id,
      issueTime: new Date(tafIssued).toISOString(),
      validTimeFrom: Math.floor(tafFrom / 1000),
      validTimeTo: Math.floor(tafTo / 1000),
      rawTAF: `TAF ${id} ${ddhhmm(tafIssued)}Z ${ddhh(tafFrom)}/${ddhh(tafTo)} 32008KT P6SM SKC`,
      fcsts: [
        {
          timeFrom: Math.floor(tafFrom / 1000),
          timeTo: Math.floor(tafTo / 1000),
          fcstChange: null,
          wdir: 320,
          wspd: 8,
          visib: "6+",
          wxString: null,
          clouds: [{ cover: "SKC", base: null }],
        },
      ],
    }
  }
  const windtemp = (fcst) => {
    const header = windsHeader(windsCycle(now), Number(fcst))
    // An excerpt of the low-level FB product computeNavlog asks for with
    // region "all" (the template test's FBUS31 rows), with MSP's 3000 and
    // 6000 ft groups set to 320/20 (FB omits the temperature at 3000 ft).
    return [
      `(Extracted from FBUS31 KWNO ${ddhhmm(windsCycle(now) + WINDS_PUBLISH_DELAY_MS)})`,
      "FD1US1",
      `DATA BASED ON ${header.basedOn}    `,
      `VALID ${header.validAt}   FOR USE ${header.forUse}. TEMPS NEG ABV 24000`,
      "",
      "FT  3000    6000    9000   12000   18000   24000  30000  34000  39000",
      "MSP 3220 3220+05 3125+01 3030-04 3145-16 3255-27 337443 326952 305554",
      "SPI 9900 2712+14 2514+09 2616+02 2736-10 2845-23 275839 266847 258854",
      "GCK      3409+14 0411+10 0312+05 0408-08 3609-22 331738 302146 273551",
      "BRL 2610 2918+13 2719+08 2621+01 2841-12 2960-23 276840 277648 269054",
      "",
    ].join("\n")
  }
  return {
    airports: AIRPORT_RECORDS,
    metars,
    tafs,
    windtemp,
    windsRegion: "all",
    gairmet: [],
    airsigmet: [],
  }
}

/** One aimock script for both turns and the performance subagent, plus everything the capture asserts. */
export function demoScenario({ now = Date.now() } = {}) {
  const departure = nextDeparture(now)
  const departureUtc = new Date(departure).toISOString()
  // resolveDeparture: hours ahead to one decimal.
  const hoursAhead = Math.round(((departure - now) / HOUR_MS) * 10) / 10
  const eta = departure + NAVLOG.totals.eteMin * 60_000
  // The FB product computeNavlog picks for the leg, whose FOR USE window holds
  // the whole flight, so the forecast's winds are covered.
  const winds = demoWindsProduct(now, departure, eta)
  if (winds === null) {
    // Unreachable for a 1400Z departure (see demoWindsProduct); refuse rather
    // than script a GO brief the computed forecast would not support.
    throw new Error(
      `No FB product published by ${new Date(now).toISOString()} covers the ${new Date(departure).toISOString()} flight`,
    )
  }
  const windsForecastHours = winds.fcst
  const etaUtc = new Date(eta).toISOString()
  const day = new Date(departure)
  const departureLabel = `1400Z ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`
  const dof = `${String(day.getUTCFullYear()).slice(-2)}${pad2(day.getUTCMonth() + 1)}${pad2(day.getUTCDate())}`
  const awc = demoAwcData(now)

  const navlogInput = {
    aircraft: { ...AIRCRAFT },
    altitudeFt: ALTITUDE_FT,
    departureTimeUtc: departureUtc,
    waypoints: WAYPOINTS.map((waypoint) => ({ ...waypoint })),
    // The route has no en-route reporting station: the demo skips
    // findRouteStations, and computeNavlog briefs the two airports.
    stations: [],
  }
  const flightPlan = {
    item7: FLIGHT_PLAN_ITEMS.item7,
    item8: FLIGHT_PLAN_ITEMS.item8,
    item9: FLIGHT_PLAN_ITEMS.item9,
    item10: FLIGHT_PLAN_ITEMS.item10,
    item13: `KSTP${hhmm(departure)}`,
    item15: FLIGHT_PLAN_ITEMS.item15,
    item16: FLIGHT_PLAN_ITEMS.item16,
    item18: `DOF/${dof}`,
    item19: FLIGHT_PLAN_ITEMS.item19,
  }

  const performanceInput = `Performance for ${ROUTE.join(", ")} at ${ALTITUDE_FT} ft, cruise ${AIRCRAFT.cruiseRpm} RPM.`

  // What computeNavlog's forecast block says for this flight (the fields the
  // capture and the tests read): each airport VFR now and at its time from
  // the stub's METAR and TAF, the one leg's winds from MSP and covered, no
  // advisory, nothing preliminary, and a GO floor with no reason.
  const forecast = {
    winds: [
      {
        leg: 1,
        station: WINDS_STATION,
        altitudeFt: ALTITUDE_FT,
        dirDegTrue: WINDS[0].dirDegTrue,
        speedKt: WINDS[0].speedKt,
        forUseFromUtc: new Date(winds.forUseFrom).toISOString(),
        forUseToUtc: new Date(winds.forUseTo).toISOString(),
        covered: true,
      },
    ],
    airports: ROUTE.map((id, index) => ({
      id,
      role: index === 0 ? "origin" : "destination",
      categoryNow: "VFR",
      categoryAtTime: "VFR",
    })),
    advisories: [],
    coverage: { preliminary: false, reasons: [] },
    verdictFloor: { level: "GO", reasons: [] },
  }

  const t = NAVLOG.totals
  const reserve = hMm(t.reserveMin)
  const cruiseFigure = `${AIRCRAFT.cruiseRpm} RPM, ${NAVLOG.gph.toFixed(1)} GPH`
  const observed = `${hhmm(awc.metars.KRST.obsTime * 1000)}Z`
  // The route's planning answer, as the model returns it under the brief
  // kit's response schema (web/app/brief/schema.ts): BottomLine, RouteSummary,
  // WatchFor, KeyNumbers, Assumptions, Citations, then one closing Prose. The
  // citation ids run in the order they are first cited, as the route asks.
  const planClosing =
    "Want me to file the plan, try another altitude, or re-brief closer to departure?"
  const planAnswer = JSON.stringify({
    ui: [
      {
        BottomLine: {
          props: {
            level: "GO",
            reason: `KSTP and KRST are VFR now and at the ${hhmm(eta)}Z ETA, with no advisory during the flight.`,
            cite: ["c1", "c2", "c3", "c4"],
          },
        },
      },
      {
        RouteSummary: {
          props: {
            from: "KSTP",
            to: "KRST",
            via: [],
            altitudeFt: ALTITUDE_FT,
            departureUtc: `${departureUtc.slice(0, 10)} ${hhmm(departure)}Z`,
          },
        },
      },
      { WatchFor: { props: { items: [] } } },
      {
        KeyNumbers: {
          props: {
            items: [
              { label: "Distance", value: String(t.distanceNm), unit: "nm", cite: [] },
              {
                label: "ETE (takeoff to landing)",
                value: hMm(t.eteMin),
                unit: null,
                cite: [],
              },
              {
                label: "Fuel burned (includes 1.1 gal for start, taxi and takeoff)",
                value: t.fuelGal.toFixed(1),
                unit: "gal",
                cite: ["c5"],
              },
              {
                label: "Fuel at landing",
                value: t.fuelRemainingGal.toFixed(1),
                unit: "gal",
                cite: [],
              },
              { label: `Reserve at ${cruiseFigure}`, value: reserve, unit: null, cite: ["c5"] },
            ],
          },
        },
      },
      {
        Assumptions: {
          props: {
            items: [
              { statement: `Departure ${departureLabel}`, origin: "pilot" },
              {
                statement: `${AIRCRAFT.usableFuelGal} gal usable for long-range tanks, from the aircraft baseline`,
                origin: "default",
              },
              {
                statement: `Cruise ${AIRCRAFT.cruiseRpm} RPM, from the aircraft baseline`,
                origin: "default",
              },
              { statement: "1 person on board assumed — tell me if different", origin: "default" },
            ],
          },
        },
      },
      {
        Citations: {
          props: {
            items: [
              { id: "c1", source: "METAR KSTP", locator: observed },
              { id: "c2", source: "METAR KRST", locator: observed },
              { id: "c3", source: "TAF KSTP", locator: "" },
              { id: "c4", source: "TAF KRST", locator: "" },
              { id: "c5", source: "poh/cruise-performance.md", locator: "Figure 5-7" },
            ],
          },
        },
      },
      { Prose: { props: { markdown: planClosing } } },
    ],
  })

  const navlogTable = [
    "| From | To | Segment | MH | GS | Dist | ETE | Fuel |",
    "|---|---|---|---|---|---|---|---|",
    ...NAVLOG.legs.map(
      (leg) =>
        `| KSTP | KRST | ${leg.segment} | ${leg.magneticHeading} | ${leg.groundspeedKt} | ${leg.distanceNm} | ${leg.eteMin} | ${leg.fuelGal} |`,
    ),
    "",
    `Totals: ${t.distanceNm} nm, ${t.eteMin} min, ${t.fuelGal.toFixed(1)} gal, reserve ${reserve}.`,
    "",
  ].join("\n")

  // The filing confirmation: any reply that is not a planning brief is a
  // single Prose, so the chat shows its markdown and nothing else.
  const filedText = [
    `Recorded the flight plan for N738ZU KSTP→KRST, departing ${departureLabel}. This demo records it in the workspace; it does not transmit to Flight Service.`,
    `Item 15, ${flightPlan.item15}, is 110 kt true airspeed, VFR, direct; item 16, ${flightPlan.item16}, is KRST in 33 min.`,
  ].join("\n")
  const filedAnswer = JSON.stringify({ ui: [{ Prose: { props: { markdown: filedText } } }] })

  const todos = PLAN_TODOS.map((todo) => ({ ...todo }))
  const memory = { data: { ...MEMORY.data }, content: MEMORY.content }

  const fixtures = script()
    // The parent, turn 1, in the route's order.
    .user(DEMO_PROMPT)
    .callsTool("readDoc", { path: BASELINE_PATH })
    .callsTool("recall", { query: PROFILE_QUERY })
    .callsTool("resolveDeparture", { departure: "1400Z" })
    .callsTool("writeTodos", { todos })
    .callsTool("lookupAirport", { id: "KSTP" })
    .callsTool("lookupAirport", { id: "KRST" })
    .callsTool("task", { subagent: "performance", input: performanceInput })
    .callsTool("computeNavlog", navlogInput)
    .callsTool("remember", memory)
    .callsTool("writeFile", { path: "reports/KSTP-KRST.md", content: navlogTable })
    .replies(planAnswer)
    // The parent, turn 2: the runtime asks the pilot to approve this call.
    .user(DEMO_FILE_PROMPT)
    .callsTool("fileFlightPlan", { flightPlan })
    .replies(filedAnswer)
    // The performance subagent, in its own thread.
    .user(performanceInput)
    .callsTool("readDoc", { path: "poh/cruise-performance.md" })
    .replies(PERFORMANCE_BRIEF)
    .build()

  return {
    now,
    prompt: DEMO_PROMPT,
    filePrompt: DEMO_FILE_PROMPT,
    departureUtc,
    departureLabel,
    hoursAhead,
    etaUtc,
    windsForecastHours,
    navlogInput,
    forecast,
    navlog: {
      tasKt: NAVLOG.tasKt,
      gph: NAVLOG.gph,
      legs: NAVLOG.legs.map((leg) => ({ ...leg })),
      totals: { ...NAVLOG.totals },
    },
    navlogTable,
    flightPlan,
    todos,
    memory,
    performanceInput,
    performanceBrief: PERFORMANCE_BRIEF,
    planAnswer,
    filedAnswer,
    // The text of each answer the chat renders verbatim, which the capture
    // waits for: the planning brief's closing Prose and the filing Prose.
    planAnswerText: planClosing,
    filedAnswerText: filedText,
    planTools: [
      "readDoc",
      "recall",
      "resolveDeparture",
      "writeTodos",
      "lookupAirport",
      "lookupAirport",
      "task",
      "computeNavlog",
      "remember",
      "writeFile",
    ],
    fileTools: ["fileFlightPlan"],
    fixtures,
  }
}

/**
 * The scenario for the clock at import. A capture that runs near 1400Z should
 * build its own with `demoScenario({ now })` right before starting aimock and
 * the AWC stub with the same `now`.
 */
export const DEMO_SCENARIO = demoScenario()
export const DEMO_FIXTURES = DEMO_SCENARIO.fixtures
export const DEMO_NAVLOG_INPUT = DEMO_SCENARIO.navlogInput
/** The parent's turn-1 tool steps, in order, and its planning answer. */
export const DEMO_PLAN_TOOLS = DEMO_SCENARIO.planTools
export const DEMO_PLAN_ANSWER = DEMO_SCENARIO.planAnswer
