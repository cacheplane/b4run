"use client"
import type { DivIcon, Layer, Map as LeafletMap, Marker, Polyline } from "leaflet"
import { useEffect, useRef, useState } from "react"
import type { RouteGeometry } from "../lib/route-geometry"
import type { FlightCategory } from "../lib/weather-selectors"

export interface RouteMapProps {
  readonly geometry: RouteGeometry | null
  /** Flight category per airport id, for marker color. */
  readonly categories: Readonly<Record<string, FlightCategory>>
  /** The waypoint-pair index to highlight (see `pairIndexOf`), or null. */
  readonly highlightedLeg: number | null
  /** Extra padding for the floating surfaces: the dock (left), the strip (top), the sheet (bottom), in pixels. */
  readonly padding: { readonly left: number; readonly bottom: number; readonly top: number }
}

type LeafletModule = typeof import("leaflet")

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * One airport, one marker: the dot and its label are a single div icon
 * anchored on the dot's center. (They used to be a circle marker plus a
 * second, label-only div icon — and a div icon keeps Leaflet's default 12×12
 * box, which the label's rounded border drew as a stray little circle beside
 * every airport.) The category rides on `data-cat`, so `theme.css` colors the
 * dot from the theme tokens and a theme switch recolors it without a redraw.
 */
const WAYPOINT_SIZE = 14

function waypointIcon(L: LeafletModule, id: string, cat: FlightCategory): DivIcon {
  // Color never stands alone: the label carries the category as text.
  const text = cat === "UNKNOWN" ? escapeHtml(id) : `${escapeHtml(id)} <b>${cat}</b>`
  return L.divIcon({
    className: "wb-wp",
    html: `<span class="wb-wp-dot" data-cat="${cat}"></span><span class="wb-wp-label">${text}</span>`,
    iconSize: [WAYPOINT_SIZE, WAYPOINT_SIZE],
    iconAnchor: [WAYPOINT_SIZE / 2, WAYPOINT_SIZE / 2],
  })
}

interface WaypointLayers {
  readonly id: string
  readonly marker: Marker
}

interface RouteLayers {
  readonly route: readonly Polyline[]
  readonly segments: readonly Polyline[]
  readonly waypoints: readonly WaypointLayers[]
  readonly headings: readonly Layer[]
}

const NO_LAYERS: RouteLayers = { route: [], segments: [], waypoints: [], headings: [] }

const applyHighlight = (segments: readonly Polyline[], index: number | null): void => {
  for (const [i, segment] of segments.entries()) {
    segment.setStyle({ opacity: i === index ? 0.7 : 0 })
  }
}

const removeAll = (layers: RouteLayers): void => {
  for (const layer of [...layers.route, ...layers.segments, ...layers.headings]) layer.remove()
  for (const waypoint of layers.waypoints) waypoint.marker.remove()
}

/**
 * The map behind everything. Leaflet is imported once, in the mount effect, so
 * this module never touches `window` on the server; `WorkbenchLayout` also
 * loads it with `next/dynamic` and `ssr: false` for the same reason.
 *
 * Three effects, in this order, and the order matters: DRAW (a new route),
 * STYLE (new flight categories) and FIT (a new route, or new room around it).
 * Drawing is synchronous, with the module kept from the mount, so a route's
 * layers always exist before the fit starts its zoom animation; and a new
 * weather brief restyles the markers in place rather than redrawing them.
 * Vector layers added in the middle of a zoom animation are projected at the
 * wrong zoom and stay off-screen, which is what an async draw racing an
 * animated fit produced.
 */
export function RouteMap({ geometry, categories, highlightedLeg, padding }: RouteMapProps) {
  const container = useRef<HTMLElement>(null)
  const layers = useRef<RouteLayers>(NO_LAYERS)
  const highlightRef = useRef<number | null>(highlightedLeg)
  // State, not a ref: the effects below must re-run once the map exists,
  // because the first geometry can arrive before Leaflet has loaded.
  const [leaflet, setLeaflet] = useState<{ L: LeafletModule; map: LeafletMap } | null>(null)

  useEffect(() => {
    let cancelled = false
    let instance: LeafletMap | null = null
    void import("leaflet").then((L) => {
      if (cancelled || container.current === null) return
      // Under reduced motion Leaflet's own animations go too: tiles appear
      // without fading in, and zooms jump rather than glide.
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
      instance = L.map(container.current, {
        zoomControl: false,
        attributionControl: false,
        ...(reduceMotion
          ? { fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false }
          : {}),
      })
      // Both controls in the bottom-right corner. The weather strip owns the
      // top, the dock the left; `theme.css` lifts the bottom-right corner
      // above the sheet by `--wb-map-inset-bottom`, which `WorkbenchLayout`
      // measures, so the OpenStreetMap attribution the tile policy requires
      // is never covered. Phones pinch to zoom, so the buttons hide there.
      L.control.zoom({ position: "bottomright" }).addTo(instance)
      L.control.attribution({ position: "bottomright", prefix: false }).addTo(instance)
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
        className: "wb-tiles",
      }).addTo(instance)
      instance.setView([39.5, -98.35], 4)
      setLeaflet({ L, map: instance })
    })
    return () => {
      cancelled = true
      instance?.remove()
      layers.current = NO_LAYERS
      setLeaflet(null)
    }
  }, [])

  // DRAW: the route, its hover segments, the waypoints and the heading labels.
  useEffect(() => {
    if (leaflet === null) return
    const { L, map } = leaflet
    removeAll(layers.current)
    layers.current = NO_LAYERS
    if (geometry === null) return
    const points = geometry.polyline.map((p): [number, number] => [p[0], p[1]])
    // A casing under the line keeps it legible over any tile. The colors are
    // classes, so `theme.css` tokens (and a theme switch) style them.
    const route = [
      L.polyline(points, { className: "wb-route-casing", weight: 7, interactive: false }),
      L.polyline(points, { className: "wb-route-line", weight: 3.5, interactive: false }),
    ].map((line) => line.addTo(map))
    // One invisible, wider segment per waypoint pair, shown when its leg is hovered.
    const segments = geometry.polyline.slice(1).map((to, i) => {
      const from = geometry.polyline[i] as readonly [number, number]
      return L.polyline(
        [
          [from[0], from[1]],
          [to[0], to[1]],
        ],
        { color: cssVar("--wb-accent-from"), weight: 9, opacity: 0, interactive: false },
      ).addTo(map)
    })
    const waypoints = geometry.markers.map((marker) => ({
      id: marker.id,
      marker: L.marker([marker.at[0], marker.at[1]], {
        icon: waypointIcon(L, marker.id, "UNKNOWN"),
        interactive: false,
        keyboard: false,
      }).addTo(map),
    }))
    const headings = geometry.legLabels.map((label) =>
      L.marker([label.at[0], label.at[1]], {
        // Zero-size and centered by CSS, so the pill sits on the leg's midpoint.
        icon: L.divIcon({
          className: "wb-hdg",
          html: `<span class="wb-hdg-label">${escapeHtml(label.text)}</span>`,
          iconSize: [0, 0],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(map),
    )
    layers.current = { route, segments, waypoints, headings }
    applyHighlight(segments, highlightRef.current)
  }, [leaflet, geometry])

  // STYLE: each waypoint's flight category, in place. It runs after DRAW in
  // the same commit when the route changes, so a fresh draw is colored.
  useEffect(() => {
    if (leaflet === null || geometry === null) return
    const { L } = leaflet
    for (const waypoint of layers.current.waypoints) {
      waypoint.marker.setIcon(waypointIcon(L, waypoint.id, categories[waypoint.id] ?? "UNKNOWN"))
    }
  }, [leaflet, geometry, categories])

  // FIT: only for a new route or new room around it, so a new weather brief
  // never moves the map under the pilot. No animation under reduced motion.
  const { left, top, bottom } = padding
  useEffect(() => {
    if (leaflet === null || geometry === null) return
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    leaflet.map.fitBounds(
      [
        [geometry.bounds[0][0], geometry.bounds[0][1]],
        [geometry.bounds[1][0], geometry.bounds[1][1]],
      ],
      {
        paddingTopLeft: [left, top],
        paddingBottomRight: [72, bottom],
        ...(reduceMotion ? { animate: false } : {}),
      },
    )
  }, [leaflet, geometry, left, top, bottom])

  useEffect(() => {
    highlightRef.current = highlightedLeg
    applyHighlight(layers.current.segments, highlightedLeg)
  }, [highlightedLeg])

  return <section ref={container} className="wb-map fixed inset-0 z-0" aria-label="Route map" />
}
