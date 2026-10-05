import { normalizeDeg } from "./geo.js"

export interface WindTriangleInput {
  readonly trueCourse: number
  readonly tasKt: number
  /** Direction the wind blows FROM, degrees true. */
  readonly windDirTrue: number
  readonly windKt: number
}

export interface WindTriangleResult {
  /** Degrees, positive right (into the wind), negative left. */
  readonly windCorrectionAngle: number
  readonly trueHeading: number
  readonly groundspeedKt: number
}

const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => (rad * 180) / Math.PI

/** Classic E6B wind triangle. Throws when the crosswind component exceeds TAS. */
export function solveWindTriangle(input: WindTriangleInput): WindTriangleResult {
  const { trueCourse, tasKt, windDirTrue, windKt } = input
  if (windKt === 0) {
    return { windCorrectionAngle: 0, trueHeading: trueCourse, groundspeedKt: tasKt }
  }
  const relative = toRad(windDirTrue - trueCourse)
  const crosswind = windKt * Math.sin(relative)
  const headwind = windKt * Math.cos(relative)
  const ratio = crosswind / tasKt
  if (Math.abs(ratio) > 1) {
    throw new Error(
      `crosswind component ${crosswind.toFixed(1)} kt exceeds true airspeed ${tasKt} kt`,
    )
  }
  const wca = toDeg(Math.asin(ratio))
  const groundspeed = tasKt * Math.cos(toRad(wca)) - headwind
  if (groundspeed <= 0) {
    throw new Error(
      `headwind component ${headwind.toFixed(1)} kt exceeds true airspeed ${tasKt} kt`,
    )
  }
  return {
    windCorrectionAngle: wca,
    trueHeading: normalizeDeg(trueCourse + wca),
    groundspeedKt: groundspeed,
  }
}
