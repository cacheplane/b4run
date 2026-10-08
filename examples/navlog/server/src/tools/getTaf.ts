import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"

interface AwcTafPeriod {
  readonly timeFrom: number
  readonly timeTo: number
  readonly fcstChange?: string | null
  readonly probability?: number | null
  readonly wdir?: number | string | null
  readonly wspd?: number | null
  readonly wgst?: number | null
  readonly visib?: number | string | null
  readonly wxString?: string | null
  readonly clouds?: readonly { readonly cover: string; readonly base?: number | null }[]
}

interface AwcTaf {
  readonly icaoId: string
  readonly issueTime?: string
  readonly validTimeFrom?: number
  readonly validTimeTo?: number
  readonly rawTAF: string
  readonly fcsts?: readonly AwcTafPeriod[]
}

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR"

/**
 * One TAF group with its validity already decoded to ISO UTC instants, so the
 * planner never reads the raw DDHHMM groups itself. `change` is BASE for the
 * opening group, FM for a permanent change, and TEMPO, BECMG or PROB for a
 * temporary or probable one layered over the prevailing group.
 */
export interface TafPeriod {
  readonly change: "BASE" | "FM" | "TEMPO" | "BECMG" | "PROB"
  readonly probability?: number
  readonly fromUtc: string
  readonly toUtc: string
  readonly flightCategory?: FlightCategory
  readonly ceilingFt?: number
  readonly visibilityMi?: number
  readonly windDirDeg?: number | "VRB"
  readonly windKt?: number
  readonly gustKt?: number
  readonly weather?: string
}

export interface Taf {
  readonly id: string
  readonly issuedAt: string
  readonly validFromUtc: string
  readonly validToUtc: string
  readonly periods: readonly TafPeriod[]
  readonly raw: string
}

const iso = (epochSeconds: number | undefined): string =>
  epochSeconds === undefined ? "" : new Date(epochSeconds * 1000).toISOString()

const CHANGES = new Set(["FM", "TEMPO", "BECMG", "PROB"])

// AWC reports visibility as a number of statute miles, or "6+" for P6SM.
const visibility = (visib: AwcTafPeriod["visib"]): number | undefined => {
  if (typeof visib === "number") return visib
  if (typeof visib !== "string") return undefined
  const miles = Number.parseFloat(visib)
  return Number.isFinite(miles) ? miles : undefined
}

// The ceiling is the lowest broken, overcast or obscured layer.
const ceiling = (clouds: AwcTafPeriod["clouds"]): number | undefined => {
  const bases = (clouds ?? [])
    .filter(
      (layer) =>
        ["BKN", "OVC", "OVX", "VV"].includes(layer.cover) && typeof layer.base === "number",
    )
    .map((layer) => layer.base as number)
  return bases.length === 0 ? undefined : Math.min(...bases)
}

/** The FAA flight category for a ceiling (ft AGL) and visibility (statute miles). */
export const flightCategory = (
  ceilingFt: number | undefined,
  visibilityMi: number | undefined,
): FlightCategory | undefined => {
  if (ceilingFt === undefined && visibilityMi === undefined) return undefined
  const ceil = ceilingFt ?? Number.POSITIVE_INFINITY
  const vis = visibilityMi ?? Number.POSITIVE_INFINITY
  if (ceil < 500 || vis < 1) return "LIFR"
  if (ceil < 1000 || vis < 3) return "IFR"
  if (ceil <= 3000 || vis <= 5) return "MVFR"
  return "VFR"
}

const period = (fcst: AwcTafPeriod): TafPeriod => {
  const ceilingFt = ceiling(fcst.clouds)
  const visibilityMi = visibility(fcst.visib)
  const category = flightCategory(ceilingFt, visibilityMi)
  const change = fcst.fcstChange && CHANGES.has(fcst.fcstChange) ? fcst.fcstChange : "BASE"
  const windDirDeg =
    fcst.wdir === "VRB" ? "VRB" : typeof fcst.wdir === "number" ? fcst.wdir : undefined
  return {
    change: change as TafPeriod["change"],
    ...(typeof fcst.probability === "number" ? { probability: fcst.probability } : {}),
    fromUtc: iso(fcst.timeFrom),
    toUtc: iso(fcst.timeTo),
    ...(category !== undefined ? { flightCategory: category } : {}),
    ...(ceilingFt !== undefined ? { ceilingFt } : {}),
    ...(visibilityMi !== undefined ? { visibilityMi } : {}),
    ...(windDirDeg !== undefined ? { windDirDeg } : {}),
    ...(typeof fcst.wspd === "number" ? { windKt: fcst.wspd } : {}),
    ...(typeof fcst.wgst === "number" ? { gustKt: fcst.wgst } : {}),
    ...(fcst.wxString ? { weather: fcst.wxString } : {}),
  }
}

/**
 * Current TAF for one or more stations: validity, each forecast group with its
 * decoded UTC window and flight category, and the raw forecast text.
 */
export default async (
  input: { readonly ids: readonly string[] },
  ctx: B4ToolContext,
): Promise<Taf[]> => {
  const ids = input.ids.map((id) => id.trim().toUpperCase()).join(",")
  const records = await awc.getJson<AwcTaf[]>("taf", { ids }, ctx.signal)
  return records.map((record) => ({
    id: record.icaoId,
    issuedAt: record.issueTime ?? "",
    validFromUtc: iso(record.validTimeFrom),
    validToUtc: iso(record.validTimeTo),
    periods: (record.fcsts ?? []).map(period),
    raw: record.rawTAF,
  }))
}

export const display = {
  icon: "web",
  running: ({ ids }) => `Fetching TAFs for ${ids.join(", ").toUpperCase()}`,
  done: (_input, tafs) => `Fetched ${tafs.length} TAF${tafs.length === 1 ? "" : "s"}`,
} satisfies ToolDisplay<{ readonly ids: readonly string[] }, Taf[]>
