import { formatHeading } from "./format"
import type { Navlog } from "./navlog-types"

export type LatLng = readonly [number, number]

export interface RouteGeometry {
  readonly polyline: readonly LatLng[]
  readonly markers: readonly { readonly id: string; readonly at: LatLng; readonly kind: string }[]
  readonly legLabels: readonly {
    readonly from: string
    readonly to: string
    readonly at: LatLng
    readonly text: string
  }[]
  /** [[southLat, westLon], [northLat, eastLon]] */
  readonly bounds: readonly [LatLng, LatLng]
}

const round5 = (n: number): number => Math.round(n * 100000) / 100000

/** Map data from a navlog: markers, the route line, one heading label per leg (cruise heading), and bounds. */
export function routeGeometry(navlog: Navlog): RouteGeometry {
  const polyline = navlog.waypoints.map((wp): LatLng => [wp.lat, wp.lon])
  const markers = navlog.waypoints.map((wp) => ({
    id: wp.id,
    at: [wp.lat, wp.lon] as LatLng,
    kind: wp.kind,
  }))
  const legLabels = navlog.waypoints.slice(1).map((to, i) => {
    const from = navlog.waypoints[i] as Navlog["waypoints"][number]
    const legs = navlog.legs.filter((leg) => leg.from === from.id && leg.to === to.id)
    const cruise = legs.find((leg) => leg.segment === "cruise") ?? legs[0]
    return {
      from: from.id,
      to: to.id,
      at: [round5((from.lat + to.lat) / 2), round5((from.lon + to.lon) / 2)] as LatLng,
      text: `MH ${formatHeading(cruise?.magneticHeading ?? 0)}°`,
    }
  })
  const lats = navlog.waypoints.map((wp) => wp.lat)
  const lons = navlog.waypoints.map((wp) => wp.lon)
  return {
    polyline,
    markers,
    legLabels,
    bounds: [
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ],
  }
}
