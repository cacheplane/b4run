"use client"
import { formatGal, formatHhmm } from "../lib/format"
import type { Navlog } from "../lib/navlog-types"
import { CopyFplButton, FlightPlanBlock } from "./FlightPlanBlock"
import { NavlogTable } from "./NavlogTable"

export interface NavlogSheetProps {
  readonly navlog: Navlog
  /** The assistant's plain-language brief for this plan (the last assistant message). */
  readonly brief: string
  readonly open: boolean
  readonly onToggle: () => void
  readonly onHoverLeg?: (index: number | null) => void
  /** `table` on desktop, `cards` on phones. */
  readonly variant?: "table" | "cards"
}

/**
 * The bottom sheet: one line of totals when collapsed; the navlog form, the
 * flight plan and the brief when open. A native disclosure, not a gesture.
 */
export function NavlogSheet({
  navlog,
  brief,
  open,
  onToggle,
  onHoverLeg,
  variant = "table",
}: NavlogSheetProps) {
  const first = navlog.waypoints[0]?.id ?? ""
  const last = navlog.waypoints.at(-1)?.id ?? ""
  const reserve = navlog.totals.reserveOk
    ? `${formatHhmm(navlog.totals.reserveMin)} reserve`
    : "Reserve under 45 min"
  return (
    <section
      className="wb-panel wb-sheet flex max-h-[var(--wb-sheet-max)] flex-col"
      aria-label="Navlog"
    >
      <div className="wb-sheet-grip mx-auto mt-2 h-1 w-9 rounded bg-wb-border" />
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-3.5 pb-2.5 pt-2 text-[13px]">
        <button
          type="button"
          className="wb-focus flex flex-wrap items-baseline gap-x-5 gap-y-1 text-left"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span>
            <span className="mr-1 text-[12px] text-wb-muted">Route</span>
            <strong>
              {first} → {last}
            </strong>
          </span>
          <span>
            <span className="mr-1 text-[12px] text-wb-muted">Dist</span>
            <strong>{navlog.totals.distanceNm} nm</strong>
          </span>
          <span>
            <span className="mr-1 text-[12px] text-wb-muted">ETE</span>
            <strong>{formatHhmm(navlog.totals.eteMin)}</strong>
          </span>
          <span>
            <span className="mr-1 text-[12px] text-wb-muted">Fuel</span>
            <strong>{formatGal(navlog.totals.fuelGal)} gal</strong>
          </span>
          <span className={navlog.totals.reserveOk ? "" : "text-[color:var(--wb-cat-ifr)]"}>
            <strong>{reserve}</strong>
          </span>
        </button>
        <span className="wb-sheet-actions ml-auto flex gap-2">
          <button
            type="button"
            className="wb-focus rounded-wb-sm border border-wb-border px-2.5 py-1 text-[12px]"
            onClick={() => window.print()}
          >
            Print
          </button>
          <CopyFplButton plan={navlog.flightPlan} />
        </span>
      </div>
      {open ? (
        <div className="overflow-auto border-t border-wb-border px-3.5 pb-3.5">
          <NavlogTable navlog={navlog} variant={variant} {...(onHoverLeg ? { onHoverLeg } : {})} />
          <FlightPlanBlock plan={navlog.flightPlan} />
          {brief ? (
            <div className="mt-3 text-[13px]">
              <span className="text-[11px] uppercase tracking-[0.04em] text-wb-muted">Brief</span>
              <p className="mt-1 whitespace-pre-wrap">{brief}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
