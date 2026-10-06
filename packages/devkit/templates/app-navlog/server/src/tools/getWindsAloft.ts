import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"
import { interpolateWind, parseWindsAloft, type WindAtLevel } from "../lib/winds-aloft.js"

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

const FORECAST_HOURS: readonly number[] = [6, 12, 24]

/**
 * The shortest published forecast that reaches `hours` ahead. A model asking for
 * the wind "in 1 hour" means the 6-hour product, not an error and a retry.
 */
export function forecastProduct(hours: number): number {
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error(`forecastHours must be a number of hours ahead, got ${hours}`)
  }
  const product = FORECAST_HOURS.find((published) => hours <= published)
  if (product === undefined) {
    throw new Error(
      `forecastHours ${hours} is beyond the longest winds-aloft forecast (${FORECAST_HOURS.at(-1)} hours)`,
    )
  }
  return product
}

export interface WindsAloft {
  readonly region: string
  readonly station: string
  readonly altitudeFt: number
  readonly forecastHours: number
  readonly basedOn: string | null
  readonly validAt: string | null
  readonly forUse: string | null
  readonly wind: WindAtLevel
}

/**
 * Forecast wind and temperature at an altitude, from the FB winds-aloft
 * product for a region and one of its stations. Pick the station nearest the
 * leg; when the station is not in the product, the error lists the ones that are.
 * forecastHours is how far ahead the leg is flown, in hours (default 6): AWC
 * publishes 6-, 12- and 24-hour forecasts, and the shortest one that reaches
 * that far is used, so 1 or 3 reads the 6-hour product.
 */
export default async (
  input: {
    readonly region: WindsAloftRegion
    readonly station: string
    readonly altitudeFt: number
    readonly forecastHours?: number
  },
  ctx: B4ToolContext,
): Promise<WindsAloft> => {
  if (!(WINDS_ALOFT_REGIONS as readonly string[]).includes(input.region)) {
    throw new Error(`region must be one of ${WINDS_ALOFT_REGIONS.join(", ")}`)
  }
  const forecastHours = forecastProduct(input.forecastHours ?? 6)
  const text = await awc.getText(
    "windtemp",
    { region: input.region, level: "low", fcst: String(forecastHours).padStart(2, "0") },
    ctx.signal,
  )
  const product = parseWindsAloft(text)
  const station = input.station.trim().toUpperCase()
  const levels = product.stations[station]
  if (!levels)
    throw new Error(
      `station ${station} is not in the ${input.region} product; available: ${Object.keys(product.stations).join(", ")}`,
    )
  return {
    region: input.region,
    station,
    altitudeFt: input.altitudeFt,
    forecastHours,
    basedOn: product.basedOn,
    validAt: product.validAt,
    forUse: product.forUse,
    wind: interpolateWind(levels, input.altitudeFt),
  }
}

export const display = {
  icon: "web",
  running: ({ station, altitudeFt }) =>
    `Fetching winds aloft at ${station.toUpperCase()} for ${altitudeFt} ft`,
  done: (_input, out) =>
    `Winds at ${out.station} ${out.altitudeFt} ft: ${out.wind.dirDegTrue}° at ${Math.round(out.wind.speedKt)} kt`,
} satisfies ToolDisplay<
  {
    readonly region: WindsAloftRegion
    readonly station: string
    readonly altitudeFt: number
    readonly forecastHours?: number
  },
  WindsAloft
>
