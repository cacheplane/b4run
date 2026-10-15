import type { AdvisoryFact, AirportWeather, Coverage, VerdictFloor } from "./types.js"

const GUST_LIMIT_KT = 20
const FREEZING_MARGIN_FT = 2000
const RESERVE_FLOOR_MIN = 45

const ft = (n: number): string => `${n.toLocaleString("en-US")} ft`

/** "8,000–14,000 ft", "8,000 ft", or how to say the advisory gives no altitude. */
function band(a: AdvisoryFact): string {
  if (a.lowestFt === null) return "at an altitude it does not give"
  if (a.highestFt === null || a.highestFt === a.lowestFt) return ft(a.lowestFt)
  return `${a.lowestFt.toLocaleString("en-US")}–${ft(a.highestFt)}`
}

/**
 * The lowest verdict the facts allow. The planner may state a worse level
 * with a reason; it may never state a better one. NO-GO reasons come first.
 */
export function verdictFloor(input: {
  readonly airports: readonly AirportWeather[]
  readonly advisories: readonly AdvisoryFact[]
  readonly coverage: Coverage
  readonly cruiseFt: number
  readonly reserveMin: number
  readonly reserveOk: boolean
}): VerdictFloor {
  const noGo: string[] = []
  const caution: string[] = []
  for (const a of input.airports) {
    const atTime = a.categoryAtTime
    if (a.role === "en-route") {
      const worst = atTime ?? a.categoryNow
      if (worst !== null && worst !== "VFR") caution.push(`${a.id} ${worst} en route`)
      continue
    }
    const when = a.role === "origin" ? "at departure" : "at ETA"
    if (atTime === "IFR" || atTime === "LIFR") noGo.push(`${a.id} ${atTime} ${when}`)
    else if (a.categoryNow === "MVFR" && atTime === "MVFR")
      caution.push(`${a.id} MVFR now and ${when}`)
    else if (a.categoryNow === "MVFR") caution.push(`${a.id} MVFR now`)
    else if (atTime === "MVFR") caution.push(`${a.id} MVFR ${when}`)
    if (
      (a.categoryNow === "IFR" || a.categoryNow === "LIFR") &&
      atTime !== "IFR" &&
      atTime !== "LIFR"
    )
      caution.push(`${a.id} ${a.categoryNow} now`)
    if (a.gustKt !== null && a.gustKt > GUST_LIMIT_KT)
      caution.push(`gusts ${a.gustKt} kt at ${a.id}`)
  }
  if (!input.reserveOk) noGo.push(`reserve ${input.reserveMin} min, under ${RESERVE_FLOOR_MIN}`)
  if (input.coverage.preliminary) caution.push("forecast preliminary")
  const cruise = input.cruiseFt
  for (const a of input.advisories) {
    if (a.relevance !== "during-flight") continue
    const hazard = a.hazard.toUpperCase()
    if (hazard === "CONVECTIVE" && a.product === "SIGMET") {
      noGo.push("convective SIGMET during the flight")
    } else if (hazard === "ICE") {
      const atCruise =
        a.lowestFt !== null &&
        a.lowestFt <= cruise &&
        (a.highestFt === null || cruise <= a.highestFt)
      if (atCruise) noGo.push(`icing ${band(a)} during the flight, at the ${ft(cruise)} cruise`)
      else caution.push(`icing ${band(a)} during the flight`)
    } else if (hazard === "FZLVL" || hazard === "M_FZLVL") {
      if (a.lowestFt === null)
        caution.push("a freezing level during the flight at an altitude it does not give")
      else if (a.lowestFt <= cruise + FREEZING_MARGIN_FT) {
        const where = a.lowestFt < cruise ? "below" : "within 2,000 ft of"
        caution.push(
          `freezing level ${ft(a.lowestFt)} during the flight, ${where} the ${ft(cruise)} cruise`,
        )
      }
    } else if (hazard === "LLWS" || hazard.startsWith("TURB") || hazard === "CONVECTIVE") {
      caution.push(`${hazard.toLowerCase()} during the flight`)
    }
  }
  const reasons = [...new Set([...noGo, ...caution])]
  return { level: noGo.length > 0 ? "NO-GO" : caution.length > 0 ? "CAUTION" : "GO", reasons }
}
