/**
 * The facts computeNavlog returns about the weather for one planned flight.
 * Every field is computed in code from aviationweather.gov data at the times
 * the navlog flies, so the planner narrates them and the Workbench renders
 * them; nothing here is a model's reading.
 */
import type { FlightCategory } from "../flight-category.js"

export type Category = FlightCategory
export type VerdictLevel = "GO" | "CAUTION" | "NO-GO"

/** An interval in epoch milliseconds, [fromMs, toMs). */
export interface TimeWindow {
  readonly fromMs: number
  readonly toMs: number
}

/** The wind the navlog used for one leg, and the forecast it came from. */
export interface LegWind {
  /** 1-based, in route order. */
  readonly leg: number
  /** The FB winds-aloft station id, e.g. "PDX". */
  readonly station: string
  readonly altitudeFt: number
  readonly dirDegTrue: number
  readonly speedKt: number
  readonly tempC: number | null
  readonly forUseFromUtc: string
  readonly forUseToUtc: string
  /** The leg's whole flying interval lies inside the published FOR USE windows. */
  readonly covered: boolean
}

export interface AirportWeather {
  readonly id: string
  readonly role: "origin" | "en-route" | "destination"
  /** Distance along the route from the origin, whole nm. */
  readonly alongNm: number
  /** When the flight is there: the departure, the pass time, or the ETA. */
  readonly atUtc: string
  readonly metar: {
    readonly raw: string
    readonly category: Category | null
    readonly observedAt: string
  } | null
  readonly taf: { readonly raw: string; readonly validToUtc: string } | null
  readonly categoryNow: Category | null
  /** Null when there is no TAF, or the TAF does not reach atUtc. */
  readonly categoryAtTime: Category | null
  /** The highest gust in the METAR or in a TAF period overlapping the flight window. */
  readonly gustKt: number | null
}

export interface AdvisoryFact {
  readonly product: "G-AIRMET" | "AIRMET" | "SIGMET"
  /** The AWC hazard code: ICE, FZLVL, M_FZLVL, TURB-LO, TURB-HI, LLWS, IFR, MT_OBSC, CONVECTIVE, … */
  readonly hazard: string
  readonly lowestFt: number | null
  readonly highestFt: number | null
  readonly validFromUtc: string | null
  readonly validToUtc: string | null
  readonly relevance: "during-flight" | "before-departure" | "after-arrival"
}

export interface Coverage {
  readonly preliminary: boolean
  /** Each gap, named: "the KBDN TAF ends 1200Z, before the 1315Z ETA". */
  readonly reasons: readonly string[]
}

export interface VerdictFloor {
  readonly level: VerdictLevel
  /** NO-GO reasons first, then CAUTION reasons; empty for GO. */
  readonly reasons: readonly string[]
}

export interface Forecast {
  /** One per leg, in order. The navlog's legs use these winds. */
  readonly winds: readonly LegWind[]
  /** Origin, then en-route stations by alongNm, then destination. */
  readonly airports: readonly AirportWeather[]
  readonly advisories: readonly AdvisoryFact[]
  readonly coverage: Coverage
  readonly verdictFloor: VerdictFloor
  /** Facts the brief should mention that change no level, e.g. "No TAF issued for KTTD". */
  readonly notes: readonly string[]
}
