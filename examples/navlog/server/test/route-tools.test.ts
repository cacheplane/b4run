import { existsSync } from "node:fs"
import type { B4ToolContext } from "@b4run/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import { awc } from "../src/lib/awc.ts"
import { createNavaidIndex, type NavaidRow } from "../src/lib/navaids.ts"
import { legBoxes, placeOnRoute, thin } from "../src/lib/route-corridor.ts"
import findRouteStations from "../src/tools/findRouteStations.ts"
import lookupNavaid from "../src/tools/lookupNavaid.ts"

const ROWS = vi.hoisted((): NavaidRow[] => [
  ["SNS", "Salinas", "VORTAC", 36.6638, -121.6031, 117300, 13.8],
  // An NDB listed before the VOR that shares its identifier.
  ["ODI", "Nodine", "NDB", 43.9, -91.4, 371, null],
  ["ODI", "Nodine", "VOR-DME", 43.9136, -91.4709, 117000, -1.5],
  ["OSW", "Oswego", "NDB", 43.4, -76.4, 251, null],
])

// The tool reads the snapshot through findNavaid; answer it from fixed rows so
// these tests do not depend on the bundled data file.
vi.mock("../src/lib/navaids.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/navaids.ts")>()
  const index = actual.createNavaidIndex(ROWS)
  return { ...actual, findNavaid: (id: string) => index.find(id) }
})

const ctx = { signal: new AbortController().signal } as unknown as B4ToolContext
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
  awc.clearCache()
})

describe("lookupNavaid", () => {
  it("returns the snapshot record for an identifier, case-insensitively", async () => {
    await expect(lookupNavaid({ id: " sns " }, ctx)).resolves.toEqual({
      id: "SNS",
      name: "Salinas",
      type: "VORTAC",
      lat: 36.6638,
      lon: -121.6031,
      freqKhz: 117300,
      magneticVariationDeg: 13.8,
    })
  })
  it("prefers the VOR when a VOR and an NDB share an identifier", async () => {
    const odi = await lookupNavaid({ id: "ODI" }, ctx)
    expect(odi.type).toBe("VOR-DME")
    expect(odi.magneticVariationDeg).toBe(-1.5)
  })
  it("rejects an unknown identifier", async () => {
    await expect(lookupNavaid({ id: "zzz" }, ctx)).rejects.toThrow(/no navaid record for ZZZ/)
  })
})

describe("createNavaidIndex", () => {
  it("keeps the VOR whichever order the rows come in, and reads a blank variation as 0", () => {
    const vorFirst = createNavaidIndex([ROWS[2] as NavaidRow, ROWS[1] as NavaidRow])
    expect(vorFirst.find("odi")?.type).toBe("VOR-DME")
    const osw = createNavaidIndex(ROWS).find("OSW")
    expect(osw?.type).toBe("NDB")
    expect(osw?.magneticVariationDeg).toBe(0)
  })
  const snapshot = new URL("../data/navaids.json", import.meta.url)
  it.skipIf(!existsSync(snapshot))("reads the bundled snapshot", async () => {
    const actual =
      await vi.importActual<typeof import("../src/lib/navaids.ts")>("../src/lib/navaids.ts")
    const sns = actual.findNavaid("SNS")
    expect(sns?.type).toMatch(/^VOR/)
    expect(sns?.magneticVariationDeg).toBeGreaterThan(0) // California: east variation
  })
})

// A route north along 93W for 60 nm, then east along 45N.
const AIRPORTS: Readonly<Record<string, { readonly lat: number; readonly lon: number }>> = {
  KAAA: { lat: 44, lon: -93 },
  KBBB: { lat: 45, lon: -93 },
  KCCC: { lat: 45, lon: -92 },
}
const PA = { id: "KAAA", ...AIRPORTS.KAAA } as { id: string; lat: number; lon: number }
const PB = { id: "KBBB", ...AIRPORTS.KBBB } as { id: string; lat: number; lon: number }
const PC = { id: "KCCC", ...AIRPORTS.KCCC } as { id: string; lat: number; lon: number }
const A = { id: "KAAA", kind: "airport" } as const
const B = { id: "KBBB", kind: "airport" } as const
const C = { id: "KCCC", kind: "airport" } as const
const lonNm = (lat: number, nm: number): number => nm / (60 * Math.cos((lat * Math.PI) / 180))

describe("route corridor", () => {
  it("expands each leg's box by the corridor, longitude at the box's highest latitude", () => {
    const [box] = legBoxes([PA, PB], 30)
    const [minLat, minLon, maxLat, maxLon] = box as readonly number[]
    expect(minLat).toBeCloseTo(43.5, 6)
    expect(maxLat).toBeCloseTo(45.5, 6)
    expect(minLon).toBeCloseTo(-93 - lonNm(45.5, 30), 6)
    expect(maxLon).toBeCloseTo(-93 + lonNm(45.5, 30), 6)
  })
  it("places a point by its distance off the nearest leg and along the route", () => {
    const onFirstLeg = placeOnRoute({ lat: 44.5, lon: -93 + lonNm(44.5, 10) }, [PA, PB, PC])
    expect(onFirstLeg.offsetNm).toBeCloseTo(10, 0)
    expect(onFirstLeg.alongNm).toBeCloseTo(30, 0)
    const onSecondLeg = placeOnRoute({ lat: 44.9, lon: -92.5 }, [PA, PB, PC])
    expect(onSecondLeg.offsetNm).toBeCloseTo(6, 0)
    expect(onSecondLeg.alongNm).toBeGreaterThan(80)
  })
  it("thins evenly by distance along the route, keeping the first and last", () => {
    const items = [0, 5, 10, 48, 52, 90, 100].map((alongNm) => ({ alongNm }))
    expect(thin(items, 3).map((s) => s.alongNm)).toEqual([0, 48, 100])
    expect(thin(items, 10)).toHaveLength(7)
  })
})

describe("findRouteStations", () => {
  const station = (icaoId: string, lat: number, lon: number) => ({
    icaoId,
    name: `${icaoId} airport`,
    lat,
    lon,
  })

  /** METAR searches answer `records`; airport lookups answer from AIRPORTS. */
  function stubAwc(records: readonly unknown[]) {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith("/airport")) {
        const position = AIRPORTS[parsed.searchParams.get("ids") ?? ""]
        return json(position ? [{ icaoId: parsed.searchParams.get("ids"), ...position }] : [])
      }
      return json(records)
    })
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  const metarCalls = (fetchMock: ReturnType<typeof stubAwc>): URL[] =>
    fetchMock.mock.calls
      .map(([url]) => new URL(url))
      .filter((url) => url.pathname.endsWith("/metar"))

  it("keeps corridor stations in order along the route and drops the route's airports", async () => {
    const fetchMock = stubAwc([
      station("KEND", 45, -92.3), // second leg, about 82 nm along
      station("KFAR", 44.5, -93 - lonNm(44.5, 40)), // 40 nm west of the first leg
      station("KBBB", 45, -93), // a route airport
      station("KMID", 44.5, -93.1), // first leg, about 30 nm along
    ])
    const out = await findRouteStations({ waypoints: [A, B, C] }, ctx)
    expect(out.stations.map((s) => s.id)).toEqual(["KMID", "KEND"])
    expect(out.stations[0]).toEqual({
      id: "KMID",
      name: "KMID airport",
      lat: 44.5,
      lon: -93.1,
      alongNm: 30,
      offsetNm: 4,
    })
    // One METAR request per leg; the overlapping boxes' shared answers merge to one station each.
    const urls = metarCalls(fetchMock)
    expect(urls).toHaveLength(2)
    for (const url of urls) {
      expect(url.pathname.endsWith("/metar")).toBe(true)
      expect(url.searchParams.get("format")).toBe("json")
      expect(url.searchParams.get("bbox")?.split(",")).toHaveLength(4)
    }
  })

  it("thins to max, spread evenly and keeping the first and last", async () => {
    stubAwc(
      [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((nm, i) =>
        station(`K${String.fromCharCode(65 + i)}XX`, 44 + nm / 60, -93.05),
      ),
    )
    const out = await findRouteStations({ waypoints: [A, B], max: 3 }, ctx)
    expect(out.stations.map((s) => s.alongNm)).toEqual([5, 30, 55])
  })

  it("honours a narrower corridor", async () => {
    stubAwc([station("KMID", 44.5, -93 - lonNm(44.5, 15))])
    const wide = await findRouteStations({ waypoints: [A, B] }, ctx)
    expect(wide.stations.map((s) => s.id)).toEqual(["KMID"])
    awc.clearCache()
    const narrow = await findRouteStations({ waypoints: [A, B], corridorNm: 10 }, ctx)
    expect(narrow.stations).toEqual([])
  })

  it("looks the coordinates up itself: airports from aviationweather.gov, navaids from the snapshot", async () => {
    stubAwc([station("KMID", 36.9, -121.75)])
    const out = await findRouteStations(
      { waypoints: [{ id: "KAAA" }, { id: "sns", kind: "navaid" }] },
      ctx,
    )
    // The KAAA–SNS leg's box spans both positions, so the query reached them.
    const [box] = metarCalls(vi.mocked(fetch) as unknown as ReturnType<typeof stubAwc>)
    const [minLat, minLon, maxLat, maxLon] = (box?.searchParams.get("bbox") ?? "")
      .split(",")
      .map(Number)
    expect(minLat).toBeLessThan(36.67)
    expect(maxLat).toBeGreaterThan(44)
    expect(minLon).toBeLessThan(-121.6)
    expect(maxLon).toBeGreaterThan(-93)
    expect(out.stations).toBeDefined()
  })

  it("names an identifier it cannot place", async () => {
    stubAwc([])
    await expect(
      findRouteStations({ waypoints: [A, { id: "KZZZ", kind: "airport" }] }, ctx),
    ).rejects.toThrow("no airport record for KZZZ")
    await expect(findRouteStations({ waypoints: [A, { id: "QQQ" }] }, ctx)).rejects.toThrow(
      "no airport or navaid record for QQQ",
    )
  })

  it("returns no stations, and asks nothing, for fewer than two waypoints", async () => {
    const fetchMock = stubAwc([station("KMID", 44.5, -93.1)])
    await expect(findRouteStations({ waypoints: [A] }, ctx)).resolves.toEqual({ stations: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
