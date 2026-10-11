export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR"

/**
 * The FAA flight category for a ceiling (ft AGL) and visibility (statute
 * miles); a missing value does not limit the category. Undefined when both
 * are missing, since there is nothing to grade.
 */
export const flightCategory = (
  ceilingFt: number | undefined,
  visibilityMi: number | undefined,
): FlightCategory | undefined => {
  if (ceilingFt === undefined && visibilityMi === undefined) return undefined
  const ceil = ceilingFt ?? Number.POSITIVE_INFINITY
  const vis = visibilityMi ?? Number.POSITIVE_INFINITY
  if (ceil < 500 || vis < 1) return "LIFR"
  if (ceil < 1000 || vis < 3) return "IFR"
  if (ceil <= 3000 || vis <= 5) return "MVFR"
  return "VFR"
}
