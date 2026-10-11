/**
 * The route bar's draft: the waypoints, altitude and departure the pilot is
 * editing before a Replan. Pure, so the bar's behavior is tested without a
 * browser.
 */
import { formatUtcHhmm } from "./format"
import type { Navlog } from "./navlog-types"

export interface DraftWaypoint {
  readonly id: string
  readonly kind: "airport" | "navaid"
  /** The navaid type (VORTAC, VOR-DME, …), "airport" for airports. */
  readonly type: string
  readonly lat: number
  readonly lon: number
}

export interface RouteDraft {
  readonly waypoints: readonly DraftWaypoint[]
  /** As typed: validated only when building the Replan message. */
  readonly altitudeFt: string
  /** As typed, or the plan's departure as `HHMMZ`. */
  readonly departure: string
  /** The plan's ISO departure instant while the departure field is untouched. */
  readonly departureFromPlan: string | null
}

/** No waypoints, no altitude, no departure: the route bar before a plan. */
export const EMPTY_DRAFT: RouteDraft = {
  waypoints: [],
  altitudeFt: "",
  departure: "",
  departureFromPlan: null,
}

export type DraftAction =
  | { type: "add"; waypoint: DraftWaypoint }
  | { type: "remove"; index: number }
  | { type: "removeLast" }
  /** Moves the waypoint at `from` so it ends up at index `to`. */
  | { type: "move"; from: number; to: number }
  | { type: "altitude"; value: string }
  | { type: "departure"; value: string }
  | { type: "reset"; draft: RouteDraft }

/** The draft a plan implies: its waypoints, altitude and departure. */
export function draftFromNavlog(navlog: Navlog): RouteDraft {
  return {
    waypoints: navlog.waypoints.map((waypoint) => {
      const kind = waypoint.kind === "navaid" ? "navaid" : "airport"
      return { id: waypoint.id, kind, type: kind, lat: waypoint.lat, lon: waypoint.lon }
    }),
    altitudeFt: String(navlog.altitudeFt),
    departure: formatUtcHhmm(navlog.departureTimeUtc),
    departureFromPlan: navlog.departureTimeUtc,
  }
}

/** How many times a waypoint follows itself: a leg of zero length. */
const repeats = (waypoints: readonly DraftWaypoint[]): number =>
  waypoints.filter((waypoint, i) => i > 0 && waypoints[i - 1]?.id === waypoint.id).length

/**
 * The waypoints with the one at `from` moved to index `to`, or null when the
 * move changes nothing or is not allowed: an index outside the route, or an
 * order that puts a waypoint right after itself (the same rule `add` keeps).
 * The route bar previews a drag with this, so the map never draws an order
 * the draft would refuse.
 */
export function moveWaypoint(
  waypoints: readonly DraftWaypoint[],
  from: number,
  to: number,
): readonly DraftWaypoint[] | null {
  const last = waypoints.length - 1
  if (from === to || from < 0 || from > last || to < 0 || to > last) return null
  const moved = waypoints[from]
  if (moved === undefined) return null
  const rest = waypoints.filter((_, i) => i !== from)
  const next = [...rest.slice(0, to), moved, ...rest.slice(to)]
  return repeats(next) > repeats(waypoints) ? null : next
}

/** The route bar's edits, applied to its draft. */
export function draftReducer(state: RouteDraft, action: DraftAction): RouteDraft {
  switch (action.type) {
    case "add": {
      const last = state.waypoints.at(-1)
      if (last?.id === action.waypoint.id) return state
      return { ...state, waypoints: [...state.waypoints, action.waypoint] }
    }
    case "remove":
      if (action.index < 0 || action.index >= state.waypoints.length) return state
      return { ...state, waypoints: state.waypoints.filter((_, i) => i !== action.index) }
    case "removeLast":
      if (state.waypoints.length === 0) return state
      return { ...state, waypoints: state.waypoints.slice(0, -1) }
    case "move": {
      const waypoints = moveWaypoint(state.waypoints, action.from, action.to)
      return waypoints === null ? state : { ...state, waypoints }
    }
    case "altitude":
      return { ...state, altitudeFt: action.value }
    case "departure":
      return { ...state, departure: action.value, departureFromPlan: null }
    case "reset":
      return action.draft
  }
}

/** The altitude as a number when it is an integer from 1000 to 17500. */
function validAltitude(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 1000 && value <= 17500 ? value : null
}

/**
 * The user message Replan sends, or null when the draft is not plannable:
 * fewer than 2 waypoints, an altitude outside 1000–17500 ft, or no departure.
 */
export function replanMessage(draft: RouteDraft): string | null {
  if (draft.waypoints.length < 2) return null
  const altitude = validAltitude(draft.altitudeFt)
  if (altitude === null) return null
  const departing = draft.departureFromPlan ?? draft.departure.trim()
  if (departing === "") return null
  const route = draft.waypoints
    .map((waypoint) =>
      waypoint.kind === "navaid" ? `${waypoint.id} (${waypoint.type})` : waypoint.id,
    )
    .join(" → ")
  return `Plan ${route} at ${altitude} ft, departing ${departing}.`
}

const EARTH_RADIUS_NM = 3440.065
const toRad = (deg: number): number => (deg * Math.PI) / 180

function greatCircleNm(a: DraftWaypoint, b: DraftWaypoint): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** The draft's total great-circle distance in nm, rounded. */
export function draftDistanceNm(draft: RouteDraft): number {
  let total = 0
  for (let i = 1; i < draft.waypoints.length; i += 1) {
    const from = draft.waypoints[i - 1]
    const to = draft.waypoints[i]
    if (from && to) total += greatCircleNm(from, to)
  }
  return Math.round(total)
}
