import type { B4ToolContext } from "@b4run/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import getMetar from "../src/tools/getMetar.ts"
import getWindsAloft from "../src/tools/getWindsAloft.ts"
import lookupAirport from "../src/tools/lookupAirport.ts"

const ctx = { signal: new AbortController().signal } as unknown as B4ToolContext
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
const text = (body: string): Response => new Response(body, { status: 200 })

afterEach(() => vi.unstubAllGlobals())

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
            elev: 215,
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
      elevationFt: 215,
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
        json([{ icaoId: "KRST", lat: 43.9, lon: -92.5, elev: 1317, magdec: "02W", runways: [] }]),
      ),
    )
    expect((await lookupAirport({ id: "KRST" }, ctx)).magneticVariationDeg).toBe(-2)
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
