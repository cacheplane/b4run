"use client"
import type { Layer, Map as LeafletMap, Polyline } from "leaflet"
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

interface RouteLayers {
  readonly route: Polyline | null
  readonly segments: readonly Polyline[]
  readonly overlays: readonly Layer[]
}

const NO_LAYERS: RouteLayers = { route: null, segments: [], overlays: [] }

/**
 * The map behind everything. Leaflet is imported inside the effects so this
 * module never touches `window` on the server; `WorkbenchLayout` also loads it
 * with `next/dynamic` and `ssr: false` for the same reason.
 */
export function RouteMap({ geometry, categories, highlightedLeg, padding }: RouteMapProps) {
  const container = useRef<HTMLElement>(null)
  const layers = useRef<RouteLayers>(NO_LAYERS)
  // State, not a ref: the drawing effect must re-run once the map exists,
  // because the first geometry can arrive before Leaflet has loaded.
  const [map, setMap] = useState<LeafletMap | null>(null)

  useEffect(() => {
    let cancelled = false
    let instance: LeafletMap | null = null
    void import("leaflet").then((L) => {
      if (cancelled || container.current === null) return
      instance = L.map(container.current, { zoomControl: false, attributionControl: true })
      L.control.zoom({ position: "bottomright" }).addTo(instance)
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(instance)
      instance.setView([39.5, -98.35], 4)
      setMap(instance)
    })
    return () => {
      cancelled = true
      instance?.remove()
      layers.current = NO_LAYERS
      setMap(null)
    }
  }, [])

  useEffect(() => {
    if (map === null) return
    let cancelled = false
    void import("leaflet").then((L) => {
      if (cancelled) return
      const previous = layers.current
      previous.route?.remove()
      for (const layer of [...previous.segments, ...previous.overlays]) layer.remove()
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
      const overlays: Layer[] = []
      for (const marker of geometry.markers) {
        const cat = categories[marker.id] ?? "UNKNOWN"
        overlays.push(
          L.circleMarker([marker.at[0], marker.at[1]], {
            radius: 6,
            color: cssVar("--wb-surface"),
            weight: 2,
            fillColor: cssVar(CATEGORY_VAR[cat]),
            fillOpacity: 1,
          }).addTo(map),
        )
        // Color never stands alone: the label carries the category as text.
        const label = cat === "UNKNOWN" ? marker.id : `${marker.id} ${cat}`
        overlays.push(
          L.marker([marker.at[0], marker.at[1]], {
            icon: L.divIcon({
              className: "wb-wp-label",
              html: escapeHtml(label),
              iconAnchor: [-10, 10],
            }),
            interactive: false,
            keyboard: false,
          }).addTo(map),
        )
      }
      for (const label of geometry.legLabels) {
        overlays.push(
          L.marker([label.at[0], label.at[1]], {
            icon: L.divIcon({ className: "wb-hdg-label", html: escapeHtml(label.text) }),
            interactive: false,
            keyboard: false,
          }).addTo(map),
        )
      }
      layers.current = { route, segments, overlays }
      map.fitBounds(
        [
          [geometry.bounds[0][0], geometry.bounds[0][1]],
          [geometry.bounds[1][0], geometry.bounds[1][1]],
        ],
        {
          paddingTopLeft: [padding.left, padding.top],
          paddingBottomRight: [40, padding.bottom],
        },
      )
    })
    return () => {
      cancelled = true
    }
  }, [map, geometry, categories, padding])

  useEffect(() => {
    for (const [i, segment] of layers.current.segments.entries()) {
      segment.setStyle({ opacity: i === highlightedLeg ? 0.6 : 0 })
    }
  }, [highlightedLeg])

  return <section ref={container} className="wb-map fixed inset-0 z-0" aria-label="Route map" />
}
