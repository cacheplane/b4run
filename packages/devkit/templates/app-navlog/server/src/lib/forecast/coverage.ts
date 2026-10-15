import type { Coverage, TimeWindow } from "./types.js"

/** "2102Z" for an epoch-ms instant. */
export function hhmmZ(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}Z`
}

interface TafRange {
  readonly validFromUtc: string
  readonly validToUtc: string
}

export interface CoverageInput {
  readonly departureMs: number
  readonly etaMs: number
  readonly origin: { readonly id: string; readonly taf: TafRange | null }
  readonly destination: { readonly id: string; readonly taf: TafRange | null }
  readonly legs: readonly {
    readonly leg: number
    readonly startMs: number
    readonly endMs: number
  }[]
  /** Every published winds-aloft FOR USE window. The products abut, so their union is what covers a leg. */
  readonly windWindows: readonly TimeWindow[]
}

/** The union of the windows, merged where they touch or overlap, sorted. */
function merge(windows: readonly TimeWindow[]): TimeWindow[] {
  const sorted = [...windows].sort((a, b) => a.fromMs - b.fromMs)
  const out: TimeWindow[] = []
  for (const w of sorted) {
    const last = out.at(-1)
    if (last && w.fromMs <= last.toMs) {
      out[out.length - 1] = { fromMs: last.fromMs, toMs: Math.max(last.toMs, w.toMs) }
    } else {
      out.push({ ...w })
    }
  }
  return out
}

/** Whether [startMs, endMs] lies inside one merged span of the windows. */
export function intervalCovered(
  startMs: number,
  endMs: number,
  windows: readonly TimeWindow[],
): boolean {
  return merge(windows).some((s) => s.fromMs <= startMs && endMs <= s.toMs)
}

/**
 * Whether the forecasts reach the flight, by the one definition the navlog
 * uses: the origin TAF covers the departure, the destination TAF covers the
 * ETA, and every leg's flying interval lies inside the published winds-aloft
 * windows. An airport with no TAF at all is not a gap here (it never will
 * have one); the caller notes it.
 */
export function coverage(input: CoverageInput): Coverage {
  const reasons: string[] = []
  const tafGap = (
    end: { readonly id: string; readonly taf: TafRange | null },
    atMs: number,
    what: "departure" | "ETA",
  ): void => {
    if (end.taf === null) return
    const from = Date.parse(end.taf.validFromUtc)
    const to = Date.parse(end.taf.validToUtc)
    // A TAF whose validity cannot be read is no TAF at all.
    if (Number.isNaN(from) || Number.isNaN(to)) return
    if (atMs < from) {
      reasons.push(`the ${end.id} TAF starts ${hhmmZ(from)}, after the ${hhmmZ(atMs)} ${what}`)
    } else if (atMs >= to) {
      reasons.push(
        `the ${end.id} TAF ends at ${hhmmZ(to)} and does not cover the ${hhmmZ(atMs)} ${what}`,
      )
    }
  }
  tafGap(input.origin, input.departureMs, "departure")
  tafGap(input.destination, input.etaMs, "ETA")
  const spans = merge(input.windWindows)
  for (const leg of input.legs) {
    if (spans.length === 0) {
      reasons.push(`no winds-aloft forecast is published for leg ${leg.leg}`)
      continue
    }
    if (intervalCovered(leg.startMs, leg.endMs, input.windWindows)) continue
    const before = spans.find((s) => s.fromMs > leg.startMs && s.fromMs <= leg.endMs) ?? spans[0]
    const containing = spans.find((s) => s.fromMs <= leg.startMs && leg.startMs < s.toMs)
    if (containing === undefined && before !== undefined && before.fromMs > leg.startMs) {
      reasons.push(
        `winds for leg ${leg.leg} are forecast from ${hhmmZ(before.fromMs)}; the leg starts ${hhmmZ(leg.startMs)}`,
      )
    } else {
      const reach = (containing ?? (spans.at(-1) as TimeWindow)).toMs
      reasons.push(
        `winds for leg ${leg.leg} are forecast until ${hhmmZ(reach)}; the leg ends ${hhmmZ(leg.endMs)}`,
      )
    }
  }
  return { preliminary: reasons.length > 0, reasons }
}
