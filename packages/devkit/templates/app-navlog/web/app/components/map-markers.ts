import type { DivIcon } from "leaflet"
import type { FlightCategory } from "../lib/weather-selectors"

/**
 * The route map's Leaflet div icons, built as HTML strings. Every color comes
 * from a class or a `data-` attribute that `theme.css` styles, so restyling a
 * marker never needs a redraw. Takes the Leaflet module as an argument because
 * `RouteMap` imports Leaflet lazily, in the browser only.
 */

type LeafletModule = typeof import("leaflet")

/** Escapes text for the icons' HTML strings. */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * A planned waypoint's dot, in px. One airport is one marker: the dot and its
 * label are a single div icon anchored on the dot's center, and the icon's
 * size is the dot's (Leaflet's default 12×12 box would put the label's
 * rounded border around nothing beside the dot).
 */
const WAYPOINT_SIZE = 14
/** Stations and draft waypoints: a smaller dot, so the planned route's airports lead. */
const SMALL_SIZE = 10

/**
 * `waypoint`: a planned waypoint, its dot colored by category. `station`: a
 * reporting station near the course, a grey dot (it is not on the route) with
 * the category in its label. `draft`: a route-bar waypoint not yet planned.
 */
export type MarkerVariant = "waypoint" | "station" | "draft"

/**
 * A marker's icon: its dot and its label. The category rides on `data-cat`,
 * so `theme.css` colors a waypoint's dot from the tokens.
 */
export function waypointIcon(
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

/** A leg's heading pill. Zero-size and centered by CSS, so it sits on the leg's midpoint. */
export function headingIcon(L: LeafletModule, text: string): DivIcon {
  return L.divIcon({
    className: "wb-hdg",
    html: `<span class="wb-hdg-label">${escapeHtml(text)}</span>`,
    iconSize: [0, 0],
  })
}

/** Marker options for an airport or station: a keyboard-focusable button named by its id. */
export const interactiveOptions = (id: string) =>
  ({ interactive: true, keyboard: true, title: id, alt: id, riseOnHover: true }) as const
