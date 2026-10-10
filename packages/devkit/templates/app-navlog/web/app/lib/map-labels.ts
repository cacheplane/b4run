/**
 * Where each map marker's label goes so labels never sit on each other or on
 * another marker's dot: right of its dot, else left of it, else hidden (the
 * marker still names itself on hover and focus, and in its accessible name).
 *
 * Pure: it takes screen rectangles and returns placements, so the rule is
 * testable without Leaflet or a layout engine. `RouteMap` measures the
 * rectangles and applies the result.
 */

export interface Rect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export type LabelPlacement = "right" | "left" | "hidden"

export interface LabelCandidate {
  readonly id: string
  /** Lower goes first, and so keeps the better spot. */
  readonly priority: number
  /** The marker's dot: an obstacle for every other label. */
  readonly dot: Rect
  /** The label's box when placed right of the dot. */
  readonly right: Rect
  /** The label's box when placed left of the dot. */
  readonly left: Rect
  /** Never hidden (the selected or focused marker). */
  readonly pinned?: boolean
}

/** How much clear space two boxes need between them, in px: touching is fine. */
const GAP = 1

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.right + GAP &&
    b.left < a.right + GAP &&
    a.top < b.bottom + GAP &&
    b.top < a.bottom + GAP
  )
}

/**
 * Place every candidate's label, in priority order (ties keep input order).
 * `obstacles` are boxes no label may cover (the heading labels on the legs).
 */
export function placeLabels(
  candidates: readonly LabelCandidate[],
  obstacles: readonly Rect[] = [],
): Map<string, LabelPlacement> {
  const order = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => a.candidate.priority - b.candidate.priority || a.index - b.index)
    .map(({ candidate }) => candidate)
  const taken: Rect[] = [...obstacles]
  const placed = new Map<string, LabelPlacement>()
  // Every dot is an obstacle from the start, for a label of the same or lower
  // priority: a label over another marker's dot hides the marker itself. A
  // more important label may cover a less important dot (a route waypoint's
  // label over a station sitting beside it), never the other way round.
  const dots = candidates.map((candidate) => ({
    id: candidate.id,
    priority: candidate.priority,
    rect: candidate.dot,
  }))
  const clear = (box: Rect, own: LabelCandidate): boolean =>
    !taken.some((rect) => overlaps(box, rect)) &&
    !dots.some(
      (dot) => dot.id !== own.id && dot.priority <= own.priority && overlaps(box, dot.rect),
    )
  for (const candidate of order) {
    if (clear(candidate.right, candidate)) {
      placed.set(candidate.id, "right")
      taken.push(candidate.right)
    } else if (clear(candidate.left, candidate)) {
      placed.set(candidate.id, "left")
      taken.push(candidate.left)
    } else if (candidate.pinned === true) {
      placed.set(candidate.id, "right")
      taken.push(candidate.right)
    } else {
      placed.set(candidate.id, "hidden")
    }
  }
  return placed
}
