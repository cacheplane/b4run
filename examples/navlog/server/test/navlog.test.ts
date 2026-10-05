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
      elevationFt: 705,
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
    // Figure 5-6 from KSTP (705 ft: 1 min, 0.2 gal, 1 nm) to 4500 ft (7 min, 1.4 gal, 9 nm):
    // 6 min, 1.2 gal, 8 nm, plus 1.1 gal start/taxi/takeoff on the climb segment.
    expect(log.legs[0]?.distanceNm).toBe(8)
    expect(log.legs[0]?.eteMin).toBe(6)
    expect(log.legs[0]?.fuelGal).toBeCloseTo(2.3, 5)
  })
  it("flies the climb row at the table's zero-wind groundspeed, no wind correction", () => {
    const climb = computeNavlog(base).legs[0]
    expect(climb?.segment).toBe("climb")
    expect(climb?.wca).toBe(0)
    expect(climb?.trueHeading).toBe(climb?.trueCourse)
    expect(climb?.magneticHeading).toBe(climb?.magneticCourse)
    expect(climb?.tasKt).toBe(72)
    expect(climb?.groundspeedKt).toBe(Math.round(8 / (6 / 60)))
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
    // Figure 5-6 from 705 ft (1 min, 0.2 gal, 1 nm) to 8500 ft (16 min, 3.0 gal, 21 nm):
    // 15 min, 2.8 gal, 20 nm.
    const climbNm = 20
    expect(log.legs.map((leg) => `${leg.from}-${leg.to}:${leg.segment}`)).toEqual([
      "KSTP-FIX6S:climb",
      "FIX6S-KRST:climb",
      "FIX6S-KRST:cruise",
    ])
    expect(log.legs[0]?.distanceNm).toBe(6)
    expect(log.legs[1]?.distanceNm).toBe(climbNm - 6)
    expect((log.legs[0]?.eteMin ?? 0) + (log.legs[1]?.eteMin ?? 0)).toBe(15)
    expect((log.legs[0]?.fuelGal ?? 0) + (log.legs[1]?.fuelGal ?? 0)).toBeCloseTo(2.8 + 1.1, 5)
    expect(log.totals.eteMin).toBe(log.legs.reduce((sum, leg) => sum + leg.eteMin, 0))
  })
  it("drops a climb sliver that rounds to nothing instead of printing a zero row", () => {
    // A field at sea level climbs to 8500 ft in 16 min, 3.0 gal, 21 nm (Figure 5-6);
    // a first leg of 20.7 nm leaves 0.3 nm of climb, which rounds to 0 nm, 0 min, 0.0 gal.
    const [kstp, krst] = base.waypoints
    if (!kstp || !krst) throw new Error("base waypoints")
    const seaLevelField = { ...kstp, elevationFt: 0 }
    const fix = {
      id: "FIX21S",
      lat: kstp.lat - 20.7 / (3440.065 * (Math.PI / 180)),
      lon: kstp.lon,
      magneticVariationDeg: 0,
      kind: "fix" as const,
    }
    const log = computeNavlog({
      ...base,
      altitudeFt: 8500,
      waypoints: [seaLevelField, fix, krst],
      winds: [
        { dirDegTrue: 320, speedKt: 20 },
        { dirDegTrue: 320, speedKt: 20 },
      ],
    })
    expect(log.legs.map((leg) => `${leg.from}-${leg.to}:${leg.segment}`)).toEqual([
      "KSTP-FIX21S:climb",
      "FIX21S-KRST:cruise",
    ])
    expect(log.legs[0]?.distanceNm).toBe(21)
    for (const leg of log.legs) {
      expect(leg.distanceNm + leg.eteMin + leg.fuelGal).toBeGreaterThan(0)
    }
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
    expect(log.legs[0]?.etaUtc).toBe("2026-10-05T14:06:00.000Z")
  })
  it("reports the reserve in minutes at cruise burn and flags under 45", () => {
    const log = computeNavlog(base)
    expect(log.totals.reserveMin).toBe(
      Math.round((log.totals.fuelRemainingGal / log.aircraft.gph) * 60),
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
  it("rejects a departure time that is not an ISO 8601 UTC instant", () => {
    for (const departureTimeUtc of ["1500Z tomorrow", "2026-10-06T09:00:00-05:00", "2026-10-06"]) {
      expect(() => computeNavlog({ ...base, departureTimeUtc })).toThrow(
        `departureTimeUtc must be an ISO 8601 UTC instant such as 2026-10-06T14:00:00Z or a UTC time such as 1400Z, got "${departureTimeUtc}"`,
      )
    }
  })
  it("resolves a 1400Z departure to its next occurrence from now", () => {
    const now = () => Date.parse("2026-10-06T15:00:00Z")
    const log = computeNavlog({ ...base, departureTimeUtc: "1400Z" }, now)
    expect(log.departureTimeUtc).toBe("2026-10-07T14:00:00.000Z")
    expect(log.legs[0]?.etaUtc).toBe("2026-10-07T14:06:00.000Z")
  })
  it("names its POH sources", () => {
    const log = computeNavlog(base)
    expect(log.sources.map((s) => s.figure)).toEqual(["Figure 5-6", "Figure 5-7"])
  })
})
