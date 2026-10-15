import { describe, expect, it } from "vitest"
import { coverage, intervalCovered } from "../src/lib/forecast/coverage.ts"

const ms = (iso: string): number => Date.parse(iso)
const taf = (from: string, to: string) => ({ validFromUtc: from, validToUtc: to })
// The FB products' FOR USE windows on 2026-10-12: 6-hour 1400–2100Z, 12-hour 2100–0600Z, 24-hour 0600–1800Z.
const WINDS = [
  { fromMs: ms("2026-10-12T14:00:00Z"), toMs: ms("2026-10-12T21:00:00Z") },
  { fromMs: ms("2026-10-12T21:00:00Z"), toMs: ms("2026-10-13T06:00:00Z") },
  { fromMs: ms("2026-10-13T06:00:00Z"), toMs: ms("2026-10-13T18:00:00Z") },
]
const base = {
  departureMs: ms("2026-10-12T20:00:00Z"),
  etaMs: ms("2026-10-12T21:02:00Z"),
  origin: { id: "KPDX", taf: taf("2026-10-12T18:00:00Z", "2026-10-13T18:00:00Z") },
  destination: { id: "KBDN", taf: taf("2026-10-12T18:00:00Z", "2026-10-13T18:00:00Z") },
  legs: [{ leg: 1, startMs: ms("2026-10-12T20:00:00Z"), endMs: ms("2026-10-12T21:02:00Z") }],
  windWindows: WINDS,
}

describe("coverage", () => {
  it("KPDX → KBDN departing 2000Z is covered: the 2100–2102Z tail falls in the next product's window", () => {
    expect(coverage(base)).toEqual({ preliminary: false, reasons: [] })
  })

  it("names a leg that ends after every winds window", () => {
    const late = {
      ...base,
      legs: [{ leg: 1, startMs: ms("2026-10-13T17:30:00Z"), endMs: ms("2026-10-13T18:18:00Z") }],
    }
    expect(coverage(late)).toEqual({
      preliminary: true,
      reasons: ["winds for leg 1 are forecast until 1800Z; the leg ends 1818Z"],
    })
  })

  it("names a leg that starts before the earliest winds window", () => {
    const early = {
      ...base,
      legs: [{ leg: 1, startMs: ms("2026-10-12T13:30:00Z"), endMs: ms("2026-10-12T14:30:00Z") }],
    }
    expect(coverage(early).reasons).toEqual([
      "winds for leg 1 are forecast from 1400Z; the leg starts 1330Z",
    ])
  })

  it("names a destination TAF that ends a minute before the ETA", () => {
    const short = {
      ...base,
      destination: { id: "KBDN", taf: taf("2026-10-12T12:00:00Z", "2026-10-12T21:01:00Z") },
    }
    expect(coverage(short)).toEqual({
      preliminary: true,
      reasons: ["the KBDN TAF ends at 2101Z and does not cover the 2102Z ETA"],
    })
  })

  it("words a TAF ending at the very minute of the ETA without contradiction", () => {
    const edge = {
      ...base,
      destination: { id: "KBDN", taf: taf("2026-10-12T12:00:00Z", "2026-10-12T21:02:00Z") },
    }
    expect(coverage(edge).reasons).toEqual([
      "the KBDN TAF ends at 2102Z and does not cover the 2102Z ETA",
    ])
  })

  it("names an origin TAF that has not started by the departure", () => {
    const notYet = {
      ...base,
      origin: { id: "KPDX", taf: taf("2026-10-12T21:00:00Z", "2026-10-13T21:00:00Z") },
    }
    expect(coverage(notYet).reasons).toEqual([
      "the KPDX TAF starts 2100Z, after the 2000Z departure",
    ])
  })

  it("does not count an airport with no TAF", () => {
    const none = { ...base, destination: { id: "KTTD", taf: null } }
    expect(coverage(none)).toEqual({ preliminary: false, reasons: [] })
  })

  it("is preliminary when no winds window was published at all", () => {
    expect(coverage({ ...base, windWindows: [] }).reasons).toEqual([
      "no winds-aloft forecast is published for leg 1",
    ])
  })
})

describe("intervalCovered", () => {
  it("is true across abutting windows and false across a gap", () => {
    expect(intervalCovered(ms("2026-10-12T20:00:00Z"), ms("2026-10-12T22:00:00Z"), WINDS)).toBe(
      true,
    )
    const gap = [
      { fromMs: ms("2026-10-12T14:00:00Z"), toMs: ms("2026-10-12T20:00:00Z") },
      { fromMs: ms("2026-10-12T21:00:00Z"), toMs: ms("2026-10-13T06:00:00Z") },
    ]
    expect(intervalCovered(ms("2026-10-12T19:30:00Z"), ms("2026-10-12T21:30:00Z"), gap)).toBe(false)
    expect(intervalCovered(ms("2026-10-12T15:00:00Z"), ms("2026-10-12T19:00:00Z"), gap)).toBe(true)
    expect(intervalCovered(ms("2026-10-12T15:00:00Z"), ms("2026-10-12T19:00:00Z"), [])).toBe(false)
  })
})

describe("coverage with an unreadable TAF", () => {
  it("counts a TAF with an empty or unparseable validity as no TAF", () => {
    expect(coverage({ ...base, origin: { id: "KPDX", taf: taf("", "") } })).toEqual({
      preliminary: false,
      reasons: [],
    })
    expect(
      coverage({
        ...base,
        destination: { id: "KBDN", taf: taf("garbage", "2026-10-13T18:00:00Z") },
      }),
    ).toEqual({ preliminary: false, reasons: [] })
  })
})
