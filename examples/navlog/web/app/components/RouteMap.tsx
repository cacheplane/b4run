"use client"
import type { CircleMarker, Layer, Map as LeafletMap, Marker, Polyline } from "leaflet"
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

const CATEGORY_VAR: Record<FlightCategory, string> = {
  VFR: "--wb-cat-vfr",
  MVFR: "--wb-cat-mvfr",
  IFR: "--wb-cat-ifr",
  LIFR: "--wb-cat-lifr",
  UNKNOWN: "--wb-muted",
}

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

interface WaypointLayers {
  readonly id: string
  readonly dot: CircleMarker
  readonly label: Marker
}

interface RouteLayers {
  readonly route: Polyline | null
  readonly segments: readonly Polyline[]
  readonly waypoints: readonly WaypointLayers[]
  readonly headings: readonly Layer[]
}

const NO_LAYERS: RouteLayers = { route: null, segments: [], waypoints: [], headings: [] }

const applyHighlight = (segments: readonly Polyline[], index: number | null): void => {
  for (const [i, segment] of segments.entries()) {
    segment.setStyle({ opacity: i === index ? 0.6 : 0 })
  }
}

const removeAll = (layers: RouteLayers): void => {
  layers.route?.remove()
  for (const layer of [...layers.segments, ...layers.headings]) layer.remove()
  for (const waypoint of layers.waypoints) {
    waypoint.dot.remove()
    waypoint.label.remove()
  }
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
      instance = L.map(container.current, { zoomControl: false, attributionControl: false })
      // Both controls in the top-left corner, which no floating panel covers:
      // on phones the sheet is at the bottom, and on desktop `theme.css`
      // shifts Leaflet's left corners past the dock. The OpenStreetMap tile
      // policy requires the attribution to stay visible.
      L.control.zoom({ position: "topleft" }).addTo(instance)
      L.control.attribution({ position: "topleft", prefix: false }).addTo(instance)
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
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
    const route = L.polyline(
      geometry.polyline.map((p): [number, number] => [p[0], p[1]]),
      { color: cssVar("--wb-route"), weight: 3 },
    ).addTo(map)
    // One invisible, wider segment per waypoint pair, shown when its leg is hovered.
    const segments = geometry.polyline.slice(1).map((to, i) => {
      const from = geometry.polyline[i] as readonly [number, number]
      return L.polyline(
        [
          [from[0], from[1]],
          [to[0], to[1]],
        ],
        { color: cssVar("--wb-accent-from"), weight: 7, opacity: 0 },
      ).addTo(map)
    })
    const waypoints = geometry.markers.map((marker) => ({
      id: marker.id,
      dot: L.circleMarker([marker.at[0], marker.at[1]], {
        radius: 6,
        color: cssVar("--wb-surface"),
        weight: 2,
        fillColor: cssVar(CATEGORY_VAR.UNKNOWN),
        fillOpacity: 1,
      }).addTo(map),
      label: L.marker([marker.at[0], marker.at[1]], {
        icon: L.divIcon({
          className: "wb-wp-label",
          html: escapeHtml(marker.id),
          iconAnchor: [-10, 10],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(map),
    }))
    const headings = geometry.legLabels.map((label) =>
      L.marker([label.at[0], label.at[1]], {
        icon: L.divIcon({ className: "wb-hdg-label", html: escapeHtml(label.text) }),
        interactive: false,
        keyboard: false,
      }).addTo(map),
    )
    layers.current = { route, segments, waypoints, headings }
    applyHighlight(segments, highlightRef.current)
  }, [leaflet, geometry])

  // STYLE: color each waypoint by its flight category, in place. It runs after
  // DRAW in the same commit when the route changes, so a fresh draw is colored.
  useEffect(() => {
    if (leaflet === null || geometry === null) return
    const { L } = leaflet
    for (const waypoint of layers.current.waypoints) {
      const cat = categories[waypoint.id] ?? "UNKNOWN"
      waypoint.dot.setStyle({ fillColor: cssVar(CATEGORY_VAR[cat]) })
      // Color never stands alone: the label carries the category as text.
      const text = cat === "UNKNOWN" ? waypoint.id : `${waypoint.id} ${cat}`
      waypoint.label.setIcon(
        L.divIcon({ className: "wb-wp-label", html: escapeHtml(text), iconAnchor: [-10, 10] }),
      )
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
        paddingBottomRight: [40, bottom],
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
