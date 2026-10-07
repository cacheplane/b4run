import { afterEach, describe, expect, test, vi } from "vitest"
import {
  initialDisclosure,
  isDisclosureOpen,
  observeDisclosure,
  toggleDisclosure,
} from "../../src/view/activity-disclosure.js"
import { CHEVRON_GLYPH, STEP_GLYPHS, stepGlyph } from "../../src/view/activity-glyphs.js"
import { NO_FLASH_MS, noFlashRemaining, sampleElapsed } from "../../src/view/activity-timing.js"

describe("the open/closed rule", () => {
  test("automation decides until the user toggles; the choice holds while the key is unchanged", () => {
    let m = initialDisclosure(true, 100)
    expect(isDisclosureOpen(m, true)).toBe(true)
    m = toggleDisclosure(m, true)
    expect(isDisclosureOpen(m, true)).toBe(false)
    m = observeDisclosure(m, false, 100) // awaiting
    m = observeDisclosure(m, true, 100) // running again, same presentation
    expect(isDisclosureOpen(m, true)).toBe(false)
    m = observeDisclosure(m, true, 200) // re-presented: automation's again
    expect(isDisclosureOpen(m, true)).toBe(true)
  })
  test("without a key, every rise of live clears the choice", () => {
    let m = toggleDisclosure(initialDisclosure(false), false)
    expect(isDisclosureOpen(m, false)).toBe(true)
    m = observeDisclosure(m, true)
    expect(isDisclosureOpen(m, true)).toBe(true)
    m = toggleDisclosure(m, true)
    expect(isDisclosureOpen(m, true)).toBe(false)
    m = observeDisclosure(m, true)
    expect(isDisclosureOpen(m, true)).toBe(false) // still live: no rise
  })
  test("an unchanged observation returns the same memory", () => {
    const m = initialDisclosure(true, 1)
    expect(observeDisclosure(m, true, 1)).toBe(m)
    const settled = initialDisclosure(false, 1)
    expect(observeDisclosure(settled, false, 1)).toBe(settled)
  })
})

describe("clocks", () => {
  afterEach(() => vi.useRealTimers())
  test("noFlashRemaining counts down to zero and stays there", () => {
    expect(noFlashRemaining(1000, 1000)).toBe(NO_FLASH_MS)
    expect(noFlashRemaining(1000, 1200)).toBe(100)
    expect(noFlashRemaining(1000, 1300)).toBe(0)
    expect(noFlashRemaining(1000, 9000)).toBe(0)
  })
  test("sampleElapsed samples at once and then every second until stopped", () => {
    vi.useFakeTimers()
    let clock = 5
    const samples: number[] = []
    const stop = sampleElapsed(
      () => clock,
      (t) => samples.push(t),
    )
    clock = 6
    vi.advanceTimersByTime(1000)
    stop()
    clock = 7
    vi.advanceTimersByTime(3000)
    expect(samples).toEqual([5, 6])
  })
})

describe("glyphs", () => {
  test("unknown names, Object.prototype keys included, draw the tool glyph", () => {
    for (const name of ["nope", "constructor", "toString", undefined]) {
      expect(stepGlyph(name)).toBe(STEP_GLYPHS.tool)
    }
    expect(stepGlyph("search")).toBe(STEP_GLYPHS.search)
    expect(CHEVRON_GLYPH).toHaveLength(1)
  })
})
