"use client"
import { useId, useMemo } from "react"
import { formatFeet, formatGal, formatHhmm, formatUtcHhmm } from "../lib/format"
import type { Navlog } from "../lib/navlog-types"
import { type EffectiveVerdict, resolveVerdict } from "../lib/verdict"
import { parseAdvisory, type WeatherBrief } from "../lib/weather-selectors"
import { CopyFplButton, FlightPlanBlock } from "./FlightPlanBlock"
import { NavlogGrid } from "./NavlogGrid"
import { NavlogTable } from "./NavlogTable"
import { PlanningBrief } from "./PlanningBrief"
import { VerdictCard, VerdictPill } from "./VerdictCard"

/**
 * A number per navlog object, the grid's key. Row ids are leg indexes, so a
 * replan of equal length would otherwise keep pretable's old selection on
 * screen (and the grid's dedupe would swallow re-selecting that leg) while the
 * layout clears its selected leg. A new navlog remounts the grid instead.
 */
const navlogRevisions = new WeakMap<Navlog, number>()
let lastNavlogRevision = 0
function navlogRevision(navlog: Navlog): number {
  let revision = navlogRevisions.get(navlog)
  if (revision === undefined) {
    lastNavlogRevision += 1
    revision = lastNavlogRevision
    navlogRevisions.set(navlog, revision)
  }
  return revision
}

const noSelectLeg = (): void => {}

export type SheetTab = "legs" | "plan" | "brief"

const SHEET_TABS: readonly { readonly id: SheetTab; readonly label: string }[] = [
  { id: "legs", label: "Legs" },
  { id: "plan", label: "Totals & plan" },
  { id: "brief", label: "Brief" },
]

export interface NavlogSheetProps {
  readonly navlog: Navlog
  /** The planning answer of the turn that produced this navlog (see `navlogAnswerText`). */
  readonly brief: string
  /** The weather brief, for the verdict, the hazards and the forecast horizon. */
  readonly weather?: WeatherBrief | null
  readonly open: boolean
  readonly onToggle: () => void
  /** The selected tab (lifted so `openSheet` can pick Legs). */
  readonly tab: SheetTab
  readonly onTabChange: (tab: SheetTab) => void
  /** The selected leg reported by the grid (desktop), for the map highlight. */
  readonly onSelectLeg?: (index: number | null) => void
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

/** The Legs tab's fixed footer: the numbers that matter while the grid scrolls. */
function TotalsStrip({ navlog }: { readonly navlog: Navlog }) {
  const { totals } = navlog
  const items: readonly (readonly [string, string, boolean])[] = [
    ["Distance", `${totals.distanceNm} nm`, false],
    ["ETE", formatHhmm(totals.eteMin), false],
    ["Fuel burned", `${formatGal(totals.fuelGal)} gal`, false],
    ["At landing", `${formatGal(totals.fuelRemainingGal)} gal`, false],
    [
      "Reserve",
      totals.reserveOk
        ? formatHhmm(totals.reserveMin)
        : `${formatHhmm(totals.reserveMin)} · under 45 min`,
      !totals.reserveOk,
    ],
  ]
  return (
    // Not printed: the tiles on Totals & plan and the table's totals row carry these.
    <dl
      aria-label="Leg totals"
      className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 border-t border-wb-border px-4 py-2.5 print:hidden"
    >
      {items.map(([label, value, danger]) => (
        <div key={label} className="flex items-baseline gap-2">
          <dt className="text-[12px] text-wb-muted">{label}</dt>
          <dd
            className={`font-mono text-[13px] font-semibold tabular-nums ${danger ? "wb-text-danger" : ""}`}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The navlog sheet: the route and its totals when collapsed. Open, a verdict
 * strip, then three tabs: Legs (the pretable grid on desktop, cards on phones,
 * with a fixed totals strip), Totals & plan (the tiles and the flight plan)
 * and Brief (the verdict card and the planning brief). A native disclosure,
 * not a gesture.
 *
 * Everything stays in the DOM: the body is only hidden on screen while
 * collapsed (`hidden print:block`), inactive panels carry `hidden` (which the
 * print rules in `theme.css` undo), and the legs print from a plain
 * `NavlogTable` because the grid virtualizes rows. So Print prints the whole
 * navlog whichever state and tab the sheet is in.
 */
export function NavlogSheet({
  navlog,
  brief,
  weather = null,
  open,
  onToggle,
  tab,
  onTabChange,
  onSelectLeg,
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
  const tabId = (id: SheetTab): string => `${bodyId}-tab-${id}`
  const panelId = (id: SheetTab): string => `${bodyId}-${id}`

  const title = (
    <span className="flex min-w-0 flex-col">
      <span className="wb-route-title">
        {first} → {last}
      </span>
      {shown ? (
        <span className="text-[12px] text-wb-muted tabular-nums">{meta}</span>
      ) : (
        // Collapsed: the totals ride in the header, since the tabs are hidden.
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

  const height = !collapsible
    ? "wb-sheet-flat h-full"
    : shown
      ? "wb-panel h-[var(--wb-sheet-max)]"
      : "wb-panel max-h-[var(--wb-sheet-max)]"

  return (
    <section
      // Open on desktop the sheet takes a definite height, so the Legs grid
      // can measure the room it fills. On the phone the sheet is the Navlog
      // tab's whole panel, so it drops its own panel instead of nesting a
      // second card.
      className={`wb-sheet flex flex-col ${height}`}
      aria-label="Navlog"
    >
      <div
        className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 ${
          collapsible ? "wb-header-row" : "pb-2.5 pt-2"
        }`}
      >
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
      {shown && verdict ? (
        <section
          aria-label="Go/no-go verdict"
          className="wb-verdict-strip flex shrink-0 items-center gap-3 border-t border-wb-border px-4 py-2"
          data-level={verdict.level}
        >
          <VerdictPill verdict={verdict} />
          <button
            type="button"
            title={verdict.reason}
            onClick={() => onTabChange("brief")}
            className="wb-focus min-w-0 flex-1 truncate rounded-wb-sm text-left text-[13px] text-wb-muted hover:text-wb-text"
          >
            {verdict.reason}
          </button>
        </section>
      ) : null}
      {shown ? (
        <div
          role="tablist"
          aria-label="Navlog views"
          className="flex shrink-0 gap-1 border-y border-wb-border px-2"
        >
          {SHEET_TABS.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={tabId(item.id)}
              aria-selected={tab === item.id}
              aria-controls={panelId(item.id)}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => onTabChange(item.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
                event.preventDefault()
                const step = event.key === "ArrowRight" ? 1 : -1
                const next = SHEET_TABS[(i + step + SHEET_TABS.length) % SHEET_TABS.length]
                if (next === undefined) return
                onTabChange(next.id)
                requestAnimationFrame(() => document.getElementById(tabId(next.id))?.focus())
              }}
              className="wb-focus wb-sheet-tab"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        id={bodyId}
        className={`wb-sheet-body flex min-h-0 flex-1 flex-col ${shown ? "" : "hidden print:block"}`}
      >
        <div
          role="tabpanel"
          id={panelId("legs")}
          aria-labelledby={tabId("legs")}
          hidden={tab !== "legs"}
          className="flex min-h-0 flex-1 flex-col"
        >
          {variant === "table" ? (
            <div className="min-h-0 flex-1">
              <NavlogGrid
                key={navlogRevision(navlog)}
                navlog={navlog}
                onSelectLeg={onSelectLeg ?? noSelectLeg}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
              <NavlogTable navlog={navlog} variant="cards" />
            </div>
          )}
          <TotalsStrip navlog={navlog} />
          {/* The print copy: pretable virtualizes rows, so print reads this table. */}
          {variant === "table" ? (
            <div className="hidden print:block">
              <NavlogTable navlog={navlog} variant="table" />
            </div>
          ) : null}
        </div>
        <div
          role="tabpanel"
          id={panelId("plan")}
          aria-labelledby={tabId("plan")}
          hidden={tab !== "plan"}
          className="min-h-0 flex-1 overflow-auto px-4 pb-4"
        >
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
          <FlightPlanBlock plan={navlog.flightPlan} />
        </div>
        <div
          role="tabpanel"
          id={panelId("brief")}
          aria-labelledby={tabId("brief")}
          hidden={tab !== "brief"}
          className="min-h-0 flex-1 overflow-auto px-4 pb-4"
        >
          {verdict ? (
            <div className="pt-3">
              <VerdictCard
                verdict={verdict}
                advisories={advisories}
                cruiseFt={navlog.altitudeFt}
                horizon={weather?.horizon}
              />
            </div>
          ) : null}
          {brief ? <PlanningBrief text={brief} verdict={verdict} /> : null}
        </div>
      </div>
    </section>
  )
}
