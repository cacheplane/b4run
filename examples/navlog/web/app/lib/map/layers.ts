import type { Layer, LeafletKeyboardEvent, Map as LeafletMap, Marker, Polyline } from "leaflet"
import type { RefObject } from "react"
import type { Category } from "../forecast"
import type { DraftWaypoint } from "../route-draft"
import type { RouteGeometry } from "../route-geometry"
import type { RouteStation } from "../weather-roles"
import { headingIcon, interactiveOptions, waypointIcon } from "./markers"

/**
 * The route map's Leaflet layers: what each of its three layers (the planned
 * route, the reporting stations, the route bar's draft) puts on the map, and
 * how it comes off again. `RouteMap` decides when each one is drawn; this
 * module decides what is drawn. Like `markers.ts`, it takes the Leaflet module
 * as an argument and imports only Leaflet's types, because `RouteMap` loads
 * Leaflet lazily, in the browser only.
 */

type LeafletModule = typeof import("leaflet")

/**
 * The marker callback, read through a ref: a new callback identity reaches
 * every marker without redrawing one.
 */
export type SelectRef = RefObject<(id: string) => void>

/** A waypoint or station marker, with the id its label names. */
export interface WaypointLayers {
  readonly id: string
  readonly marker: Marker
  /** An airport or station: it opens the weather panel. Navaids and fixes are labels only. */
  readonly interactive: boolean
}

/** The planned route, as drawn. */
export interface RouteLayers {
  /** The line and the casing under it. */
  readonly route: readonly Polyline[]
  /** One invisible segment per waypoint pair, lit when its leg is selected in the navlog. */
  readonly segments: readonly Polyline[]
  readonly waypoints: readonly WaypointLayers[]
  /** The heading pills on each leg. */
  readonly headings: readonly Layer[]
}

/** The route bar's draft, as drawn when it is not the planned route. */
export interface DraftLayers {
  /** The dashed line, absent for a single waypoint. */
  readonly line: readonly Polyline[]
  /** Dots for the draft's waypoints that are not planned ones. */
  readonly markers: readonly Marker[]
}

export const NO_ROUTE: RouteLayers = { route: [], segments: [], waypoints: [], headings: [] }
export const NO_DRAFT: DraftLayers = { line: [], markers: [] }

/** A `theme.css` token's current value, for the one layer Leaflet colors itself. */
const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/**
 * Wire a marker to the weather panel: a click, or Enter or Space while it has
 * keyboard focus. Leaflet gives a keyboard marker `tabindex="0"` and
 * `role="button"` but no key activation of its own. The key listener is a
 * Leaflet layer event, not a DOM listener on the icon, because `setIcon`
 * (restyling a marker) replaces the icon element and a DOM listener would go
 * with it.
 */
function onActivate(marker: Marker, id: string, select: SelectRef): Marker {
  marker.on("click", () => select.current(id))
  marker.on("keydown", (event: LeafletKeyboardEvent) => {
    const key = event.originalEvent
    if (key.key !== "Enter" && key.key !== " ") return
    key.preventDefault()
    select.current(id)
  })
  return marker
}

/**
 * Draw the planned route: the line, its highlight segments, the waypoints and
 * the heading pills. Waypoints start uncategorized; `RouteMap` colors them
 * with `waypointIcon` once the forecast is known.
 */
export function drawRoute(
  L: LeafletModule,
  map: LeafletMap,
  geometry: RouteGeometry,
  select: SelectRef,
): RouteLayers {
  const points = geometry.polyline.map((p): [number, number] => [p[0], p[1]])
  // A casing under the line keeps it legible over any tile. The colors are
  // classes, so the `theme.css` tokens style them.
  const route = [
    L.polyline(points, { className: "wb-route-casing", weight: 7, interactive: false }),
    L.polyline(points, { className: "wb-route-line", weight: 3.5, interactive: false }),
  ].map((line) => line.addTo(map))
  // One invisible, wider segment per waypoint pair, shown when its leg is selected in the navlog.
  const segments = geometry.polyline.slice(1).map((to, i) => {
    const from = geometry.polyline[i] as readonly [number, number]
    return L.polyline(
      [
        [from[0], from[1]],
        [to[0], to[1]],
      ],
      { color: cssVar("--wb-accent"), weight: 9, opacity: 0, interactive: false },
    ).addTo(map)
  })
  const waypoints = geometry.markers.map((marker): WaypointLayers => {
    const interactive = marker.kind === "airport"
    const icon = waypointIcon(L, marker.id, "UNKNOWN")
    const layer = interactive
      ? onActivate(
          L.marker([marker.at[0], marker.at[1]], { icon, ...interactiveOptions(marker.id) }),
          marker.id,
          select,
        )
      : L.marker([marker.at[0], marker.at[1]], { icon, interactive: false, keyboard: false })
    return { id: marker.id, marker: layer.addTo(map), interactive }
  })
  const headings = geometry.legLabels.map((label) =>
    L.marker([label.at[0], label.at[1]], {
      icon: headingIcon(L, label.text),
      interactive: false,
      keyboard: false,
    }).addTo(map),
  )
  return { route, segments, waypoints, headings }
}

/**
 * Draw the reporting stations near the course: grey dots labelled with their
 * category. A station that is also a planned waypoint is the waypoint's
 * marker already, so it is skipped.
 */
export function drawStations(
  L: LeafletModule,
  map: LeafletMap,
  stations: readonly RouteStation[],
  geometry: RouteGeometry | null,
  categories: Readonly<Record<string, Category>>,
  select: SelectRef,
): readonly WaypointLayers[] {
  const planned = new Set(geometry?.markers.map((marker) => marker.id.toUpperCase()) ?? [])
  return stations
    .filter((station) => !planned.has(station.id.toUpperCase()))
    .map((station) => ({
      id: station.id,
      interactive: true,
      marker: onActivate(
        L.marker([station.lat, station.lon], {
          icon: waypointIcon(L, station.id, categories[station.id] ?? "UNKNOWN", "station"),
          ...interactiveOptions(station.id),
          // Under the route's own markers: where a station's label meets a
          // waypoint's, the waypoint reads on top.
          zIndexOffset: -1000,
        }),
        station.id,
        select,
      ).addTo(map),
    }))
}

/**
 * Draw the route bar's draft: a dashed line through its waypoints, and small
 * dots for the ones the planned route does not already mark.
 */
export function drawDraft(
  L: LeafletModule,
  map: LeafletMap,
  draft: readonly DraftWaypoint[],
  geometry: RouteGeometry | null,
): DraftLayers {
  const points = draft.map((waypoint): [number, number] => [waypoint.lat, waypoint.lon])
  const line =
    points.length > 1
      ? [
          L.polyline(points, {
            className: "wb-route-draft",
            weight: 2.5,
            interactive: false,
          }).addTo(map),
        ]
      : []
  const planned = new Set(geometry?.markers.map((marker) => marker.id) ?? [])
  const markers = draft
    .filter((waypoint) => !planned.has(waypoint.id))
    .map((waypoint) =>
      L.marker([waypoint.lat, waypoint.lon], {
        icon: waypointIcon(L, waypoint.id, "UNKNOWN", "draft"),
        interactive: false,
        keyboard: false,
      }).addTo(map),
    )
  return { line, markers }
}

/** Take the planned route's layers off the map. */
export function removeRoute(layers: RouteLayers): void {
  for (const layer of [...layers.route, ...layers.segments, ...layers.headings]) layer.remove()
  for (const waypoint of layers.waypoints) waypoint.marker.remove()
}

/** Take the station markers off the map. */
export function removeStations(stations: readonly WaypointLayers[]): void {
  for (const station of stations) station.marker.remove()
}

/** Take the draft's line and dots off the map. */
export function removeDraft(layers: DraftLayers): void {
  for (const layer of [...layers.line, ...layers.markers]) layer.remove()
}

/** Light the segment at `index` (a waypoint-pair index) and hide the rest; null hides them all. */
export function applyHighlight(segments: readonly Polyline[], index: number | null): void {
  for (const [i, segment] of segments.entries()) {
    segment.setStyle({ opacity: i === index ? 0.7 : 0 })
  }
}

/**
 * Whether Leaflet is mid zoom or pan animation. It has no public flag for
 * this; `_animatingZoom` and `_panAnim._inProgress` are the internal ones its
 * own handlers read.
 */
export function isAnimating(map: LeafletMap): boolean {
  const internal = map as unknown as {
    readonly _animatingZoom?: boolean
    readonly _panAnim?: { readonly _inProgress?: boolean }
  }
  return internal._animatingZoom === true || internal._panAnim?._inProgress === true
}
