import { readFileSync } from "node:fs"
import { awc } from "../awc.js"
import { distanceNm } from "../geo.js"
import {
  type ForUseWindow,
  forUseWindow,
  interpolateWind,
  parseWindsAloft,
  type StationWinds,
  type WindAtLevel,
  type WindsAloftProduct,
} from "../winds-aloft.js"
import type { TimeWindow } from "./types.js"

export const FORECAST_HOURS = [6, 12, 24] as const
export type ForecastHours = (typeof FORECAST_HOURS)[number]

export interface ProductChoice {
  readonly forecastHours: ForecastHours
  readonly window: ForUseWindow
  /** False when no product's FOR USE window contains the time. */
  readonly covered: boolean
}

/**
 * The published product whose FOR USE window contains `at`, the shortest when
 * two windows share a boundary. When none does, the nearest one, uncovered: the
 * longest-reaching product for a time beyond every window, the earliest for a
 * time before them. Products whose header has no FOR USE window are skipped.
 */
export function chooseProduct(
  products: ReadonlyMap<ForecastHours, WindsAloftProduct>,
  at: number,
  now: number,
): ProductChoice | null {
  const windows = FORECAST_HOURS.flatMap((forecastHours) => {
    const product = products.get(forecastHours)
    const window = product ? forUseWindow(product, now) : null
    return window ? [{ forecastHours, window }] : []
  })
  const covering = windows.find(
    ({ window }) => Date.parse(window.fromUtc) <= at && at < Date.parse(window.toUtc),
  )
  if (covering) return { ...covering, covered: true }
  const latest = windows.reduce<(typeof windows)[number] | null>(
    (best, entry) =>
      best === null || Date.parse(entry.window.toUtc) > Date.parse(best.window.toUtc)
        ? entry
        : best,
    null,
  )
  if (latest === null) return null
  if (at >= Date.parse(latest.window.toUtc)) return { ...latest, covered: false }
  const earliest = windows.reduce((best, entry) =>
    Date.parse(entry.window.fromUtc) < Date.parse(best.window.fromUtc) ? entry : best,
  )
  return { ...earliest, covered: false }
}

/**
 * The 6-, 12- and 24-hour low-level products for a region ("all" for the
 * contiguous US). A product AWC answers with an empty body (204, nothing
 * published) is left out of the map rather than parsed, and so is one AWC
 * failed to serve: the products left still cover what they cover, and a time
 * only the missing one covered reads as uncovered. Throws only when no
 * product could be fetched at all.
 */
export async function fetchWindsProducts(
  region: string,
  signal?: AbortSignal,
): Promise<Map<ForecastHours, WindsAloftProduct>> {
  const results = await Promise.allSettled(
    FORECAST_HOURS.map((hours) =>
      awc.getText(
        "windtemp",
        { region, level: "low", fcst: String(hours).padStart(2, "0") },
        signal,
      ),
    ),
  )
  // A cancelled run is not an AWC failure.
  signal?.throwIfAborted()
  const failures = results.flatMap((result, i) =>
    result.status === "rejected"
      ? [
          `${FORECAST_HOURS[i]}-hour: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        ]
      : [],
  )
  if (failures.length === FORECAST_HOURS.length) {
    throw new Error(`no winds-aloft product could be fetched (${failures.join("; ")})`)
  }
  return new Map(
    FORECAST_HOURS.flatMap((hours, i) => {
      const result = results[i]
      if (result?.status !== "fulfilled" || result.value.trim() === "") return []
      return [[hours, parseWindsAloft(result.value)] as const]
    }),
  )
}

/** Every published product's FOR USE window. */
export function windWindows(
  products: ReadonlyMap<ForecastHours, WindsAloftProduct>,
  now: number,
): TimeWindow[] {
  return FORECAST_HOURS.flatMap((hours) => {
    const product = products.get(hours)
    const window = product ? forUseWindow(product, now) : null
    return window ? [{ fromMs: Date.parse(window.fromUtc), toMs: Date.parse(window.toUtc) }] : []
  })
}

export interface WindsStation {
  readonly id: string
  readonly lat: number
  readonly lon: number
}

interface WindsStationTable {
  readonly snapshot: string
  readonly unresolved: string[]
  readonly stations: WindsStation[]
}

let table: WindsStationTable | undefined

/** The committed station table (scripts/build-winds-stations.mjs), read once on first use. */
export function windsStationTable(): WindsStationTable {
  if (!table) {
    const file = JSON.parse(
      readFileSync(new URL("../../../data/winds-stations.json", import.meta.url), "utf8"),
    ) as { snapshot: string; unresolved: string[]; stations: [string, number, number][] }
    table = {
      snapshot: file.snapshot,
      unresolved: file.unresolved,
      stations: file.stations.map(([id, lat, lon]) => ({ id, lat, lon })),
    }
  }
  return table
}

/** The great-circle nearest station whose id is in `available` (the product's stations). */
export function nearestWindsStation(
  point: { readonly lat: number; readonly lon: number },
  available: ReadonlySet<string>,
  stations: readonly WindsStation[] = windsStationTable().stations,
): WindsStation | null {
  let best: WindsStation | null = null
  let bestNm = Number.POSITIVE_INFINITY
  for (const station of stations) {
    if (!available.has(station.id)) continue
    const nm = distanceNm(point, station)
    if (nm < bestNm) {
      best = station
      bestNm = nm
    }
  }
  return best
}

/** The wind one station gives for a cruise, and the level it is for. */
export interface CruiseWind {
  readonly station: string
  /** The cruise altitude, or the nearest forecast level when no station forecasts it. */
  readonly levelFt: number
  readonly wind: WindAtLevel
  /**
   * Null when a station forecasts the cruise. Otherwise where the cruise sits:
   * below every forecast level, above every one, or between two no station
   * forecasts together.
   */
  readonly fallback: "below" | "above" | "between" | null
}

const levelsOf = (station: StationWinds): number[] =>
  Object.keys(station)
    .map(Number)
    .sort((a, b) => a - b)

/**
 * The wind at `altitudeFt` near a point: from the nearest station in the
 * product whose levels bracket the altitude, falling back through the
 * next-nearest. When no station brackets it (a cruise below the lowest FB
 * level, 3,000 ft), the forecast level nearest the altitude, from the nearest
 * station that has it. Null only when the product has no placed station with
 * a level.
 */
export function cruiseWind(
  product: WindsAloftProduct,
  point: { readonly lat: number; readonly lon: number },
  altitudeFt: number,
  stations: readonly WindsStation[] = windsStationTable().stations,
): CruiseWind | null {
  const entries = Object.entries(product.stations)
  const bracketing = entries.flatMap(([id, winds]) => {
    const levels = levelsOf(winds)
    const lowest = levels[0]
    const highest = levels.at(-1)
    return lowest !== undefined &&
      highest !== undefined &&
      lowest <= altitudeFt &&
      altitudeFt <= highest
      ? [id]
      : []
  })
  const station = nearestWindsStation(point, new Set(bracketing), stations)
  if (station !== null) {
    const winds = product.stations[station.id] as StationWinds
    return {
      station: station.id,
      levelFt: altitudeFt,
      wind: interpolateWind(winds, altitudeFt),
      fallback: null,
    }
  }
  const placed = new Set(stations.map((s) => s.id))
  const levels = [
    ...new Set(entries.filter(([id]) => placed.has(id)).flatMap(([, winds]) => levelsOf(winds))),
  ].sort((a, b) => a - b)
  const levelFt = levels.reduce<number | null>(
    (best, level) =>
      best === null || Math.abs(level - altitudeFt) < Math.abs(best - altitudeFt) ? level : best,
    null,
  )
  if (levelFt === null) return null
  const having = entries.flatMap(([id, winds]) => (winds[levelFt] !== undefined ? [id] : []))
  const nearest = nearestWindsStation(point, new Set(having), stations)
  if (nearest === null) return null
  const wind = (product.stations[nearest.id] as StationWinds)[levelFt] as WindAtLevel
  const fallback =
    altitudeFt < levelFt && levelFt === levels[0]
      ? "below"
      : altitudeFt > levelFt && levelFt === levels.at(-1)
        ? "above"
        : "between"
  return { station: nearest.id, levelFt, wind, fallback }
}

const feet = (n: number): string => `${n.toLocaleString("en-US")} ft`

/** The forecast note for a leg flown on another level's wind; null when it used the cruise's. */
export function cruiseWindNote(leg: number, altitudeFt: number, choice: CruiseWind): string | null {
  const uses = `leg ${leg} uses the ${feet(choice.levelFt)} wind at ${choice.station}`
  switch (choice.fallback) {
    case null:
      return null
    case "below":
      return `Winds below ${feet(choice.levelFt)} are not forecast; ${uses}`
    case "above":
      return `Winds above ${feet(choice.levelFt)} are not forecast; ${uses}`
    case "between":
      return `No winds-aloft station forecasts ${feet(altitudeFt)}; ${uses}`
  }
}
