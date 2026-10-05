import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"
import { withinBoundingBox } from "../lib/geo-filter.js"

interface AwcAdvisory {
  readonly product?: string
  readonly hazard?: string
  readonly severity?: string
  readonly validTimeFrom?: string | number
  readonly validTimeTo?: string | number
  readonly base?: string | number
  readonly top?: string | number
  readonly coords?: readonly { readonly lat: number; readonly lon: number }[]
  readonly rawAirSigmet?: string
}

export interface Advisory {
  readonly product: string
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

/** G-AIRMETs and SIGMETs whose area touches a point (padded half a degree), for a route corridor check. */
export default async (
  input: { readonly lat: number; readonly lon: number },
  ctx: B4ToolContext,
): Promise<Advisory[]> => {
  const [gairmets, sigmets] = await Promise.all([
    awc.getJson<AwcAdvisory[]>("gairmet", {}, ctx.signal),
    awc.getJson<AwcAdvisory[]>("sigmet", {}, ctx.signal),
  ])
  return [
    ...gairmets.map((g) => ({ ...g, product: g.product ?? "G-AIRMET" })),
    ...sigmets.map((s) => ({ ...s, product: s.product ?? "SIGMET" })),
  ]
    .filter((advisory) => withinBoundingBox(input, advisory.coords ?? []))
    .map((advisory) => ({
      product: advisory.product ?? "",
      hazard: advisory.hazard ?? "",
      severity: advisory.severity ?? "",
      validFrom: text(advisory.validTimeFrom),
      validTo: text(advisory.validTimeTo),
      base: text(advisory.base),
      top: text(advisory.top),
      raw: advisory.rawAirSigmet ?? "",
    }))
}

export const display = {
  icon: "web",
  running: ({ lat, lon }) => `Checking advisories near ${lat.toFixed(2)}, ${lon.toFixed(2)}`,
  done: (_input, advisories) =>
    advisories.length === 0
      ? "No advisories touch the route"
      : `${advisories.length} advisor${advisories.length === 1 ? "y" : "ies"} touch the route`,
} satisfies ToolDisplay<{ readonly lat: number; readonly lon: number }, Advisory[]>
