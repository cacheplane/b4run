import { isStructuredAnswer, parseBriefAnswer } from "../brief/parse"
import { parsePlanningAnswer } from "./assistant-text"
import { formatHhmm } from "./format"
import type { Navlog } from "./navlog-types"
import {
  advisoryLabel,
  isPreliminary,
  parseAdvisory,
  type Verdict,
  type VerdictLevel,
  type WeatherBrief,
} from "./weather-selectors"

/**
 * The verdict floor: the brief's written rules, enforced in code.
 *
 * The weather subagent is prompted with the rules (NO-GO for IFR or LIFR at
 * either end at the ETA; CAUTION for MVFR, gusts over 20 kt, a preliminary
 * forecast, a freezing level near the cruise, LLWS or turbulence during the
 * flight), but nothing made the model follow them: a live run said "GO" over
 * a brief that reported gusts to 25 kt and called itself preliminary. The
 * floor reads the same brief and the navlog and returns the least the verdict
 * can be. It only ever raises a call, never lowers one: a model that judged
 * the weather worse than these rules can see keeps its call.
 */

const RANK: Readonly<Record<VerdictLevel, number>> = { GO: 0, CAUTION: 1, "NO-GO": 2 }

/** The more severe of two levels. */
export function worseLevel(a: VerdictLevel, b: VerdictLevel): VerdictLevel {
  return RANK[a] >= RANK[b] ? a : b
}

/** The least the verdict can be, and why. `GO` with no reasons when nothing applies. */
export interface VerdictFloor {
  readonly level: VerdictLevel
  /** Short phrases, NO-GO reasons first: `KDLH IFR at ETA`, `gusts 25 kt at KDLH`. */
  readonly reasons: readonly string[]
}

export interface VerdictFloorOptions {
  /** The planned cruise altitude, in feet, for the freezing-level rule. */
  readonly cruiseFt?: number | undefined
  /** The navlog on screen, for the reserve rule. */
  readonly navlog?: Pick<Navlog, "totals"> | null | undefined
}

/** `31015G25KT`, `VRB05G22KT`, `240110G125KT`: the gust, in knots. */
const GUST = /\b(?:\d{3}|VRB)\d{2,3}G(\d{2,3})KT\b/g

/** The highest gust a raw report names, or null. */
export function maxGustKt(raw: string): number | null {
  let max: number | null = null
  for (const m of raw.matchAll(GUST)) {
    const kt = Number(m[1])
    if (max === null || kt > max) max = kt
  }
  return max
}

/** Over this, a gust is a CAUTION (the brief's rule: "gusts over 20 kt"). */
const GUST_LIMIT_KT = 20
/** A freezing level or icing within this of the cruise is a CAUTION. */
const FREEZING_MARGIN_FT = 2000
/** The VFR day reserve the navlog is checked against. */
const RESERVE_MIN = 45

const ICING = /\b(FZLVL|M-FZLVL|ICE|ICING|FREEZING)\b/i
const ALWAYS = /\b(LLWS|TURB(?:-LO|-HI)?|TURBULENCE|CONVECTIVE|TS|THUNDERSTORMS?)\b/i

/** `Freezing level 4,000 ft` reads mid-sentence as `freezing level 4,000 ft`; `SIGMET …` stays. */
const midSentence = (label: string): string =>
  /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label

/**
 * The floor under the verdict, from data the client already has: the brief's
 * airports (categories and raw METAR/TAF), its forecast horizon and
 * advisories, and the navlog's reserve.
 *
 * - IFR or LIFR at the ETA at any airport: NO-GO.
 * - Reserve under 45 min: NO-GO.
 * - MVFR now or at the ETA: CAUTION.
 * - A gust over 20 kt in a METAR or a TAF: CAUTION. A TAF group cannot be
 *   placed in the flight window exactly from the raw text, so any gust in the
 *   TAF counts, and the reason says "in the TAF".
 * - A preliminary forecast horizon: CAUTION.
 * - An advisory during the flight for LLWS, turbulence or convection, or for
 *   icing or a freezing level within 2,000 ft of (or below) the cruise, or at
 *   an altitude the line does not give: CAUTION.
 */
export function verdictFloor(
  brief: WeatherBrief | null | undefined,
  { cruiseFt, navlog }: VerdictFloorOptions = {},
): VerdictFloor {
  const noGo: string[] = []
  const caution: string[] = []
  for (const airport of brief?.airports ?? []) {
    const ifrAtEta = airport.atEta === "IFR" || airport.atEta === "LIFR"
    if (ifrAtEta) noGo.push(`${airport.id} ${airport.atEta} at ETA`)
    const mvfrNow = airport.now === "MVFR"
    const mvfrEta = airport.atEta === "MVFR"
    if (mvfrNow && mvfrEta) caution.push(`${airport.id} MVFR now and at ETA`)
    else if (mvfrNow && !ifrAtEta) caution.push(`${airport.id} MVFR now`)
    else if (mvfrEta) caution.push(`${airport.id} MVFR at ETA`)
    const metarGust = maxGustKt(airport.metar)
    const tafGust = maxGustKt(airport.taf)
    const metarOver = metarGust !== null && metarGust > GUST_LIMIT_KT
    const tafOver = tafGust !== null && tafGust > GUST_LIMIT_KT
    if (metarOver && tafOver && (tafGust as number) > (metarGust as number)) {
      caution.push(`gusts ${metarGust} kt at ${airport.id} (${tafGust} kt in the TAF)`)
    } else if (metarOver) {
      caution.push(`gusts ${metarGust} kt at ${airport.id}`)
    } else if (tafOver) {
      caution.push(`gusts ${tafGust} kt at ${airport.id} in the TAF`)
    }
  }
  if (brief && isPreliminary(brief.horizon)) caution.push("forecast preliminary")
  const seen = new Set<string>()
  for (const line of brief?.advisories ?? []) {
    const advisory = parseAdvisory(line)
    if (advisory.relevance !== "during flight") continue
    const hazard = advisory.hazard !== "" ? advisory.hazard : advisory.raw
    const icing = ICING.test(hazard)
    if (!icing && !ALWAYS.test(hazard)) continue
    if (
      icing &&
      cruiseFt !== undefined &&
      advisory.lowestFt !== null &&
      advisory.lowestFt > cruiseFt + FREEZING_MARGIN_FT
    ) {
      continue
    }
    const reason = `${midSentence(advisoryLabel(advisory))} during flight`
    if (seen.has(reason)) continue
    seen.add(reason)
    caution.push(reason)
  }
  if (navlog && !navlog.totals.reserveOk) {
    noGo.push(`reserve ${formatHhmm(navlog.totals.reserveMin)}, under ${RESERVE_MIN} min`)
  }
  const level: VerdictLevel = noGo.length > 0 ? "NO-GO" : caution.length > 0 ? "CAUTION" : "GO"
  return { level, reasons: [...noGo, ...caution] }
}

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

/**
 * The planner's call: a structured answer's `BottomLine`, or for a markdown
 * answer (a thread from before the brief kit) its "Bottom line:" line. A
 * structured answer still streaming has no call yet.
 */
function plannerVerdict(answer: string): Verdict | null {
  if (isStructuredAnswer(answer)) return parseBriefAnswer(answer)?.bottomLine ?? null
  return parsePlanningAnswer(answer)?.verdict ?? null
}

export interface ResolveVerdictInput {
  /** The weather subagent's parsed brief. */
  readonly weather?: WeatherBrief | null | undefined
  /** The planning answer's text, for its `BottomLine` (or markdown "Bottom line:") verdict. */
  readonly answer?: string | undefined
  /** The navlog on screen: its reserve, and its altitude as the cruise. */
  readonly navlog?: Pick<Navlog, "totals" | "altitudeFt"> | null | undefined
  /** The cruise altitude, when there is no navlog to read it from. */
  readonly cruiseFt?: number | undefined
}

/**
 * The one verdict every surface shows (the weather strip's pill, the sheet's
 * card and pill, the planning brief's bottom line), so they cannot disagree.
 *
 * The model's call is the worse of the weather brief's "Verdict:" and the
 * planner's "Bottom line:" (the brief's on a tie, since its sentence is the
 * weather's), then the floor raises it.
 */
export function resolveVerdict({
  weather,
  answer,
  navlog,
  cruiseFt,
}: ResolveVerdictInput): EffectiveVerdict | null {
  const fromWeather = weather?.verdict ?? null
  const fromPlanner = answer ? plannerVerdict(answer) : null
  const model =
    fromWeather === null
      ? fromPlanner
      : fromPlanner !== null && RANK[fromPlanner.level] > RANK[fromWeather.level]
        ? fromPlanner
        : fromWeather
  const floor = verdictFloor(weather, {
    cruiseFt: cruiseFt ?? navlog?.altitudeFt,
    navlog,
  })
  return effectiveVerdict(model, floor)
}

/**
 * Why the verdict on screen outranks the planner's bottom line: the floor's
 * reasons, or the weather brief's own call when the floor did not raise it.
 */
export function outrankNote(planner: VerdictLevel, verdict: EffectiveVerdict): string {
  const reasons = verdict.floorReasons ?? []
  const why =
    reasons.length > 0
      ? `Raised: ${reasons.join(", ")}.`
      : `The weather brief said ${verdict.level}.`
  return `The planner said ${planner}. ${why}`
}

/** True when `level` is more severe than `than`. */
export function isWorse(level: VerdictLevel, than: VerdictLevel): boolean {
  return RANK[level] > RANK[than]
}
