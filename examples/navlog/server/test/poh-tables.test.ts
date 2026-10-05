import { describe, expect, it } from "vitest"
import {
  climbFromSeaLevel,
  cruiseAt,
  landingDistance,
  takeoffDistance,
} from "../src/lib/poh-tables.ts"

describe("cruise performance (Figure 5-7)", () => {
  it("returns the table row at a listed altitude and RPM, standard temperature", () => {
    expect(cruiseAt({ pressureAltitudeFt: 4000, rpm: 2400 })).toEqual({
      bhpPct: 64,
      tasKt: 110,
      gph: 7.1,
    })
  })
  it("interpolates between altitude rows", () => {
    const r = cruiseAt({ pressureAltitudeFt: 5000, rpm: 2400 })
    expect(r.tasKt).toBeCloseTo(109.5, 5)
    expect(r.gph).toBeCloseTo(6.95, 5)
  })
  it("uses the 20 °C above column when asked", () => {
    expect(cruiseAt({ pressureAltitudeFt: 2000, rpm: 2300, temperature: "above" })).toEqual({
      bhpPct: 56,
      tasKt: 105,
      gph: 6.3,
    })
  })
  it("rejects a pressure altitude outside the table instead of clamping", () => {
    expect(() => cruiseAt({ pressureAltitudeFt: 1500, rpm: 2400 })).toThrow(
      "cruise table covers 2000 to 12,000 ft pressure altitude (Figure 5-7)",
    )
  })
  it("rejects an RPM the table does not list at that altitude", () => {
    expect(() => cruiseAt({ pressureAltitudeFt: 2000, rpm: 2600 })).toThrow(/not listed/)
  })
  it("rejects a setting the table marks unavailable", () => {
    expect(() => cruiseAt({ pressureAltitudeFt: 2000, rpm: 2500, temperature: "below" })).toThrow(
      /not available/,
    )
  })
})

describe("time, fuel and distance to climb (Figure 5-6)", () => {
  it("reads a listed altitude", () => {
    expect(climbFromSeaLevel(4000)).toEqual({ timeMin: 6, fuelGal: 1.2, distanceNm: 8 })
  })
  it("interpolates between rows", () => {
    expect(climbFromSeaLevel(4500)).toEqual({ timeMin: 7, fuelGal: 1.4, distanceNm: 9 })
  })
  it("is zero at sea level and rejects above the table", () => {
    expect(climbFromSeaLevel(0)).toEqual({ timeMin: 0, fuelGal: 0, distanceNm: 0 })
    expect(() => climbFromSeaLevel(13000)).toThrow(/above 12,000/)
  })
})

describe("takeoff and landing (Figures 5-4 and 5-10)", () => {
  it("reads takeoff distance at 1000 ft and 20 °C", () => {
    expect(takeoffDistance({ pressureAltitudeFt: 1000, temperatureC: 20 })).toEqual({
      groundRollFt: 915,
      over50FtFt: 1630,
    })
  })
  it("interpolates takeoff distance across temperature", () => {
    expect(takeoffDistance({ pressureAltitudeFt: 0, temperatureC: 5 })).toEqual({
      groundRollFt: 748,
      over50FtFt: 1345,
    })
  })
  it("reads landing distance at 2000 ft and 10 °C", () => {
    expect(landingDistance({ pressureAltitudeFt: 2000, temperatureC: 10 })).toEqual({
      groundRollFt: 550,
      over50FtFt: 1300,
    })
  })
})
