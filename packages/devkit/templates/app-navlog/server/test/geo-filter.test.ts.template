import { describe, expect, it } from "vitest"
import { withinBoundingBox } from "../src/lib/geo-filter.ts"

// A one-degree square advisory area over southern Minnesota.
const AREA = [
  { lat: 44.0, lon: -94.0 },
  { lat: 45.0, lon: -94.0 },
  { lat: 45.0, lon: -93.0 },
  { lat: 44.0, lon: -93.0 },
]

describe("withinBoundingBox", () => {
  it("includes a point inside the polygon's box", () => {
    expect(withinBoundingBox({ lat: 44.5, lon: -93.5 }, AREA)).toBe(true)
  })

  it("includes a point on the box's edge", () => {
    expect(withinBoundingBox({ lat: 45.0, lon: -93.0 }, AREA, 0)).toBe(true)
  })

  it("includes a point outside the box but within the default half-degree pad", () => {
    expect(withinBoundingBox({ lat: 45.4, lon: -92.6 }, AREA)).toBe(true)
  })

  it("excludes a point past the pad on any side", () => {
    expect(withinBoundingBox({ lat: 45.6, lon: -93.5 }, AREA)).toBe(false)
    expect(withinBoundingBox({ lat: 43.4, lon: -93.5 }, AREA)).toBe(false)
    expect(withinBoundingBox({ lat: 44.5, lon: -92.4 }, AREA)).toBe(false)
    expect(withinBoundingBox({ lat: 44.5, lon: -94.6 }, AREA)).toBe(false)
  })

  it("honors a custom pad, including none", () => {
    const point = { lat: 45.2, lon: -93.5 }
    expect(withinBoundingBox(point, AREA, 0)).toBe(false)
    expect(withinBoundingBox(point, AREA, 0.25)).toBe(true)
  })

  it("treats a single coordinate as a point padded on every side", () => {
    const station = [{ lat: 44.9346, lon: -93.0603 }]
    expect(withinBoundingBox({ lat: 45.3, lon: -93.4 }, station)).toBe(true)
    expect(withinBoundingBox({ lat: 45.5, lon: -93.0603 }, station)).toBe(false)
  })

  it("never matches an advisory with no coordinates", () => {
    expect(withinBoundingBox({ lat: 44.5, lon: -93.5 }, [])).toBe(false)
  })
})
