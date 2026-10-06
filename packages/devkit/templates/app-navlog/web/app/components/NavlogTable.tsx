import { formatGal, formatHeading, formatHhmm, formatUtcHhmm, formatVariation } from "../lib/format"
import type { Navlog, NavlogLeg } from "../lib/navlog-types"

const legName = (leg: NavlogLeg): string => `${leg.from} → ${leg.to} (${leg.segment})`

interface Column {
  readonly key: string
  readonly label: string
  /** The header's tooltip, spelling out the abbreviation. */
  readonly title: string
  readonly value: (leg: NavlogLeg) => string
}

/** Where the variation comes from; the footnote under the table says the same. */
export const VARIATION_SOURCE = "Variation from the FAA airport record"

const COLUMNS: readonly Column[] = [
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

const column = (key: string): Column => COLUMNS.find((c) => c.key === key) as Column

/** Phone cards: the six numbers flown by, fuel remaining last and loudest. */
const CARD_KEYS = ["mh", "gs", "ete", "eta", "fuel", "fuelrem"] as const

function totalFor(navlog: Navlog, key: string): string {
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

export interface NavlogTableProps {
  readonly navlog: Navlog
  /** `table` (desktop) or `cards` (phone). */
  readonly variant?: "table" | "cards"
  readonly onHoverLeg?: (index: number | null) => void
}

function VariationNote() {
  return (
    <p className="mt-1.5 text-[11px] text-wb-muted">
      <sup aria-hidden="true">*</sup> {VARIATION_SOURCE}; it may be dated.
    </p>
  )
}

/** The classic paper navlog: one row per leg segment, a totals row. */
export function NavlogTable({ navlog, variant = "table", onHoverLeg }: NavlogTableProps) {
  if (variant === "cards") {
    return (
      <div className="pt-1">
        <ol className="grid gap-2">
          {navlog.legs.map((leg, index) => (
            <li
              key={`${leg.from}-${leg.to}-${leg.segment}`}
              data-leg={index}
              className="wb-leg-card grid grid-cols-3 gap-x-3 gap-y-1.5 rounded-wb border border-wb-border p-3 text-[13px] tabular-nums"
            >
              <span className="col-span-3 flex items-baseline justify-between gap-2">
                <span className="font-semibold">{legName(leg)}</span>
                <span className="text-[12px] text-wb-muted">
                  {leg.distanceNm} nm · {leg.remainingNm} rem
                </span>
              </span>
              {CARD_KEYS.map((key) => {
                const c = column(key)
                const loud = key === "fuelrem"
                return (
                  <span key={key} title={c.title} className={loud ? "wb-leg-loud" : ""}>
                    <span className="block text-[11px] text-wb-muted">{c.label}</span>
                    <span className={loud ? "font-semibold" : ""}>{c.value(leg)}</span>
                  </span>
                )
              })}
              <span className="col-span-3 text-[12px] text-wb-muted">
                Wind {column("wind").value(leg)} · WCA {column("wca").value(leg)} · Var{" "}
                {column("var").value(leg)}
                <sup aria-hidden="true">*</sup>
              </span>
            </li>
          ))}
        </ol>
        <VariationNote />
      </div>
    )
  }
  return (
    <div>
      <table className="wb-navlog-table w-full border-collapse text-[12.5px] tabular-nums">
        <thead>
          <tr>
            <th scope="col" className="text-left">
              Leg
            </th>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                scope="col"
                title={c.title}
                className={`text-right ${c.key === "fuelrem" ? "wb-col-loud" : ""}`}
              >
                {c.label}
                {c.key === "var" ? <sup aria-hidden="true">*</sup> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {navlog.legs.map((leg, index) => (
            <tr
              key={`${leg.from}-${leg.to}-${leg.segment}`}
              data-leg={index}
              tabIndex={0}
              className="wb-focus"
              onMouseEnter={() => onHoverLeg?.(index)}
              onMouseLeave={() => onHoverLeg?.(null)}
              onFocus={() => onHoverLeg?.(index)}
              onBlur={() => onHoverLeg?.(null)}
            >
              <td className="text-left">{legName(leg)}</td>
              {COLUMNS.map((c) => (
                <td
                  key={c.key}
                  className={`text-right ${c.key === "fuelrem" ? "wb-col-loud" : ""}`}
                >
                  {c.value(leg)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="text-left">
              Totals
            </th>
            {COLUMNS.map((c) => (
              <td key={c.key} className={`text-right ${c.key === "fuelrem" ? "wb-col-loud" : ""}`}>
                {totalFor(navlog, c.key)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
      <VariationNote />
    </div>
  )
}
