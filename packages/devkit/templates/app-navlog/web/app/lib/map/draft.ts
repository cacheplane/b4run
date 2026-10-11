import type { DraftWaypoint } from "../route-draft"
import type { RouteGeometry } from "../route-geometry"

/**
 * How the route map treats the route bar's draft. Pure, so the rules that
 * decide whether the draft is drawn, and what the map frames with no plan,
 * are tested without Leaflet.
 */

/** True when the draft's ids are the planned route's, in order. */
export function draftMatchesPlan(
  draft: readonly DraftWaypoint[],
  geometry: RouteGeometry | null,
): boolean {
  if (geometry === null || draft.length !== geometry.markers.length) return false
  return draft.every((waypoint, i) => waypoint.id === geometry.markers[i]?.id)
}

/**
 * The box around the draft's waypoints, as `[[south, west], [north, east]]`,
 * or null with fewer than two: one waypoint is a point, not a box to fit.
 */
export function draftBounds(draft: readonly DraftWaypoint[]): RouteGeometry["bounds"] | null {
  if (draft.length < 2) return null
  const lats = draft.map((waypoint) => waypoint.lat)
  const lons = draft.map((waypoint) => waypoint.lon)
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ]
}
