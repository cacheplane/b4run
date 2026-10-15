import { describe, expect, it } from "vitest"
import { advisoryLine, readForecast, windsLine } from "./forecast"
import { SAMPLE_NAVLOG } from "./test-fixtures"

const FORECAST = {
  winds: [
    {
      leg: 1,
      station: "PDX",
      altitudeFt: 9500,
      dirDegTrue: 28,
      speedKt: 17,
      tempC: -4,
      forUseFromUtc: "2026-10-12T14:00:00.000Z",
      forUseToUtc: "2026-10-12T21:00:00.000Z",
      covered: true,
    },
  ],
  airports: [],
  advisories: [
    {
      product: "G-AIRMET",
      hazard: "FZLVL",
      lowestFt: 8000,
      highestFt: 8000,
      validFromUtc: "2026-10-12T18:00:00.000Z",
      validToUtc: "2026-10-13T00:00:00.000Z",
      relevance: "during-flight",
    },
  ],
  coverage: { preliminary: false, reasons: [] },
  verdictFloor: {
    level: "CAUTION",
    reasons: ["freezing level 8,000 ft during the flight, below the 9,500 ft cruise"],
  },
  notes: [],
} as const

describe("readForecast", () => {
  it("is the navlog's forecast block, or null for a navlog without one", () => {
    expect(readForecast({ ...SAMPLE_NAVLOG, forecast: FORECAST } as never)).toEqual(FORECAST)
    expect(readForecast(SAMPLE_NAVLOG)).toBeNull()
    expect(readForecast(null)).toBeNull()
  })
  it("rejects a malformed block rather than rendering half of it", () => {
    expect(readForecast({ ...SAMPLE_NAVLOG, forecast: { winds: "no" } } as never)).toBeNull()
  })
})

describe("display lines", () => {
  it("reads one leg's winds", () => {
    expect(windsLine(FORECAST.winds[0])).toBe(
      "leg 1: 028° at 17 kt, −4 °C, 9,500 ft (PDX), for use 1400Z–2100Z",
    )
  })
  it("reads one advisory", () => {
    expect(advisoryLine(FORECAST.advisories[0])).toBe(
      "G-AIRMET FZLVL · 8,000 ft · 1800Z–0000Z · during flight",
    )
  })
})
