import { describe, expect, it } from "vitest"
import { resolveStations, stationIds } from "../scripts/build-winds-stations.mjs"
import { nearestWindsStation, windsStationTable } from "../src/lib/forecast/winds.ts"

// Points neither the navaid snapshot nor an airport record places: the Gulf
// points, offshore platforms, and two coastal VORs the snapshot lacks.
const KNOWN_UNRESOLVED = ["H51", "H52", "H61", "HAT", "MQT", "T01", "T06", "T07", "2XG", "4J3"]

describe("winds stations table", () => {
  it("places every station but the known unresolved points", () => {
    const table = windsStationTable()
    const stations = table.stations
    expect(table.unresolved.every((id) => KNOWN_UNRESOLVED.includes(id))).toBe(true)
    expect(stations.length).toBeGreaterThan(160)
    expect(stations.find((s) => s.id === "PDX")).toBeDefined()
    expect(stations.find((s) => s.id === "RDM")).toBeDefined()
  })

  it("reads station ids from an FB product and resolves VORs before airports", async () => {
    const text = [
      "(Extracted from FBUS31 KWNO 121800)",
      "FBUS31 KWNO 122001",
      "DATA BASED ON 121800Z",
      "VALID 130000Z   FOR USE 2000-0300Z. TEMPS NEG ABV 24000",
      "",
      "FT  3000    6000    9000   12000",
      "PDX 9900 2511+07 2609+02 2711-04",
      "RDM      2715+05 2817+00 2821-06",
      "H51 1105 1210+18 1315+12 1420+06",
    ].join("\n")
    expect(stationIds(text)).toEqual(["PDX", "RDM", "H51"])
    const out = await resolveStations(
      ["PDX", "RDM", "H51"],
      [["PDX", "Portland", "VORTAC", 45.58, -122.6, 116300, 16]],
      async (id) => (id === "RDM" ? { lat: 44.25, lon: -121.15 } : null),
    )
    expect(out).toEqual({
      stations: [
        ["PDX", 45.58, -122.6],
        ["RDM", 44.25, -121.15],
      ],
      unresolved: ["H51"],
    })
  })
})

describe("nearestWindsStation", () => {
  const TABLE = [
    { id: "PDX", lat: 45.58, lon: -122.6 },
    { id: "RDM", lat: 44.25, lon: -121.15 },
    { id: "SEA", lat: 47.43, lon: -122.3 },
  ]
  it("picks the great-circle nearest station in the product", () => {
    expect(
      nearestWindsStation({ lat: 44.8, lon: -121.9 }, new Set(["PDX", "RDM", "SEA"]), TABLE)?.id,
    ).toBe("RDM")
  })
  it("falls back to the next nearest when the nearest is not in the product", () => {
    expect(
      nearestWindsStation({ lat: 44.8, lon: -121.9 }, new Set(["PDX", "SEA"]), TABLE)?.id,
    ).toBe("PDX")
  })
  it("is null when no station in the table is in the product", () => {
    expect(nearestWindsStation({ lat: 44.8, lon: -121.9 }, new Set(["XXX"]), TABLE)).toBeNull()
  })
})
