import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { chooseProduct, type ForecastHours, fetchWindsProducts } from "../lib/forecast/winds.js"
import { interpolateWind, type WindAtLevel, type WindsAloftProduct } from "../lib/winds-aloft.js"

const WINDS_ALOFT_REGIONS = ["bos", "mia", "chi", "dfw", "slc", "sfo", "alaska", "hawaii"] as const
export type WindsAloftRegion = (typeof WINDS_ALOFT_REGIONS)[number]
export type { ForecastHours }

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/

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
  const products = await fetchWindsProducts(input.region, ctx.signal)
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
