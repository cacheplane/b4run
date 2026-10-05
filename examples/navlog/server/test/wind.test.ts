import { describe, expect, it } from "vitest"
import { solveWindTriangle } from "../src/lib/wind.ts"

describe("wind triangle", () => {
  it("direct headwind slows groundspeed with no correction angle", () => {
    const r = solveWindTriangle({ trueCourse: 360, tasKt: 110, windDirTrue: 360, windKt: 20 })
    expect(r.windCorrectionAngle).toBeCloseTo(0, 5)
    expect(r.trueHeading).toBeCloseTo(0, 5)
    expect(r.groundspeedKt).toBeCloseTo(90, 5)
  })
  it("direct tailwind speeds groundspeed with no correction angle", () => {
    const r = solveWindTriangle({ trueCourse: 90, tasKt: 110, windDirTrue: 270, windKt: 20 })
    expect(r.windCorrectionAngle).toBeCloseTo(0, 5)
    expect(r.groundspeedKt).toBeCloseTo(130, 5)
  })
  it("direct crosswind from the right needs a right correction", () => {
    const r = solveWindTriangle({ trueCourse: 360, tasKt: 100, windDirTrue: 90, windKt: 20 })
    expect(r.windCorrectionAngle).toBeCloseTo(11.54, 1)
    expect(r.trueHeading).toBeCloseTo(11.54, 1)
    expect(r.groundspeedKt).toBeCloseTo(97.98, 1)
  })
  it("direct crosswind from the left needs a left correction", () => {
    const r = solveWindTriangle({ trueCourse: 360, tasKt: 100, windDirTrue: 270, windKt: 20 })
    expect(r.windCorrectionAngle).toBeCloseTo(-11.54, 1)
    expect(r.trueHeading).toBeCloseTo(348.46, 1)
  })
  it("calm wind leaves everything as is", () => {
    const r = solveWindTriangle({ trueCourse: 200, tasKt: 110, windDirTrue: 0, windKt: 0 })
    expect(r.windCorrectionAngle).toBe(0)
    expect(r.trueHeading).toBe(200)
    expect(r.groundspeedKt).toBe(110)
  })
  it("throws when the wind exceeds TAS so no solution exists", () => {
    expect(() =>
      solveWindTriangle({ trueCourse: 360, tasKt: 50, windDirTrue: 90, windKt: 60 }),
    ).toThrow(/exceeds true airspeed/)
  })
})
