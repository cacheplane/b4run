import type { Navlog } from "./navlog-types"
import { isRecord } from "./tool-result"

/**
 * The weather facts computeNavlog returns for one planned flight, re-declared
 * here as plain types (as navlog-types.ts does for Navlog); the server's
 * src/lib/forecast/types.ts is the source of truth.
 */
export type Category = "VFR" | "MVFR" | "IFR" | "LIFR"
export type VerdictLevel = "GO" | "CAUTION" | "NO-GO"

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
  /**
   * The highest gust in the METAR or in a TAF period overlapping the flight
   * window. The verdict floor counts it only at the origin and the destination.
   */
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

/**
 * The weather facts computeNavlog computed for the navlog on screen, read
 * from its result. Null when the navlog has none (a thread planned before the
 * forecast block) or the block is not well formed; a surface then shows no
 * weather rather than half of it.
 */
export function readForecast(navlog: Navlog | null): Forecast | null {
  const block = (navlog as { forecast?: unknown } | null)?.forecast
  if (!isRecord(block)) return null
  const { winds, airports, advisories, coverage, verdictFloor, notes } = block
  if (
    !Array.isArray(winds) ||
    !Array.isArray(airports) ||
    !Array.isArray(advisories) ||
    !Array.isArray(notes)
  )
    return null
  if (!isRecord(coverage) || !isRecord(verdictFloor)) return null
  if (!VERDICT_LEVELS.has(verdictFloor.level) || !Array.isArray(verdictFloor.reasons)) return null
  return block as unknown as Forecast
}

const VERDICT_LEVELS: ReadonlySet<unknown> = new Set<VerdictLevel>(["GO", "CAUTION", "NO-GO"])

/** The category an airport is shown in, on its pill and its map marker: at its time, else now. */
export function shownCategory(airport: AirportWeather): Category | null {
  return airport.categoryAtTime ?? airport.categoryNow
}

/** Worse is higher; an unknown category is below every known one. */
const SEVERITY: Readonly<Record<Category, number>> = { VFR: 1, MVFR: 2, IFR: 3, LIFR: 4 }
const severity = (airport: AirportWeather): number => {
  const category = shownCategory(airport)
  return category === null ? 0 : SEVERITY[category]
}

/**
 * The forecast's entry for an airport id, as its map marker and its panel
 * show it. An out-and-back lists its shared id twice (origin and
 * destination); the worse of the two is shown, the first on a tie.
 */
export function airportWeatherFor(forecast: Forecast | null, id: string): AirportWeather | null {
  const key = id.toUpperCase()
  let shown: AirportWeather | null = null
  for (const airport of forecast?.airports ?? []) {
    if (airport.id.toUpperCase() !== key) continue
    if (shown === null || severity(airport) > severity(shown)) shown = airport
  }
  return shown
}

/** Each airport's shown category by id, for the map markers; an airport with none is left out. */
export function categoriesById(forecast: Forecast | null): Record<string, Category> {
  const out: Record<string, Category> = {}
  for (const { id } of forecast?.airports ?? []) {
    const airport = airportWeatherFor(forecast, id)
    const category = airport === null ? null : shownCategory(airport)
    if (category !== null) out[id] = category
  }
  return out
}

const ft = (n: number): string => `${n.toLocaleString("en-US")} ft`
const hhmm = (iso: string | null): string =>
  iso === null ? "…" : `${iso.slice(11, 13)}${iso.slice(14, 16)}Z`

/** "leg 1: 028° at 17 kt, −4 °C, 9,500 ft (PDX), for use 1400Z–2100Z" */
export function windsLine(w: LegWind): string {
  const temp = w.tempC === null ? "" : `, ${w.tempC < 0 ? "−" : ""}${Math.abs(w.tempC)} °C`
  return `leg ${w.leg}: ${String(w.dirDegTrue).padStart(3, "0")}° at ${Math.round(w.speedKt)} kt${temp}, ${ft(w.altitudeFt)} (${w.station}), for use ${hhmm(w.forUseFromUtc)}–${hhmm(w.forUseToUtc)}`
}

/** "G-AIRMET FZLVL · 8,000 ft · 1800Z–0000Z · during flight" */
export function advisoryLine(a: AdvisoryFact): string {
  const alt =
    a.lowestFt === null
      ? "altitude not given"
      : a.highestFt !== null && a.highestFt !== a.lowestFt
        ? `${ft(a.lowestFt)}–${ft(a.highestFt)}`
        : ft(a.lowestFt)
  return `${a.product} ${a.hazard} · ${alt} · ${hhmm(a.validFromUtc)}–${hhmm(a.validToUtc)} · ${a.relevance.replace("-", " ")}`
}
