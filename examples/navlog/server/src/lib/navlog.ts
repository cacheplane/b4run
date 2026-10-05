import { buildFlightPlan, type FlightPlan } from "./fpl.js"
import { distanceNm, initialTrueCourse, type LatLon, magneticFromTrue } from "./geo.js"
import { climbFromSeaLevel, cruiseAt } from "./poh-tables.js"
import { solveWindTriangle } from "./wind.js"

export interface NavlogWaypoint extends LatLon {
  readonly id: string
  readonly kind: "airport" | "navaid" | "fix"
  readonly elevationFt?: number
  /** Signed: east positive, west negative. */
  readonly magneticVariationDeg: number
}

export interface NavlogWind {
  readonly dirDegTrue: number
  readonly speedKt: number
  readonly tempC?: number
}

export interface NavlogInput {
  readonly aircraft: {
    readonly tailNumber: string
    readonly cruiseRpm: number
    readonly usableFuelGal: number
  }
  readonly altitudeFt: number
  readonly departureTimeUtc: string
  readonly waypoints: readonly NavlogWaypoint[]
  /** One entry per leg (waypoints.length - 1). */
  readonly winds: readonly NavlogWind[]
  readonly personsOnBoard?: number
}

export interface NavlogLeg {
  readonly from: string
  readonly to: string
  readonly segment: "climb" | "cruise"
  readonly trueCourse: number
  readonly variation: number
  readonly magneticCourse: number
  readonly wind: { readonly dir: number; readonly kt: number }
  readonly wca: number
  readonly trueHeading: number
  readonly magneticHeading: number
  readonly tasKt: number
  readonly groundspeedKt: number
  readonly distanceNm: number
  readonly remainingNm: number
  readonly eteMin: number
  readonly etaUtc: string
  readonly fuelGal: number
  readonly fuelRemainingGal: number
}

export interface Navlog {
  readonly aircraft: {
    readonly tailNumber: string
    readonly type: "C172"
    readonly cruiseRpm: number
    readonly tasKt: number
    readonly gph: number
    readonly usableFuelGal: number
  }
  readonly altitudeFt: number
  readonly departureTimeUtc: string
  readonly waypoints: readonly NavlogWaypoint[]
  readonly legs: readonly NavlogLeg[]
  readonly totals: {
    readonly distanceNm: number
    readonly eteMin: number
    readonly fuelGal: number
    readonly fuelRemainingGal: number
    readonly reserveMin: number
    readonly reserveOk: boolean
  }
  readonly flightPlan: FlightPlan
  readonly sources: readonly { readonly figure: string; readonly path: string }[]
}

const START_TAXI_TAKEOFF_GAL = 1.1
const RESERVE_MIN = 45
/** Figure 5-6 climb speed, used as climb-segment TAS. */
const CLIMB_TAS_KT = 72

const round1 = (n: number): number => Math.round(n * 10) / 10

/** Pure navlog arithmetic. No model, no network. */
export function computeNavlog(input: NavlogInput): Navlog {
  if (input.waypoints.length < 2) throw new Error("computeNavlog needs at least two waypoints")
  const legCount = input.waypoints.length - 1
  if (input.winds.length !== legCount)
    throw new Error(`computeNavlog needs one wind entry per leg (${legCount})`)
  const departure = new Date(input.departureTimeUtc)
  if (Number.isNaN(departure.getTime()))
    throw new Error(`departureTimeUtc is not a date: ${input.departureTimeUtc}`)

  const cruise = cruiseAt({ pressureAltitudeFt: input.altitudeFt, rpm: input.aircraft.cruiseRpm })
  const climb = climbFromSeaLevel(input.altitudeFt)

  const legs: NavlogLeg[] = []
  let clock = departure.getTime()
  let fuelRemaining = input.aircraft.usableFuelGal

  const push = (partial: Omit<NavlogLeg, "etaUtc" | "fuelRemainingGal" | "remainingNm">): void => {
    clock += partial.eteMin * 60_000
    fuelRemaining = round1(fuelRemaining - partial.fuelGal)
    legs.push({
      ...partial,
      // Filled in below from the whole-nm leg distances, so the column adds up.
      remainingNm: 0,
      etaUtc: new Date(clock).toISOString(),
      fuelRemainingGal: fuelRemaining,
    })
  }

  for (let i = 0; i < legCount; i++) {
    const from = input.waypoints[i] as NavlogWaypoint
    const to = input.waypoints[i + 1] as NavlogWaypoint
    const wind = input.winds[i] as NavlogWind
    const legDistance = distanceNm(from, to)
    const trueCourse = initialTrueCourse(from, to)
    const variation = from.magneticVariationDeg
    const magneticCourse = magneticFromTrue(trueCourse, variation)

    const segments: { segment: "climb" | "cruise"; distanceNm: number; tasKt: number }[] = []
    if (i === 0 && climb.distanceNm > 0) {
      const climbDistance = Math.min(climb.distanceNm, legDistance)
      segments.push({ segment: "climb", distanceNm: climbDistance, tasKt: CLIMB_TAS_KT })
      if (legDistance > climbDistance)
        segments.push({
          segment: "cruise",
          distanceNm: legDistance - climbDistance,
          tasKt: cruise.tasKt,
        })
    } else {
      segments.push({ segment: "cruise", distanceNm: legDistance, tasKt: cruise.tasKt })
    }

    for (const seg of segments) {
      const tri = solveWindTriangle({
        trueCourse,
        tasKt: seg.tasKt,
        windDirTrue: wind.dirDegTrue,
        windKt: wind.speedKt,
      })
      const isClimb = seg.segment === "climb"
      const eteMin = isClimb ? climb.timeMin : Math.round((seg.distanceNm / tri.groundspeedKt) * 60)
      const fuelGal = isClimb
        ? round1(climb.fuelGal + START_TAXI_TAKEOFF_GAL)
        : round1((eteMin / 60) * cruise.gph)
      push({
        from: from.id,
        to: to.id,
        segment: seg.segment,
        trueCourse: Math.round(trueCourse),
        variation,
        magneticCourse: Math.round(magneticCourse),
        wind: { dir: wind.dirDegTrue, kt: wind.speedKt },
        wca: Math.round(tri.windCorrectionAngle),
        trueHeading: Math.round(tri.trueHeading),
        magneticHeading: Math.round(magneticFromTrue(tri.trueHeading, variation)),
        tasKt: seg.tasKt,
        groundspeedKt: Math.round(tri.groundspeedKt),
        distanceNm: Math.round(seg.distanceNm),
        eteMin,
        fuelGal,
      })
    }
  }

  // Distance remaining after each leg, and the total, are sums of the leg
  // distances as printed (whole nm), so the navlog columns add up.
  let distanceAfter = 0
  for (let k = legs.length - 1; k >= 0; k--) {
    const leg = legs[k] as NavlogLeg
    legs[k] = { ...leg, remainingNm: distanceAfter }
    distanceAfter += leg.distanceNm
  }
  const totalDistanceNm = distanceAfter

  const eteMin = legs.reduce((sum, leg) => sum + leg.eteMin, 0)
  const fuelGal = round1(legs.reduce((sum, leg) => sum + leg.fuelGal, 0))
  const fuelRemainingGal = round1(input.aircraft.usableFuelGal - fuelGal)
  const reserveMin = (fuelRemainingGal / cruise.gph) * 60
  const first = input.waypoints[0] as NavlogWaypoint
  const last = input.waypoints[input.waypoints.length - 1] as NavlogWaypoint

  return {
    aircraft: {
      tailNumber: input.aircraft.tailNumber,
      type: "C172",
      cruiseRpm: input.aircraft.cruiseRpm,
      tasKt: cruise.tasKt,
      gph: cruise.gph,
      usableFuelGal: input.aircraft.usableFuelGal,
    },
    altitudeFt: input.altitudeFt,
    departureTimeUtc: departure.toISOString(),
    waypoints: input.waypoints,
    legs,
    totals: {
      distanceNm: round1(totalDistanceNm),
      eteMin,
      fuelGal,
      fuelRemainingGal,
      reserveMin,
      reserveOk: reserveMin >= RESERVE_MIN,
    },
    flightPlan: buildFlightPlan({
      tailNumber: input.aircraft.tailNumber,
      departure: first.id,
      destination: last.id,
      route: input.waypoints.slice(1, -1).map((wp) => wp.id),
      departureTimeUtc: departure.toISOString(),
      cruiseTasKt: cruise.tasKt,
      altitudeFt: input.altitudeFt,
      eteMin,
      enduranceMin: Math.round((input.aircraft.usableFuelGal / cruise.gph) * 60),
      personsOnBoard: input.personsOnBoard ?? 1,
    }),
    sources: [
      { figure: "Figure 5-6", path: "poh/time-fuel-distance-to-climb.md" },
      { figure: "Figure 5-7", path: "poh/cruise-performance.md" },
    ],
  }
}
