import type { B4ToolContext } from "@b4run/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { awc } from "../src/lib/awc.ts"
import { forUseWindow, parseWindsAloft } from "../src/lib/winds-aloft.ts"
import getAdvisories from "../src/tools/getAdvisories.ts"
import getMetar from "../src/tools/getMetar.ts"
import getTaf, { flightCategory } from "../src/tools/getTaf.ts"
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

describe("getTaf", () => {
  it("decodes each forecast group to a UTC window and flight category", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json([
          {
            icaoId: "KDLH",
            issueTime: "2026-10-07T23:20:00.000Z",
            validTimeFrom: 1791417600, // 2026-10-08T00:00Z
            validTimeTo: 1791504000, // 2026-10-09T00:00Z
            rawTAF:
              "TAF KDLH 072320Z 0800/0824 32012KT P6SM VCSH SCT070 FM080200 31008KT P6SM SCT070 TEMPO 0816/0820 3SM -RA BKN025",
            fcsts: [
              {
                timeFrom: 1791417600,
                timeTo: 1791424800,
                fcstChange: null,
                wdir: 320,
                wspd: 12,
                visib: "6+",
                wxString: "VCSH",
                clouds: [{ cover: "SCT", base: 7000 }],
              },
              {
                timeFrom: 1791424800,
                timeTo: 1791504000,
                fcstChange: "FM",
                wdir: 310,
                wspd: 8,
                wgst: 18,
                visib: "6+",
                wxString: null,
                clouds: [{ cover: "SCT", base: 7000 }],
              },
              {
                timeFrom: 1791475200,
                timeTo: 1791489600,
                fcstChange: "TEMPO",
                wdir: null,
                visib: 3,
                wxString: "-RA",
                clouds: [{ cover: "BKN", base: 2500 }],
              },
            ],
          },
        ]),
      ),
    )
    const [taf] = await getTaf({ ids: ["kdlh"] }, ctx)
    expect(taf?.validFromUtc).toBe("2026-10-08T00:00:00.000Z")
    expect(taf?.periods).toEqual([
      {
        change: "BASE",
        fromUtc: "2026-10-08T00:00:00.000Z",
        toUtc: "2026-10-08T02:00:00.000Z",
        flightCategory: "VFR",
        visibilityMi: 6,
        windDirDeg: 320,
        windKt: 12,
        weather: "VCSH",
      },
      {
        change: "FM",
        fromUtc: "2026-10-08T02:00:00.000Z",
        toUtc: "2026-10-09T00:00:00.000Z",
        flightCategory: "VFR",
        visibilityMi: 6,
        windDirDeg: 310,
        windKt: 8,
        gustKt: 18,
      },
      {
        change: "TEMPO",
        fromUtc: "2026-10-08T16:00:00.000Z",
        toUtc: "2026-10-08T20:00:00.000Z",
        flightCategory: "MVFR",
        ceilingFt: 2500,
        visibilityMi: 3,
        weather: "-RA",
      },
    ])
  })
  it("grades ceiling and visibility by the FAA flight categories", () => {
    expect(flightCategory(undefined, 6)).toBe("VFR")
    expect(flightCategory(3000, 10)).toBe("MVFR")
    expect(flightCategory(5000, 5)).toBe("MVFR")
    expect(flightCategory(900, 10)).toBe("IFR")
    expect(flightCategory(400, 10)).toBe("LIFR")
    expect(flightCategory(5000, 0.5)).toBe("LIFR")
    expect(flightCategory(undefined, undefined)).toBeUndefined()
  })
})

describe("getWindsAloft", () => {
  const rows = `FT  3000    6000    9000\nMSP 3332 3229+07 3132+02\n`
  /** An FB product header as AWC publishes it, over the same station rows. */
  const fb = (basedOn: string, validAt: string, forUse: string): string =>
    `DATA BASED ON ${basedOn}\nVALID ${validAt}   FOR USE ${forUse}. TEMPS NEG ABV 24000\n\n${rows}`
  /** The three products issued from one data time, keyed by the fcst parameter. */
  const ISSUES: Record<string, Record<string, string>> = {
    "071800Z": {
      "06": fb("071800Z", "080000Z", "2000-0300Z"),
      "12": fb("071800Z", "080600Z", "0300-1200Z"),
      "24": fb("071800Z", "081800Z", "1200-0000Z"),
    },
    "080000Z": {
      "06": fb("080000Z", "080600Z", "0200-0900Z"),
      "12": fb("080000Z", "081200Z", "0900-1800Z"),
      "24": fb("080000Z", "090000Z", "1800-0600Z"),
    },
    "081200Z": {
      "06": fb("081200Z", "081800Z", "1400-2100Z"),
      "12": fb("081200Z", "090000Z", "2100-0600Z"),
      "24": fb("081200Z", "091200Z", "0600-1800Z"),
    },
  }
  /** Serve one issue's products, as AWC would at a given time, and fix the clock to that time. */
  const serve = (now: string, issue: string): void => {
    vi.setSystemTime(new Date(now))
    awc.clearCache()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = ISSUES[issue]?.[new URL(url).searchParams.get("fcst") ?? ""]
        return body === undefined ? new Response("", { status: 404 }) : text(body)
      }),
    )
  }
  const flight = { region: "chi", station: "MSP", altitudeFt: 4500 } as const

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("interpolates a station's wind to the requested altitude", async () => {
    serve("2026-10-08T03:00:00Z", "080000Z")
    const out = await getWindsAloft({ ...flight, validAtUtc: "2026-10-08T14:00:00Z" }, ctx)
    expect(out.station).toBe("MSP")
    expect(out.wind).toEqual({ dirDegTrue: 325, speedKt: 30.5, tempC: null })
  })
  it("picks the product whose FOR USE window contains a 1400Z flight, whenever it is asked", async () => {
    // The tool, not the subagent, picks the product: a model working out the
    // forecast hours itself can read a product whose window does not contain
    // the leg. Each run time below
    // serves the products AWC publishes then; the tool must pick the one
    // whose FOR USE window contains 1400Z.
    const cases = [
      {
        now: "2026-10-08T00:30:00Z",
        issue: "071800Z",
        hours: 24,
        from: "12:00",
        to: "2026-10-09T00:00",
      },
      {
        now: "2026-10-08T03:00:00Z",
        issue: "080000Z",
        hours: 12,
        from: "09:00",
        to: "2026-10-08T18:00",
      },
      {
        now: "2026-10-08T06:30:00Z",
        issue: "080000Z",
        hours: 12,
        from: "09:00",
        to: "2026-10-08T18:00",
      },
      {
        now: "2026-10-08T13:00:00Z",
        issue: "081200Z",
        hours: 6,
        from: "14:00",
        to: "2026-10-08T21:00",
      },
    ]
    for (const { now, issue, hours, from, to } of cases) {
      serve(now, issue)
      const out = await getWindsAloft({ ...flight, validAtUtc: "2026-10-08T14:00:00Z" }, ctx)
      expect({ now, hours: out.forecastHours, covered: out.covered }).toEqual({
        now,
        hours,
        covered: true,
      })
      expect(out.forUseFromUtc).toBe(`2026-10-08T${from}:00.000Z`)
      expect(out.forUseToUtc).toBe(`${to}:00.000Z`)
      expect(out.note).toBeUndefined()
    }
  })
  it("reads every product's header, so the choice is never computed from the clock alone", async () => {
    serve("2026-10-08T03:00:00Z", "080000Z")
    await getWindsAloft({ ...flight, validAtUtc: "2026-10-08T14:00:00Z" }, ctx)
    const fetchMock = vi.mocked(fetch)
    expect(
      fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("fcst")).sort(),
    ).toEqual(["06", "12", "24"])
  })
  it("says so when no product covers the time yet, and returns the latest as preliminary", async () => {
    serve("2026-10-08T03:00:00Z", "080000Z")
    const out = await getWindsAloft({ ...flight, validAtUtc: "2026-10-09T14:00:00Z" }, ctx)
    expect(out.covered).toBe(false)
    expect(out.forecastHours).toBe(24)
    expect(out.forUseToUtc).toBe("2026-10-09T06:00:00.000Z")
    expect(out.note).toMatch(/No winds-aloft forecast covers 2026-10-09T14:00:00Z yet/)
    expect(out.note).toMatch(/preliminary/)
  })
  it("marks a time before every window uncovered and returns the earliest product", async () => {
    serve("2026-10-08T03:00:00Z", "080000Z")
    const out = await getWindsAloft({ ...flight, validAtUtc: "2026-10-08T01:00:00Z" }, ctx)
    expect(out.covered).toBe(false)
    expect(out.forecastHours).toBe(6)
    expect(out.note).toMatch(/before the earliest winds-aloft forecast/)
  })
  it("places a 24-hour window that crosses midnight and a month end", async () => {
    // Read on the 1st, the 24-hour product issued from the 31st's 00Z data is
    // for use 1800Z on the 31st to 0600Z on the 1st.
    vi.setSystemTime(new Date("2026-11-01T03:00:00Z"))
    const window = forUseWindow(parseWindsAloft(fb("311800Z", "010000Z", "1800-0600Z")), Date.now())
    expect(window).toEqual({
      fromUtc: "2026-10-31T18:00:00.000Z",
      toUtc: "2026-11-01T06:00:00.000Z",
    })
  })
  it("rejects a validAtUtc that is not an ISO UTC instant", async () => {
    serve("2026-10-08T03:00:00Z", "080000Z")
    for (const validAtUtc of ["1400Z", "in 11 hours", "2026-10-08T14:00:00-05:00"]) {
      await expect(getWindsAloft({ ...flight, validAtUtc }, ctx)).rejects.toThrow(
        /validAtUtc must be an ISO 8601 UTC instant/,
      )
    }
  })
  it("lists the available stations when the requested one is absent", async () => {
    serve("2026-10-08T03:00:00Z", "080000Z")
    await expect(
      getWindsAloft({ ...flight, station: "XYZ", validAtUtc: "2026-10-08T14:00:00Z" }, ctx),
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
    // contour is a LINE that carries `level` instead of base and top.
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
