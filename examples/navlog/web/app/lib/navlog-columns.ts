import { formatGal, formatHeading, formatHhmm, formatUtcHhmm, formatVariation } from "./format"
import type { Navlog, NavlogLeg } from "./navlog-types"

/** A leg's name for its row: `KSTP → KRST (climb)`. */
export const legName = (leg: NavlogLeg): string => `${leg.from} → ${leg.to} (${leg.segment})`

export interface LegColumn {
  readonly key: string
  readonly label: string
  /** The header's tooltip, spelling out the abbreviation. */
  readonly title: string
  readonly value: (leg: NavlogLeg) => string
}

/** Where the variation comes from; the footnote under the table says the same. */
export const VARIATION_SOURCE = "Variation from the FAA airport record"

export const LEG_COLUMNS: readonly LegColumn[] = [
  { key: "tc", label: "TC", title: "True course", value: (leg) => formatHeading(leg.trueCourse) },
  {
    key: "var",
    label: "Var",
    title: `Magnetic variation. ${VARIATION_SOURCE}, which may be dated.`,
    value: (leg) => formatVariation(leg.variation),
  },
  {
    key: "mc",
    label: "MC",
    title: "Magnetic course",
    value: (leg) => formatHeading(leg.magneticCourse),
  },
  {
    key: "wind",
    label: "Wind",
    title: "Wind aloft, direction/knots",
    value: (leg) => `${formatHeading(leg.wind.dir)}/${leg.wind.kt}`,
  },
  {
    key: "wca",
    label: "WCA",
    title: "Wind correction angle",
    value: (leg) => `${leg.wca > 0 ? "+" : ""}${leg.wca}`,
  },
  {
    key: "mh",
    label: "MH",
    title: "Magnetic heading",
    value: (leg) => formatHeading(leg.magneticHeading),
  },
  {
    key: "tas",
    label: "TAS",
    title: "True airspeed, knots",
    value: (leg) => String(Math.round(leg.tasKt)),
  },
  {
    key: "gs",
    label: "GS",
    title: "Groundspeed, knots",
    value: (leg) => String(leg.groundspeedKt),
  },
  { key: "dist", label: "Dist", title: "Leg distance, nm", value: (leg) => String(leg.distanceNm) },
  {
    key: "rem",
    label: "Rem",
    title: "Distance remaining, nm",
    value: (leg) => String(leg.remainingNm),
  },
  { key: "ete", label: "ETE", title: "Time en route", value: (leg) => formatHhmm(leg.eteMin) },
  {
    key: "eta",
    label: "ETA",
    title: "Estimated arrival, UTC",
    value: (leg) => formatUtcHhmm(leg.etaUtc),
  },
  { key: "fuel", label: "Fuel", title: "Fuel burned, gal", value: (leg) => formatGal(leg.fuelGal) },
  {
    key: "fuelrem",
    label: "Fuel rem",
    title: "Fuel remaining, gal",
    value: (leg) => formatGal(leg.fuelRemainingGal),
  },
]

/** The totals row's value under a column, by its key; empty where a column has no total. */
export function totalFor(navlog: Navlog, key: string): string {
  switch (key) {
    case "dist":
      return String(navlog.totals.distanceNm)
    case "ete":
      return formatHhmm(navlog.totals.eteMin)
    case "fuel":
      return formatGal(navlog.totals.fuelGal)
    case "fuelrem":
      return formatGal(navlog.totals.fuelRemainingGal)
    default:
      return ""
  }
}
