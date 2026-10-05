import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"
import { withinBoundingBox } from "../lib/geo-filter.js"

interface AwcAdvisory {
  readonly hazard?: string
  readonly severity?: string | number
  readonly validTimeFrom?: string | number
  readonly validTimeTo?: string | number
  /** G-AIRMET validity: the forecast time and its expiry. */
  readonly validTime?: string | number
  readonly expireTime?: string | number
  readonly forecastHour?: number
  readonly base?: string | number
  readonly top?: string | number
  /** AWC sends coordinates as numbers or numeric strings depending on the product. */
  readonly coords?: readonly { readonly lat: number | string; readonly lon: number | string }[]
  readonly rawAirSigmet?: string
}

export interface Advisory {
  readonly product: "G-AIRMET" | "SIGMET"
  readonly hazard: string
  readonly severity: string
  readonly validFrom: string
  readonly validTo: string
  readonly base: string
  readonly top: string
  readonly raw: string
}

const text = (value: string | number | undefined): string =>
  value === undefined ? "" : String(value)

function touches(point: { lat: number; lon: number }, advisory: AwcAdvisory): boolean {
  const coords = (advisory.coords ?? [])
    .map((c) => ({ lat: Number(c.lat), lon: Number(c.lon) }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
  return withinBoundingBox(point, coords)
}

function toAdvisory(product: Advisory["product"], advisory: AwcAdvisory): Advisory {
  return {
    product,
    hazard: advisory.hazard ?? "",
    severity: text(advisory.severity),
    validFrom: text(advisory.validTimeFrom ?? advisory.validTime),
    validTo: text(advisory.validTimeTo ?? advisory.expireTime),
    base: text(advisory.base),
    top: text(advisory.top),
    raw: advisory.rawAirSigmet ?? "",
  }
}

/** G-AIRMETs and SIGMETs whose area touches a point (padded half a degree), for a route corridor check. */
export default async (
  input: { readonly lat: number; readonly lon: number },
  ctx: B4ToolContext,
): Promise<Advisory[]> => {
  const [gairmets, airsigmets] = await Promise.all([
    awc.getJson<AwcAdvisory[]>("gairmet", {}, ctx.signal),
    awc.getJson<AwcAdvisory[]>("airsigmet", {}, ctx.signal),
  ])
  // G-AIRMETs repeat per forecast hour; keep one row per hazard and validity.
  const seen = new Set<string>()
  const gairmetRows: Advisory[] = []
  for (const advisory of gairmets) {
    if (!touches(input, advisory)) continue
    const row = toAdvisory("G-AIRMET", advisory)
    const key = `${row.hazard}|${row.validFrom}`
    if (seen.has(key)) continue
    seen.add(key)
    gairmetRows.push(row)
  }
  const sigmetRows = airsigmets
    .filter((advisory) => touches(input, advisory))
    .map((advisory) => toAdvisory("SIGMET", advisory))
  return [...gairmetRows, ...sigmetRows]
}

export const display = {
  icon: "web",
  running: ({ lat, lon }) => `Checking advisories near ${lat.toFixed(2)}, ${lon.toFixed(2)}`,
  done: (_input, advisories) =>
    advisories.length === 0
      ? "No advisories touch the route"
      : `${advisories.length} advisor${advisories.length === 1 ? "y" : "ies"} touch the route`,
} satisfies ToolDisplay<{ readonly lat: number; readonly lon: number }, Advisory[]>
