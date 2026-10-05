import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"

interface AwcMetar {
  readonly icaoId: string
  readonly reportTime?: string
  readonly temp?: number
  readonly dewp?: number
  readonly wdir?: number | string
  readonly wspd?: number
  readonly visib?: number | string
  readonly altim?: number
  readonly rawOb: string
  readonly clouds?: readonly { readonly cover: string; readonly base?: number }[]
  readonly fltCat?: string
}

export interface Metar {
  readonly id: string
  readonly observedAt: string
  readonly flightCategory: string
  readonly windDirDeg: number | null
  readonly windKt: number | null
  readonly visibilityMi: number | null
  readonly ceilingFt: number | null
  readonly tempC: number | null
  readonly dewpointC: number | null
  readonly altimeterHpa: number | null
  readonly raw: string
}

const CEILING_COVERS = new Set(["BKN", "OVC", "OVX"])

function ceilingOf(clouds: AwcMetar["clouds"]): number | null {
  const layers = (clouds ?? []).filter(
    (layer) => CEILING_COVERS.has(layer.cover) && layer.base !== undefined,
  )
  if (layers.length === 0) return null
  return Math.min(...layers.map((layer) => layer.base as number))
}

const num = (value: number | string | undefined): number | null => {
  if (value === undefined) return null
  if (typeof value === "number") return value
  const parsed = Number.parseFloat(value)
  return Number.isNaN(parsed) ? null : parsed
}

/** Current METAR for one or more stations, parsed, with the raw observation. */
export default async (
  input: { readonly ids: readonly string[] },
  ctx: B4ToolContext,
): Promise<Metar[]> => {
  const ids = input.ids.map((id) => id.trim().toUpperCase()).join(",")
  const records = await awc.getJson<AwcMetar[]>("metar", { ids }, ctx.signal)
  return records.map((record) => ({
    id: record.icaoId,
    observedAt: record.reportTime ?? "",
    flightCategory: record.fltCat ?? "UNKNOWN",
    windDirDeg: num(record.wdir),
    windKt: record.wspd ?? null,
    visibilityMi: num(record.visib),
    ceilingFt: ceilingOf(record.clouds),
    tempC: record.temp ?? null,
    dewpointC: record.dewp ?? null,
    altimeterHpa: record.altim ?? null,
    raw: record.rawOb,
  }))
}

export const display = {
  icon: "web",
  running: ({ ids }) => `Fetching METARs for ${ids.join(", ").toUpperCase()}`,
  done: (_input, metars) =>
    `Fetched METARs: ${metars.map((m) => `${m.id} ${m.flightCategory}`).join(", ")}`,
} satisfies ToolDisplay<{ readonly ids: readonly string[] }, Metar[]>
