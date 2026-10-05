export interface FlightPlanInput {
  readonly tailNumber: string
  readonly departure: string
  readonly destination: string
  /** Intermediate fixes, in order, without departure and destination. */
  readonly route: readonly string[]
  readonly departureTimeUtc: string
  readonly cruiseTasKt: number
  readonly altitudeFt: number
  readonly eteMin: number
  readonly enduranceMin: number
  readonly personsOnBoard: number
}

export interface FlightPlan {
  readonly item7: string
  readonly item8: string
  readonly item9: string
  readonly item10: string
  readonly item13: string
  readonly item15: string
  readonly item16: string
  readonly item18: string
  readonly item19: string
}

const hhmm = (minutes: number): string => {
  // Round to whole minutes first, so 59.6 min is 0100, never 0060.
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}`
}

/** ICAO flight plan items for a VFR C172 with a transponder and GPS. */
export function buildFlightPlan(input: FlightPlanInput): FlightPlan {
  const dep = new Date(input.departureTimeUtc)
  if (Number.isNaN(dep.getTime()))
    throw new Error(`departureTimeUtc is not a date: ${input.departureTimeUtc}`)
  const time = `${String(dep.getUTCHours()).padStart(2, "0")}${String(dep.getUTCMinutes()).padStart(2, "0")}`
  const dof = `${String(dep.getUTCFullYear()).slice(-2)}${String(dep.getUTCMonth() + 1).padStart(2, "0")}${String(dep.getUTCDate()).padStart(2, "0")}`
  const routeText = input.route.length === 0 ? "DCT" : `DCT ${input.route.join(" DCT ")} DCT`
  return {
    item7: input.tailNumber.toUpperCase(),
    item8: "VG",
    item9: "C172/L",
    item10: "SG/C",
    item13: `${input.departure.toUpperCase()}${time}`,
    item15: `N${String(Math.round(input.cruiseTasKt)).padStart(4, "0")}VFR ${routeText}`,
    item16: `${input.destination.toUpperCase()}${hhmm(input.eteMin)}`,
    item18: `DOF/${dof}`,
    item19: `E/${hhmm(input.enduranceMin)} P/${input.personsOnBoard}`,
  }
}

/** The message form a filing service accepts, one item per line. Recorded, not transmitted. */
export function formatFplMessage(plan: FlightPlan): string {
  return [
    `(FPL-${plan.item7}-${plan.item8}`,
    `-${plan.item9}-${plan.item10}`,
    `-${plan.item13}`,
    `-${plan.item15}`,
    `-${plan.item16}`,
    `-${plan.item18}`,
    `-${plan.item19})`,
  ].join("\n")
}
