import type { Forecast } from "./forecast"

/**
 * The navlog as the server's `computeNavlog` tool returns it. Kept as a plain
 * type (not imported from the server package) because the Workbench reads
 * the tool result off the wire and must not depend on the server's build.
 * Mirrors the server's `Navlog` in `server/src/lib/navlog.ts` field for field.
 */
export interface NavlogWaypoint {
  readonly id: string
  readonly lat: number
  readonly lon: number
  readonly kind: "airport" | "navaid" | "fix"
  readonly elevationFt?: number
  /** Signed: east positive, west negative. */
  readonly magneticVariationDeg: number
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

export interface FlightPlan {
  readonly item7: string
  readonly item8: string
  readonly item9: string
  readonly item10: string
  readonly item13: string
  readonly item15: string
  readonly item16: string
  readonly item18: string
  readonly item19: string
}

export interface Navlog {
  readonly forecast?: Forecast
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
