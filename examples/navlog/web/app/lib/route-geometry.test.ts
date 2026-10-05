import { describe, expect, test } from "vitest"
import { type NavlogLeg, SAMPLE_NAVLOG } from "./navlog-types"
import { pairIndexOf, routeGeometry } from "./route-geometry"

describe("routeGeometry", () => {
  test("one marker per waypoint and one polyline through them", () => {
    const g = routeGeometry(SAMPLE_NAVLOG)
    expect(g.markers.map((m) => m.id)).toEqual(["KSTP", "KRST"])
    expect(g.polyline).toEqual([
      [44.9346, -93.0603],
      [43.9083, -92.49],
    ])
  })
  test("one heading label per leg pair at the leg midpoint, climb and cruise merged", () => {
    const g = routeGeometry(SAMPLE_NAVLOG)
    // The fixture's climb segment flies MH 158; the label shows the cruise segment's MH 161.
    expect(g.legLabels).toEqual([
      { from: "KSTP", to: "KRST", at: [44.42145, -92.77515], text: "MH 161°" },
    ])
  })
  test("bounds cover every waypoint", () => {
    const g = routeGeometry(SAMPLE_NAVLOG)
    expect(g.bounds).toEqual([
      [43.9083, -93.0603],
      [44.9346, -92.49],
    ])
  })
})

describe("pairIndexOf", () => {
  test("the climb and cruise rows of one waypoint pair map to that pair", () => {
    expect(pairIndexOf(SAMPLE_NAVLOG, 0)).toBe(0)
    expect(pairIndexOf(SAMPLE_NAVLOG, 1)).toBe(0)
  })
  test("a route that returns to its origin counts pairs, not waypoint ids", () => {
    const [climb, cruise] = SAMPLE_NAVLOG.legs as [NavlogLeg, NavlogLeg]
    const back = { ...cruise, from: "KRST", to: "KSTP" }
    const roundTrip = { ...SAMPLE_NAVLOG, legs: [climb, cruise, back] }
    expect(pairIndexOf(roundTrip, 2)).toBe(1)
  })
})
