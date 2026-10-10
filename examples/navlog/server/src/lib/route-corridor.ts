import { distanceNm, EARTH_RADIUS_NM, initialTrueCourse, type LatLon } from "./geo.js"

/** `[minLat, minLon, maxLat, maxLon]`, the order aviationweather.gov's `bbox` takes. */
export type Box = readonly [minLat: number, minLon: number, maxLat: number, maxLon: number]

export interface RoutePlacement {
  /** Distance along the route from the origin to the point's foot on the nearest leg. */
  readonly alongNm: number
  /** Distance from the point to the nearest leg. */
  readonly offsetNm: number
}

const toRad = (deg: number): number => (deg * Math.PI) / 180

/**
 * One box per leg: the leg's endpoints, expanded by `corridorNm` on every side.
 * A degree of latitude is 60 nm; a degree of longitude is 60 nm times the
 * cosine of the latitude, taken at the box's highest latitude so the box never
 * comes up short.
 */
export function legBoxes(waypoints: readonly LatLon[], corridorNm: number): Box[] {
  const padLat = corridorNm / 60
  const boxes: Box[] = []
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1] as LatLon
    const b = waypoints[i] as LatLon
    const minLat = Math.max(-90, Math.min(a.lat, b.lat) - padLat)
    const maxLat = Math.min(90, Math.max(a.lat, b.lat) + padLat)
    const cosLat = Math.cos(toRad(Math.max(Math.abs(minLat), Math.abs(maxLat))))
    const padLon = cosLat > 1e-6 ? corridorNm / (60 * cosLat) : 180
    boxes.push([
      minLat,
      Math.max(-180, Math.min(a.lon, b.lon) - padLon),
      maxLat,
      Math.min(180, Math.max(a.lon, b.lon) + padLon),
    ])
  }
  return boxes
}

/** Along-track and cross-track distance from one leg, clamped to the leg's ends. */
function placeOnLeg(
  point: LatLon,
  from: LatLon,
  to: LatLon,
): { readonly alongNm: number; readonly offsetNm: number } {
  const legNm = distanceNm(from, to)
  const toPointNm = distanceNm(from, point)
  if (legNm === 0 || toPointNm === 0) return { alongNm: 0, offsetNm: toPointNm }
  const angular = toPointNm / EARTH_RADIUS_NM
  const relative = toRad(initialTrueCourse(from, point) - initialTrueCourse(from, to))
  const crossTrack = Math.asin(Math.max(-1, Math.min(1, Math.sin(angular) * Math.sin(relative))))
  const alongAbs =
    Math.acos(Math.max(-1, Math.min(1, Math.cos(angular) / Math.cos(crossTrack)))) * EARTH_RADIUS_NM
  const along = Math.cos(relative) < 0 ? -alongAbs : alongAbs
  if (along <= 0) return { alongNm: 0, offsetNm: toPointNm }
  if (along >= legNm) return { alongNm: legNm, offsetNm: distanceNm(to, point) }
  return { alongNm: along, offsetNm: Math.abs(crossTrack) * EARTH_RADIUS_NM }
}

/**
 * Where a point sits relative to the route: its distance from the nearest leg,
 * and how far along the route (from the origin) its foot on that leg falls.
 */
export function placeOnRoute(point: LatLon, waypoints: readonly LatLon[]): RoutePlacement {
  let best: RoutePlacement = {
    alongNm: 0,
    offsetNm: waypoints[0] ? distanceNm(waypoints[0], point) : Number.POSITIVE_INFINITY,
  }
  let legStartNm = 0
  for (let i = 1; i < waypoints.length; i++) {
    const from = waypoints[i - 1] as LatLon
    const to = waypoints[i] as LatLon
    const leg = placeOnLeg(point, from, to)
    if (leg.offsetNm < best.offsetNm) {
      best = { alongNm: legStartNm + leg.alongNm, offsetNm: leg.offsetNm }
    }
    legStartNm += distanceNm(from, to)
  }
  return best
}

/**
 * At most `max` items, spread evenly by `alongNm`: the first and last are
 * always kept, and each pick in between is the item nearest its evenly spaced
 * target. Expects `items` sorted by `alongNm`; returns them in that order.
 */
export function thin<T extends { readonly alongNm: number }>(
  items: readonly T[],
  max: number,
): T[] {
  if (items.length <= max) return [...items]
  if (max <= 0) return []
  const first = items[0] as T
  if (max === 1) return [first]
  const last = items[items.length - 1] as T
  const step = (last.alongNm - first.alongNm) / (max - 1)
  const picked = new Set<number>([0, items.length - 1])
  for (let k = 1; k < max - 1; k++) {
    const target = first.alongNm + k * step
    let bestIndex = -1
    for (let i = 0; i < items.length; i++) {
      if (picked.has(i)) continue
      const gap = Math.abs((items[i] as T).alongNm - target)
      if (bestIndex === -1 || gap < Math.abs((items[bestIndex] as T).alongNm - target)) {
        bestIndex = i
      }
    }
    picked.add(bestIndex)
  }
  return [...picked].sort((a, b) => a - b).map((i) => items[i] as T)
}
