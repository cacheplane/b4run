import { describe, expect, test } from "vitest"
import { dropIndex } from "./drop-index"

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
