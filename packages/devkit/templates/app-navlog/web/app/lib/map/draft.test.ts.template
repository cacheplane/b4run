import { describe, expect, test } from "vitest"
import type { DraftWaypoint } from "../route-draft"
import type { RouteGeometry } from "../route-geometry"
import { draftBounds, draftMatchesPlan } from "./draft"

const waypoint = (id: string, lat: number, lon: number): DraftWaypoint => ({
  id,
  kind: "airport",
  type: "airport",
  lat,
  lon,
})

const KSTP = waypoint("KSTP", 44.93, -93.06)
const KRST = waypoint("KRST", 43.91, -92.5)
const KLSE = waypoint("KLSE", 43.88, -91.26)

/** A planned route through `ids`; only its markers' ids matter here. */
const plan = (...ids: string[]): RouteGeometry => ({
  polyline: [],
  markers: ids.map((id) => ({ id, at: [0, 0], kind: "airport" })),
  legLabels: [],
  bounds: [
    [0, 0],
    [0, 0],
  ],
})

describe("draftMatchesPlan", () => {
  test("the plan's ids in the plan's order match", () => {
    expect(draftMatchesPlan([KSTP, KRST], plan("KSTP", "KRST"))).toBe(true)
  })
  test("a reordered, longer or shorter draft does not", () => {
    expect(draftMatchesPlan([KRST, KSTP], plan("KSTP", "KRST"))).toBe(false)
    expect(draftMatchesPlan([KSTP, KRST, KLSE], plan("KSTP", "KRST"))).toBe(false)
    expect(draftMatchesPlan([KSTP], plan("KSTP", "KRST"))).toBe(false)
  })
  test("with no plan, nothing matches", () => {
    expect(draftMatchesPlan([KSTP, KRST], null)).toBe(false)
  })
})

describe("draftBounds", () => {
  test("two waypoints or more give the box around them, south-west then north-east", () => {
    expect(draftBounds([KSTP, KRST, KLSE])).toEqual([
      [43.88, -93.06],
      [44.93, -91.26],
    ])
  })
  test("fewer than two give no box", () => {
    expect(draftBounds([KSTP])).toBeNull()
    expect(draftBounds([])).toBeNull()
  })
})
