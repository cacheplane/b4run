import { describe, expect, it } from "vitest"
import {
  type AirportWeather,
  advisoryLine,
  airportWeatherFor,
  categoriesById,
  readForecast,
  windsLine,
} from "./forecast"
import { SAMPLE_FORECAST, SAMPLE_NAVLOG } from "./test-fixtures"

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
  it("rejects a verdict floor whose level is not GO, CAUTION or NO-GO, or without reasons", () => {
    const withFloor = (verdictFloor: unknown) =>
      readForecast({ ...SAMPLE_NAVLOG, forecast: { ...FORECAST, verdictFloor } } as never)
    expect(withFloor({ level: "NO-GO", reasons: ["x"] })).not.toBeNull()
    expect(withFloor({ level: "MAYBE", reasons: [] })).toBeNull()
    expect(withFloor({ level: "go", reasons: [] })).toBeNull()
    expect(withFloor({ reasons: [] })).toBeNull()
    expect(withFloor({ level: "GO" })).toBeNull()
    expect(withFloor({ level: "GO", reasons: "none" })).toBeNull()
  })
})

describe("an out-and-back's shared id", () => {
  const [origin, , destination] = SAMPLE_FORECAST.airports as readonly AirportWeather[]
  const outAndBack = (departure: AirportWeather["categoryAtTime"], arrival: typeof departure) => ({
    ...SAMPLE_FORECAST,
    airports: [
      { ...(origin as AirportWeather), id: "KPDX", categoryAtTime: departure },
      { ...(destination as AirportWeather), id: "KPDX", categoryAtTime: arrival },
    ],
  })
  it("shows the worse of the two entries, whichever end it is", () => {
    const later = outAndBack("VFR", "IFR")
    expect(airportWeatherFor(later, "kpdx")).toBe(later.airports[1])
    expect(categoriesById(later)).toEqual({ KPDX: "IFR" })
    const earlier = outAndBack("MVFR", "VFR")
    expect(airportWeatherFor(earlier, "KPDX")).toBe(earlier.airports[0])
    expect(categoriesById(earlier)).toEqual({ KPDX: "MVFR" })
  })
  it("keeps the first entry when they tie, and a known category over an unknown one", () => {
    const tie = outAndBack("VFR", "VFR")
    expect(airportWeatherFor(tie, "KPDX")).toBe(tie.airports[0])
    const unknown = {
      ...SAMPLE_FORECAST,
      airports: [
        { ...(origin as AirportWeather), id: "KPDX", categoryNow: null, categoryAtTime: null },
        { ...(destination as AirportWeather), id: "KPDX", categoryAtTime: "VFR" as const },
      ],
    }
    expect(airportWeatherFor(unknown, "KPDX")).toBe(unknown.airports[1])
    expect(airportWeatherFor(null, "KPDX")).toBeNull()
    expect(airportWeatherFor(unknown, "KBDN")).toBeNull()
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
