import { describe, expect, it } from "vitest"
import { computeNavlog, type NavlogInput } from "../src/lib/navlog.ts"

const base: NavlogInput = {
  aircraft: { tailNumber: "N738ZU", cruiseRpm: 2400, usableFuelGal: 50 },
  altitudeFt: 4500,
  departureTimeUtc: "2026-10-05T14:00:00Z",
  waypoints: [
    {
      id: "KSTP",
      lat: 44.9346,
      lon: -93.0603,
      elevationFt: 215,
      magneticVariationDeg: 0,
      kind: "airport",
    },
    {
      id: "KRST",
      lat: 43.9083,
      lon: -92.49,
      elevationFt: 1317,
      magneticVariationDeg: 0,
      kind: "airport",
    },
  ],
  winds: [{ dirDegTrue: 320, speedKt: 20, tempC: 5 }],
}

describe("computeNavlog", () => {
  it("splits the first leg into a climb segment and a cruise segment", () => {
    const log = computeNavlog(base)
    expect(log.legs.map((leg) => leg.segment)).toEqual(["climb", "cruise"])
    expect(log.legs[0]?.from).toBe("KSTP")
    expect(log.legs[1]?.to).toBe("KRST")
    // Figure 5-6 from KSTP (215 ft: 0 min, 0.1 gal, 0 nm) to 4500 ft (7 min, 1.4 gal, 9 nm):
    // 7 min, 1.3 gal, 9 nm, plus 1.1 gal start/taxi/takeoff on the climb segment.
    expect(log.legs[0]?.distanceNm).toBe(9)
    expect(log.legs[0]?.eteMin).toBe(7)
    expect(log.legs[0]?.fuelGal).toBeCloseTo(2.4, 5)
  })
  it("flies the climb row at the table's zero-wind groundspeed, no wind correction", () => {
    const climb = computeNavlog(base).legs[0]
    expect(climb?.segment).toBe("climb")
    expect(climb?.wca).toBe(0)
    expect(climb?.trueHeading).toBe(climb?.trueCourse)
    expect(climb?.magneticHeading).toBe(climb?.magneticCourse)
    expect(climb?.tasKt).toBe(72)
    expect(climb?.groundspeedKt).toBe(Math.round(9 / (7 / 60)))
    expect(climb?.wind).toEqual({ dir: 320, kt: 20 })
  })
  it("carries the climb into the next leg when the first leg is shorter", () => {
    const fix = {
      id: "FIX6S",
      lat: 44.9346 - 6 / 60,
      lon: -93.0603,
      magneticVariationDeg: 0,
      kind: "fix" as const,
    }
    const [kstp, krst] = base.waypoints
    if (!kstp || !krst) throw new Error("base waypoints")
    const log = computeNavlog({
      ...base,
      altitudeFt: 8500,
      waypoints: [kstp, fix, krst],
      winds: [
        { dirDegTrue: 320, speedKt: 20 },
        { dirDegTrue: 320, speedKt: 20 },
      ],
    })
    // Figure 5-6 from 215 ft to 8500 ft: 16 min, 2.9 gal, 21 nm.
    const climbNm = 21
    expect(log.legs.map((leg) => `${leg.from}-${leg.to}:${leg.segment}`)).toEqual([
      "KSTP-FIX6S:climb",
      "FIX6S-KRST:climb",
      "FIX6S-KRST:cruise",
    ])
    expect(log.legs[0]?.distanceNm).toBe(6)
    expect(log.legs[1]?.distanceNm).toBe(climbNm - 6)
    expect((log.legs[0]?.eteMin ?? 0) + (log.legs[1]?.eteMin ?? 0)).toBe(16)
    expect((log.legs[0]?.fuelGal ?? 0) + (log.legs[1]?.fuelGal ?? 0)).toBeCloseTo(2.9 + 1.1, 5)
    expect(log.totals.eteMin).toBe(log.legs.reduce((sum, leg) => sum + leg.eteMin, 0))
  })
  it("uses the Figure 5-7 cruise row at the pressure altitude and RPM", () => {
    const log = computeNavlog(base)
    expect(log.aircraft.tasKt).toBeCloseTo(109.75, 2) // 4500 ft between 110 (4000) and 109.5 (5000)
    expect(log.aircraft.gph).toBeCloseTo(7.025, 3)
  })
  it("applies the wind triangle to the cruise segment", () => {
    const log = computeNavlog(base)
    const cruise = log.legs[1]
    expect(cruise?.wind).toEqual({ dir: 320, kt: 20 })
    expect(cruise?.groundspeedKt).toBeGreaterThan(cruise?.tasKt ?? 0) // quartering tailwind on a SSE course
    expect(cruise?.wca).toBeGreaterThan(0)
    expect(cruise?.magneticHeading).toBeGreaterThan(cruise?.magneticCourse ?? 0)
  })
  it("accumulates distance, time, fuel and ETA across legs", () => {
    const log = computeNavlog(base)
    const total = log.legs.reduce((sum, leg) => sum + leg.distanceNm, 0)
    expect(log.totals.distanceNm).toBeCloseTo(total, 5)
    expect(log.totals.eteMin).toBe(log.legs.reduce((sum, leg) => sum + leg.eteMin, 0))
    expect(log.legs.at(-1)?.remainingNm).toBe(0)
    expect(log.legs.at(-1)?.fuelRemainingGal).toBeCloseTo(50 - log.totals.fuelGal, 5)
    expect(log.legs[0]?.etaUtc).toBe("2026-10-05T14:07:00.000Z")
  })
  it("reports the reserve in minutes at cruise burn and flags under 45", () => {
    const log = computeNavlog(base)
    expect(log.totals.reserveMin).toBeCloseTo(
      (log.totals.fuelRemainingGal / log.aircraft.gph) * 60,
      5,
    )
    expect(log.totals.reserveOk).toBe(true)
    const thirsty = computeNavlog({ ...base, aircraft: { ...base.aircraft, usableFuelGal: 8 } })
    expect(thirsty.totals.reserveOk).toBe(false)
  })
  it("applies magnetic variation per leg from the departure waypoint of that leg", () => {
    const log = computeNavlog({
      ...base,
      waypoints: [
        { ...base.waypoints[0]!, magneticVariationDeg: 2 },
        { ...base.waypoints[1]!, magneticVariationDeg: -3 },
      ],
    })
    expect(log.legs[0]?.variation).toBe(2)
    expect(log.legs[0]?.magneticCourse).toBeCloseTo(log.legs[0]!.trueCourse - 2, 5)
  })
  it("rejects fewer than two waypoints and a winds array of the wrong length", () => {
    expect(() => computeNavlog({ ...base, waypoints: [base.waypoints[0]!] })).toThrow(
      /at least two waypoints/,
    )
    expect(() => computeNavlog({ ...base, winds: [] })).toThrow(/one wind entry per leg/)
  })
  it("names its POH sources", () => {
    const log = computeNavlog(base)
    expect(log.sources.map((s) => s.figure)).toEqual(["Figure 5-6", "Figure 5-7"])
  })
})
