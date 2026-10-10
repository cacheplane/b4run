"use client"
import type {
  DivIcon,
  Layer,
  LeafletKeyboardEvent,
  Map as LeafletMap,
  Marker,
  Polyline,
} from "leaflet"
import { type RefObject, useEffect, useRef, useState } from "react"
import type { DraftWaypoint } from "../lib/route-draft"
import type { RouteGeometry } from "../lib/route-geometry"
import type { RouteStation } from "../lib/weather-roles"
import type { FlightCategory } from "../lib/weather-selectors"

export interface RouteMapProps {
  readonly geometry: RouteGeometry | null
  /** Flight category per airport id, for marker color. */
  readonly categories: Readonly<Record<string, FlightCategory>>
  /** The waypoint-pair index to highlight (see `pairIndexOf`), or null. */
  readonly highlightedLeg: number | null
  /** Room to leave around the route when fitting it: the route bar along the top, in pixels. */
  readonly padding: { readonly left: number; readonly bottom: number; readonly top: number }
  /**
   * The route bar's draft waypoints. Drawn dashed when they are not the
   * planned route (same ids in the same order); with no plan on the map, the
   * map fits them.
   */
  readonly draft: readonly DraftWaypoint[] | null
  /** The reporting stations near the course (`findRouteStations`), drawn as small grey markers. */
  readonly stations: readonly RouteStation[]
  /** The marker whose weather panel is open, or null. */
  readonly selectedMarker?: string | null
  /** An airport or station marker was clicked, or pressed with Enter or Space. */
  readonly onSelectMarker: (id: string) => void
}

type LeafletModule = typeof import("leaflet")
/** Leaflet and the map it made. */
interface LoadedMap {
  readonly L: LeafletModule
  readonly map: LeafletMap
}

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
/** Stations and draft waypoints: a smaller dot, so the planned route's airports lead. */
const SMALL_SIZE = 10

/**
 * `waypoint`: a planned waypoint, its dot colored by category. `station`: a
 * reporting station near the course, a grey dot (it is not on the route) with
 * the category in its label. `draft`: a route-bar waypoint not yet planned.
 */
type MarkerVariant = "waypoint" | "station" | "draft"

function waypointIcon(
  L: LeafletModule,
  id: string,
  cat: FlightCategory,
  variant: MarkerVariant = "waypoint",
): DivIcon {
  // Color never stands alone: the label carries the category as text.
  const text = cat === "UNKNOWN" ? escapeHtml(id) : `${escapeHtml(id)} <b>${cat}</b>`
  const size = variant === "waypoint" ? WAYPOINT_SIZE : SMALL_SIZE
  const dot =
    variant === "waypoint"
      ? `<span class="wb-wp-dot" data-cat="${cat}"></span>`
      : `<span class="wb-wp-dot"></span>`
  return L.divIcon({
    className: variant === "waypoint" ? "wb-wp" : `wb-wp wb-wp-${variant}`,
    html: `${dot}<span class="wb-wp-label">${text}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

/** Marker options for an airport or station: a keyboard-focusable button named by its id. */
const interactiveOptions = (id: string) =>
  ({ interactive: true, keyboard: true, title: id, alt: id, riseOnHover: true }) as const

interface WaypointLayers {
  readonly id: string
  readonly marker: Marker
  /** An airport: it opens the weather panel. Navaids and fixes are labels only. */
  readonly interactive: boolean
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

/**
 * Wire a marker to the weather panel: a click, or Enter or Space while it has
 * keyboard focus. Leaflet gives a keyboard marker `tabindex="0"` and
 * `role="button"` but no key activation of its own. The key listener is a
 * Leaflet layer event, not a DOM listener on the icon, because `setIcon`
 * (STYLE) replaces the icon element and a DOM listener would go with it.
 */
function onActivate(marker: Marker, id: string, select: RefObject<(id: string) => void>): Marker {
  marker.on("click", () => select.current(id))
  marker.on("keydown", (event: LeafletKeyboardEvent) => {
    const key = event.originalEvent
    if (key.key !== "Enter" && key.key !== " ") return
    key.preventDefault()
    select.current(id)
  })
  return marker
}

/** True when the draft's ids are the planned route's, in order. */
function draftMatchesPlan(
  draft: readonly DraftWaypoint[],
  geometry: RouteGeometry | null,
): boolean {
  if (geometry === null || draft.length !== geometry.markers.length) return false
  return draft.every((waypoint, i) => waypoint.id === geometry.markers[i]?.id)
}

interface DraftLayers {
  readonly line: readonly Polyline[]
  readonly markers: readonly Marker[]
}

const NO_DRAFT: DraftLayers = { line: [], markers: [] }

const removeAll = (layers: RouteLayers): void => {
  for (const layer of [...layers.route, ...layers.segments, ...layers.headings]) layer.remove()
  for (const waypoint of layers.waypoints) waypoint.marker.remove()
}

/** Whether `current` holds the map that is alive now (see `liveMap` in `RouteMap`). */
function isLive(
  current: LoadedMap | null,
  liveMap: RefObject<LeafletMap | null>,
): current is LoadedMap {
  return current !== null && current.map === liveMap.current
}

/**
 * The route map: it fills its panel (the right column on desktop, the Map tab
 * on phones). Leaflet is imported once, in the mount effect, so this module
 * never touches `window` on the server; `WorkbenchLayout` also loads it with
 * `next/dynamic` and `ssr: false` for the same reason.
 *
 * Three effects, in this order, and the order matters: DRAW (a new route),
 * STYLE (new flight categories) and FIT (a new route, or new room around it).
 * Between STYLE and FIT sit three more that never move the map: STATIONS
 * (the reporting stations), SELECTED (which marker's panel is open) and
 * DRAFT (the route bar's unplanned route, a vector drawn before FIT for the
 * reason below). With no plan, FIT fits the draft instead.
 * Drawing is synchronous, with the module kept from the mount, so a route's
 * layers always exist before the fit starts its zoom animation; and a new
 * weather brief restyles the markers in place rather than redrawing them.
 * Vector layers added in the middle of a zoom animation are projected at the
 * wrong zoom and stay off-screen, which is what an async draw racing an
 * animated fit produced.
 */
export function RouteMap({
  geometry,
  categories,
  highlightedLeg,
  padding,
  draft,
  stations,
  selectedMarker = null,
  onSelectMarker,
}: RouteMapProps) {
  const container = useRef<HTMLElement>(null)
  const layers = useRef<RouteLayers>(NO_LAYERS)
  const stationLayers = useRef<readonly WaypointLayers[]>([])
  const draftLayers = useRef<DraftLayers>(NO_DRAFT)
  // Read through a ref, so a new callback identity never redraws a marker.
  const selectRef = useRef(onSelectMarker)
  selectRef.current = onSelectMarker
  const highlightRef = useRef<number | null>(highlightedLeg)
  // A fit asked for while the map had no size (a hidden panel, a layout not
  // yet laid out): fitting a 0×0 box zooms all the way in, so it waits here
  // and RESIZE runs it once the map has a size.
  const pendingFit = useRef<(() => void) | null>(null)
  // State, not a ref: the effects below must re-run once the map exists,
  // because the first geometry can arrive before Leaflet has loaded.
  const [leaflet, setLeaflet] = useState<LoadedMap | null>(null)
  // The map that is alive right now: set when it is created, cleared when it
  // is removed. When React re-runs every effect (Fast Refresh, dev effect
  // re-runs), the create effect's cleanup removes the map before the other
  // effects re-run with the state that still holds it; drawing on a removed
  // map throws inside Leaflet ("reading 'appendChild'"). Each effect bails
  // unless its map is this one.
  const liveMap = useRef<LeafletMap | null>(null)

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
      // Both controls in the bottom-right corner. The route bar owns the top
      // of the panel and the weather panel the bottom-left, so this corner is
      // free and the OpenStreetMap attribution the tile policy requires is
      // never covered.
      // Phones pinch to zoom, so the buttons hide there.
      L.control.zoom({ position: "bottomright" }).addTo(instance)
      L.control.attribution({ position: "bottomright", prefix: false }).addTo(instance)
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
        className: "wb-tiles",
      }).addTo(instance)
      instance.setView([39.5, -98.35], 4)
      liveMap.current = instance
      setLeaflet({ L, map: instance })
    })
    return () => {
      cancelled = true
      if (instance !== null && liveMap.current === instance) liveMap.current = null
      instance?.remove()
      layers.current = NO_LAYERS
      stationLayers.current = []
      draftLayers.current = NO_DRAFT
      setLeaflet(null)
    }
  }, [])

  // RESIZE: the map fills a panel now, not the viewport. The panel changes
  // size when the navlog sheet opens or closes, and goes from zero to full
  // size if the map first lays out hidden; Leaflet must re-measure each time
  // or it draws tiles for the old box. A fit that found no size runs here.
  useEffect(() => {
    if (!isLive(leaflet, liveMap) || container.current === null) return
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (!isLive(leaflet, liveMap)) return
      leaflet.map.invalidateSize()
      const pending = pendingFit.current
      if (pending === null) return
      const size = leaflet.map.getSize()
      if (size.x === 0 || size.y === 0) return
      pendingFit.current = null
      pending()
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [leaflet])

  // DRAW: the route, its highlight segments, the waypoints and the heading labels.
  useEffect(() => {
    if (!isLive(leaflet, liveMap)) return
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
            selectRef,
          )
        : L.marker([marker.at[0], marker.at[1]], { icon, interactive: false, keyboard: false })
      return { id: marker.id, marker: layer.addTo(map), interactive }
    })
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
    if (!isLive(leaflet, liveMap) || geometry === null) return
    const { L } = leaflet
    for (const waypoint of layers.current.waypoints) {
      waypoint.marker.setIcon(waypointIcon(L, waypoint.id, categories[waypoint.id] ?? "UNKNOWN"))
    }
  }, [leaflet, geometry, categories])

  // STATIONS: the reporting stations near the course, grey, labelled with
  // their category. A station that is also a planned waypoint is the
  // waypoint's marker already.
  useEffect(() => {
    if (!isLive(leaflet, liveMap)) return
    const { L, map } = leaflet
    for (const station of stationLayers.current) station.marker.remove()
    const planned = new Set(geometry?.markers.map((marker) => marker.id.toUpperCase()) ?? [])
    stationLayers.current = stations
      .filter((station) => !planned.has(station.id.toUpperCase()))
      .map((station) => ({
        id: station.id,
        interactive: true,
        marker: onActivate(
          L.marker([station.lat, station.lon], {
            icon: waypointIcon(L, station.id, categories[station.id] ?? "UNKNOWN", "station"),
            ...interactiveOptions(station.id),
          }),
          station.id,
          selectRef,
        ).addTo(map),
      }))
  }, [leaflet, geometry, stations, categories])

  // SELECTED: the open panel's marker reads as expanded. After STYLE and
  // STATIONS, which replace icon elements.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route, categories and stations redraw the icons this marks
  useEffect(() => {
    if (!isLive(leaflet, liveMap)) return
    for (const layer of [...layers.current.waypoints, ...stationLayers.current]) {
      if (!layer.interactive) continue
      layer.marker.getElement()?.setAttribute("aria-expanded", String(layer.id === selectedMarker))
    }
  }, [leaflet, geometry, categories, stations, selectedMarker])

  // DRAFT: the route bar's draft, dashed, when it is not the planned route;
  // its waypoints that are not planned ones get small dots.
  const draftDiffers = draft !== null && draft.length > 0 && !draftMatchesPlan(draft, geometry)
  useEffect(() => {
    if (!isLive(leaflet, liveMap)) return
    const { L, map } = leaflet
    for (const layer of [...draftLayers.current.line, ...draftLayers.current.markers]) {
      layer.remove()
    }
    draftLayers.current = NO_DRAFT
    if (draft === null || !draftDiffers) return
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
    draftLayers.current = { line, markers }
  }, [leaflet, geometry, draft, draftDiffers])

  // What FIT frames: the planned route's bounds, or with no plan the draft's
  // (two waypoints or more). A string, so an unchanged box never refits.
  const draftBoundsKey =
    geometry === null && draft !== null && draft.length > 1
      ? JSON.stringify([
          [Math.min(...draft.map((w) => w.lat)), Math.min(...draft.map((w) => w.lon))],
          [Math.max(...draft.map((w) => w.lat)), Math.max(...draft.map((w) => w.lon))],
        ])
      : null

  // FIT: only for a new route or new room around it, so a new weather brief
  // never moves the map under the pilot. No animation under reduced motion.
  const { left, top, bottom } = padding
  useEffect(() => {
    const bounds =
      geometry !== null
        ? geometry.bounds
        : draftBoundsKey !== null
          ? (JSON.parse(draftBoundsKey) as RouteGeometry["bounds"])
          : null
    if (!isLive(leaflet, liveMap) || bounds === null) {
      pendingFit.current = null
      return
    }
    const fitRoute = (): void => {
      if (!isLive(leaflet, liveMap)) return
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
      leaflet.map.fitBounds(
        [
          [bounds[0][0], bounds[0][1]],
          [bounds[1][0], bounds[1][1]],
        ],
        {
          paddingTopLeft: [left, top],
          paddingBottomRight: [72, bottom],
          ...(reduceMotion ? { animate: false } : {}),
        },
      )
    }
    const size = leaflet.map.getSize()
    if (size.x === 0 || size.y === 0) {
      pendingFit.current = fitRoute
      return
    }
    pendingFit.current = null
    fitRoute()
  }, [leaflet, geometry, draftBoundsKey, left, top, bottom])

  useEffect(() => {
    highlightRef.current = highlightedLeg
    applyHighlight(layers.current.segments, highlightedLeg)
  }, [highlightedLeg])

  return <section ref={container} className="wb-map absolute inset-0 z-0" aria-label="Route map" />
}
