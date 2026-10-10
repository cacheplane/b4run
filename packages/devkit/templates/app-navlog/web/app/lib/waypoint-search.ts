/**
 * Waypoint search over the bundled snapshot (`data/waypoints.json`): the
 * airports and navaids the route bar offers as you type. Pure, so the ranking
 * is testable without the route handler.
 *
 * Ranking, best first:
 *   1. exact id or alias;
 *   2. id or alias prefix (shorter matched code first);
 *   3. name word-prefix;
 *   4. name substring.
 * Within a rank, airports with a K-prefixed 4-letter id come first. For the
 * code ranks (1 and 2) navaids come next, so "SNS" shows both KSNS and the
 * SNS VORTAC; then everything else. Ties break alphabetically by id.
 *
 * Duplicate ids exist in the snapshot (the same code at two fields) and are
 * kept: a result is identified by kind, id AND position, never by id alone.
 */

/** `[id, alias, name, lat, lon]` */
export type AirportRow = readonly [string, string | null, string, number, number]
/** `[id, name, type, lat, lon, freqKhz]` */
export type NavaidRow = readonly [string, string, string, number, number, number | null]

/** The shape of `data/waypoints.json`. */
export interface WaypointData {
  readonly snapshot: string
  readonly airports: readonly AirportRow[]
  readonly navaids: readonly NavaidRow[]
}

export interface Waypoint {
  readonly id: string
  readonly kind: "airport" | "navaid"
  /** `"airport"` for an airport; the navaid's type (`"VORTAC"`, `"NDB"`, …) otherwise. */
  readonly type: string
  readonly name: string
  readonly lat: number
  readonly lon: number
  readonly freqKhz?: number
}

interface Entry {
  readonly waypoint: Waypoint
  readonly id: string
  readonly alias: string | undefined
  /** Lowercased, punctuation folded to single spaces, with a leading space. */
  readonly name: string
  /** 0: K-prefixed 4-letter airport, 1: navaid, 2: other airport. */
  readonly group: 0 | 1 | 2
}

const index = new WeakMap<WaypointData, readonly Entry[]>()

function foldName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function entriesOf(data: WaypointData): readonly Entry[] {
  const cached = index.get(data)
  if (cached !== undefined) return cached
  const entries: Entry[] = []
  for (const [id, alias, name, lat, lon] of data.airports) {
    const lowerId = id.toLowerCase()
    entries.push({
      waypoint: { id, kind: "airport", type: "airport", name, lat, lon },
      id: lowerId,
      alias: alias === null ? undefined : alias.toLowerCase(),
      name: ` ${foldName(name)}`,
      group: lowerId.length === 4 && lowerId.startsWith("k") ? 0 : 2,
    })
  }
  for (const [id, name, type, lat, lon, freqKhz] of data.navaids) {
    entries.push({
      waypoint: {
        id,
        kind: "navaid",
        type,
        name,
        lat,
        lon,
        ...(freqKhz !== null ? { freqKhz } : {}),
      },
      id: id.toLowerCase(),
      alias: undefined,
      name: ` ${foldName(name)}`,
      group: 1,
    })
  }
  index.set(data, entries)
  return entries
}

interface Match {
  readonly entry: Entry
  readonly rank: 1 | 2 | 3 | 4
  /** The matched code's length (rank 2 only; 0 otherwise). */
  readonly length: number
}

function matchOf(entry: Entry, q: string, folded: string): Match | undefined {
  const { id, alias } = entry
  if (id === q || alias === q) return { entry, rank: 1, length: 0 }
  const idPrefix = id.startsWith(q)
  const aliasPrefix = alias?.startsWith(q) === true
  if (idPrefix || aliasPrefix) {
    const length = Math.min(
      idPrefix ? id.length : Number.POSITIVE_INFINITY,
      aliasPrefix && alias !== undefined ? alias.length : Number.POSITIVE_INFINITY,
    )
    return { entry, rank: 2, length }
  }
  if (folded === "") return undefined
  if (entry.name.includes(` ${folded}`)) return { entry, rank: 3, length: 0 }
  if (entry.name.includes(folded)) return { entry, rank: 4, length: 0 }
  return undefined
}

/** Navaids only lead "other" airports in the code ranks; by name they are peers. */
function groupFor(match: Match): number {
  if (match.entry.group === 0) return 0
  return match.rank <= 2 ? match.entry.group : 1
}

function compare(a: Match, b: Match): number {
  return (
    a.rank - b.rank ||
    groupFor(a) - groupFor(b) ||
    a.length - b.length ||
    (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0)
  )
}

export function searchWaypoints(data: WaypointData, q: string, limit = 8): Waypoint[] {
  const query = q.trim().toLowerCase()
  if (query === "" || limit <= 0) return []
  const folded = foldName(query)
  const matches: Match[] = []
  for (const entry of entriesOf(data)) {
    const match = matchOf(entry, query, folded)
    if (match !== undefined) matches.push(match)
  }
  // Array#sort is stable, so duplicate ids keep their snapshot order.
  matches.sort(compare)
  return matches.slice(0, limit).map((match) => match.entry.waypoint)
}
