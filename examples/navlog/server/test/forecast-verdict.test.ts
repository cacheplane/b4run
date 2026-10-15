import { describe, expect, it } from "vitest"
import type { AdvisoryFact, AirportWeather } from "../src/lib/forecast/types.ts"
import { verdictFloor } from "../src/lib/forecast/verdict.ts"

const airport = (
  over: Partial<AirportWeather> & Pick<AirportWeather, "id" | "role">,
): AirportWeather => ({
  alongNm: 0,
  atUtc: "2026-10-12T20:00:00.000Z",
  metar: null,
  taf: null,
  categoryNow: "VFR",
  categoryAtTime: "VFR",
  gustKt: null,
  ...over,
})
const advisory = (over: Partial<AdvisoryFact>): AdvisoryFact => ({
  product: "G-AIRMET",
  hazard: "TURB-LO",
  lowestFt: 0,
  highestFt: 12000,
  validFromUtc: null,
  validToUtc: null,
  relevance: "during-flight",
  ...over,
})
const clean = {
  airports: [airport({ id: "KPDX", role: "origin" }), airport({ id: "KBDN", role: "destination" })],
  advisories: [],
  coverage: { preliminary: false, reasons: [] },
  cruiseFt: 9500,
  reserveMin: 390,
  reserveOk: true,
}

describe("verdictFloor", () => {
  it("is GO with no reasons for a clean flight", () => {
    expect(verdictFloor(clean)).toEqual({ level: "GO", reasons: [] })
  })

  it("is NO-GO for IFR at the destination at the ETA, and for a short reserve", () => {
    const out = verdictFloor({
      ...clean,
      airports: [
        clean.airports[0] as AirportWeather,
        airport({ id: "KBDN", role: "destination", categoryAtTime: "IFR" }),
      ],
      reserveMin: 38,
      reserveOk: false,
    })
    expect(out).toEqual({
      level: "NO-GO",
      reasons: ["KBDN IFR at ETA", "reserve 38 min, under 45"],
    })
  })

  it("is NO-GO for a convective SIGMET or icing at the cruise during the flight", () => {
    expect(
      verdictFloor({
        ...clean,
        advisories: [advisory({ product: "SIGMET", hazard: "CONVECTIVE" })],
      }).level,
    ).toBe("NO-GO")
    expect(
      verdictFloor({
        ...clean,
        advisories: [advisory({ hazard: "ICE", lowestFt: 8000, highestFt: 14000 })],
      }).reasons,
    ).toEqual(["icing 8,000–14,000 ft during the flight, at the 9,500 ft cruise"])
  })

  it("is CAUTION for icing that does not reach the cruise, or at an altitude it does not give", () => {
    expect(
      verdictFloor({
        ...clean,
        advisories: [advisory({ hazard: "ICE", lowestFt: 12000, highestFt: 16000 })],
      }).level,
    ).toBe("CAUTION")
    expect(
      verdictFloor({
        ...clean,
        advisories: [advisory({ hazard: "ICE", lowestFt: null, highestFt: null })],
      }).level,
    ).toBe("CAUTION")
  })

  it("is CAUTION for a freezing level within 2,000 ft of the cruise, not for one far above it", () => {
    expect(
      verdictFloor({
        ...clean,
        advisories: [advisory({ hazard: "FZLVL", lowestFt: 8000, highestFt: 8000 })],
      }).reasons,
    ).toEqual(["freezing level 8,000 ft during the flight, below the 9,500 ft cruise"])
    expect(
      verdictFloor({
        ...clean,
        advisories: [advisory({ hazard: "FZLVL", lowestFt: 14000, highestFt: 14000 })],
      }).level,
    ).toBe("GO")
  })

  it("is CAUTION for MVFR at an end, an en-route station worse than VFR, a gust, or a preliminary forecast", () => {
    const out = verdictFloor({
      ...clean,
      airports: [
        airport({ id: "KPDX", role: "origin", categoryNow: "MVFR" }),
        airport({ id: "KS33", role: "en-route", categoryAtTime: null, categoryNow: "IFR" }),
        airport({ id: "KBDN", role: "destination", gustKt: 25 }),
      ],
      coverage: { preliminary: true, reasons: ["the KBDN TAF ends 1200Z, before the 1315Z ETA"] },
    })
    expect(out).toEqual({
      level: "CAUTION",
      reasons: [
        "KPDX MVFR now",
        "KS33 IFR en route",
        "gusts 25 kt at KBDN",
        "forecast preliminary",
      ],
    })
  })

  it("ignores advisories outside the flight window", () => {
    expect(
      verdictFloor({
        ...clean,
        advisories: [
          advisory({ product: "SIGMET", hazard: "CONVECTIVE", relevance: "after-arrival" }),
        ],
      }).level,
    ).toBe("GO")
  })
})
