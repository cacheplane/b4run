import { describe, expect, it } from "vitest"
import { buildFlightPlan, formatFplMessage, parseUtcInstant } from "../src/lib/fpl.ts"

const plan = buildFlightPlan({
  tailNumber: "N738ZU",
  departure: "KSTP",
  destination: "KRST",
  route: ["FGT", "KOWA"],
  departureTimeUtc: "2026-10-05T14:00:00Z",
  cruiseTasKt: 110,
  altitudeFt: 4500,
  eteMin: 48,
  enduranceMin: 400,
  personsOnBoard: 2,
})

describe("ICAO flight plan", () => {
  it("fills items 7 to 19 from the navlog", () => {
    expect(plan).toEqual({
      item7: "N738ZU",
      item8: "VG",
      item9: "C172/L",
      item10: "SG/C",
      item13: "KSTP1400",
      item15: "N0110VFR DCT FGT DCT KOWA DCT",
      item16: "KRST0048",
      item18: "DOF/261005",
      item19: "E/0640 P/2",
    })
  })
  it("formats the FPL message", () => {
    expect(formatFplMessage(plan)).toBe(
      "(FPL-N738ZU-VG\n-C172/L-SG/C\n-KSTP1400\n-N0110VFR DCT FGT DCT KOWA DCT\n-KRST0048\n-DOF/261005\n-E/0640 P/2)",
    )
  })
  it("rejects a departure time that is not an ISO 8601 UTC instant", () => {
    expect(() => buildFlightPlan({ ...planInput(), departureTimeUtc: "tomorrow 9am" })).toThrow(
      'departureTimeUtc must be an ISO 8601 UTC instant such as 2026-10-06T14:00:00Z, a UTC time such as 1400Z, or "tomorrow 1400Z", got "tomorrow 9am"',
    )
  })
  it('reads "tomorrow 1500Z" as the first 1500Z at least 12 hours ahead', () => {
    // The live demo, 2026-10-06 at 1450Z: "tomorrow, leaving around 1500Z" is
    // 7 October, not today's 1500Z ten minutes away.
    const lateMorning = () => Date.parse("2026-10-06T14:50:00Z")
    expect(parseUtcInstant("tomorrow 1500Z", lateMorning).toISOString()).toBe(
      "2026-10-07T15:00:00.000Z",
    )
    // A US pilot at 8 pm Central (0100Z on the 7th) also means the 7th.
    const usEvening = () => Date.parse("2026-10-07T01:00:00Z")
    expect(parseUtcInstant("Tomorrow 1500Z", usEvening).toISOString()).toBe(
      "2026-10-07T15:00:00.000Z",
    )
    // "today" is the plain next occurrence.
    expect(parseUtcInstant("today 1500Z", lateMorning).toISOString()).toBe(
      "2026-10-06T15:00:00.000Z",
    )
    expect(parseUtcInstant("1500Z tomorrow", lateMorning).toISOString()).toBe(
      "2026-10-07T15:00:00.000Z",
    )
    const plan = buildFlightPlan(
      { ...planInput(), departureTimeUtc: "tomorrow 1500Z" },
      lateMorning,
    )
    expect(plan.item13).toBe("KSTP1500")
    expect(plan.item18).toBe("DOF/261007")
  })
  it("reads a UTC clock time as its next occurrence", () => {
    const before = () => Date.parse("2026-10-06T09:30:00Z")
    const after = () => Date.parse("2026-10-06T15:00:00Z")
    expect(parseUtcInstant("1400Z", before).toISOString()).toBe("2026-10-06T14:00:00.000Z")
    expect(parseUtcInstant("1400Z", after).toISOString()).toBe("2026-10-07T14:00:00.000Z")
    expect(parseUtcInstant("1400z", before).toISOString()).toBe("2026-10-06T14:00:00.000Z")
    expect(() => parseUtcInstant("2460Z", before)).toThrow(
      /a UTC time such as 1400Z, or "tomorrow 1400Z", got "2460Z"/,
    )
    const plan = buildFlightPlan({ ...planInput(), departureTimeUtc: "1400Z" }, after)
    expect(plan.item13).toBe("KSTP1400")
    expect(plan.item18).toBe("DOF/261007")
  })
  it("writes DCT alone for a direct flight", () => {
    const direct = buildFlightPlan({ ...planInput(), route: [] })
    expect(direct.item15).toBe("N0110VFR DCT")
  })
  it("rounds minutes before splitting hours, so 59.6 min is 0100", () => {
    const plan = buildFlightPlan({ ...planInput(), eteMin: 59.6, enduranceMin: 119.5 })
    expect(plan.item16).toBe("KRST0100")
    expect(plan.item19).toBe("E/0200 P/2")
  })
})

function planInput() {
  return {
    tailNumber: "N738ZU",
    departure: "KSTP",
    destination: "KRST",
    route: ["FGT", "KOWA"],
    departureTimeUtc: "2026-10-05T14:00:00Z",
    cruiseTasKt: 110,
    altitudeFt: 4500,
    eteMin: 48,
    enduranceMin: 400,
    personsOnBoard: 2,
  }
}
