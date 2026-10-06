import type { B4ToolContext } from "@b4run/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import { awc } from "../src/lib/awc.ts"
import getAdvisories from "../src/tools/getAdvisories.ts"
import getMetar from "../src/tools/getMetar.ts"
import getWindsAloft from "../src/tools/getWindsAloft.ts"
import lookupAirport from "../src/tools/lookupAirport.ts"

const ctx = { signal: new AbortController().signal } as unknown as B4ToolContext
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
const text = (body: string): Response => new Response(body, { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
  // The tools share one client whose cache is keyed by URL; one test's stubbed
  // response must not answer the next test's request.
  awc.clearCache()
})

describe("lookupAirport", () => {
  it("returns the fields the planner needs from the FAA record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json([
          {
            icaoId: "KSTP",
            name: "ST PAUL/ST PAUL DOWNTOWN HOLMAN FLD ",
            state: "MN",
            lat: 44.9346,
            lon: -93.0603,
            elev: 215, // meters
            magdec: "01E",
            freqs: "ATIS,118.35;LCL/P,119.1",
            runways: [{ id: "14/32", dimension: "6491x150", surface: "A", alignment: 146 }],
          },
        ]),
      ),
    )
    const airport = await lookupAirport({ id: "kstp" }, ctx)
    expect(airport).toEqual({
      id: "KSTP",
      name: "St Paul/St Paul Downtown Holman Fld",
      state: "MN",
      lat: 44.9346,
      lon: -93.0603,
      elevationFt: 705,
      magneticVariationDeg: 1,
      frequencies: [
        { name: "ATIS", mhz: "118.35" },
        { name: "LCL/P", mhz: "119.1" },
      ],
      runways: [{ id: "14/32", lengthFt: 6491, widthFt: 150, surface: "A", alignmentDeg: 146 }],
    })
  })
  it("reads west variation as negative and rejects an unknown id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json([{ icaoId: "KRST", lat: 43.9, lon: -92.5, elev: 401, magdec: "02W", runways: [] }]),
      ),
    )
    const krst = await lookupAirport({ id: "KRST" }, ctx)
    expect(krst.magneticVariationDeg).toBe(-2)
    expect(krst.elevationFt).toBe(1316) // 401 m
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json([])),
    )
    await expect(lookupAirport({ id: "ZZZZ" }, ctx)).rejects.toThrow(/no airport record for ZZZZ/)
  })
})

describe("getMetar", () => {
  it("returns category, wind, visibility, ceiling and the raw text per station", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json([
          {
            icaoId: "KRST",
            reportTime: "2026-10-04T03:00:00.000Z",
            temp: 15.6,
            dewp: 9.4,
            wdir: 260,
            wspd: 11,
            visib: 9,
            altim: 1019.4,
            rawOb: "METAR KRST 040254Z 26011KT 9SM OVC085 16/09 A3010",
            clouds: [{ cover: "OVC", base: 8500 }],
            fltCat: "VFR",
          },
        ]),
      ),
    )
    const out = await getMetar({ ids: ["KRST"] }, ctx)
    expect(out).toEqual([
      {
        id: "KRST",
        observedAt: "2026-10-04T03:00:00.000Z",
        flightCategory: "VFR",
        windDirDeg: 260,
        windKt: 11,
        visibilityMi: 9,
        ceilingFt: 8500,
        tempC: 15.6,
        dewpointC: 9.4,
        altimeterHpa: 1019.4,
        raw: "METAR KRST 040254Z 26011KT 9SM OVC085 16/09 A3010",
      },
    ])
  })
})

describe("getWindsAloft", () => {
  const product = `FT  3000    6000    9000\nMSP 3332 3229+07 3132+02\n`
  it("interpolates a station's wind to the requested altitude", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => text(product)),
    )
    const out = await getWindsAloft({ region: "chi", station: "MSP", altitudeFt: 4500 }, ctx)
    expect(out.station).toBe("MSP")
    expect(out.wind).toEqual({ dirDegTrue: 325, speedKt: 30.5, tempC: null })
  })
  it("reads the shortest published forecast that reaches the requested hours", async () => {
    // AWC publishes 6-, 12- and 24-hour products. The live weather subagent asked
    // for forecastHours 1 and got an error and a retry; it now gets the 6-hour one.
    // A region no other test reads, so the client's URL cache starts empty here.
    const fetchMock = vi.fn(async (_url: string) => text(product))
    vi.stubGlobal("fetch", fetchMock)
    const asked = [1, 6, 9, 24]
    const read: number[] = []
    for (const forecastHours of asked) {
      const out = await getWindsAloft(
        { region: "slc", station: "MSP", altitudeFt: 4500, forecastHours },
        ctx,
      )
      read.push(out.forecastHours)
    }
    expect(read).toEqual([6, 6, 12, 24])
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("fcst"))).toEqual([
      "06",
      "12",
      "24",
    ])
  })
  it("rejects a period beyond the longest forecast, or a negative one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => text(product)),
    )
    await expect(
      getWindsAloft({ region: "chi", station: "MSP", altitudeFt: 4500, forecastHours: 30 }, ctx),
    ).rejects.toThrow(/beyond the longest winds-aloft forecast \(24 hours\)/)
    await expect(
      getWindsAloft({ region: "chi", station: "MSP", altitudeFt: 4500, forecastHours: -1 }, ctx),
    ).rejects.toThrow(/number of hours ahead/)
  })
  it("lists the available stations when the requested one is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => text(product)),
    )
    await expect(
      getWindsAloft({ region: "chi", station: "XYZ", altitudeFt: 4500 }, ctx),
    ).rejects.toThrow(/available: MSP/)
  })
})

describe("getAdvisories", () => {
  it("keeps advisories whose area touches the point, labelled by the product they came from", async () => {
    const inside = [
      { lat: "44.0", lon: "-94.0" },
      { lat: "46.0", lon: "-94.0" },
      { lat: "46.0", lon: "-92.0" },
      { lat: "44.0", lon: "-92.0" },
    ]
    const outside = [
      { lat: "35.0", lon: "-80.0" },
      { lat: "36.0", lon: "-80.0" },
      { lat: "36.0", lon: "-79.0" },
    ]
    const gairmet = [
      // The same G-AIRMET repeats per forecast hour.
      {
        hazard: "ICE",
        forecastHour: 0,
        validTime: "2026-10-04T03:00:00Z",
        expireTime: "2026-10-04T06:00:00Z",
        coords: inside,
      },
      {
        hazard: "ICE",
        forecastHour: 3,
        validTime: "2026-10-04T03:00:00Z",
        expireTime: "2026-10-04T06:00:00Z",
        coords: inside,
      },
      {
        hazard: "TURB-LO",
        forecastHour: 0,
        validTime: "2026-10-04T03:00:00Z",
        expireTime: "2026-10-04T06:00:00Z",
        coords: outside,
      },
    ]
    const airsigmet = [
      {
        hazard: "CONVECTIVE",
        severity: 1,
        validTimeFrom: 1791090000,
        validTimeTo: 1791097200,
        coords: [
          { lat: 44.5, lon: -93.5 },
          { lat: 45.5, lon: -92.5 },
          { lat: 44.5, lon: -92.5 },
        ],
        rawAirSigmet: "CONVECTIVE SIGMET 12C",
      },
    ]
    const fetchMock = vi.fn(async (url: string) =>
      json(url.includes("/gairmet?") ? gairmet : url.includes("/airsigmet?") ? airsigmet : []),
    )
    vi.stubGlobal("fetch", fetchMock)
    const out = await getAdvisories({ lat: 44.9346, lon: -93.0603 }, ctx)
    expect(out).toEqual([
      {
        product: "G-AIRMET",
        hazard: "ICE",
        validFrom: "2026-10-04T03:00:00.000Z",
        validTo: "2026-10-04T06:00:00.000Z",
      },
      {
        product: "SIGMET",
        hazard: "CONVECTIVE",
        severity: "1",
        validFrom: "2026-10-04T05:00:00.000Z",
        validTo: "2026-10-04T07:00:00.000Z",
        raw: "CONVECTIVE SIGMET 12C",
      },
    ])
    expect(fetchMock.mock.calls.map(([url]) => String(url).split("?")[0])).toEqual([
      "https://aviationweather.gov/api/data/gairmet",
      "https://aviationweather.gov/api/data/airsigmet",
    ])
  })

  it("normalizes the fields AWC sends as null, hundreds of feet, or epoch seconds", async () => {
    // Shapes copied from live AWC responses (2026-10-05): G-AIRMET altitudes are
    // hundreds of feet as strings ("040", "SFC"), absent fields are null, the
    // expiry is epoch seconds while validTime is ISO, and a freezing-level
    // contour is a LINE that carries `level` instead of base and top (#955).
    const area = [
      { lat: 44.0, lon: -94.0 },
      { lat: 46.0, lon: -94.0 },
      { lat: 46.0, lon: -92.0 },
      { lat: 44.0, lon: -92.0 },
    ]
    const gairmet = [
      {
        hazard: "FZLVL",
        geometryType: "LINE",
        validTime: "2026-10-05T21:00:00.000Z",
        expireTime: 1791234000,
        severity: null,
        due_to: null,
        base: null,
        top: null,
        fzlbase: null,
        fzltop: null,
        level: "120",
        coords: area,
      },
      {
        hazard: "ICE",
        geometryType: "AREA",
        validTime: "2026-10-06T00:00:00.000Z",
        expireTime: 1791255600,
        severity: "MOD",
        due_to: "ICE",
        base: "040",
        top: "130",
        level: null,
        coords: area,
      },
      {
        hazard: "IFR",
        geometryType: "AREA",
        validTime: "2026-10-06T00:00:00.000Z",
        expireTime: 1791255600,
        severity: null,
        due_to: "CIG BLW 010 VIS BLW 3SM BR FG",
        base: "SFC",
        top: null,
        coords: area,
      },
    ]
    const airsigmet = [
      {
        airSigmetType: "AIRMET",
        hazard: "TURB",
        severity: null,
        validTimeFrom: 1791244500,
        validTimeTo: 1791251700,
        altitudeLow1: 18000,
        altitudeHi1: 31000,
        coords: area,
        rawAirSigmet: "AIRMET TANGO",
      },
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        json(url.includes("/gairmet?") ? gairmet : url.includes("/airsigmet?") ? airsigmet : []),
      ),
    )
    const out = await getAdvisories({ lat: 45, lon: -93 }, ctx)
    expect(out).toEqual([
      {
        product: "G-AIRMET",
        hazard: "FZLVL",
        validFrom: "2026-10-05T21:00:00.000Z",
        validTo: "2026-10-05T21:00:00.000Z",
        freezingLevel: "12,000 ft",
      },
      {
        product: "G-AIRMET",
        hazard: "ICE",
        severity: "MOD",
        validFrom: "2026-10-06T00:00:00.000Z",
        validTo: "2026-10-06T03:00:00.000Z",
        base: "4,000 ft",
        top: "13,000 ft",
        cause: "ICE",
      },
      {
        product: "G-AIRMET",
        hazard: "IFR",
        validFrom: "2026-10-06T00:00:00.000Z",
        validTo: "2026-10-06T03:00:00.000Z",
        base: "surface",
        cause: "CIG BLW 010 VIS BLW 3SM BR FG",
      },
      {
        product: "AIRMET",
        hazard: "TURB",
        validFrom: "2026-10-05T23:55:00.000Z",
        validTo: "2026-10-06T01:55:00.000Z",
        base: "18,000 ft",
        top: "31,000 ft",
        raw: "AIRMET TANGO",
      },
    ])
    for (const advisory of out) {
      expect(Object.values(advisory)).not.toContain("null")
      expect(Object.values(advisory)).not.toContain("")
    }
  })
})
