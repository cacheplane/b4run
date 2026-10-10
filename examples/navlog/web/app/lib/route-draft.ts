/**
 * The route bar's draft: the waypoints, altitude and departure the pilot is
 * editing before a Replan. Pure, so the bar's behavior is tested without a
 * browser.
 */
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
  | { type: "altitude"; value: string }
  | { type: "departure"; value: string }
  | { type: "reset"; draft: RouteDraft }

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** `2026-10-11T09:05:00Z` → `0905Z`; an unparseable instant gives "". */
function hhmmz(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}Z`
}

/** The draft a plan implies: its waypoints, altitude and departure. */
export function draftFromNavlog(navlog: Navlog): RouteDraft {
  return {
    waypoints: navlog.waypoints.map((waypoint) => {
      const kind = waypoint.kind === "navaid" ? "navaid" : "airport"
      return { id: waypoint.id, kind, type: kind, lat: waypoint.lat, lon: waypoint.lon }
    }),
    altitudeFt: String(navlog.altitudeFt),
    departure: hhmmz(navlog.departureTimeUtc),
    departureFromPlan: navlog.departureTimeUtc,
  }
}

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

/** True when the draft's waypoint ids match the plan's, in order. */
export function sameRoute(draft: RouteDraft, navlog: Navlog | null): boolean {
  if (navlog === null) return false
  if (draft.waypoints.length !== navlog.waypoints.length) return false
  return draft.waypoints.every((waypoint, i) => waypoint.id === navlog.waypoints[i]?.id)
}
