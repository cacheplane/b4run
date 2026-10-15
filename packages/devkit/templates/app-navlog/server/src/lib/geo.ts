export interface LatLon {
  readonly lat: number
  readonly lon: number
}

export const EARTH_RADIUS_NM = 3440.065
const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => (rad * 180) / Math.PI

/** Normalize an angle in degrees into [0, 360). */
export function normalizeDeg(deg: number): number {
  const r = deg % 360
  return r < 0 ? r + 360 : r
}

/** Great-circle distance in nautical miles (haversine). */
export function distanceNm(from: LatLon, to: LatLon): number {
  const dLat = toRad(to.lat - from.lat)
  const dLon = toRad(to.lon - from.lon)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Initial true course in degrees, [0, 360). Zero for coincident points. */
export function initialTrueCourse(from: LatLon, to: LatLon): number {
  if (from.lat === to.lat && from.lon === to.lon) return 0
  const phi1 = toRad(from.lat)
  const phi2 = toRad(to.lat)
  const dLon = toRad(to.lon - from.lon)
  const y = Math.sin(dLon) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon)
  return normalizeDeg(toDeg(Math.atan2(y, x)))
}

/**
 * True to magnetic. `variationDeg` is signed: positive east, negative west.
 * "East is least": subtract east variation.
 */
export function magneticFromTrue(trueDeg: number, variationDeg: number): number {
  return normalizeDeg(trueDeg - variationDeg)
}

/** The point a fraction of the way along the great circle from one point to another. */
export function intermediatePoint(from: LatLon, to: LatLon, fraction: number): LatLon {
  const angular = distanceNm(from, to) / EARTH_RADIUS_NM
  if (angular === 0) return { lat: from.lat, lon: from.lon }
  const a = Math.sin((1 - fraction) * angular) / Math.sin(angular)
  const b = Math.sin(fraction * angular) / Math.sin(angular)
  const [lat1, lon1, lat2, lon2] = [toRad(from.lat), toRad(from.lon), toRad(to.lat), toRad(to.lon)]
  const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2)
  const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2)
  const z = a * Math.sin(lat1) + b * Math.sin(lat2)
  return { lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lon: toDeg(Math.atan2(y, x)) }
}
