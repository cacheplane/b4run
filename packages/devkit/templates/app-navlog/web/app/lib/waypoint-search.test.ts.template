import { describe, expect, test } from "vitest"
import snapshot from "../../data/waypoints.json"
import { searchWaypoints, type WaypointData } from "./waypoint-search"

const data: WaypointData = {
  snapshot: "2026-10-10",
  airports: [
    ["KSNS", "SNS", "Salinas Municipal Airport", 36.6628, -121.606],
    ["KSBA", "SBA", "Santa Barbara Municipal Airport", 34.4262, -119.84],
    ["KSBP", "SBP", "San Luis County Regional Airport", 35.2368, -120.642],
    ["CSB2", null, "Salinas Valley Ranch", 36.1, -121.2],
    ["SB1", null, "Westsalinas Strip", 36.0, -121.0],
    ["DUP1", null, "First Duplicate Field", 40.0, -100.0],
    ["DUP1", null, "Second Duplicate Field", 41.0, -101.0],
  ],
  navaids: [
    ["SNS", "Salinas", "VORTAC", 36.6638, -121.603, 117300],
    ["SBX", "San Luis Obispo", "NDB", 35.2, -120.6, null],
  ],
}

const ids = (q: string, limit?: number) =>
  searchWaypoints(data, q, limit).map((waypoint) => `${waypoint.kind}:${waypoint.id}`)

describe("searchWaypoints", () => {
  test("an empty or blank query gives nothing", () => {
    expect(searchWaypoints(data, "")).toEqual([])
    expect(searchWaypoints(data, "   ")).toEqual([])
  })

  test("SNS finds the VORTAC by id first, then the airport by its alias", () => {
    expect(ids("SNS")).toEqual(["navaid:SNS", "airport:KSNS"])
  })

  test("is case-insensitive and trimmed", () => {
    expect(ids("  sns ")).toEqual(["navaid:SNS", "airport:KSNS"])
  })

  test("maps rows to waypoints, keeping a navaid frequency and omitting a null one", () => {
    const [vortac] = searchWaypoints(data, "SNS").filter((w) => w.kind === "navaid")
    expect(vortac).toEqual({
      id: "SNS",
      kind: "navaid",
      type: "VORTAC",
      name: "Salinas",
      lat: 36.6638,
      lon: -121.603,
      freqKhz: 117300,
    })
    const [ndb] = searchWaypoints(data, "SBX")
    expect(ndb).not.toHaveProperty("freqKhz")
    const [airport] = searchWaypoints(data, "KSNS")
    expect(airport).toMatchObject({ kind: "airport", type: "airport" })
  })

  test("a code prefix ranks K airports, then navaids, then other airports, shorter codes first", () => {
    expect(ids("KSB")).toEqual(["airport:KSBA", "airport:KSBP"])
    expect(ids("SB")).toEqual(["airport:KSBA", "airport:KSBP", "navaid:SBX", "airport:SB1"])
  })

  test("an exact code outranks a name match", () => {
    // "sb1" is SB1's id; nothing else names it.
    expect(ids("SB1")).toEqual(["airport:SB1"])
  })

  test("salinas ranks name word-prefixes before substrings, K airports first", () => {
    expect(ids("salinas")).toEqual(["airport:KSNS", "airport:CSB2", "navaid:SNS", "airport:SB1"])
  })

  test("a multi-word name prefix matches across words", () => {
    expect(ids("san luis")).toEqual(["airport:KSBP", "navaid:SBX"])
  })

  test("a name substring matches inside a word", () => {
    expect(ids("arbara")).toEqual(["airport:KSBA"])
  })

  test("keeps duplicate ids, each with its own position", () => {
    const results = searchWaypoints(data, "DUP1")
    expect(results.map((w) => [w.id, w.lat])).toEqual([
      ["DUP1", 40],
      ["DUP1", 41],
    ])
  })

  test("honours the limit", () => {
    expect(ids("s", 2)).toHaveLength(2)
    expect(searchWaypoints(data, "s", 0)).toEqual([])
  })
})

describe("searchWaypoints over the bundled snapshot", () => {
  // JSON imports widen tuples to arrays, so the shape is asserted, not inferred.
  const real = snapshot as unknown as WaypointData

  test("SNS returns the SNS VORTAC first and KSNS near the top", () => {
    const top = searchWaypoints(real, "SNS")
      .slice(0, 3)
      .map((w) => `${w.kind}:${w.id}`)
    expect(top[0]).toBe("navaid:SNS")
    expect(top).toContain("airport:KSNS")
  })

  test("KPAO is first for its own id", () => {
    expect(searchWaypoints(real, "KPAO")[0]).toMatchObject({ id: "KPAO", kind: "airport" })
  })
})
