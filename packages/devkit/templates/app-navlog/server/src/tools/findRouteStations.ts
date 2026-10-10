import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"
import { legBoxes, placeOnRoute, thin } from "../lib/route-corridor.js"

interface AwcMetarStation {
  readonly icaoId?: string
  readonly name?: string
  readonly lat?: number
  readonly lon?: number
}

export interface FindRouteStationsInput {
  /** The route's waypoints in order, origin first, with coordinates from lookupAirport or lookupNavaid. */
  readonly waypoints: readonly { readonly id: string; readonly lat: number; readonly lon: number }[]
  /** How far either side of the course a station may be. Default 25 nm. */
  readonly corridorNm?: number
  /** The most stations to return, spread evenly along the route. Default 6. */
  readonly max?: number
}

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

const DEFAULT_CORRIDOR_NM = 25
const DEFAULT_MAX = 6

const coord = (deg: number): string => String(Number(deg.toFixed(3)))

/**
 * Find the METAR-reporting stations along a route, for the en-route weather:
 * those within corridorNm of the course, excluding the route's own airports,
 * in order along the route and thinned evenly to max. Pass the waypoints in
 * route order with their coordinates.
 */
export default async (
  input: FindRouteStationsInput,
  ctx: B4ToolContext,
): Promise<{ stations: RouteStation[] }> => {
  const { waypoints } = input
  if (waypoints.length < 2) return { stations: [] }
  const corridorNm = input.corridorNm ?? DEFAULT_CORRIDOR_NM
  const max = input.max ?? DEFAULT_MAX
  const routeIds = new Set(waypoints.map((wp) => wp.id.trim().toUpperCase()))
  const answers = await Promise.all(
    legBoxes(waypoints, corridorNm).map((box) =>
      awc.getJson<AwcMetarStation[]>(
        "metar",
        { bbox: box.map(coord).join(","), format: "json" },
        ctx.signal,
      ),
    ),
  )
  // Neighbouring leg boxes overlap, so one station can answer twice.
  const byId = new Map<string, RouteStation>()
  for (const record of answers.flat()) {
    const id = record.icaoId?.trim().toUpperCase()
    if (!id || record.lat === undefined || record.lon === undefined) continue
    if (byId.has(id) || routeIds.has(id)) continue
    const point = { lat: record.lat, lon: record.lon }
    const { alongNm, offsetNm } = placeOnRoute(point, waypoints)
    if (offsetNm > corridorNm) continue
    byId.set(id, { id, name: record.name ?? id, ...point, alongNm, offsetNm })
  }
  const ordered = [...byId.values()].sort((a, b) => a.alongNm - b.alongNm)
  return {
    stations: thin(ordered, max).map((station) => ({
      ...station,
      alongNm: Math.round(station.alongNm),
      offsetNm: Math.round(station.offsetNm),
    })),
  }
}

export const display = {
  icon: "web",
  running: ({ waypoints }) =>
    `Finding weather stations along ${waypoints.map((wp) => wp.id).join("–")}`,
  done: (_input, { stations }) =>
    stations.length === 0
      ? "Found no weather stations along the route"
      : `Found ${stations.length} weather station${stations.length === 1 ? "" : "s"} along the route: ${stations.map((s) => s.id).join(", ")}`,
} satisfies ToolDisplay<FindRouteStationsInput, { stations: RouteStation[] }>
