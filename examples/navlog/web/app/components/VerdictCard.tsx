import { type EffectiveVerdict, raiseNote } from "../lib/verdict"
import {
  type Advisory,
  advisoryLabel,
  advisorySeverity,
  type HazardSeverity,
  isPreliminary,
  type VerdictLevel,
} from "../lib/weather-selectors"

/**
 * The go/no-go surface. Color never stands alone: every verdict carries its
 * word and its own icon shape (a check, a triangle, an octagon), and every
 * hazard chip carries its text.
 */

const ICON_PATHS: Record<VerdictLevel, string> = {
  GO: "M20 6 9 17l-5-5",
  CAUTION:
    "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  "NO-GO": "M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9L7.9 2Zm7.1 7-6 6m0-6 6 6",
}

export function VerdictIcon({
  level,
  className = "",
}: {
  readonly level: VerdictLevel
  readonly className?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={ICON_PATHS[level]} />
    </svg>
  )
}

/**
 * The compact verdict: icon and word, the reason as its tooltip. A level the
 * floor raised says so in words ("raised"), with the reasons in the tooltip,
 * so the pill never shows a level the agent did not call without saying so.
 */
export function VerdictPill({ verdict }: { readonly verdict: EffectiveVerdict }) {
  const note = raiseNote(verdict)
  const raised = verdict.raisedFrom !== undefined && verdict.raisedFrom !== null
  const tooltip = [note ?? "", verdict.reason].filter((part) => part !== "").join("\n")
  return (
    <span
      className="wb-verdict-pill"
      data-level={verdict.level}
      data-raised={raised ? "true" : undefined}
      title={tooltip !== "" ? tooltip : undefined}
    >
      <VerdictIcon level={verdict.level} className="size-3.5 shrink-0" />
      <span>{verdict.level}</span>
      {raised ? <span className="wb-verdict-pill-raised">raised</span> : null}
    </span>
  )
}

const ALERT_PATH =
  "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
const CLOCK_PATH = "M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"

/**
 * One advisory as a chip: amber or red when it applies during the flight,
 * muted (with its relevance spelled out) when it does not.
 */
export function HazardChip({
  advisory,
  cruiseFt,
}: {
  readonly advisory: Advisory
  readonly cruiseFt?: number | undefined
}) {
  const severity = advisorySeverity(advisory, cruiseFt)
  const label = advisoryLabel(advisory)
  const tooltip = [advisory.raw, advisory.valid !== "" ? `Valid ${advisory.valid}` : ""]
    .filter((part) => part !== "")
    .join("\n")
  return (
    <span className="wb-hazard" data-severity={severity} title={tooltip}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="size-3.5 shrink-0"
      >
        <path d={severity === "muted" ? CLOCK_PATH : ALERT_PATH} />
      </svg>
      <span>
        {label}
        {severity === "muted" && advisory.relevance !== null ? (
          <span className="wb-hazard-when"> · {advisory.relevance}</span>
        ) : null}
      </span>
    </span>
  )
}

const RANK: Record<HazardSeverity, number> = { danger: 0, warn: 1, muted: 2 }

/** Advisories loudest first: red, then amber, then the ones outside the flight. */
export function sortAdvisories(
  advisories: readonly Advisory[],
  cruiseFt?: number,
): readonly Advisory[] {
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

/** One muted chip standing for every advisory outside the flight window. */
export function OutsideWindowChip({ advisories }: { readonly advisories: readonly Advisory[] }) {
  if (advisories.length === 0) return null
  const list = advisories.map((a) => `${advisoryLabel(a)} · ${a.relevance}`).join("\n")
  return (
    <span className="wb-hazard" data-severity="muted" title={list}>
      {advisories.length} outside the flight window
    </span>
  )
}

export interface VerdictCardProps {
  /** The verdict to show (`resolveVerdict`): the agent's call, raised to the floor when needed. */
  readonly verdict: EffectiveVerdict
  readonly advisories?: readonly Advisory[]
  readonly cruiseFt?: number | undefined
  /** The brief's forecast-horizon sentence; shown when it says the brief is preliminary. */
  readonly horizon?: string | undefined
}

/**
 * The go/no-go call at the top of the navlog: level, why, the hazards behind
 * it. When the floor raised the agent's call, the card shows the raised level
 * with its reasons first ("Raised from GO: gusts 25 kt at KDLH, forecast
 * preliminary.") and keeps the agent's own sentence under it.
 */
export function VerdictCard({ verdict, advisories = [], cruiseFt, horizon }: VerdictCardProps) {
  const { relevant, outside } = partitionAdvisories(advisories, cruiseFt)
  const note = raiseNote(verdict)
  const raisedFrom = verdict.raisedFrom ?? null
  return (
    <section className="wb-verdict" data-level={verdict.level} aria-label="Go/no-go verdict">
      <div className="flex items-start gap-3">
        <span className="wb-verdict-badge" aria-hidden="true">
          <VerdictIcon level={verdict.level} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="wb-eyebrow">Go / no-go</p>
          <p className="wb-verdict-word">{verdict.level}</p>
          {note !== null ? (
            <p className="wb-verdict-raised mt-0.5 text-[13.5px] leading-snug">{note}</p>
          ) : null}
          {verdict.reason !== "" && raisedFrom !== null ? (
            // The agent's own sentence stays visible, as the secondary line under the raise.
            <p className="mt-1 text-[12.5px] leading-snug text-wb-muted">
              <span className="font-semibold">The agent said {raisedFrom}:</span> {verdict.reason}
            </p>
          ) : verdict.reason !== "" ? (
            <p className="mt-0.5 text-[13.5px] leading-snug text-wb-text">{verdict.reason}</p>
          ) : null}
        </div>
      </div>
      {relevant.length + outside.length > 0 ? (
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Hazards">
          {relevant.map((advisory) => (
            <li key={advisory.raw}>
              <HazardChip advisory={advisory} cruiseFt={cruiseFt} />
            </li>
          ))}
          {outside.length > 0 ? (
            <li>
              <OutsideWindowChip advisories={outside} />
            </li>
          ) : null}
        </ul>
      ) : null}
      {isPreliminary(horizon) ? <HorizonNote text={horizon as string} className="mt-2.5" /> : null}
    </section>
  )
}

const INFO_PATH = "M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"

/** "This brief is preliminary": the forecast-horizon sentence, with an info icon. */
export function HorizonNote({
  text,
  className = "",
}: {
  readonly text: string
  readonly className?: string
}) {
  return (
    <p className={`wb-horizon ${className}`}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="mt-px size-3.5 shrink-0"
      >
        <path d={INFO_PATH} />
      </svg>
      <span>
        <strong className="font-semibold">Preliminary.</strong> {text}
      </span>
    </p>
  )
}
