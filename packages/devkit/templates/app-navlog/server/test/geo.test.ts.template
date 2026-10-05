import { describe, expect, it } from "vitest"
import { distanceNm, initialTrueCourse, magneticFromTrue } from "../src/lib/geo.ts"

// KSTP 44.9346,-93.0603  KRST 43.9083,-92.4900 (FAA airport records)
const KSTP = { lat: 44.9346, lon: -93.0603 }
const KRST = { lat: 43.9083, lon: -92.49 }

describe("great circle", () => {
  it("measures KSTP to KRST at about 66 nm", () => {
    expect(distanceNm(KSTP, KRST)).toBeCloseTo(66.3, 0)
  })
  it("gives a south-southeast initial true course from KSTP to KRST", () => {
    const tc = initialTrueCourse(KSTP, KRST)
    expect(tc).toBeGreaterThan(155)
    expect(tc).toBeLessThan(160)
  })
  it("is zero distance and course 0 for the same point", () => {
    expect(distanceNm(KSTP, KSTP)).toBe(0)
    expect(initialTrueCourse(KSTP, KSTP)).toBe(0)
  })
  it("normalizes courses into [0, 360)", () => {
    expect(initialTrueCourse({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })).toBeCloseTo(270, 5)
  })
})

describe("magnetic from true", () => {
  it("subtracts east variation and adds west variation", () => {
    expect(magneticFromTrue(100, 5)).toBe(95) // 5E
    expect(magneticFromTrue(100, -5)).toBe(105) // 5W
  })
  it("wraps around north", () => {
    expect(magneticFromTrue(2, 5)).toBe(357)
    expect(magneticFromTrue(358, -5)).toBe(3)
  })
})
