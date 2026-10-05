import { formatGal, formatHeading, formatHhmm, formatUtcHhmm } from "../lib/format"
import type { Navlog, NavlogLeg } from "../lib/navlog-types"

const legName = (leg: NavlogLeg): string => `${leg.from} → ${leg.to} (${leg.segment})`

interface Column {
  readonly key: string
  readonly label: string
  readonly value: (leg: NavlogLeg) => string
}

const COLUMNS: readonly Column[] = [
  { key: "tc", label: "TC", value: (leg) => formatHeading(leg.trueCourse) },
  {
    key: "var",
    label: "Var",
    value: (leg) => `${Math.abs(leg.variation)}${leg.variation < 0 ? "W" : "E"}`,
  },
  { key: "mc", label: "MC", value: (leg) => formatHeading(leg.magneticCourse) },
  { key: "wind", label: "Wind", value: (leg) => `${formatHeading(leg.wind.dir)}/${leg.wind.kt}` },
  { key: "wca", label: "WCA", value: (leg) => `${leg.wca > 0 ? "+" : ""}${leg.wca}` },
  { key: "mh", label: "MH", value: (leg) => formatHeading(leg.magneticHeading) },
  { key: "tas", label: "TAS", value: (leg) => String(Math.round(leg.tasKt)) },
  { key: "gs", label: "GS", value: (leg) => String(leg.groundspeedKt) },
  { key: "dist", label: "Dist", value: (leg) => String(leg.distanceNm) },
  { key: "rem", label: "Rem", value: (leg) => String(leg.remainingNm) },
  { key: "ete", label: "ETE", value: (leg) => formatHhmm(leg.eteMin) },
  { key: "eta", label: "ETA", value: (leg) => formatUtcHhmm(leg.etaUtc) },
  { key: "fuel", label: "Fuel", value: (leg) => formatGal(leg.fuelGal) },
  { key: "fuelrem", label: "Rem", value: (leg) => formatGal(leg.fuelRemainingGal) },
]

const CARD_KEYS = ["mh", "gs", "dist", "ete", "eta", "fuel"] as const

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

/** The classic paper navlog: one row per leg segment, a totals row. */
export function NavlogTable({ navlog, variant = "table", onHoverLeg }: NavlogTableProps) {
  if (variant === "cards") {
    return (
      <div className="grid gap-2 pt-2">
        {navlog.legs.map((leg, index) => (
          <div
            key={`${leg.from}-${leg.to}-${leg.segment}`}
            data-leg={index}
            className="grid grid-cols-3 gap-x-3 gap-y-1 rounded-wb border border-wb-border p-2.5 text-[12.5px] tabular-nums"
          >
            <span className="col-span-3 font-semibold">{legName(leg)}</span>
            {CARD_KEYS.map((key) => {
              const column = COLUMNS.find((c) => c.key === key) as Column
              return (
                <span key={key}>
                  <span className="block text-[11px] text-wb-muted">{column.label}</span>
                  {column.value(leg)}
                </span>
              )
            })}
          </div>
        ))}
      </div>
    )
  }
  return (
    <table className="w-full border-collapse text-[12.5px] tabular-nums">
      <thead>
        <tr>
          <th className="border-b border-wb-border px-1.5 py-1.5 text-left font-medium text-wb-muted">
            Leg
          </th>
          {COLUMNS.map((column) => (
            <th
              key={column.key}
              className="whitespace-nowrap border-b border-wb-border px-1.5 py-1.5 text-right font-medium text-wb-muted"
            >
              {column.label}
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
            className="wb-focus hover:bg-wb-rail focus:bg-wb-rail"
            onMouseEnter={() => onHoverLeg?.(index)}
            onMouseLeave={() => onHoverLeg?.(null)}
            onFocus={() => onHoverLeg?.(index)}
            onBlur={() => onHoverLeg?.(null)}
          >
            <td className="whitespace-nowrap border-b border-wb-border px-1.5 py-1.5">
              {legName(leg)}
            </td>
            {COLUMNS.map((column) => (
              <td
                key={column.key}
                className="whitespace-nowrap border-b border-wb-border px-1.5 py-1.5 text-right"
              >
                {column.value(leg)}
              </td>
            ))}
          </tr>
        ))}
        <tr className="font-semibold">
          <td className="px-1.5 py-1.5">Totals</td>
          {COLUMNS.map((column) => (
            <td key={column.key} className="px-1.5 py-1.5 text-right">
              {totalFor(navlog, column.key)}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  )
}
