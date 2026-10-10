import type { TurnsView } from "@b4run/ag-ui/view"
import { latestToolResult } from "./navlog-selectors"
import type { Navlog } from "./navlog-types"
import type { AirportWeather, WeatherBrief } from "./weather-selectors"

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

/** One airport card in the Weather tab: its id, where it sits on the route, and its brief entry. */
export interface RoleEntry {
  readonly id: string
  /** Distance along the route from the origin; null for the origin and the destination. */
  readonly alongNm: number | null
  /** The brief's entry for this airport, or null when the brief has none. */
  readonly airport: AirportWeather | null
  readonly name?: string
}

export interface WeatherRoles {
  readonly origin: RoleEntry
  readonly enRoute: readonly RoleEntry[]
  readonly destination: RoleEntry
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

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
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const candidate =
    isRecord(parsed) && "result" in parsed && isRecord(parsed.result) ? parsed.result : parsed
  if (!isRecord(candidate) || !Array.isArray(candidate.stations)) return null
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
 * The brief's airports by route role: the origin (first waypoint), the
 * destination (last), and en route the intermediate airport waypoints and
 * the corridor stations, ordered by distance along the route. A station that
 * repeats a waypoint's id is dropped (the waypoint wins, keeping the
 * station's name); navaids and fixes are not airports and have no weather.
 */
export function groupByRole(
  brief: WeatherBrief | null,
  navlog: Navlog,
  stations: readonly RouteStation[],
): WeatherRoles {
  const byId = new Map<string, AirportWeather>()
  for (const airport of brief?.airports ?? []) byId.set(airport.id.toUpperCase(), airport)
  const weatherFor = (id: string): AirportWeather | null => byId.get(id.toUpperCase()) ?? null
  const stationNames = new Map<string, string>()
  for (const station of stations) stationNames.set(station.id.toUpperCase(), station.name)
  const entry = (id: string, alongNm: number | null): RoleEntry => {
    const name = stationNames.get(id.toUpperCase())
    return { id, alongNm, airport: weatherFor(id), ...(name !== undefined ? { name } : {}) }
  }

  const waypoints = navlog.waypoints
  const first = waypoints[0]?.id ?? ""
  const last = waypoints.length > 1 ? (waypoints.at(-1)?.id ?? "") : ""
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
    enRoute.push({
      id: station.id,
      alongNm: station.alongNm,
      airport: weatherFor(station.id),
      name: station.name,
    })
  }
  enRoute.sort((a, b) => (a.alongNm ?? 0) - (b.alongNm ?? 0))
  return { origin: entry(first, null), enRoute, destination: entry(last, null) }
}
