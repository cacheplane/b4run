import type { TurnsView } from "@b4run/ag-ui/view"
import type { AirportWeather, Forecast } from "./forecast"
import { latestToolResult } from "./navlog-selectors"
import type { Navlog } from "./navlog-types"
import { isRecord, parseToolResult } from "./tool-result"

/**
 * A METAR-reporting station near the course, as the server's
 * `findRouteStations` tool returns it (`{ stations: RouteStation[] }`). Kept
 * as a plain type, like `Navlog`, so the Workbench does not depend on the
 * server's build.
 */
export interface RouteStation {
  readonly id: string
  readonly name: string
  readonly lat: number
  readonly lon: number
  /** Distance along the route from the origin, whole nm. */
  readonly alongNm: number
  /** Distance from the course, whole nm. */
  readonly offsetNm: number
}

/** One airport card in the Weather tab: its id, where it sits on the route, and its forecast entry. */
export interface RoleEntry {
  readonly id: string
  /** Distance along the route from the origin; null for the origin and the destination. */
  readonly alongNm: number | null
  /** The forecast's entry for this airport, or null when there is none. */
  readonly airport: AirportWeather | null
  readonly name?: string
}

export interface WeatherRoles {
  readonly origin: RoleEntry
  readonly enRoute: readonly RoleEntry[]
  readonly destination: RoleEntry
  /**
   * The route's length the en-route distances are measured against: the
   * forecast destination's distance along when there is one (the same
   * measure as the en-route airports'), else the navlog's total.
   */
  readonly routeNm: number
}

/** How far short of the route's length a station still counts as at the destination. */
const END_TOLERANCE_NM = 2

/**
 * Where an en-route airport sits: its distance along the route, or "near
 * departure" / "near destination" for one past either end, whose distance
 * along clamps to 0 or to the route's length.
 */
export function placeText(alongNm: number, routeNm: number): string {
  const nm = Math.round(alongNm)
  if (nm <= 0) return "near departure"
  // The server measures the route along great circles and the navlog totals
  // its legs (a climb split, rounding), so the two lengths differ by a mile
  // or two: a station clamped to the route's end lands just short of the total.
  if (nm >= Math.round(routeNm) - END_TOLERANCE_NM) return "near destination"
  return `${nm} nm along`
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

function toStation(value: unknown): RouteStation | null {
  if (!isRecord(value)) return null
  const { id, name, lat, lon, alongNm, offsetNm } = value
  if (typeof id !== "string" || id.trim() === "") return null
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return null
  if (!isFiniteNumber(alongNm) || !isFiniteNumber(offsetNm)) return null
  return {
    id,
    name: typeof name === "string" ? name : id,
    lat,
    lon,
    alongNm,
    offsetNm,
  }
}

/** The stations array of a `findRouteStations` result, or null when the text is not one. */
function readRouteStations(text: string): RouteStation[] | null {
  const candidate = parseToolResult(text)
  if (candidate === null || !Array.isArray(candidate.stations)) return null
  return candidate.stations.flatMap((entry) => {
    const station = toStation(entry)
    return station === null ? [] : [station]
  })
}

/**
 * Parse a `findRouteStations` tool result (JSON text, or a `{ result }`
 * envelope). Entries missing a field are dropped; anything that is not a
 * stations result is an empty list.
 */
export function parseRouteStations(text: string): RouteStation[] {
  return readRouteStations(text) ?? []
}

/** The stations of the latest done `findRouteStations` step whose result parses (an empty list counts). */
export function latestRouteStations(view: TurnsView): RouteStation[] {
  const found = latestToolResult(
    view,
    "findRouteStations",
    (result) => readRouteStations(result) !== null,
  )
  return found === null ? [] : parseRouteStations(found.result)
}

/**
 * Cumulative distance to each waypoint after the first, by waypoint index.
 * Legs run in order and a top-of-climb splits one into two legs with the same
 * `to`, so every leg ending at a waypoint counts toward it.
 */
function alongByWaypoint(navlog: Navlog): Map<number, number> {
  const along = new Map<number, number>()
  let total = 0
  let legIndex = 0
  for (let i = 1; i < navlog.waypoints.length; i++) {
    const waypoint = navlog.waypoints[i]
    if (waypoint === undefined) continue
    while (legIndex < navlog.legs.length) {
      const leg = navlog.legs[legIndex]
      if (leg === undefined || leg.to !== waypoint.id) break
      total += leg.distanceNm
      legIndex += 1
    }
    along.set(i, total)
  }
  return along
}

/**
 * The airports by route role. With a forecast, its airports are the source:
 * grouped by their `role`, in the forecast's order, a corridor station only
 * lending its name; the navlog's first and last waypoints stand in, with no
 * weather, for an end the forecast lacks. Without one (no navlog weather yet,
 * or a thread planned before the forecast block), the ids alone: the origin
 * (first waypoint), the destination (last), and en route the intermediate
 * airport waypoints and the corridor stations, ordered by distance along. A
 * station that repeats a waypoint's id is dropped (the waypoint wins, keeping
 * the station's name); navaids and fixes are not airports and have no weather.
 */
export function groupByRole(
  navlog: Navlog,
  forecast: Forecast | null,
  stations: readonly RouteStation[],
): WeatherRoles {
  const stationNames = new Map<string, string>()
  for (const station of stations) stationNames.set(station.id.toUpperCase(), station.name)
  const named = (id: string): { name?: string } => {
    const name = stationNames.get(id.toUpperCase())
    return name !== undefined ? { name } : {}
  }
  const entry = (
    id: string,
    alongNm: number | null,
    airport: AirportWeather | null = null,
  ): RoleEntry => ({
    id,
    alongNm,
    airport,
    ...named(id),
  })

  const waypoints = navlog.waypoints
  const first = waypoints[0]?.id ?? ""
  const last = waypoints.length > 1 ? (waypoints.at(-1)?.id ?? "") : ""

  if (forecast !== null) {
    const origin = forecast.airports.find((a) => a.role === "origin")
    const destination = forecast.airports.find((a) => a.role === "destination")
    return {
      origin: origin !== undefined ? entry(origin.id, null, origin) : entry(first, null),
      enRoute: forecast.airports
        .filter((a) => a.role === "en-route")
        .map((a) => entry(a.id, a.alongNm, a)),
      destination:
        destination !== undefined ? entry(destination.id, null, destination) : entry(last, null),
      routeNm: destination?.alongNm ?? navlog.totals.distanceNm,
    }
  }

  const along = alongByWaypoint(navlog)
  const seen = new Set<string>([first.toUpperCase(), last.toUpperCase()])
  const enRoute: RoleEntry[] = []
  for (let i = 1; i < waypoints.length - 1; i++) {
    const waypoint = waypoints[i]
    if (waypoint === undefined || waypoint.kind !== "airport") continue
    const key = waypoint.id.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    enRoute.push(entry(waypoint.id, along.get(i) ?? null))
  }
  for (const station of stations) {
    const key = station.id.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    enRoute.push({ id: station.id, alongNm: station.alongNm, airport: null, name: station.name })
  }
  enRoute.sort((a, b) => (a.alongNm ?? 0) - (b.alongNm ?? 0))
  return {
    origin: entry(first, null),
    enRoute,
    destination: entry(last, null),
    routeNm: navlog.totals.distanceNm,
  }
}
