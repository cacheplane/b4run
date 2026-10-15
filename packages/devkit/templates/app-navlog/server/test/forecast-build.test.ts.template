import { describe, expect, it } from "vitest"
import { buildForecast, legIntervals, timeAtAlong } from "../src/lib/forecast/build.ts"
import type { Taf } from "../src/lib/forecast/taf.ts"
import { computeNavlog, type NavlogWaypoint } from "../src/lib/navlog.ts"

const KPDX: NavlogWaypoint = {
  id: "KPDX",
  kind: "airport",
  lat: 45.5887,
  lon: -122.5969,
  elevationFt: 31,
  magneticVariationDeg: 16,
}
const KBDN: NavlogWaypoint = {
  id: "KBDN",
  kind: "airport",
  lat: 44.0946,
  lon: -121.2002,
  elevationFt: 3458,
  magneticVariationDeg: 14,
}
const KHAF: NavlogWaypoint = {
  id: "KHAF",
  kind: "airport",
  lat: 37.5134,
  lon: -122.5011,
  elevationFt: 66,
  magneticVariationDeg: 13,
}
const KPAO: NavlogWaypoint = {
  id: "KPAO",
  kind: "airport",
  lat: 37.4611,
  lon: -122.115,
  elevationFt: 7,
  magneticVariationDeg: 13,
}
const aircraft = { tailNumber: "N734ST", cruiseRpm: 2400, usableFuelGal: 50 }
const calm = (n: number) => Array.from({ length: n }, () => ({ dirDegTrue: 0, speedKt: 0 }))
const navlog = (waypoints: NavlogWaypoint[]) =>
  computeNavlog({
    aircraft,
    altitudeFt: 9500,
    departureTimeUtc: "2026-10-12T20:00:00Z",
    waypoints,
    winds: calm(waypoints.length - 1),
  })

const tafFor = (id: string): Taf => ({
  id,
  issuedAt: "2026-10-12T17:20:00.000Z",
  validFromUtc: "2026-10-12T18:00:00.000Z",
  validToUtc: "2026-10-13T18:00:00.000Z",
  raw: `TAF ${id} 121720Z 1218/1318 VRB05KT P6SM SKC`,
  periods: [
    {
      change: "BASE",
      fromUtc: "2026-10-12T18:00:00.000Z",
      toUtc: "2026-10-13T18:00:00.000Z",
      flightCategory: "VFR",
    },
  ],
})
const metarFor = (id: string, category = "VFR") => ({
  id,
  observedAt: "2026-10-12T18:15:00.000Z",
  flightCategory: category,
  windDirDeg: 330,
  windKt: 6,
  gustKt: null,
  visibilityMi: 10,
  ceilingFt: null,
  tempC: 10,
  dewpointC: -3,
  altimeterHpa: 1016,
  raw: `METAR ${id} 121815Z AUTO 33006KT 10SM CLR`,
})

describe("legIntervals", () => {
  it("maps rows to legs, including an out-and-back that repeats a waypoint", () => {
    const log = navlog([KPAO, KHAF, KPAO])
    const legs = legIntervals(log)
    expect(legs.map((l) => l.leg)).toEqual([1, 2])
    expect(legs[0]?.startMs).toBe(Date.parse("2026-10-12T20:00:00Z"))
    expect(legs[1]?.startMs).toBe(legs[0]?.endMs)
    expect(legs[1]?.endMs).toBe(Date.parse(log.legs.at(-1)?.etaUtc ?? ""))
  })
})

describe("timeAtAlong", () => {
  it("is the departure at 0 nm and the ETA at the route's length", () => {
    const log = navlog([KPDX, KBDN])
    expect(timeAtAlong(log, 0)).toBe(Date.parse(log.departureTimeUtc))
    expect(timeAtAlong(log, log.totals.distanceNm)).toBe(Date.parse(log.legs.at(-1)?.etaUtc ?? ""))
  })
})

describe("buildForecast", () => {
  it("assembles origin, stations by alongNm and destination, and a GO floor for a clean flight", () => {
    const log = navlog([KPDX, KBDN])
    const forecast = buildForecast({
      navlog: log,
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
      windWindows: [
        { fromMs: Date.parse("2026-10-12T14:00:00Z"), toMs: Date.parse("2026-10-13T18:00:00Z") },
      ],
      metars: [metarFor("KPDX"), metarFor("KS33"), metarFor("KBDN")],
      tafs: [tafFor("KPDX"), tafFor("KBDN")],
      advisories: [],
      stations: [{ id: "KS33", alongNm: 80 }],
    })
    expect(forecast.airports.map((a) => [a.id, a.role, a.categoryNow, a.categoryAtTime])).toEqual([
      ["KPDX", "origin", "VFR", "VFR"],
      ["KS33", "en-route", "VFR", null],
      ["KBDN", "destination", "VFR", "VFR"],
    ])
    expect(forecast.coverage).toEqual({ preliminary: false, reasons: [] })
    expect(forecast.verdictFloor).toEqual({ level: "GO", reasons: [] })
    expect(forecast.notes).toEqual(["No TAF issued for KS33"])
  })

  it("carries the caller's notes first, de-duplicated with its own", () => {
    const forecast = buildForecast({
      navlog: navlog([KPDX, KBDN]),
      winds: [],
      windWindows: [],
      metars: [metarFor("KPDX"), metarFor("KS33"), metarFor("KBDN")],
      tafs: [tafFor("KPDX"), tafFor("KBDN")],
      advisories: [],
      stations: [{ id: "KS33", alongNm: 80 }],
      notes: ["Winds for leg 1 did not settle", "No TAF issued for KS33"],
    })
    expect(forecast.notes).toEqual(["Winds for leg 1 did not settle", "No TAF issued for KS33"])
  })

  it("builds for a navaid destination with no METAR or TAF", () => {
    const SNS: NavlogWaypoint = {
      id: "SNS",
      kind: "navaid",
      lat: 36.6628,
      lon: -121.6064,
      magneticVariationDeg: 14,
    }
    const log = navlog([KPAO, SNS])
    const forecast = buildForecast({
      navlog: log,
      winds: [],
      windWindows: [],
      metars: [metarFor("KPAO")],
      tafs: [tafFor("KPAO")],
      advisories: [],
      stations: [],
    })
    expect(forecast.airports.at(-1)).toMatchObject({
      id: "SNS",
      role: "destination",
      metar: null,
      taf: null,
      categoryAtTime: null,
    })
    expect(forecast.coverage.reasons.some((r) => r.includes("SNS"))).toBe(false)
  })
})
