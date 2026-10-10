import { describe, expect, test } from "vitest"
import { type LabelCandidate, placeLabels, type Rect } from "./map-labels"

const rect = (left: number, top: number, width: number, height: number): Rect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
})

/** A 14px dot at (x, y) with a 60×18 label beside it on either side. */
function marker(
  id: string,
  x: number,
  y: number,
  priority: number,
  pinned = false,
): LabelCandidate {
  return {
    id,
    priority,
    dot: rect(x - 7, y - 7, 14, 14),
    right: rect(x + 13, y - 9, 60, 18),
    left: rect(x - 73, y - 9, 60, 18),
    ...(pinned ? { pinned } : {}),
  }
}

describe("placeLabels", () => {
  test("labels with room go right of their dots", () => {
    const placed = placeLabels([marker("KPAO", 100, 100, 0), marker("KSBA", 100, 300, 0)])
    expect([...placed]).toEqual([
      ["KPAO", "right"],
      ["KSBA", "right"],
    ])
  })

  test("a lower-priority label that would collide flips left", () => {
    // KHAF's dot sits just left of KPAO's, so its right-hand label lands on KPAO.
    const placed = placeLabels([marker("KHAF", 60, 100, 2), marker("KPAO", 100, 100, 0)])
    expect(placed.get("KPAO")).toBe("right")
    expect(placed.get("KHAF")).toBe("left")
  })

  test("a label with no room on either side hides, and the higher priority keeps its spot", () => {
    const placed = placeLabels(
      [marker("KPAO", 100, 100, 0), marker("KHAF", 104, 104, 2)],
      // Something already left of KHAF.
      [rect(30, 95, 60, 18)],
    )
    expect(placed.get("KPAO")).toBe("right")
    expect(placed.get("KHAF")).toBe("hidden")
  })

  test("a label never covers the dot of a marker as important as it", () => {
    // KAAA's right-hand label would cover KBBB's dot; both are route waypoints.
    const placed = placeLabels([marker("KAAA", 100, 100, 0), marker("KBBB", 140, 100, 0)])
    expect(placed.get("KAAA")).toBe("left")
  })

  test("a waypoint's label may cover a station's dot beside it, and the station gives way", () => {
    // The Salinas VORTAC and Salinas airport, a few pixels apart.
    const placed = placeLabels([marker("KSNS", 103, 102, 2), marker("SNS", 100, 100, 0)])
    expect(placed.get("SNS")).toBe("right")
    expect(placed.get("KSNS")).not.toBe("right")
  })

  test("obstacles (the heading labels) are never covered", () => {
    const placed = placeLabels([marker("KPAO", 100, 100, 0)], [rect(110, 90, 80, 20)])
    expect(placed.get("KPAO")).toBe("left")
  })

  test("a pinned marker keeps its label even when it collides", () => {
    const placed = placeLabels(
      [marker("KPAO", 100, 100, 0), marker("KHAF", 104, 104, 2, true)],
      [rect(30, 95, 60, 18)],
    )
    expect(placed.get("KHAF")).toBe("right")
  })
})
