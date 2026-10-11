"use client"
import type { Map as LeafletMap } from "leaflet"
import { type RefObject, useEffect, useRef, useState } from "react"
import { draftBounds, draftMatchesPlan } from "../lib/map/draft"
import { declutterLabels } from "../lib/map/label-dom"
import {
  applyHighlight,
  type DraftLayers,
  drawDraft,
  drawRoute,
  drawStations,
  isAnimating,
  NO_DRAFT,
  NO_ROUTE,
  type RouteLayers,
  removeDraft,
  removeRoute,
  removeStations,
  type WaypointLayers,
} from "../lib/map/layers"
import { waypointIcon } from "../lib/map/markers"
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

/** What each layer has on the map right now. SELECTED and LABELS read all three. */
interface DrawnLayers {
  route: RouteLayers
  stations: readonly WaypointLayers[]
  draft: DraftLayers
}

/** A fresh, empty `DrawnLayers`: the effects assign its fields, so it is never shared. */
const nothingDrawn = (): DrawnLayers => ({ route: NO_ROUTE, stations: [], draft: NO_DRAFT })

/** What FIT leaves for RESIZE, so a resize can finish or repeat the last fit. */
interface FitState {
  /**
   * A fit asked for while the map had no size (a hidden panel, a layout not
   * yet laid out): fitting a 0×0 box zooms all the way in, so it waits here
   * and RESIZE runs it once the map has a size.
   */
  pending: (() => void) | null
  /**
   * The last fit. Until the pilot touches the map, a resize (the sheet
   * opening as the plan lands, a window narrowed to a phone and back) runs
   * it again instead of leaving the route off-screen.
   */
  last: ((animate: boolean) => void) | null
  /** Whether the pilot has moved the map since the last fit: from then on the view is theirs. */
  userMoved: boolean
  /**
   * The bounds the last fit framed: only a new route animates its fit. A
   * re-fit of the same route (new room around it as the route bar measures
   * itself) jumps, because a second animated fit started during the first
   * leaves Leaflet between zoom levels.
   */
  framed: string | null
}

/** Whether `current` holds the map that is alive now (see `liveMap` in `RouteMap`). */
function isLive(
  current: LoadedMap | null,
  liveMap: RefObject<LeafletMap | null>,
): current is LoadedMap {
  return current !== null && current.map === liveMap.current
}

/** How long a resize must be quiet before the route refits, in ms. */
const RESIZE_SETTLE_MS = 150

/**
 * The route map: it fills its panel (the right column on desktop, the Map tab
 * on phones). Leaflet is imported once, in CREATE, so this module never
 * touches `window` on the server; `WorkbenchLayout` also loads it with
 * `next/dynamic` and `ssr: false` for the same reason. What each layer looks
 * like lives in `lib/map/` (`layers.ts`, `markers.ts`); this component decides
 * when each is drawn.
 *
 * Its effects run in this order, and the order matters:
 *
 * 1. CREATE: import Leaflet and make the map, once.
 * 2. RESIZE: re-measure when the panel changes size, and run a fit that
 *    found no size, or repeat the last fit until the pilot moves the map.
 * 3. DRAW: the planned route, for a new route.
 * 4. STYLE: each waypoint's flight category, in place, for a new brief.
 * 5. STATIONS: the reporting stations near the course.
 * 6. SELECTED: which marker's panel is open (after STYLE and STATIONS,
 *    which replace icon elements).
 * 7. DRAFT: the route bar's draft, when it is not the planned route.
 * 8. FIT: frame a new route, or the same route in new room; with no plan,
 *    the draft. Only FIT moves the map.
 * 9. HIGHLIGHT: the leg selected in the navlog.
 * 10. LABELS: place every label, last, so it sees what the others drew.
 *
 * They share three refs: `drawn` (what each layer has on the map), `fit`
 * (what FIT leaves for RESIZE) and `liveMap` (the map alive now; each effect
 * bails unless its map is this one).
 *
 * Drawing is synchronous, with the module kept from CREATE, so a route's
 * layers always exist before the fit starts its zoom animation; and a new
 * weather brief restyles the markers in place rather than redrawing them.
 * Vector layers added in the middle of a zoom animation are projected at the
 * wrong zoom and stay off-screen, which is what an async draw racing an
 * animated fit would do.
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
  const drawn = useRef<DrawnLayers>(nothingDrawn())
  const fit = useRef<FitState>({ pending: null, last: null, userMoved: false, framed: null })
  // The latest props the markers and DRAW read, through refs, so a new
  // callback identity or highlight never redraws a marker.
  const selectRef = useRef(onSelectMarker)
  selectRef.current = onSelectMarker
  const highlightRef = useRef<number | null>(highlightedLeg)
  // State, not a ref: the effects below must re-run once the map exists,
  // because the first geometry can arrive before Leaflet has loaded.
  const [leaflet, setLeaflet] = useState<LoadedMap | null>(null)
  // The map that is alive right now: set when it is created, cleared when it
  // is removed. When React re-runs every effect (Fast Refresh, dev effect
  // re-runs), CREATE's cleanup removes the map before the other effects
  // re-run with the state that still holds it; drawing on a removed map
  // throws inside Leaflet ("reading 'appendChild'"). Each effect bails
  // unless its map is this one.
  const liveMap = useRef<LeafletMap | null>(null)

  // CREATE: the map, its controls and its tiles.
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
      // Removing the map removes every layer on it.
      instance?.remove()
      drawn.current = nothingDrawn()
      setLeaflet(null)
    }
  }, [])

  // RESIZE: the map fills a panel, not the viewport. The panel changes
  // size when the navlog sheet opens or closes, and goes from zero to full
  // size if the map first lays out hidden; Leaflet must re-measure each time
  // or it draws tiles for the old box. A fit that found no size runs here.
  useEffect(() => {
    if (!isLive(leaflet, liveMap) || container.current === null) return
    if (typeof ResizeObserver === "undefined") return
    // A panel resizes over several frames (the sheet's height settling), and
    // a fit started mid-resize animates against a size that is about to
    // change; so the refit waits for the size to settle, then jumps.
    let settle: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      if (!isLive(leaflet, liveMap)) return
      leaflet.map.invalidateSize({ pan: false })
      const size = leaflet.map.getSize()
      if (size.x === 0 || size.y === 0) return
      const pending = fit.current.pending
      if (pending !== null) {
        fit.current.pending = null
        pending()
        return
      }
      clearTimeout(settle)
      settle = setTimeout(() => {
        if (!isLive(leaflet, liveMap) || fit.current.userMoved) return
        const refit = (): void => fit.current.last?.(false)
        // A fit still animating (the first fit, started before the sheet
        // opened) would land after this jump and undo it, so wait it out.
        if (isAnimating(leaflet.map)) leaflet.map.once("moveend", refit)
        else refit()
      }, RESIZE_SETTLE_MS)
    })
    observer.observe(container.current)
    // A pointer, wheel or key on the map is the pilot moving it (or opening a
    // marker): from then on the view is theirs until the next fit.
    const element = container.current
    const moved = (): void => {
      fit.current.userMoved = true
    }
    element.addEventListener("pointerdown", moved)
    element.addEventListener("wheel", moved, { passive: true })
    element.addEventListener("keydown", moved)
    return () => {
      clearTimeout(settle)
      observer.disconnect()
      element.removeEventListener("pointerdown", moved)
      element.removeEventListener("wheel", moved)
      element.removeEventListener("keydown", moved)
    }
  }, [leaflet])

  // DRAW: the route, its highlight segments, the waypoints and the heading pills.
  useEffect(() => {
    if (!isLive(leaflet, liveMap)) return
    const { L, map } = leaflet
    removeRoute(drawn.current.route)
    drawn.current.route = geometry === null ? NO_ROUTE : drawRoute(L, map, geometry, selectRef)
    applyHighlight(drawn.current.route.segments, highlightRef.current)
  }, [leaflet, geometry])

  // STYLE: each waypoint's flight category, in place. It runs after DRAW in
  // the same commit when the route changes, so a fresh draw is colored.
  useEffect(() => {
    if (!isLive(leaflet, liveMap) || geometry === null) return
    const { L } = leaflet
    for (const waypoint of drawn.current.route.waypoints) {
      waypoint.marker.setIcon(waypointIcon(L, waypoint.id, categories[waypoint.id] ?? "UNKNOWN"))
    }
  }, [leaflet, geometry, categories])

  // STATIONS: the reporting stations near the course, redrawn with their
  // categories; the route decides which ones its own waypoints already mark.
  useEffect(() => {
    if (!isLive(leaflet, liveMap)) return
    const { L, map } = leaflet
    removeStations(drawn.current.stations)
    drawn.current.stations = drawStations(L, map, stations, geometry, categories, selectRef)
  }, [leaflet, geometry, stations, categories])

  // SELECTED: the open panel's marker reads as expanded. After STYLE and
  // STATIONS, which replace icon elements.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route, categories and stations redraw the icons this marks
  useEffect(() => {
    if (!isLive(leaflet, liveMap)) return
    for (const layer of [...drawn.current.route.waypoints, ...drawn.current.stations]) {
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
    removeDraft(drawn.current.draft)
    drawn.current.draft =
      draft !== null && draftDiffers ? drawDraft(L, map, draft, geometry) : NO_DRAFT
  }, [leaflet, geometry, draft, draftDiffers])

  // What FIT frames with no plan: the draft's box (two waypoints or more). A
  // string, so an unchanged box never refits.
  const draftBox = geometry === null && draft !== null ? draftBounds(draft) : null
  const draftBoundsKey = draftBox === null ? null : JSON.stringify(draftBox)

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
      fit.current.pending = null
      fit.current.last = null
      return
    }
    const fitRoute = (animate = true): void => {
      if (!isLive(leaflet, liveMap)) return
      const reduceMotion =
        !animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
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
    fit.current.last = fitRoute
    fit.current.userMoved = false
    const boundsKey = JSON.stringify(bounds)
    const isNewRoute = boundsKey !== fit.current.framed
    fit.current.framed = boundsKey
    const size = leaflet.map.getSize()
    if (size.x === 0 || size.y === 0) {
      fit.current.pending = () => fitRoute(false)
      return
    }
    fit.current.pending = null
    fitRoute(isNewRoute)
  }, [leaflet, geometry, draftBoundsKey, left, top, bottom])

  // HIGHLIGHT: the leg selected in the navlog grid, lit on its segment.
  useEffect(() => {
    highlightRef.current = highlightedLeg
    applyHighlight(drawn.current.route.segments, highlightedLeg)
  }, [highlightedLeg])

  // LABELS: after every render (this effect is last, so it sees what the
  // others drew) and every zoom, each marker's label goes where it collides
  // with no other label, dot or heading pill: right, else left, else hidden
  // until the marker is hovered or focused. One pass per frame.
  useEffect(() => {
    if (!isLive(leaflet, liveMap)) return
    let frame: number | null = null
    const schedule = (): void => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        // Mid-zoom the markers are not where they will land; the zoom's end
        // schedules another pass.
        if (!isLive(leaflet, liveMap) || isAnimating(leaflet.map)) return
        declutterLabels({
          waypoints: drawn.current.route.waypoints,
          stations: drawn.current.stations,
          drafts: drawn.current.draft.markers,
          headings: drawn.current.route.headings,
        })
      })
    }
    schedule()
    leaflet.map.on("zoomend moveend", schedule)
    return () => {
      leaflet.map.off("zoomend moveend", schedule)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  })

  return <section ref={container} className="wb-map absolute inset-0 z-0" aria-label="Route map" />
}
