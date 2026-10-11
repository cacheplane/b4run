import type { Map as LeafletMap, Marker, Polyline } from "leaflet"
import { describe, expect, test } from "vitest"
import { applyHighlight, isAnimating, removeDraft, removeRoute, removeStations } from "./layers"

/**
 * Stand-ins for Leaflet layers that record what was done to them. Drawing is
 * covered by `RouteMap.test.tsx`, over a fake Leaflet module; these are the
 * helpers that only touch layers already drawn.
 */
function fakeLayer() {
  const layer = {
    removed: false,
    opacity: undefined as number | undefined,
    remove() {
      layer.removed = true
      return layer
    },
    setStyle(style: { opacity: number }) {
      layer.opacity = style.opacity
      return layer
    },
  }
  return layer
}
type FakeLayer = ReturnType<typeof fakeLayer>
const asPolylines = (layers: FakeLayer[]) => layers as unknown as Polyline[]
const asMarker = (layer: FakeLayer) => layer as unknown as Marker
const asMap = (internal: object) => internal as unknown as LeafletMap

describe("applyHighlight", () => {
  test("lights the selected segment and hides the others", () => {
    const segments = [fakeLayer(), fakeLayer(), fakeLayer()]
    applyHighlight(asPolylines(segments), 1)
    expect(segments.map((s) => s.opacity)).toEqual([0, 0.7, 0])
  })
  test("null hides every segment", () => {
    const segments = [fakeLayer(), fakeLayer()]
    applyHighlight(asPolylines(segments), null)
    expect(segments.map((s) => s.opacity)).toEqual([0, 0])
  })
})

describe("removing layers", () => {
  test("removeRoute takes off the line, segments, headings and waypoint markers", () => {
    const all = [fakeLayer(), fakeLayer(), fakeLayer(), fakeLayer()]
    const [line, segment, heading, waypoint] = all as [FakeLayer, FakeLayer, FakeLayer, FakeLayer]
    removeRoute({
      route: asPolylines([line]),
      segments: asPolylines([segment]),
      headings: asPolylines([heading]),
      waypoints: [{ id: "KSTP", marker: asMarker(waypoint), interactive: true }],
    })
    expect(all.every((layer) => layer.removed)).toBe(true)
  })
  test("removeStations and removeDraft take off every marker and line they were given", () => {
    const station = fakeLayer()
    const line = fakeLayer()
    const dot = fakeLayer()
    removeStations([{ id: "KOWA", marker: asMarker(station), interactive: true }])
    removeDraft({ line: asPolylines([line]), markers: [asMarker(dot)] })
    expect([station, line, dot].every((layer) => layer.removed)).toBe(true)
  })
})

describe("isAnimating", () => {
  test("reads Leaflet's internal zoom and pan flags", () => {
    expect(isAnimating(asMap({}))).toBe(false)
    expect(isAnimating(asMap({ _animatingZoom: true }))).toBe(true)
    expect(isAnimating(asMap({ _panAnim: { _inProgress: true } }))).toBe(true)
    expect(isAnimating(asMap({ _animatingZoom: false, _panAnim: { _inProgress: false } }))).toBe(
      false,
    )
  })
})
