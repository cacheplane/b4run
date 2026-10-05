import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"

interface AwcAirport {
  readonly icaoId?: string
  readonly name?: string
  readonly state?: string
  readonly lat: number
  readonly lon: number
  readonly elev?: number
  readonly magdec?: string
  readonly freqs?: string
  readonly runways?: readonly {
    readonly id: string
    readonly dimension?: string
    readonly surface?: string
    readonly alignment?: number
  }[]
}

export interface Airport {
  readonly id: string
  readonly name: string
  readonly state: string
  readonly lat: number
  readonly lon: number
  readonly elevationFt: number
  /** Signed: east positive, west negative. */
  readonly magneticVariationDeg: number
  readonly frequencies: readonly { readonly name: string; readonly mhz: string }[]
  readonly runways: readonly {
    readonly id: string
    readonly lengthFt: number
    readonly widthFt: number
    readonly surface: string
    readonly alignmentDeg: number
  }[]
}

function titleCase(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase())
}

function variationFrom(magdec: string | undefined): number {
  const m = /^(\d+)([EW])$/.exec((magdec ?? "").trim())
  if (!m) return 0
  const value = Number.parseInt(m[1] as string, 10)
  return m[2] === "W" ? -value : value
}

/**
 * Look up an airport by ICAO or FAA identifier: coordinates, field elevation,
 * magnetic variation, frequencies and runways, from the FAA record served by
 * aviationweather.gov.
 */
export default async (input: { readonly id: string }, ctx: B4ToolContext): Promise<Airport> => {
  const id = input.id.trim().toUpperCase()
  const records = await awc.getJson<AwcAirport[]>("airport", { ids: id }, ctx.signal)
  const record = records[0]
  if (!record) throw new Error(`no airport record for ${id}`)
  const frequencies = (record.freqs ?? "")
    .split(";")
    .map((entry) => entry.split(","))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([name, mhz]) => ({ name: name.trim(), mhz: mhz.trim() }))
  const runways = (record.runways ?? []).map((runway) => {
    const [length, width] = (runway.dimension ?? "0x0")
      .split("x")
      .map((n) => Number.parseInt(n, 10))
    return {
      id: runway.id,
      lengthFt: length ?? 0,
      widthFt: width ?? 0,
      surface: runway.surface ?? "",
      alignmentDeg: runway.alignment ?? 0,
    }
  })
  return {
    id: record.icaoId ?? id,
    name: titleCase(record.name ?? id),
    state: record.state ?? "",
    lat: record.lat,
    lon: record.lon,
    elevationFt: record.elev ?? 0,
    magneticVariationDeg: variationFrom(record.magdec),
    frequencies,
    runways,
  }
}

export const display = {
  icon: "web",
  running: ({ id }) => `Looking up ${id.toUpperCase()}`,
  done: ({ id }, airport) =>
    `Looked up ${id.toUpperCase()}, ${airport.name}, field elevation ${airport.elevationFt} ft`,
} satisfies ToolDisplay<{ readonly id: string }, Airport>
