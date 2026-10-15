import { type AdvisoryFact, advisoryLine, type Coverage } from "../lib/forecast"
import { type EffectiveVerdict, raiseNote, type VerdictLevel } from "../lib/verdict"

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

/** The verdict level's shape (check, triangle, octagon), so the level never rides on color alone. */
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

export type HazardSeverity = "danger" | "warn" | "muted"

/** Hazards that turn a during-flight advisory red when they reach the cruise altitude. */
const SEVERE = /\b(CONVECTIVE|ICE|ICING|TS|THUNDERSTORMS?)\b/i

/**
 * How loudly an advisory is shown. During the flight: amber, or red for
 * convection or icing at or below the cruise altitude (or at an unknown
 * altitude). Outside the flight: muted.
 */
export function advisorySeverity(advisory: AdvisoryFact, cruiseFt?: number): HazardSeverity {
  if (advisory.relevance !== "during-flight") return "muted"
  if (!SEVERE.test(advisory.hazard)) return "warn"
  if (cruiseFt === undefined || advisory.lowestFt === null) return "danger"
  return advisory.lowestFt <= cruiseFt ? "danger" : "warn"
}

const RANK: Readonly<Record<HazardSeverity, number>> = { danger: 0, warn: 1, muted: 2 }

/** One advisory as a chip, labelled by its `advisoryLine`: amber or red during the flight, muted outside it. */
export function HazardChip({
  advisory,
  cruiseFt,
}: {
  readonly advisory: AdvisoryFact
  readonly cruiseFt?: number | undefined
}) {
  const severity = advisorySeverity(advisory, cruiseFt)
  return (
    <span className="wb-hazard" data-severity={severity}>
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
      <span>{advisoryLine(advisory)}</span>
    </span>
  )
}

export interface VerdictCardProps {
  /** The verdict to show (`resolveVerdict`): the agent's call, raised to the floor when needed. */
  readonly verdict: EffectiveVerdict
  /** The forecast's advisories; the card shows a chip for each one during the flight. */
  readonly advisories?: readonly AdvisoryFact[]
  readonly cruiseFt?: number | undefined
  /** The forecast's coverage; the card names its gaps when it is preliminary. */
  readonly coverage?: Coverage | undefined
}

/**
 * The go/no-go call at the top of the navlog: level, why, the hazards behind
 * it (the advisories during the flight, loudest first). When the floor raised
 * the agent's call, the card shows the raised level with its reasons first
 * ("Raised from GO: gusts 25 kt at KDLH.") and keeps the agent's own sentence
 * under it.
 */
export function VerdictCard({ verdict, advisories = [], cruiseFt, coverage }: VerdictCardProps) {
  const hazards = advisories
    .filter((a) => a.relevance === "during-flight")
    .sort((a, b) => RANK[advisorySeverity(a, cruiseFt)] - RANK[advisorySeverity(b, cruiseFt)])
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
      {hazards.length > 0 ? (
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Hazards">
          {hazards.map((advisory, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two G-AIRMET contours can read alike
            <li key={`${advisoryLine(advisory)}-${i}`}>
              <HazardChip advisory={advisory} cruiseFt={cruiseFt} />
            </li>
          ))}
        </ul>
      ) : null}
      {coverage?.preliminary ? (
        <HorizonNote text={coverage.reasons.join("; ")} className="mt-2.5" />
      ) : null}
    </section>
  )
}

const INFO_PATH = "M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"

/** "Preliminary: …": the forecast's coverage gaps, named, with an info icon. */
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
        <strong className="font-semibold">Preliminary:</strong> {text}
      </span>
    </p>
  )
}
