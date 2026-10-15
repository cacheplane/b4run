import { describe, expect, it } from "vitest"
import { advisoryRelevance, altitudeFt, toAdvisoryFact } from "../src/lib/forecast/advisories.ts"

const ms = (iso: string): number => Date.parse(iso)
const DEP = ms("2026-10-12T20:00:00Z")
const ETA = ms("2026-10-12T21:02:00Z")

describe("advisoryRelevance", () => {
  it("during flight when it starts before the ETA and ends after the departure", () => {
    expect(
      advisoryRelevance(ms("2026-10-12T18:00:00Z"), ms("2026-10-13T00:00:00Z"), DEP, ETA),
    ).toBe("during-flight")
  })
  it("during flight when it has no end", () => {
    expect(advisoryRelevance(ms("2026-10-12T18:00:00Z"), null, DEP, ETA)).toBe("during-flight")
  })
  it("before departure when it ends at the departure", () => {
    expect(advisoryRelevance(ms("2026-10-12T15:00:00Z"), DEP, DEP, ETA)).toBe("before-departure")
  })
  it("after arrival when it starts at the ETA", () => {
    expect(advisoryRelevance(ETA, ms("2026-10-13T03:00:00Z"), DEP, ETA)).toBe("after-arrival")
  })
})

describe("altitudeFt", () => {
  it("reads the tool's altitude strings", () => {
    expect(altitudeFt("4,000 ft")).toBe(4000)
    expect(altitudeFt("surface")).toBe(0)
    expect(altitudeFt("FL290")).toBe(29000)
    expect(altitudeFt("freezing level")).toBeNull()
    expect(altitudeFt(undefined)).toBeNull()
  })
})

describe("toAdvisoryFact", () => {
  it("takes a freezing-level contour's altitude as both bounds", () => {
    const fact = toAdvisoryFact(
      {
        product: "G-AIRMET",
        hazard: "FZLVL",
        freezingLevel: "8,000 ft",
        validFrom: "2026-10-12T18:00:00.000Z",
        validTo: "2026-10-13T00:00:00.000Z",
      },
      DEP,
      ETA,
    )
    expect(fact).toEqual({
      product: "G-AIRMET",
      hazard: "FZLVL",
      lowestFt: 8000,
      highestFt: 8000,
      validFromUtc: "2026-10-12T18:00:00.000Z",
      validToUtc: "2026-10-13T00:00:00.000Z",
      relevance: "during-flight",
    })
  })
})
