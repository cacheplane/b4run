"use client"
import { useId, useMemo } from "react"
import { formatFeet, formatGal, formatHhmm, formatUtcHhmm } from "../lib/format"
import type { Navlog } from "../lib/navlog-types"
import { type EffectiveVerdict, resolveVerdict } from "../lib/verdict"
import { parseAdvisory, type WeatherBrief } from "../lib/weather-selectors"
import { CopyFplButton, FlightPlanBlock } from "./FlightPlanBlock"
import { NavlogTable } from "./NavlogTable"
import { PlanningBrief } from "./PlanningBrief"
import { VerdictCard, VerdictPill } from "./VerdictCard"

export interface NavlogSheetProps {
  readonly navlog: Navlog
  /** The planning answer of the turn that produced this navlog (see `navlogAnswerText`). */
  readonly brief: string
  /** The weather brief, for the verdict, the hazards and the forecast horizon. */
  readonly weather?: WeatherBrief | null
  readonly open: boolean
  readonly onToggle: () => void
  readonly onHoverLeg?: (index: number | null) => void
  /** `table` on desktop, `cards` on phones. */
  readonly variant?: "table" | "cards"
  /**
   * Whether the header is a disclosure button. The phone's Navlog tab is
   * always open, so there it is plain text: a toggle that does nothing would
   * still announce itself as expandable.
   */
  readonly collapsible?: boolean
}

/**
 * The verdict to show: the worse of the weather brief's "Verdict:" and the
 * planning answer's "Bottom line:", raised to the verdict floor (the brief's
 * written rules, checked against its data and this navlog's reserve). None
 * when neither call exists and the floor finds nothing.
 */
export function sheetVerdict(
  weather: WeatherBrief | null | undefined,
  brief: string,
  navlog?: Navlog | null,
): EffectiveVerdict | null {
  return resolveVerdict({ weather, answer: brief, navlog })
}

/**
 * The bottom sheet: the route and its totals when collapsed; the verdict, the
 * key totals, the navlog form, the flight plan and the planning brief when
 * open. A native disclosure, not a gesture.
 *
 * The body is always in the DOM, only hidden on screen while collapsed
 * (`hidden print:block`), so Print prints the whole navlog whichever state the
 * sheet is in.
 */
export function NavlogSheet({
  navlog,
  brief,
  weather = null,
  open,
  onToggle,
  onHoverLeg,
  variant = "table",
  collapsible = true,
}: NavlogSheetProps) {
  const bodyId = useId()
  const first = navlog.waypoints[0]?.id ?? ""
  const last = navlog.waypoints.at(-1)?.id ?? ""
  const { totals } = navlog
  const reserve = totals.reserveOk
    ? `${formatHhmm(totals.reserveMin)} reserve`
    : "Reserve under 45 min"
  const shown = open || !collapsible
  const verdict = useMemo(() => sheetVerdict(weather, brief, navlog), [weather, brief, navlog])
  const advisories = useMemo(() => (weather?.advisories ?? []).map(parseAdvisory), [weather])
  const meta = [
    navlog.aircraft.tailNumber,
    formatFeet(navlog.altitudeFt),
    `dep ${formatUtcHhmm(navlog.departureTimeUtc)}`,
  ].join(" · ")

  const title = (
    <span className="flex min-w-0 flex-col">
      <span className="wb-route-title">
        {first} → {last}
      </span>
      {shown ? (
        <span className="text-[12px] text-wb-muted tabular-nums">{meta}</span>
      ) : (
        // Collapsed: the totals ride in the header, since the tiles are hidden.
        <span className="flex flex-wrap gap-x-3 text-[12.5px] tabular-nums text-wb-muted">
          <span>
            <strong className="font-semibold text-wb-text">{totals.distanceNm} nm</strong>
          </span>
          <span>
            ETE <strong className="font-semibold text-wb-text">{formatHhmm(totals.eteMin)}</strong>
          </span>
          <span>
            <strong className="font-semibold text-wb-text">{formatGal(totals.fuelGal)} gal</strong>{" "}
            burned
          </span>
          <span className={totals.reserveOk ? "" : "wb-text-danger"}>
            <strong className="font-semibold">{reserve}</strong>
          </span>
        </span>
      )}
    </span>
  )

  const card = verdict ? (
    <VerdictCard
      verdict={verdict}
      advisories={advisories}
      cruiseFt={navlog.altitudeFt}
      horizon={weather?.horizon}
    />
  ) : null

  return (
    <section
      // On the phone the sheet already sits in the bottom sheet's panel, so
      // it drops its own panel and height cap instead of nesting a second card.
      className={`wb-sheet flex flex-col ${
        collapsible ? "wb-panel max-h-[var(--wb-sheet-max)]" : "wb-sheet-flat"
      }`}
      aria-label="Navlog"
    >
      {collapsible ? (
        <div className="wb-sheet-grip mx-auto mt-1.5 h-1 w-9 rounded-full bg-wb-border" />
      ) : null}
      {!collapsible && card ? <div className="px-3.5 pt-3">{card}</div> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 pb-2.5 pt-2">
        {collapsible ? (
          <button
            type="button"
            className="wb-focus flex min-w-[14rem] flex-1 items-center gap-3 rounded-wb-sm text-left"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={onToggle}
          >
            <span className="sr-only">{open ? "Hide navlog" : "Show navlog"}</span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={`size-4 shrink-0 text-wb-muted transition-transform print:hidden ${open ? "" : "rotate-180"}`}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
            {verdict && !open ? <VerdictPill verdict={verdict} /> : null}
            {title}
          </button>
        ) : (
          <div className="flex min-w-[12rem] flex-1 items-center gap-3">{title}</div>
        )}
        <span className="wb-sheet-actions flex shrink-0 gap-2">
          <button type="button" className="wb-focus wb-button" onClick={() => window.print()}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="size-3.5"
            >
              <path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z" />
            </svg>
            Print
          </button>
          <CopyFplButton plan={navlog.flightPlan} />
        </span>
      </div>
      <div
        id={bodyId}
        className={`wb-sheet-body overflow-auto border-t border-wb-border px-3.5 pb-4 ${
          shown ? "" : "hidden print:block"
        }`}
      >
        {collapsible && card ? <div className="pt-3">{card}</div> : null}
        <dl className="wb-stats mt-3" aria-label="Totals">
          <div className="wb-stat">
            <dt>Distance</dt>
            <dd>{totals.distanceNm} nm</dd>
          </div>
          <div className="wb-stat">
            <dt>ETE</dt>
            <dd>{formatHhmm(totals.eteMin)}</dd>
          </div>
          <div className="wb-stat">
            <dt>Fuel burned</dt>
            <dd>{formatGal(totals.fuelGal)} gal</dd>
          </div>
          <div className="wb-stat">
            <dt>Fuel at landing</dt>
            <dd>{formatGal(totals.fuelRemainingGal)} gal</dd>
          </div>
          <div className="wb-stat" data-tone={totals.reserveOk ? undefined : "danger"}>
            <dt>Reserve</dt>
            <dd>
              {formatHhmm(totals.reserveMin)}
              {totals.reserveOk ? null : <span className="wb-stat-note">under 45 min</span>}
            </dd>
          </div>
        </dl>
        <div className="mt-3">
          <NavlogTable navlog={navlog} variant={variant} {...(onHoverLeg ? { onHoverLeg } : {})} />
        </div>
        <FlightPlanBlock plan={navlog.flightPlan} />
        {brief ? <PlanningBrief text={brief} verdict={verdict} /> : null}
      </div>
    </section>
  )
}
