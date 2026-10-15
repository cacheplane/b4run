import { readFileSync } from "node:fs"
import { awc } from "../awc.js"
import { distanceNm } from "../geo.js"
import {
  type ForUseWindow,
  forUseWindow,
  parseWindsAloft,
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
 * published) is left out of the map rather than parsed.
 */
export async function fetchWindsProducts(
  region: string,
  signal?: AbortSignal,
): Promise<Map<ForecastHours, WindsAloftProduct>> {
  const texts = await Promise.all(
    FORECAST_HOURS.map((hours) =>
      awc.getText(
        "windtemp",
        { region, level: "low", fcst: String(hours).padStart(2, "0") },
        signal,
      ),
    ),
  )
  return new Map(
    FORECAST_HOURS.flatMap((hours, i) => {
      const text = texts[i] as string
      return text.trim() === "" ? [] : [[hours, parseWindsAloft(text)] as const]
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
