import { buildFlightPlan, type FlightPlan, parseUtcInstant } from "./fpl.js"
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
/** Figure 5-6 climb speed, KIAS. Shown in the TAS column of a climb row; not used for groundspeed. */
const CLIMB_SPEED_KIAS = 72

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Climb from the departure field to cruise altitude. Figure 5-6 is cumulative
 * from sea level, so the climb from a field above sea level is the row for the
 * cruise altitude minus the row for the field, component-wise, never below zero.
 */
function climbFromField(
  fieldElevationFt: number,
  altitudeFt: number,
): {
  timeMin: number
  fuelGal: number
  distanceNm: number
} {
  const top = climbFromSeaLevel(altitudeFt)
  const field = climbFromSeaLevel(Math.min(fieldElevationFt, altitudeFt))
  return {
    timeMin: Math.max(0, top.timeMin - field.timeMin),
    fuelGal: Math.max(0, round1(top.fuelGal - field.fuelGal)),
    distanceNm: Math.max(0, top.distanceNm - field.distanceNm),
  }
}

type LegRow = Omit<NavlogLeg, "remainingNm">

/**
 * Pure navlog arithmetic. No model, no network. `now` resolves a clock-time
 * departure such as 1400Z to its next occurrence; tests pin it.
 */
export function computeNavlog(input: NavlogInput, now?: () => number): Navlog {
  if (input.waypoints.length < 2) throw new Error("computeNavlog needs at least two waypoints")
  const legCount = input.waypoints.length - 1
  if (input.winds.length !== legCount)
    throw new Error(`computeNavlog needs one wind entry per leg (${legCount})`)
  const departure = parseUtcInstant(input.departureTimeUtc, now)

  const cruise = cruiseAt({ pressureAltitudeFt: input.altitudeFt, rpm: input.aircraft.cruiseRpm })
  const origin = input.waypoints[0] as NavlogWaypoint
  const climb = climbFromField(origin.elevationFt ?? 0, input.altitudeFt)

  // The climb can span several legs. Time and fuel are prorated by the share of
  // the climb distance flown on each leg, and rounded on the running total so
  // the climb rows still add up to the Figure 5-6 figures.
  let climbFlownNm = 0
  let climbMinRounded = 0
  let climbGalRounded = 0
  // Start, taxi and takeoff fuel goes on the first row emitted.
  let startAllowanceGal = START_TAXI_TAKEOFF_GAL

  const rows: LegRow[] = []
  let clock = departure.getTime()
  let fuelRemaining = input.aircraft.usableFuelGal

  const pushRow = (partial: Omit<LegRow, "etaUtc" | "fuelRemainingGal">): void => {
    // A sliver of climb or cruise that rounds to nothing everywhere is not a row.
    if (partial.distanceNm === 0 && partial.eteMin === 0 && partial.fuelGal === 0) return
    clock += partial.eteMin * 60_000
    fuelRemaining = round1(fuelRemaining - partial.fuelGal)
    rows.push({
      ...partial,
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
    const common = {
      from: from.id,
      to: to.id,
      trueCourse: Math.round(trueCourse),
      variation,
      magneticCourse: Math.round(magneticCourse),
      wind: { dir: wind.dirDegTrue, kt: wind.speedKt },
    }

    let cruiseDistance = legDistance
    const climbLeftNm = climb.distanceNm - climbFlownNm
    if (climbLeftNm > 0) {
      const climbNm = Math.min(climbLeftNm, legDistance)
      climbFlownNm += climbNm
      cruiseDistance = legDistance - climbNm
      const share = climbFlownNm / climb.distanceNm
      const exactMin = climb.timeMin * share
      const eteMin = Math.round(exactMin) - climbMinRounded
      climbMinRounded += eteMin
      const climbGal = round1(climb.fuelGal * share - climbGalRounded)
      climbGalRounded = round1(climbGalRounded + climbGal)
      const exactSegMin = (climb.timeMin * climbNm) / climb.distanceNm
      // No wind triangle on a climb row: Figure 5-6 distances are zero-wind,
      // so the groundspeed is the table's distance over its time.
      const groundspeed = exactSegMin > 0 ? climbNm / (exactSegMin / 60) : CLIMB_SPEED_KIAS
      pushRow({
        ...common,
        segment: "climb",
        wca: 0,
        trueHeading: Math.round(trueCourse),
        magneticHeading: Math.round(magneticCourse),
        tasKt: CLIMB_SPEED_KIAS,
        groundspeedKt: Math.round(groundspeed),
        distanceNm: Math.round(climbNm),
        eteMin,
        fuelGal: round1(climbGal + startAllowanceGal),
      })
      startAllowanceGal = 0
    }

    if (cruiseDistance > 0) {
      const tri = solveWindTriangle({
        trueCourse,
        tasKt: cruise.tasKt,
        windDirTrue: wind.dirDegTrue,
        windKt: wind.speedKt,
      })
      const eteMin = Math.round((cruiseDistance / tri.groundspeedKt) * 60)
      pushRow({
        ...common,
        segment: "cruise",
        wca: Math.round(tri.windCorrectionAngle),
        trueHeading: Math.round(tri.trueHeading),
        magneticHeading: Math.round(magneticFromTrue(tri.trueHeading, variation)),
        tasKt: cruise.tasKt,
        groundspeedKt: Math.round(tri.groundspeedKt),
        distanceNm: Math.round(cruiseDistance),
        eteMin,
        fuelGal: round1((eteMin / 60) * cruise.gph + startAllowanceGal),
      })
      startAllowanceGal = 0
    }
  }

  // One backward pass: distance remaining after each row is the sum of the
  // whole-nm rows after it, so the column adds up.
  const remaining: number[] = new Array(rows.length).fill(0)
  for (let k = rows.length - 2; k >= 0; k--) {
    remaining[k] = (remaining[k + 1] ?? 0) + (rows[k + 1]?.distanceNm ?? 0)
  }
  const legs: NavlogLeg[] = rows.map((row, k) => ({ ...row, remainingNm: remaining[k] ?? 0 }))
  // The plain sum of the whole-nm legs, so the totals row equals the column.
  const totalDistanceNm = legs.reduce((sum, leg) => sum + leg.distanceNm, 0)

  const eteMin = legs.reduce((sum, leg) => sum + leg.eteMin, 0)
  const fuelGal = round1(legs.reduce((sum, leg) => sum + leg.fuelGal, 0))
  const fuelRemainingGal = round1(input.aircraft.usableFuelGal - fuelGal)
  const reserveMin = Math.round((fuelRemainingGal / cruise.gph) * 60)
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
      distanceNm: totalDistanceNm,
      eteMin,
      fuelGal,
      fuelRemainingGal,
      reserveMin,
      reserveOk: reserveMin >= RESERVE_MIN,
    },
    flightPlan: buildFlightPlan({
      tailNumber: input.aircraft.tailNumber,
      departure: origin.id,
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
