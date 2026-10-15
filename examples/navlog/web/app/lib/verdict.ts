import { readBottomLine } from "../brief/parse"
import type { Forecast, VerdictFloor, VerdictLevel } from "./forecast"

export type { VerdictLevel }

/**
 * The go/no-go verdict: the planner's `BottomLine` (`readBottomLine`), raised
 * to the floor computeNavlog computed (`forecast.verdictFloor`) when that is
 * worse. The client never re-derives the floor; a markdown answer (a thread
 * from before the brief kit) makes no planner call. Nothing ever lowers a call.
 */

/** A go/no-go call: the level and the one sentence why. */
export interface Verdict {
  readonly level: VerdictLevel
  readonly reason: string
}

const RANK: Readonly<Record<VerdictLevel, number>> = { GO: 0, CAUTION: 1, "NO-GO": 2 }

/**
 * The verdict the page shows: the model's call, raised to the floor when the
 * floor is worse. `reason` is always the model's own sentence (empty when
 * there was no model call).
 */
export interface EffectiveVerdict extends Verdict {
  /**
   * Set only when the floor raised the level: the model's level it was raised
   * from, or null when there was no model call and the floor alone set it.
   */
  readonly raisedFrom?: VerdictLevel | null
  /** Why the floor raised it; set with `raisedFrom`. */
  readonly floorReasons?: readonly string[]
}

/**
 * The worse of the model's verdict and the floor. Null when there is neither a
 * model call nor anything the floor found (an old-format brief over a clean
 * route). A model call as bad or worse than the floor is returned as is.
 */
export function effectiveVerdict(
  model: Verdict | null | undefined,
  floor: VerdictFloor,
): EffectiveVerdict | null {
  if (model === null || model === undefined) {
    if (floor.reasons.length === 0) return null
    return { level: floor.level, reason: "", raisedFrom: null, floorReasons: floor.reasons }
  }
  if (RANK[floor.level] <= RANK[model.level]) return model
  return {
    level: floor.level,
    reason: model.reason,
    raisedFrom: model.level,
    floorReasons: floor.reasons,
  }
}

/**
 * The honest note for a raised verdict: `Raised from GO: gusts 25 kt at KDLH,
 * forecast preliminary.`, or `From the brief's data: KDLH IFR at ETA.` when
 * there was no model call. Null when the model's call stands.
 */
export function raiseNote(verdict: EffectiveVerdict): string | null {
  if (verdict.raisedFrom === undefined) return null
  const reasons = (verdict.floorReasons ?? []).join(", ")
  const lead =
    verdict.raisedFrom === null ? "From the brief's data" : `Raised from ${verdict.raisedFrom}`
  return `${lead}: ${reasons}.`
}

/** What `resolveVerdict` reads: the computed facts and the planning answer. */
export interface ResolveVerdictInput {
  /** computeNavlog's forecast block for the navlog on screen. */
  readonly forecast: Forecast | null
  /** The planning answer's text, for its BottomLine. */
  readonly answer?: string | undefined
}

/**
 * The one verdict every surface shows. The planner's BottomLine, raised to
 * the floor computeNavlog computed when it is lower (the "Raised from" note
 * says why); a planner's call above the floor stands, with its own reason.
 */
export function resolveVerdict({ forecast, answer }: ResolveVerdictInput): EffectiveVerdict | null {
  const model = answer ? readBottomLine(answer) : null
  const floor: VerdictFloor = forecast?.verdictFloor ?? { level: "GO", reasons: [] }
  return effectiveVerdict(model, floor)
}

/**
 * Why the verdict on screen outranks the planner's bottom line: the floor's
 * reasons when the floor raised it, else the computed floor's level alone.
 */
export function outrankNote(planner: VerdictLevel, verdict: EffectiveVerdict): string {
  const reasons = verdict.floorReasons ?? []
  const why =
    reasons.length > 0
      ? `Raised: ${reasons.join(", ")}.`
      : `The computed floor is ${verdict.level}.`
  return `The planner said ${planner}. ${why}`
}

/** True when `level` is more severe than `than`. */
export function isWorse(level: VerdictLevel, than: VerdictLevel): boolean {
  return RANK[level] > RANK[than]
}
