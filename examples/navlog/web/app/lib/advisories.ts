/**
 * The weather brief's "Advisories:" lines, read for display: each line into
 * its product, hazard, altitudes, validity and relevance to the flight, how
 * loudly to show it, and which advisories earn a chip of their own. Pure, no
 * React; the verdict floor (`./verdict`) reads the same parse.
 */

export type AdvisoryRelevance =
  | "during flight"
  | "expires before departure"
  | "starts after arrival"

/** One advisory line, parsed from `<PRODUCT> <HAZARD> | <altitudes> | valid … | <RELEVANCE>`. */
export interface Advisory {
  /** `G-AIRMET`, `AIRMET`, `SIGMET`, `CWA`…; empty for a free-text line. */
  readonly product: string
  /** `FZLVL`, `ICE`, `CONVECTIVE`…; empty for a free-text line. */
  readonly hazard: string
  /** `freezing level 4,000 ft`, `tops FL290`; empty when the line does not say. */
  readonly altitudes: string
  /** `2100Z–0300Z 07`; empty when the line does not say. */
  readonly valid: string
  /** Null when the line does not say (briefs written before the advisory contract). */
  readonly relevance: AdvisoryRelevance | null
  /** The lowest altitude the advisory names, in feet, or null. `SFC` is 0. */
  readonly lowestFt: number | null
  readonly raw: string
}

const RELEVANCES: readonly AdvisoryRelevance[] = [
  "during flight",
  "expires before departure",
  "starts after arrival",
]

/** Every altitude the text names, in feet: `FL290`, `4,000 ft`, `SFC`. */
function altitudesFt(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/\bFL\s?(\d{2,3})\b/gi)) out.push(Number(m[1]) * 100)
  for (const m of text.matchAll(/\b(\d{1,2},?\d{3})\s*(?:ft|feet)\b/gi)) {
    out.push(Number((m[1] as string).replace(",", "")))
  }
  if (/\bSFC\b|\bsurface\b/i.test(text)) out.push(0)
  return out
}

const PRODUCT = /^(CONVECTIVE SIGMET|G-AIRMET|AIRMET|SIGMET|CWA|PIREP|TFR)\s+(.*)$/i

/** One advisory line from the brief (`G-AIRMET FZLVL | … | valid … | relevance`) into its parts. */
export function parseAdvisory(line: string): Advisory {
  const raw = line.trim()
  const parts = raw.split("|").map((part) => part.trim())
  const head = PRODUCT.exec(parts[0] ?? "")
  const product = head ? (head[1] as string).toUpperCase() : ""
  const hazard = head ? (head[2] as string).trim() : ""
  const last = (parts.at(-1) ?? "").toLowerCase().replace(/\.$/, "")
  const relevance =
    RELEVANCES.find((r) => last === r) ??
    RELEVANCES.find((r) => raw.toLowerCase().includes(r)) ??
    null
  const valid = parts.find((part) => /^valid\b/i.test(part)) ?? ""
  const altitudes =
    parts.length >= 3 && !/^valid\b/i.test(parts[1] ?? "") ? (parts[1] as string) : ""
  const alts = altitudesFt(altitudes !== "" ? altitudes : raw)
  return {
    product,
    hazard,
    altitudes,
    valid: valid.replace(/^valid\s*/i, ""),
    relevance,
    lowestFt: alts.length > 0 ? Math.min(...alts) : null,
    raw,
  }
}

export type HazardSeverity = "danger" | "warn" | "muted"

/** Hazards that turn a during-flight advisory red when they reach the cruise altitude. */
const SEVERE = /\b(CONVECTIVE|ICE|ICING|TS|THUNDERSTORMS?)\b/i

/**
 * How loudly an advisory is shown. During the flight: amber, or red for
 * convection or icing at or below the cruise altitude (or at an unknown
 * altitude). Outside the flight, or when the line does not say: muted.
 */
export function advisorySeverity(advisory: Advisory, cruiseFt?: number): HazardSeverity {
  if (advisory.relevance !== "during flight") return "muted"
  if (!SEVERE.test(advisory.hazard !== "" ? advisory.hazard : advisory.raw)) return "warn"
  if (cruiseFt === undefined || advisory.lowestFt === null) return "danger"
  return advisory.lowestFt <= cruiseFt ? "danger" : "warn"
}

const HAZARD_NAMES: Readonly<Record<string, string>> = {
  FZLVL: "Freezing level",
  "M-FZLVL": "Freezing level",
  ICE: "Icing",
  TURB: "Turbulence",
  "TURB-LO": "Turbulence",
  "TURB-HI": "Turbulence",
  LLWS: "Low-level wind shear",
  SFC_WND: "Surface wind",
  MT_OBSC: "Mountain obscuration",
  IFR: "IFR",
  CONVECTIVE: "Convective",
}

/** A hazard chip's short text: `Freezing level 4,000 ft`, `SIGMET Convective tops FL290`. */
export function advisoryLabel(advisory: Advisory): string {
  if (advisory.hazard === "") {
    return advisory.raw.length > 48 ? `${advisory.raw.slice(0, 47)}…` : advisory.raw
  }
  const name = HAZARD_NAMES[advisory.hazard.toUpperCase()] ?? advisory.hazard
  const prefix = /SIGMET|CWA/.test(advisory.product) ? `${advisory.product} ` : ""
  // "freezing level 4,000 ft" under a "Freezing level" name reads twice.
  const where = advisory.altitudes.replace(/^freezing level\s*/i, "").trim()
  return `${prefix}${name}${where !== "" ? ` ${where}` : ""}`
}

const RANK: Readonly<Record<HazardSeverity, number>> = { danger: 0, warn: 1, muted: 2 }

/** Advisories loudest first: red, then amber, then the ones outside the flight. */
function sortAdvisories(advisories: readonly Advisory[], cruiseFt?: number): readonly Advisory[] {
  return [...advisories].sort(
    (a, b) => RANK[advisorySeverity(a, cruiseFt)] - RANK[advisorySeverity(b, cruiseFt)],
  )
}

/**
 * The advisories worth a chip, and the rest. A G-AIRMET repeats per forecast
 * hour and per contour, so identical labels collapse to one. Advisories that
 * expire before departure or start after arrival do not change the flight;
 * they become one quiet "N outside the flight window" chip instead of a row
 * each, so the hazards that matter are not drowned out. An advisory with no
 * relevance (an older brief) cannot be placed, so it keeps its own chip.
 */
export function partitionAdvisories(
  advisories: readonly Advisory[],
  cruiseFt?: number,
): { readonly relevant: readonly Advisory[]; readonly outside: readonly Advisory[] } {
  const seen = new Set<string>()
  const relevant: Advisory[] = []
  const outside: Advisory[] = []
  for (const advisory of sortAdvisories(advisories, cruiseFt)) {
    const key = `${advisoryLabel(advisory)}|${advisory.relevance ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    const quiet = advisorySeverity(advisory, cruiseFt) === "muted" && advisory.relevance !== null
    ;(quiet ? outside : relevant).push(advisory)
  }
  return { relevant, outside }
}
