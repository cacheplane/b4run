import type { Layer, Marker } from "leaflet"
import { type LabelCandidate, placeLabels, type Rect } from "./map-labels"

/**
 * The DOM half of label placement: measure the route map's rendered markers,
 * hand the boxes to the pure `placeLabels`, and write the result back. Only
 * the marker types come from Leaflet, so this module never loads it.
 */

/**
 * Which labels keep the better spot, lowest first: the route's waypoints
 * (the route is what the map is for), then the reporting stations, then the
 * route bar's unplanned draft points. Only the order matters.
 */
export const LABEL_PRIORITY = { waypoint: 0, station: 1, draft: 2 } as const

/** A marker with the id its label names. */
export interface LabeledMarker {
  readonly id: string
  readonly marker: Marker
}

/** A DOM element's box in viewport pixels. */
function boxOf(element: Element): Rect {
  const { left, top, right, bottom } = element.getBoundingClientRect()
  return { left, top, right, bottom }
}

/**
 * Measure every marker's dot and label, place the labels (`placeLabels`) and
 * write each placement onto its label as `data-placement`, which `theme.css`
 * reads. Labels are measured in their default spot, right of the dot; the
 * left spot is the same box mirrored across the dot. The heading pills are
 * obstacles no label may cover.
 */
export function declutterLabels(groups: {
  readonly waypoints: readonly LabeledMarker[]
  readonly stations: readonly LabeledMarker[]
  readonly drafts: readonly Marker[]
  readonly headings: readonly Layer[]
}): void {
  const entries: {
    readonly id: string
    readonly priority: number
    readonly element: HTMLElement
  }[] = []
  const add = (id: string, priority: number, marker: Marker): void => {
    const element = marker.getElement()
    if (element !== undefined) entries.push({ id, priority, element })
  }
  for (const waypoint of groups.waypoints) {
    add(`wp:${waypoint.id}`, LABEL_PRIORITY.waypoint, waypoint.marker)
  }
  for (const station of groups.stations) {
    add(`st:${station.id}`, LABEL_PRIORITY.station, station.marker)
  }
  for (const [i, marker] of groups.drafts.entries()) {
    add(`draft:${i}`, LABEL_PRIORITY.draft, marker)
  }
  const labels = new Map<string, HTMLElement>()
  for (const entry of entries) {
    const label = entry.element.querySelector<HTMLElement>(".wb-wp-label")
    if (label === null) continue
    label.removeAttribute("data-placement")
    labels.set(entry.id, label)
  }
  const candidates: LabelCandidate[] = []
  for (const entry of entries) {
    const label = labels.get(entry.id)
    const dot = entry.element.querySelector(".wb-wp-dot")
    if (label === undefined || dot === null) continue
    const dotBox = boxOf(dot)
    const right = boxOf(label)
    // Not laid out (a hidden panel): leave it where it is.
    if (right.right - right.left === 0 || dotBox.right - dotBox.left === 0) continue
    const gap = right.left - dotBox.right
    const width = right.right - right.left
    // A route waypoint always keeps its label (the route is what the map is
    // for), as does the marker whose panel is open or that has focus; the
    // stations and draft points around them give way.
    const pinned =
      entry.priority === LABEL_PRIORITY.waypoint ||
      entry.element.getAttribute("aria-expanded") === "true" ||
      entry.element === document.activeElement
    candidates.push({
      id: entry.id,
      priority: entry.priority,
      dot: dotBox,
      right,
      left: {
        left: dotBox.left - gap - width,
        right: dotBox.left - gap,
        top: right.top,
        bottom: right.bottom,
      },
      ...(pinned ? { pinned } : {}),
    })
  }
  const obstacles: Rect[] = []
  for (const heading of groups.headings) {
    const pill = (heading as Marker).getElement?.()?.querySelector(".wb-hdg-label")
    if (pill !== null && pill !== undefined) obstacles.push(boxOf(pill))
  }
  for (const [id, placement] of placeLabels(candidates, obstacles)) {
    if (placement !== "right") labels.get(id)?.setAttribute("data-placement", placement)
  }
}
