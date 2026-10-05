import { describe, expect, it } from "vitest"
import { buildFlightPlan, formatFplMessage } from "../src/lib/fpl.ts"

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
