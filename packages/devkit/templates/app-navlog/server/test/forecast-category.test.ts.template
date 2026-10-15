import { describe, expect, it } from "vitest"
import { categoryAt, type Taf, worstCategory } from "../src/lib/forecast/taf.ts"

const ms = (iso: string): number => Date.parse(iso)
const window = (from: string, to: string) => ({ fromMs: ms(from), toMs: ms(to) })

const TAF: Taf = {
  id: "KBDN",
  issuedAt: "2026-10-12T11:21:00.000Z",
  validFromUtc: "2026-10-12T12:00:00.000Z",
  validToUtc: "2026-10-13T12:00:00.000Z",
  raw: "TAF KBDN …",
  periods: [
    {
      change: "BASE",
      fromUtc: "2026-10-12T12:00:00.000Z",
      toUtc: "2026-10-12T19:00:00.000Z",
      flightCategory: "VFR",
    },
    {
      change: "FM",
      fromUtc: "2026-10-12T19:00:00.000Z",
      toUtc: "2026-10-13T05:00:00.000Z",
      flightCategory: "MVFR",
    },
    {
      change: "TEMPO",
      fromUtc: "2026-10-12T22:00:00.000Z",
      toUtc: "2026-10-13T01:00:00.000Z",
      flightCategory: "IFR",
    },
    {
      change: "FM",
      fromUtc: "2026-10-13T05:00:00.000Z",
      toUtc: "2026-10-13T12:00:00.000Z",
      flightCategory: "VFR",
    },
  ],
}

describe("categoryAt", () => {
  it("reads the BASE or FM period that contains the time", () => {
    expect(
      categoryAt(
        TAF,
        ms("2026-10-12T15:00:00Z"),
        window("2026-10-12T14:00:00Z", "2026-10-12T15:00:00Z"),
      ),
    ).toBe("VFR")
    expect(
      categoryAt(
        TAF,
        ms("2026-10-12T20:00:00Z"),
        window("2026-10-12T19:30:00Z", "2026-10-12T20:00:00Z"),
      ),
    ).toBe("MVFR")
  })

  it("is made worse by a TEMPO overlapping the flight window", () => {
    expect(
      categoryAt(
        TAF,
        ms("2026-10-12T21:00:00Z"),
        window("2026-10-12T20:00:00Z", "2026-10-12T22:30:00Z"),
      ),
    ).toBe("IFR")
  })

  it("ignores a TEMPO that ends exactly when the window opens", () => {
    expect(
      categoryAt(
        TAF,
        ms("2026-10-13T02:00:00Z"),
        window("2026-10-13T01:00:00Z", "2026-10-13T02:00:00Z"),
      ),
    ).toBe("MVFR")
  })

  it("is null when no period contains the time", () => {
    expect(
      categoryAt(
        TAF,
        ms("2026-10-13T13:00:00Z"),
        window("2026-10-13T12:30:00Z", "2026-10-13T13:00:00Z"),
      ),
    ).toBeNull()
  })

  it("is null for a period with no category", () => {
    const blank: Taf = {
      ...TAF,
      periods: [{ change: "BASE", fromUtc: TAF.validFromUtc, toUtc: TAF.validToUtc }],
    }
    expect(
      categoryAt(
        blank,
        ms("2026-10-12T15:00:00Z"),
        window("2026-10-12T14:00:00Z", "2026-10-12T15:00:00Z"),
      ),
    ).toBeNull()
  })
})

describe("worstCategory", () => {
  it("ranks LIFR worst and ignores null", () => {
    expect(worstCategory("VFR", "MVFR")).toBe("MVFR")
    expect(worstCategory("LIFR", "IFR")).toBe("LIFR")
    expect(worstCategory(null, "VFR")).toBe("VFR")
    expect(worstCategory(null, null)).toBeNull()
  })
})
