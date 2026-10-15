import type { B4ToolContext } from "@b4run/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { awc } from "../src/lib/awc.ts"
import computeNavlog, { type ComputeNavlogInput } from "../src/tools/computeNavlog.ts"

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

/**
 * An FB (windtemp) text in the product's fixed-column layout, header as in
 * test/winds-aloft.test.ts. Under the 2026-10-12T18:30Z clock the windows
 * resolve to 06 → 12th 1400–2100Z, 12 → 2100–0600Z, 24 → 13th 0600–1800Z.
 */
const fb = (validDdhhmm: string, forUse: string): string =>
  [
    "DATA BASED ON 121200Z",
    `VALID ${validDdhhmm}Z   FOR USE ${forUse}Z. TEMPS NEG ABV 24000`,
    "",
    "FT  3000    6000    9000   12000",
    "PDX 9900 2511+07 0217-04 2711-04",
    "RDM      2715+05 0315-05 2821-06",
  ].join("\n")
const PRODUCTS = {
  "06": fb("121800", "1400-2100"),
  "12": fb("130000", "2100-0600"),
  "24": fb("131200", "0600-1800"),
}

const ctx = { signal: undefined } as unknown as B4ToolContext
const KPDX = {
  id: "KPDX",
  kind: "airport" as const,
  lat: 45.5887,
  lon: -122.5969,
  elevationFt: 31,
  magneticVariationDeg: 16,
}
const KBDN = {
  id: "KBDN",
  kind: "airport" as const,
  lat: 44.0946,
  lon: -121.2002,
  elevationFt: 3458,
  magneticVariationDeg: 14,
}
const input: ComputeNavlogInput = {
  aircraft: { tailNumber: "N734ST", cruiseRpm: 2400, usableFuelGal: 50 },
  altitudeFt: 9500,
  departureTimeUtc: "2026-10-12T20:00:00Z",
  waypoints: [KPDX, KBDN],
  stations: [{ id: "KS33", alongNm: 80 }],
}

const epoch = (iso: string): number => Date.parse(iso) / 1000

function stub(windtemp: Record<string, string>) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url)
    const p = u.pathname.split("/").at(-1)
    if (p === "windtemp") return new Response(windtemp[u.searchParams.get("fcst") ?? ""] ?? "")
    if (p === "metar") {
      return json(
        ["KPDX", "KS33", "KBDN"].map((id) => ({
          icaoId: id,
          rawOb: `METAR ${id} 121815Z 33006KT 10SM CLR`,
          fltCat: "VFR",
          reportTime: "2026-10-12T18:15:00.000Z",
        })),
      )
    }
    if (p === "taf") {
      return json(
        ["KPDX", "KBDN"].map((id) => ({
          icaoId: id,
          rawTAF: `TAF ${id}`,
          validTimeFrom: epoch("2026-10-12T18:00:00Z"),
          validTimeTo: epoch("2026-10-13T18:00:00Z"),
          fcsts: [
            {
              timeFrom: epoch("2026-10-12T18:00:00Z"),
              timeTo: epoch("2026-10-13T18:00:00Z"),
              visib: "6+",
              clouds: [],
            },
          ],
        })),
      )
    }
    return json([])
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

beforeEach(() => {
  awc.clearCache()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-12T18:30:00Z"))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  awc.clearCache()
})

describe("computeNavlog tool", () => {
  it("takes no winds, uses the forecast at each leg's time, and returns the forecast", async () => {
    stub(PRODUCTS)
    const out = await computeNavlog(input, ctx)
    expect(out.forecast.winds).toHaveLength(1)
    // The leg's midpoint (44.84N 121.90W) is nearer RDM than PDX.
    expect(out.forecast.winds[0]).toMatchObject({
      leg: 1,
      station: "RDM",
      altitudeFt: 9500,
      forUseFromUtc: "2026-10-12T14:00:00.000Z",
      forUseToUtc: "2026-10-12T21:00:00.000Z",
      covered: true,
    })
    expect(out.legs.at(-1)?.wind).toEqual({
      dir: out.forecast.winds[0]?.dirDegTrue,
      kt: out.forecast.winds[0]?.speedKt,
    })
    expect(out.forecast.coverage.preliminary).toBe(false)
    expect(out.forecast.airports.map((a) => a.id)).toEqual(["KPDX", "KS33", "KBDN"])
  })

  it("interpolates the winds at a cruise altitude between two FB levels", async () => {
    stub(PRODUCTS)
    const out = await computeNavlog(input, ctx)
    const wind = out.forecast.winds[0]
    // RDM: 9,000 ft 0315-05, 12,000 ft 2821-06; 9,500 ft is one sixth of the way.
    expect(wind?.speedKt).toBeCloseTo(16, 5)
    expect(wind?.tempC).toBeCloseTo(-5 - 1 / 6, 5)
  })

  it("resolves a bare clock-time departure once, so both passes use the same instant", async () => {
    stub(PRODUCTS)
    const out = await computeNavlog({ ...input, departureTimeUtc: "2000Z" }, ctx)
    expect(out.departureTimeUtc).toBe("2026-10-12T20:00:00.000Z")
  })

  it("marks a leg flown past every FOR USE window uncovered and the forecast preliminary", async () => {
    stub(PRODUCTS)
    const out = await computeNavlog({ ...input, departureTimeUtc: "2026-10-13T17:30:00Z" }, ctx)
    expect(out.forecast.winds[0]).toMatchObject({ covered: false })
    expect(out.forecast.coverage.preliminary).toBe(true)
  })

  it("throws a named error when no winds product is published", async () => {
    stub({ "06": "", "12": "", "24": "" })
    await expect(computeNavlog(input, ctx)).rejects.toThrow(/no winds-aloft station/i)
  })
})
