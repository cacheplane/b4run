import type { TurnsView } from "@b4run/ag-ui/view"
import { describe, expect, test } from "vitest"
import type { Forecast } from "./forecast"
import type { Navlog, NavlogLeg, NavlogWaypoint } from "./navlog-types"
import { SAMPLE_FORECAST, SAMPLE_NAVLOG } from "./test-fixtures"
import {
  groupByRole,
  latestRouteStations,
  parseRouteStations,
  placeText,
  type RouteStation,
} from "./weather-roles"

const waypoint = (id: string, kind: NavlogWaypoint["kind"] = "airport"): NavlogWaypoint => ({
  id,
  lat: 44,
  lon: -93,
  kind,
  magneticVariationDeg: 0,
})

const leg = (from: string, to: string, distanceNm: number): NavlogLeg => ({
  ...(SAMPLE_NAVLOG.legs[1] as NavlogLeg),
  from,
  to,
  distanceNm,
})

/** KSTP → KRGK (airport) → ODI (VOR) → KRST, with a top-of-climb split on the first leg. */
const multiLeg: Navlog = {
  ...SAMPLE_NAVLOG,
  waypoints: [waypoint("KSTP"), waypoint("KRGK"), waypoint("ODI", "navaid"), waypoint("KRST")],
  legs: [
    leg("KSTP", "KRGK", 8),
    leg("KSTP", "KRGK", 22),
    leg("KRGK", "ODI", 40),
    leg("ODI", "KRST", 30),
  ],
}

const station = (id: string, alongNm: number, name = `${id} Airport`): RouteStation => ({
  id,
  name,
  lat: 44,
  lon: -93,
  alongNm,
  offsetNm: 5,
})

describe("groupByRole with a forecast", () => {
  test("the forecast's airports by role, in its order, the stations naming them", () => {
    const roles = groupByRole(SAMPLE_NAVLOG, SAMPLE_FORECAST, [station("KS33", 79, "Madras")])
    expect(roles.origin).toMatchObject({ id: "KPDX", alongNm: null })
    expect(roles.origin.airport?.metar?.raw).toMatch(/^KPDX /)
    expect(roles.enRoute.map((entry) => [entry.id, entry.alongNm, entry.name])).toEqual([
      ["KS33", 80, "Madras"],
    ])
    expect(roles.destination).toMatchObject({ id: "KBDN", alongNm: null })
    expect(roles.destination.airport?.id).toBe("KBDN")
    expect(roles.routeNm).toBe(104)
  })
  test("a corridor station the forecast does not hold is not added", () => {
    const roles = groupByRole(multiLeg, SAMPLE_FORECAST, [station("KHCD", 12)])
    expect(roles.enRoute.map((entry) => entry.id)).toEqual(["KS33"])
  })
  test("a forecast with no origin or destination falls back to the navlog's ends, unreported", () => {
    const enRouteOnly: Forecast = {
      ...SAMPLE_FORECAST,
      airports: SAMPLE_FORECAST.airports.filter((a) => a.role === "en-route"),
    }
    const roles = groupByRole(SAMPLE_NAVLOG, enRouteOnly, [])
    expect(roles.origin).toMatchObject({ id: "KSTP", airport: null })
    expect(roles.destination).toMatchObject({ id: "KRST", airport: null })
    expect(roles.routeNm).toBe(SAMPLE_NAVLOG.totals.distanceNm)
  })
})

describe("groupByRole without a forecast", () => {
  test("origin is the first waypoint, destination the last, none reported", () => {
    const roles = groupByRole(SAMPLE_NAVLOG, null, [])
    expect(roles.origin).toMatchObject({ id: "KSTP", airport: null, alongNm: null })
    expect(roles.destination).toMatchObject({ id: "KRST", airport: null, alongNm: null })
    expect(roles.enRoute).toEqual([])
    expect(roles.routeNm).toBe(SAMPLE_NAVLOG.totals.distanceNm)
  })
  test("en route: intermediate airports at their cumulative leg distance, navaids excluded", () => {
    const roles = groupByRole(multiLeg, null, [])
    expect(roles.enRoute.map((entry) => [entry.id, entry.alongNm])).toEqual([["KRGK", 30]])
    expect(roles.enRoute.map((entry) => entry.id)).not.toContain("ODI")
  })
  test("stations join en route, sorted by distance along", () => {
    const roles = groupByRole(multiLeg, null, [station("KFBL", 55), station("KHCD", 12)])
    expect(roles.enRoute.map((entry) => [entry.id, entry.alongNm])).toEqual([
      ["KHCD", 12],
      ["KRGK", 30],
      ["KFBL", 55],
    ])
    expect(roles.enRoute[0]?.name).toBe("KHCD Airport")
    expect(roles.enRoute.every((entry) => entry.airport === null)).toBe(true)
  })
  test("a station repeating a waypoint is deduplicated, the waypoint winning", () => {
    const roles = groupByRole(multiLeg, null, [
      station("krgk", 31, "Red Wing"),
      station("KRST", 100),
    ])
    expect(roles.enRoute).toHaveLength(1)
    expect(roles.enRoute[0]).toMatchObject({ id: "KRGK", alongNm: 30, name: "Red Wing" })
  })
})

describe("placeText", () => {
  test("nm along, or near either end within the tolerance", () => {
    expect(placeText(80, 104)).toBe("80 nm along")
    expect(placeText(0, 104)).toBe("near departure")
    expect(placeText(102, 104)).toBe("near destination")
    expect(placeText(101, 104)).toBe("101 nm along")
  })
})

describe("parseRouteStations", () => {
  const stations = [station("KHCD", 12), station("KFBL", 55)]
  test("reads the tool's JSON", () => {
    expect(parseRouteStations(JSON.stringify({ stations }))).toEqual(stations)
  })
  test("reads a { result } envelope", () => {
    expect(parseRouteStations(JSON.stringify({ result: { stations } }))).toEqual(stations)
  })
  test("drops entries missing a field", () => {
    const text = JSON.stringify({
      stations: [stations[0], { id: "KBAD", lat: 44 }, { ...stations[1], alongNm: "far" }],
    })
    expect(parseRouteStations(text)).toEqual([stations[0]])
  })
  test("anything else is an empty list", () => {
    expect(parseRouteStations("not json")).toEqual([])
    expect(parseRouteStations("null")).toEqual([])
    expect(parseRouteStations(JSON.stringify({ stations: "none" }))).toEqual([])
    expect(parseRouteStations(JSON.stringify([stations[0]]))).toEqual([])
  })
})

describe("latestRouteStations", () => {
  const view = (results: readonly string[]): TurnsView =>
    ({
      turns: [
        {
          id: "t1",
          status: "done",
          steps: results.map((result, i) => ({
            kind: "tool",
            id: `s${i}`,
            name: "findRouteStations",
            status: "done",
            result,
          })),
        },
      ],
    }) as unknown as TurnsView

  test("the newest parsing result wins, an empty list included", () => {
    const older = JSON.stringify({ stations: [station("KHCD", 12)] })
    expect(latestRouteStations(view([older]))).toEqual([station("KHCD", 12)])
    expect(latestRouteStations(view([older, JSON.stringify({ stations: [] })]))).toEqual([])
  })
  test("a result that is not a stations list leaves the last good one", () => {
    const older = JSON.stringify({ stations: [station("KHCD", 12)] })
    expect(latestRouteStations(view([older, "AWC unavailable"]))).toEqual([station("KHCD", 12)])
    expect(latestRouteStations(view([]))).toEqual([])
  })
})
