import { awc } from "../awc.js"
import { withinBoundingBox } from "../geo-filter.js"
import type { AdvisoryFact } from "./types.js"

/** A field AWC may send as a string, a number, or null. */
type AwcValue = string | number | null | undefined

interface AwcAdvisory {
  readonly hazard?: string | null
  readonly severity?: AwcValue
  /** AIRMET/SIGMET validity, epoch seconds. */
  readonly validTimeFrom?: AwcValue
  readonly validTimeTo?: AwcValue
  /** G-AIRMET validity: the forecast time (ISO) and its expiry (epoch seconds). */
  readonly validTime?: AwcValue
  readonly expireTime?: AwcValue
  readonly forecastHour?: number
  /** G-AIRMET altitudes, hundreds of feet as strings ("040"), or "SFC" / "FZL". */
  readonly base?: AwcValue
  readonly top?: AwcValue
  /** Freezing-level contours (FZLVL, M_FZLVL) carry their altitude here instead. */
  readonly level?: AwcValue
  readonly fzlbase?: AwcValue
  readonly fzltop?: AwcValue
  readonly due_to?: AwcValue
  /** AIRMET/SIGMET altitudes, feet. */
  readonly altitudeLow1?: AwcValue
  readonly altitudeHi1?: AwcValue
  readonly airSigmetType?: AwcValue
  /** AWC sends coordinates as numbers or numeric strings depending on the product. */
  readonly coords?: readonly { readonly lat: number | string; readonly lon: number | string }[]
  readonly rawAirSigmet?: AwcValue
}

/**
 * One advisory near the route. A field AWC did not send is absent rather than
 * empty, times are ISO 8601, and altitudes read "surface", "freezing level" or
 * "4,000 ft" whatever unit the product used.
 */
export interface Advisory {
  readonly product: "G-AIRMET" | "AIRMET" | "SIGMET"
  readonly hazard: string
  readonly severity?: string
  readonly validFrom?: string
  readonly validTo?: string
  readonly base?: string
  readonly top?: string
  /** The altitude of a freezing-level contour. */
  readonly freezingLevel?: string
  /** What the G-AIRMET is for, e.g. "CIG BLW 010 VIS BLW 3SM BR FG". */
  readonly cause?: string
  readonly raw?: string
}

/** A present, non-empty value as trimmed text; null, undefined and "" are absent. */
function text(value: AwcValue): string | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = String(value).trim()
  return trimmed === "" ? undefined : trimmed
}

/** ISO 8601 from an ISO string or epoch seconds (number or numeric string). */
function isoTime(value: AwcValue): string | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const epoch = /^\d+$/.test(raw) ? Number(raw) : undefined
  // AWC uses seconds; a millisecond value is twelve or more digits.
  const date = epoch === undefined ? new Date(raw) : new Date(epoch >= 1e12 ? epoch : epoch * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

const feet = (value: number): string => `${value.toLocaleString("en-US")} ft`

/** A G-AIRMET altitude: hundreds of feet ("040"), "SFC", or "FZL". */
function gairmetAltitude(value: AwcValue): string | undefined {
  const raw = text(value)?.toUpperCase()
  if (raw === undefined) return undefined
  if (raw === "SFC") return "surface"
  if (raw === "FZL") return "freezing level"
  return /^\d{1,3}$/.test(raw) ? feet(Number(raw) * 100) : raw
}

/** An AIRMET/SIGMET altitude in feet. */
function airsigmetAltitude(value: AwcValue): string | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? feet(n) : raw
}

function touches(point: { lat: number; lon: number }, advisory: AwcAdvisory): boolean {
  const coords = (advisory.coords ?? [])
    .map((c) => ({ lat: Number(c.lat), lon: Number(c.lon) }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
  return withinBoundingBox(point, coords)
}

/** Only the fields that have a value, so the brief never reads "null" or "". */
function present<T extends Record<string, string | undefined>>(
  fields: T,
): { [K in keyof T]?: string } {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ) as { [K in keyof T]?: string }
}

function fromGairmet(advisory: AwcAdvisory): Advisory {
  return {
    product: "G-AIRMET",
    hazard: text(advisory.hazard) ?? "",
    ...present({
      severity: text(advisory.severity),
      validFrom: isoTime(advisory.validTime),
      validTo: isoTime(advisory.expireTime),
      base: gairmetAltitude(advisory.base ?? advisory.fzlbase),
      top: gairmetAltitude(advisory.top ?? advisory.fzltop),
      freezingLevel: gairmetAltitude(advisory.level),
      cause: text(advisory.due_to),
    }),
  }
}

function fromAirsigmet(advisory: AwcAdvisory): Advisory {
  return {
    product: text(advisory.airSigmetType)?.toUpperCase() === "AIRMET" ? "AIRMET" : "SIGMET",
    hazard: text(advisory.hazard) ?? "",
    ...present({
      severity: text(advisory.severity),
      validFrom: isoTime(advisory.validTimeFrom),
      validTo: isoTime(advisory.validTimeTo),
      base: airsigmetAltitude(advisory.altitudeLow1),
      top: airsigmetAltitude(advisory.altitudeHi1),
      raw: text(advisory.rawAirSigmet),
    }),
  }
}

/**
 * G-AIRMETs, AIRMETs and SIGMETs whose area touches any of the points (each
 * padded half a degree), one row per distinct advisory.
 */
export async function fetchAdvisoriesNear(
  points: readonly { readonly lat: number; readonly lon: number }[],
  signal?: AbortSignal,
): Promise<Advisory[]> {
  const [gairmets, airsigmets] = await Promise.all([
    awc.getJson<AwcAdvisory[]>("gairmet", {}, signal),
    awc.getJson<AwcAdvisory[]>("airsigmet", {}, signal),
  ])
  const near = (advisory: AwcAdvisory): boolean => points.some((point) => touches(point, advisory))
  // G-AIRMETs repeat per forecast hour; keep one row per distinct advisory.
  const seen = new Set<string>()
  const rows: Advisory[] = []
  for (const advisory of gairmets) {
    if (!near(advisory)) continue
    const row = fromGairmet(advisory)
    const key = [row.hazard, row.validFrom, row.base, row.top, row.freezingLevel].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  for (const advisory of airsigmets) if (near(advisory)) rows.push(fromAirsigmet(advisory))
  return rows
}

/** "4,000 ft", "surface" or "FL290" in feet; null for "freezing level" or nothing. */
export function altitudeFt(text: string | undefined): number | null {
  if (text === undefined) return null
  if (/^surface$/i.test(text.trim())) return 0
  const fl = /\bFL\s?(\d{2,3})\b/i.exec(text)
  if (fl) return Number(fl[1]) * 100
  const ft = /(\d{1,3}(?:,\d{3})*|\d+)\s*ft\b/i.exec(text)
  return ft ? Number((ft[1] as string).replaceAll(",", "")) : null
}

/** Where an advisory's validity sits against the flight window. A missing start counts as already valid. */
export function advisoryRelevance(
  validFromMs: number | null,
  validToMs: number | null,
  departureMs: number,
  etaMs: number,
): AdvisoryFact["relevance"] {
  if (validToMs !== null && validToMs <= departureMs) return "before-departure"
  if (validFromMs !== null && validFromMs >= etaMs) return "after-arrival"
  return "during-flight"
}

/** The typed fact for one advisory and one flight. */
export function toAdvisoryFact(
  advisory: Advisory,
  departureMs: number,
  etaMs: number,
): AdvisoryFact {
  const contour = altitudeFt(advisory.freezingLevel)
  const fromMs = advisory.validFrom === undefined ? null : Date.parse(advisory.validFrom)
  const toMs = advisory.validTo === undefined ? null : Date.parse(advisory.validTo)
  return {
    product: advisory.product,
    hazard: advisory.hazard,
    lowestFt: contour ?? altitudeFt(advisory.base),
    highestFt: contour ?? altitudeFt(advisory.top),
    validFromUtc: advisory.validFrom ?? null,
    validToUtc: advisory.validTo ?? null,
    relevance: advisoryRelevance(fromMs, toMs, departureMs, etaMs),
  }
}
