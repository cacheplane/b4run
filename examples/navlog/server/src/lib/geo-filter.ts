import type { LatLon } from "./geo.js"

/** True when the point lies inside the bounding box of a polygon's coordinates, padded by `padDeg`. */
export function withinBoundingBox(
  point: LatLon,
  coords: readonly { readonly lat: number; readonly lon: number }[],
  padDeg = 0.5,
): boolean {
  if (coords.length === 0) return false
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  let minLon = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  for (const c of coords) {
    minLat = Math.min(minLat, c.lat)
    maxLat = Math.max(maxLat, c.lat)
    minLon = Math.min(minLon, c.lon)
    maxLon = Math.max(maxLon, c.lon)
  }
  return (
    point.lat >= minLat - padDeg &&
    point.lat <= maxLat + padDeg &&
    point.lon >= minLon - padDeg &&
    point.lon <= maxLon + padDeg
  )
}
