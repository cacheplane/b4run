import type { TurnsView } from "@b4run/ag-ui/view"
import { describe, expect, test } from "vitest"
import { type Navlog, type NavlogLeg, type NavlogWaypoint, SAMPLE_NAVLOG } from "./navlog-types"
import {
  groupByRole,
  latestRouteStations,
  parseRouteStations,
  type RouteStation,
} from "./weather-roles"
import type { AirportWeather, WeatherBrief } from "./weather-selectors"

const airport = (id: string): AirportWeather => ({
  id,
  now: "VFR",
  atEta: "VFR",
  line: "VFR now, VFR at ETA",
  metar: `METAR ${id} 061353Z 32012KT 10SM CLR 08/M02 A3012`,
  taf: `TAF ${id} 061130Z 0612/0712 32012KT P6SM SKC`,
})

const brief = (...ids: string[]): WeatherBrief => ({
  airports: ids.map(airport),
  winds: [],
  advisories: [],
  note: "",
})

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

describe("groupByRole", () => {
  test("origin is the first waypoint, destination the last, each with its brief airport", () => {
    const roles = groupByRole(brief("KSTP", "KRST"), SAMPLE_NAVLOG, [])
    expect(roles.origin.id).toBe("KSTP")
    expect(roles.origin.airport?.id).toBe("KSTP")
    expect(roles.destination.id).toBe("KRST")
    expect(roles.destination.airport?.id).toBe("KRST")
    expect(roles.enRoute).toEqual([])
  })
  test("en route: intermediate airports at their cumulative leg distance, navaids excluded", () => {
    const roles = groupByRole(brief("KSTP", "KRGK", "KRST"), multiLeg, [])
    expect(roles.enRoute.map((entry) => [entry.id, entry.alongNm])).toEqual([["KRGK", 30]])
    expect(roles.enRoute.map((entry) => entry.id)).not.toContain("ODI")
  })
  test("stations join en route, sorted by distance along", () => {
    const roles = groupByRole(brief("KSTP", "KRST"), multiLeg, [
      station("KFBL", 55),
      station("KHCD", 12),
    ])
    expect(roles.enRoute.map((entry) => [entry.id, entry.alongNm])).toEqual([
      ["KHCD", 12],
      ["KRGK", 30],
      ["KFBL", 55],
    ])
    expect(roles.enRoute[0]?.name).toBe("KHCD Airport")
  })
  test("a station repeating a waypoint is deduplicated, the waypoint winning", () => {
    const roles = groupByRole(brief(), multiLeg, [
      station("krgk", 31, "Red Wing"),
      station("KRST", 100),
    ])
    expect(roles.enRoute).toHaveLength(1)
    expect(roles.enRoute[0]).toMatchObject({ id: "KRGK", alongNm: 30, name: "Red Wing" })
  })
  test("an airport missing from the brief has no weather; ids match case-insensitively", () => {
    const roles = groupByRole(brief("kstp"), multiLeg, [station("KHCD", 12)])
    expect(roles.origin.airport?.id).toBe("kstp")
    expect(roles.destination.airport).toBeNull()
    expect(roles.enRoute.every((entry) => entry.airport === null)).toBe(true)
  })
  test("with no brief every entry is unreported", () => {
    const roles = groupByRole(null, SAMPLE_NAVLOG, [])
    expect(roles.origin).toMatchObject({ id: "KSTP", airport: null, alongNm: null })
    expect(roles.destination).toMatchObject({ id: "KRST", airport: null, alongNm: null })
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
