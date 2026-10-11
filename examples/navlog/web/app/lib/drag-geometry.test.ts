import { describe, expect, test } from "vitest"
import { dropIndex, EDGE_PX, edgeScrollSpeed, MAX_SCROLL_PX } from "./drag-geometry"

// Three pills with middles at 50, 150 and 250.
const CENTERS = [50, 150, 250]

describe("dropIndex", () => {
  test("a pill dropped near where it started stays put", () => {
    expect(dropIndex(140, CENTERS, 1)).toBe(1)
    expect(dropIndex(160, CENTERS, 1)).toBe(1)
  })

  test("past a neighbour's middle, the pill takes its place", () => {
    expect(dropIndex(40, CENTERS, 1)).toBe(0)
    expect(dropIndex(260, CENTERS, 1)).toBe(2)
  })

  test("the first pill dragged to the end lands last", () => {
    expect(dropIndex(400, CENTERS, 0)).toBe(2)
  })

  test("the last pill dragged before the start lands first", () => {
    expect(dropIndex(-20, CENTERS, 2)).toBe(0)
  })
})

describe("edgeScrollSpeed", () => {
  // A row from x = 100 to x = 500.
  const speed = (x: number): number => edgeScrollSpeed(x, 100, 500)

  test("the middle of the row does not scroll", () => {
    expect(speed(300)).toBe(0)
    expect(speed(100 + EDGE_PX)).toBe(0)
    expect(speed(500 - EDGE_PX)).toBe(0)
  })

  test("near an end it scrolls toward that end, faster the closer the pointer", () => {
    expect(speed(110)).toBeLessThan(0)
    expect(speed(490)).toBeGreaterThan(0)
    expect(Math.abs(speed(105))).toBeGreaterThan(Math.abs(speed(120)))
  })

  test("at or past an end it scrolls at full speed", () => {
    expect(speed(100)).toBe(-MAX_SCROLL_PX)
    expect(speed(40)).toBe(-MAX_SCROLL_PX)
    expect(speed(500)).toBe(MAX_SCROLL_PX)
    expect(speed(900)).toBe(MAX_SCROLL_PX)
  })

  test("a narrow row keeps a middle where it does not scroll", () => {
    expect(edgeScrollSpeed(130, 100, 160)).toBe(0)
    expect(edgeScrollSpeed(100, 100, 100)).toBe(0)
  })
})
