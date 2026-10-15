import { awc } from "../awc.js"

interface AwcMetar {
  readonly icaoId: string
  readonly reportTime?: string
  readonly temp?: number
  readonly dewp?: number
  readonly wdir?: number | string
  readonly wspd?: number
  readonly wgst?: number
  readonly lat?: number
  readonly lon?: number
  readonly name?: string
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
  readonly gustKt: number | null
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

/** METARs for the stations, parsed, with each station's position and name. */
export async function fetchMetars(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<
  (Metar & {
    readonly lat: number | null
    readonly lon: number | null
    readonly name: string | null
  })[]
> {
  if (ids.length === 0) return []
  const query = ids.map((id) => id.trim().toUpperCase()).join(",")
  const records = await awc.getJson<AwcMetar[]>("metar", { ids: query }, signal)
  return records.map((record) => ({
    id: record.icaoId,
    observedAt: record.reportTime ?? "",
    flightCategory: record.fltCat ?? "UNKNOWN",
    windDirDeg: num(record.wdir),
    windKt: record.wspd ?? null,
    gustKt: record.wgst ?? null,
    visibilityMi: num(record.visib),
    ceilingFt: ceilingOf(record.clouds),
    tempC: record.temp ?? null,
    dewpointC: record.dewp ?? null,
    altimeterHpa: record.altim ?? null,
    raw: record.rawOb,
    lat: record.lat ?? null,
    lon: record.lon ?? null,
    name: record.name ?? null,
  }))
}
