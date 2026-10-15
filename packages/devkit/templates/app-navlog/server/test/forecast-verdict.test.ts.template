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
      coverage: {
        preliminary: true,
        reasons: ["the KBDN TAF ends at 1200Z and does not cover the 1315Z ETA"],
      },
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

  it("is CAUTION for IFR or LIFR now at an end when the forecast at the time is not IFR", () => {
    expect(
      verdictFloor({
        ...clean,
        airports: [
          clean.airports[0] as AirportWeather,
          airport({ id: "KBDN", role: "destination", categoryNow: "IFR", categoryAtTime: null }),
        ],
      }),
    ).toEqual({ level: "CAUTION", reasons: ["KBDN IFR now"] })
    expect(
      verdictFloor({
        ...clean,
        airports: [
          clean.airports[0] as AirportWeather,
          airport({ id: "KBDN", role: "destination", categoryNow: "LIFR", categoryAtTime: "VFR" }),
        ],
      }),
    ).toEqual({ level: "CAUTION", reasons: ["KBDN LIFR now"] })
  })

  it("is NO-GO for an origin that is IFR now with no forecast for it, CAUTION for the destination", () => {
    expect(
      verdictFloor({
        ...clean,
        airports: [
          airport({ id: "KPDX", role: "origin", categoryNow: "IFR", categoryAtTime: null }),
          clean.airports[1] as AirportWeather,
        ],
      }),
    ).toEqual({
      level: "NO-GO",
      reasons: ["KPDX IFR now at departure, with no forecast for it"],
    })
    expect(
      verdictFloor({
        ...clean,
        airports: [
          airport({ id: "KPDX", role: "origin", categoryNow: "LIFR", categoryAtTime: "VFR" }),
          clean.airports[1] as AirportWeather,
        ],
      }),
    ).toEqual({ level: "CAUTION", reasons: ["KPDX LIFR now"] })
  })

  it("is NO-GO for icing from the freezing level up to a known top above the cruise", () => {
    expect(
      verdictFloor({
        ...clean,
        advisories: [advisory({ hazard: "ICE", lowestFt: null, highestFt: 16000 })],
      }),
    ).toEqual({
      level: "NO-GO",
      reasons: ["icing freezing level to 16,000 ft during the flight, at the 9,500 ft cruise"],
    })
    expect(
      verdictFloor({
        ...clean,
        advisories: [advisory({ hazard: "ICE", lowestFt: null, highestFt: 8000 })],
      }),
    ).toEqual({
      level: "CAUTION",
      reasons: ["icing freezing level to 8,000 ft during the flight"],
    })
  })

  it("accepts M_FZLVL and M-FZLVL alike", () => {
    for (const hazard of ["M_FZLVL", "M-FZLVL"]) {
      expect(
        verdictFloor({
          ...clean,
          advisories: [advisory({ hazard, lowestFt: 8000, highestFt: 8000 })],
        }).reasons,
      ).toEqual(["freezing level 8,000 ft during the flight, below the 9,500 ft cruise"])
    }
  })

  it("states hazards in plain English, not by code", () => {
    const reasonFor = (over: Partial<AdvisoryFact>) =>
      verdictFloor({ ...clean, advisories: [advisory(over)] }).reasons
    expect(reasonFor({ hazard: "TURB-LO" })).toEqual(["turbulence during the flight"])
    expect(reasonFor({ hazard: "TURB-HI" })).toEqual(["turbulence during the flight"])
    expect(reasonFor({ hazard: "TURB" })).toEqual(["turbulence during the flight"])
    expect(reasonFor({ hazard: "LLWS" })).toEqual(["low-level wind shear during the flight"])
    expect(reasonFor({ hazard: "CONVECTIVE", product: "AIRMET" })).toEqual([
      "convection during the flight",
    ])
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
