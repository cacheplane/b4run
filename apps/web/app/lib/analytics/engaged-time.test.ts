import { describe, expect, it, vi } from "vitest"
import { createEngagedTimeTracker, ENGAGED_TIME_THRESHOLDS_MS } from "./engaged-time"

/**
 * Visible time is the only time that counts: a backgrounded tab accrues wall
 * clock but no engagement. The hidden-time cases are load-bearing.
 */

function setup(startVisible = true) {
  let clock = 1_000
  const onThreshold = vi.fn()
  const engaged = createEngagedTimeTracker({
    onThreshold,
    now: () => clock,
    startVisible,
  })
  return {
    onThreshold,
    engaged,
    advance(ms: number) {
      clock += ms
      engaged.tick()
    },
    advanceWithoutTick(ms: number) {
      clock += ms
    },
  }
}

describe("engaged time thresholds", () => {
  it("exports 10s and 30s, the first matching PostHog bounce cutoff", () => {
    // 10s is not arbitrary: PostHog's bounce test is `session_duration >= 10s`.
    // An event at a genuine 10 visible seconds makes the recorded duration
    // match reality for a reader who never clicks.
    expect(ENGAGED_TIME_THRESHOLDS_MS).toEqual([10_000, 30_000])
  })

  it("fires the first threshold only once ten visible seconds have passed", () => {
    const { advance, onThreshold } = setup()
    advance(9_999)
    expect(onThreshold).not.toHaveBeenCalled()
    advance(1)
    expect(onThreshold).toHaveBeenCalledExactlyOnceWith(10_000)
  })

  it("fires each threshold exactly once, however many times it is ticked", () => {
    const { advance, onThreshold } = setup()
    advance(10_000)
    advance(1_000)
    advance(1_000)
    expect(onThreshold).toHaveBeenCalledExactlyOnceWith(10_000)
  })

  it("fires the second threshold at thirty visible seconds", () => {
    const { advance, onThreshold } = setup()
    advance(30_000)
    expect(onThreshold).toHaveBeenNthCalledWith(1, 10_000)
    expect(onThreshold).toHaveBeenNthCalledWith(2, 30_000)
    expect(onThreshold).toHaveBeenCalledTimes(2)
  })

  it("does not count time while the page is hidden", () => {
    // The honesty test. A backgrounded tab accrues wall-clock time but no
    // engagement; counting it would inflate session duration rather than
    // correct it.
    const { advance, engaged, onThreshold } = setup()
    advance(5_000)
    engaged.setVisible(false)
    advance(60_000)
    expect(onThreshold).not.toHaveBeenCalled()
    expect(engaged.visibleMs()).toBe(5_000)
  })

  it("resumes accumulating when the page becomes visible again", () => {
    const { advance, engaged, onThreshold } = setup()
    advance(6_000)
    engaged.setVisible(false)
    advance(60_000)
    engaged.setVisible(true)
    advance(4_000)
    expect(onThreshold).toHaveBeenCalledExactlyOnceWith(10_000)
    expect(engaged.visibleMs()).toBe(10_000)
  })

  it("keeps time from earlier visible runs across repeated hide/show cycles", () => {
    // One cycle cannot distinguish `accumulatedMs +=` from `accumulatedMs =`,
    // because the accumulator is still zero. Two can.
    const { advance, engaged, onThreshold } = setup()
    advance(4_000)
    engaged.setVisible(false)
    advance(60_000)
    engaged.setVisible(true)
    advance(4_000)
    engaged.setVisible(false)
    advance(60_000)
    engaged.setVisible(true)
    advance(2_000)
    expect(engaged.visibleMs()).toBe(10_000)
    expect(onThreshold).toHaveBeenCalledExactlyOnceWith(10_000)
  })

  it("reports completion only once every threshold has fired", () => {
    const { advance, engaged } = setup()
    advance(10_000)
    expect(engaged.isComplete()).toBe(false)
    advance(20_000)
    expect(engaged.isComplete()).toBe(true)
  })

  it("never fires for a page that starts hidden and is never seen", () => {
    // A prerendered or background-opened tab must not report engagement.
    const { advance, onThreshold, engaged } = setup(false)
    advance(120_000)
    expect(onThreshold).not.toHaveBeenCalled()
    expect(engaged.visibleMs()).toBe(0)
  })

  it("counts time that elapsed between ticks, not tick count", () => {
    // The production caller ticks on an interval; a throttled background
    // timer must not under-report time the page was genuinely visible.
    const { advanceWithoutTick, engaged, onThreshold } = setup()
    advanceWithoutTick(30_000)
    engaged.tick()
    expect(onThreshold).toHaveBeenCalledTimes(2)
  })

  it("does not double count when told it is visible twice", () => {
    const { advance, engaged, onThreshold } = setup()
    advance(5_000)
    engaged.setVisible(true)
    advance(4_999)
    expect(onThreshold).not.toHaveBeenCalled()
    expect(engaged.visibleMs()).toBe(9_999)
  })
})
