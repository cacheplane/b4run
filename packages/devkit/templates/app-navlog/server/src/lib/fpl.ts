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

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/

const UTC_CLOCK = /^([01]\d|2[0-3])([0-5]\d)Z$/i
const DAY_MS = 24 * 60 * 60_000

/** "tomorrow 1400Z" or "1400Z tomorrow" (and the same with "today"). */
const DAY_CLOCK =
  /^(?:(today|tomorrow)\s+([01]\d|2[0-3])([0-5]\d)Z|([01]\d|2[0-3])([0-5]\d)Z\s+(today|tomorrow))$/i
/** "Tomorrow" is never sooner than this: half a day covers a pilot in any US time zone. */
const TOMORROW_MIN_AHEAD_MS = 12 * 60 * 60_000

/** The next time the UTC clock reads hh:mm, at or after `from`. */
function nextClock(from: number, hours: number, minutes: number): number {
  const today = new Date(from)
  const candidate = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
    hours,
    minutes,
  )
  return candidate < from ? candidate + DAY_MS : candidate
}

/**
 * Parse a departure time: an ISO 8601 UTC instant; a UTC clock time such as
 * 1400Z, which means its next occurrence from `now` (today if that time has not
 * passed yet, otherwise tomorrow); or the clock time with the day the pilot
 * named, "today 1400Z" or "tomorrow 1400Z". "Tomorrow" is the first 1400Z at
 * least 12 hours ahead, which is the pilot's tomorrow whether they ask in the
 * morning or the evening of any US time zone (a UTC-date "tomorrow" would skip
 * a day for a pilot asking in the evening). Throws a message the model can act
 * on otherwise.
 */
export function parseUtcInstant(value: string, now: () => number = Date.now): Date {
  const trimmed = value.trim()
  const clock = UTC_CLOCK.exec(trimmed)
  if (clock) return new Date(nextClock(now(), Number(clock[1]), Number(clock[2])))
  const dayClock = DAY_CLOCK.exec(trimmed)
  if (dayClock) {
    const day = (dayClock[1] ?? dayClock[6] ?? "").toLowerCase()
    const hours = Number(dayClock[2] ?? dayClock[4])
    const minutes = Number(dayClock[3] ?? dayClock[5])
    const from = now() + (day === "tomorrow" ? TOMORROW_MIN_AHEAD_MS : 0)
    return new Date(nextClock(from, hours, minutes))
  }
  const date = new Date(trimmed)
  if (!UTC_INSTANT.test(trimmed) || Number.isNaN(date.getTime())) {
    throw new Error(
      `departureTimeUtc must be an ISO 8601 UTC instant such as 2026-10-06T14:00:00Z, a UTC time such as 1400Z, or "tomorrow 1400Z", got "${value}"`,
    )
  }
  return date
}

/** ICAO flight plan items for a VFR C172 with a transponder and GPS. */
export function buildFlightPlan(input: FlightPlanInput, now?: () => number): FlightPlan {
  const dep = parseUtcInstant(input.departureTimeUtc, now)
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
