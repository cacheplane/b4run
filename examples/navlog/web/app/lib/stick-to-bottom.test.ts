import { describe, expect, test } from "vitest"
import {
  distanceFromBottom,
  isNearBottom,
  nextFollowing,
  STICK_THRESHOLD_PX,
  showJumpToLatest,
} from "./stick-to-bottom"

/** A 600 px viewport over `height` px of content, scrolled to `top`. */
const at = (top: number, height = 6000) => ({
  scrollTop: top,
  scrollHeight: height,
  clientHeight: 600,
})

describe("stick to bottom", () => {
  test("measures the gap below the viewport", () => {
    expect(distanceFromBottom(at(5400))).toBe(0)
    expect(distanceFromBottom(at(5000))).toBe(400)
  })

  test("within the threshold counts as the bottom", () => {
    expect(STICK_THRESHOLD_PX).toBe(80)
    expect(isNearBottom(at(5320))).toBe(true)
    expect(isNearBottom(at(5300))).toBe(false)
  })

  test("content growing under a following reader never stops the follow", () => {
    // The reader was at the bottom of 6,000 px; a tool card added 900 px. No
    // scroll moved, the gap is now 900 px — still following.
    expect(nextFollowing(true, 5400, at(5400, 6900))).toBe(true)
  })

  test("scrolling up stops following; returning to the bottom resumes it", () => {
    expect(nextFollowing(true, 5400, at(5000))).toBe(false)
    expect(nextFollowing(false, 5000, at(5100))).toBe(false)
    expect(nextFollowing(false, 5100, at(5390))).toBe(true)
  })

  test("a smooth jump moving down does not cancel itself half-way", () => {
    expect(nextFollowing(true, 1000, at(3000))).toBe(true)
  })

  test("the pill shows only while not following with something below", () => {
    expect(showJumpToLatest(false, at(1000))).toBe(true)
    expect(showJumpToLatest(true, at(1000))).toBe(false)
    expect(showJumpToLatest(false, at(5400))).toBe(false)
  })
})
