import { awc } from "../awc.js"
import { type FlightCategory, flightCategory } from "../flight-category.js"
import type { Category, TimeWindow } from "./types.js"

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

export interface AwcTaf {
  readonly icaoId: string
  readonly issueTime?: string
  readonly validTimeFrom?: number
  readonly validTimeTo?: number
  readonly rawTAF: string
  readonly fcsts?: readonly AwcTafPeriod[]
}

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

/** A Taf from AWC's JSON record. */
export function toTaf(record: AwcTaf): Taf {
  return {
    id: record.icaoId,
    issuedAt: record.issueTime ?? "",
    validFromUtc: iso(record.validTimeFrom),
    validToUtc: iso(record.validTimeTo),
    periods: (record.fcsts ?? []).map(period),
    raw: record.rawTAF,
  }
}

/** The current TAFs for some stations, through the shared cached client. */
export async function fetchTafs(ids: readonly string[], signal?: AbortSignal): Promise<Taf[]> {
  if (ids.length === 0) return []
  const query = ids.map((id) => id.trim().toUpperCase()).join(",")
  const records = await awc.getJson<AwcTaf[]>("taf", { ids: query }, signal)
  return records.map(toTaf)
}

const RANK: Readonly<Record<Category, number>> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 }

/** The worse of two categories; null only when both are. */
export function worstCategory(a: Category | null, b: Category | null): Category | null {
  if (a === null) return b
  if (b === null) return a
  return RANK[a] >= RANK[b] ? a : b
}

/**
 * The flight category a TAF forecasts at `atMs`: the BASE or FM period whose
 * [fromUtc, toUtc) contains it (a later FM supersedes), made worse by any
 * TEMPO, BECMG or PROB period overlapping `window`. Null when no prevailing
 * period contains the time or it carries no category.
 */
export function categoryAt(taf: Taf, atMs: number, window: TimeWindow): Category | null {
  let base: TafPeriod | undefined
  for (const p of taf.periods) {
    if (p.change !== "BASE" && p.change !== "FM") continue
    if (Date.parse(p.fromUtc) <= atMs && atMs < Date.parse(p.toUtc)) base = p
  }
  if (base?.flightCategory === undefined) return null
  let category: Category = base.flightCategory
  for (const p of taf.periods) {
    if (p.change === "BASE" || p.change === "FM" || p.flightCategory === undefined) continue
    const overlaps = Date.parse(p.fromUtc) < window.toMs && Date.parse(p.toUtc) > window.fromMs
    if (overlaps) category = worstCategory(category, p.flightCategory) as Category
  }
  return category
}
