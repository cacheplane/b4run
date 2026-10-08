import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"
import {
  type ForUseWindow,
  forUseWindow,
  interpolateWind,
  parseWindsAloft,
  type WindAtLevel,
  type WindsAloftProduct,
} from "../lib/winds-aloft.js"

export const WINDS_ALOFT_REGIONS = [
  "bos",
  "mia",
  "chi",
  "dfw",
  "slc",
  "sfo",
  "alaska",
  "hawaii",
] as const
export type WindsAloftRegion = (typeof WINDS_ALOFT_REGIONS)[number]

export const FORECAST_HOURS = [6, 12, 24] as const
export type ForecastHours = (typeof FORECAST_HOURS)[number]

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/

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

export interface WindsAloft {
  readonly region: string
  readonly station: string
  readonly altitudeFt: number
  /** The time the leg is flown, as asked. */
  readonly validAtUtc: string
  /**
   * True when the product's FOR USE window contains validAtUtc. When false the
   * wind is the nearest product's and the brief is preliminary.
   */
  readonly covered: boolean
  readonly forecastHours: ForecastHours
  readonly basedOn: string | null
  readonly validAt: string | null
  readonly forUse: string | null
  readonly forUseFromUtc: string
  readonly forUseToUtc: string
  /** Present when covered is false: why, in a sentence the brief can use. */
  readonly note?: string
  readonly wind: WindAtLevel
}

interface WindsAloftInput {
  readonly region: WindsAloftRegion
  readonly station: string
  readonly altitudeFt: number
  readonly validAtUtc: string
}

/**
 * Forecast wind and temperature at an altitude, from the FB winds-aloft
 * product for a region and one of its stations. Pick the station nearest the
 * leg; when the station is not in the product, the error lists the ones that are.
 * validAtUtc is when the leg is flown, as an ISO 8601 UTC instant: pass
 * departureUtc, or the leg's ETA. The tool reads the 6-, 12- and 24-hour
 * products and uses the one whose FOR USE window contains that time; never
 * work out forecast hours yourself. covered false means no published forecast
 * covers the time yet, so the winds are preliminary.
 */
export default async (input: WindsAloftInput, ctx: B4ToolContext): Promise<WindsAloft> => {
  if (!(WINDS_ALOFT_REGIONS as readonly string[]).includes(input.region)) {
    throw new Error(`region must be one of ${WINDS_ALOFT_REGIONS.join(", ")}`)
  }
  const validAtUtc = input.validAtUtc?.trim() ?? ""
  const at = Date.parse(validAtUtc)
  if (!UTC_INSTANT.test(validAtUtc) || Number.isNaN(at)) {
    throw new Error(
      `validAtUtc must be an ISO 8601 UTC instant such as 2026-10-06T14:00:00Z (departureUtc or the leg's ETA), got "${input.validAtUtc}"`,
    )
  }
  const now = Date.now()
  const texts = await Promise.all(
    FORECAST_HOURS.map((forecastHours) =>
      awc.getText(
        "windtemp",
        { region: input.region, level: "low", fcst: String(forecastHours).padStart(2, "0") },
        ctx.signal,
      ),
    ),
  )
  const products = new Map(
    FORECAST_HOURS.map((forecastHours, index) => [
      forecastHours,
      parseWindsAloft(texts[index] as string),
    ]),
  )
  const choice = chooseProduct(products, at, now)
  if (choice === null) {
    throw new Error(
      `the ${input.region} winds-aloft products have no FOR USE window in their header`,
    )
  }
  const product = products.get(choice.forecastHours) as WindsAloftProduct
  const station = input.station.trim().toUpperCase()
  const levels = product.stations[station]
  if (!levels)
    throw new Error(
      `station ${station} is not in the ${input.region} product; available: ${Object.keys(product.stations).join(", ")}`,
    )
  const note = choice.covered
    ? undefined
    : at >= Date.parse(choice.window.toUtc)
      ? `No winds-aloft forecast covers ${validAtUtc} yet: the latest (${choice.forecastHours}-hour) is for use until ${choice.window.toUtc}. These winds are preliminary.`
      : `${validAtUtc} is before the earliest winds-aloft forecast's FOR USE window, which opens ${choice.window.fromUtc}. These winds are the nearest forecast.`
  return {
    region: input.region,
    station,
    altitudeFt: input.altitudeFt,
    validAtUtc,
    covered: choice.covered,
    forecastHours: choice.forecastHours,
    basedOn: product.basedOn,
    validAt: product.validAt,
    forUse: product.forUse,
    forUseFromUtc: choice.window.fromUtc,
    forUseToUtc: choice.window.toUtc,
    ...(note !== undefined ? { note } : {}),
    wind: interpolateWind(levels, input.altitudeFt),
  }
}

export const display = {
  icon: "web",
  running: ({ station, altitudeFt }) =>
    `Fetching winds aloft at ${station.toUpperCase()} for ${altitudeFt} ft`,
  done: (_input, out) =>
    `Winds at ${out.station} ${out.altitudeFt} ft: ${out.wind.dirDegTrue}° at ${Math.round(out.wind.speedKt)} kt${out.covered ? "" : " (preliminary)"}`,
} satisfies ToolDisplay<WindsAloftInput, WindsAloft>
