import {
  LEG_COLUMNS,
  type LegColumn,
  legName,
  totalFor,
  VARIATION_SOURCE,
} from "../lib/navlog-columns"
import type { Navlog } from "../lib/navlog-types"

const column = (key: string): LegColumn => LEG_COLUMNS.find((c) => c.key === key) as LegColumn

/** Phone cards: the six numbers flown by, fuel remaining last and loudest. */
const CARD_KEYS = ["mh", "gs", "ete", "eta", "fuel", "fuelrem"] as const

export interface NavlogTableProps {
  readonly navlog: Navlog
  /** `table` (desktop) or `cards` (phone). */
  readonly variant?: "table" | "cards"
}

function VariationNote() {
  return (
    <p className="mt-1.5 text-[11px] text-wb-muted">
      <sup aria-hidden="true">*</sup> {VARIATION_SOURCE}; it may be dated.
    </p>
  )
}

/** The classic paper navlog: one row per leg segment, a totals row. */
export function NavlogTable({ navlog, variant = "table" }: NavlogTableProps) {
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
            {LEG_COLUMNS.map((c) => (
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
            <tr key={`${leg.from}-${leg.to}-${leg.segment}`} data-leg={index}>
              <td className="text-left">{legName(leg)}</td>
              {LEG_COLUMNS.map((c) => (
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
            {LEG_COLUMNS.map((c) => (
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
