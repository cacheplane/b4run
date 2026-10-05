import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { FlightPlanBlock, fplMessage } from "./FlightPlanBlock"

describe("FlightPlanBlock", () => {
  test("renders items 7 to 19 with their ICAO labels", () => {
    const html = renderToStaticMarkup(<FlightPlanBlock plan={SAMPLE_NAVLOG.flightPlan} />)
    for (const label of [
      "7 Aircraft ID",
      "8 Rules / type",
      "9 Type / wake",
      "10 Equipment",
      "13 Departure",
      "15 Speed / level / route",
      "16 Destination / EET",
      "18 Other",
      "19 Endurance / POB",
    ]) {
      expect(html).toContain(label)
    }
    expect(html).toContain("N738ZU")
    expect(html).toContain("KRST0033")
  })
  test("formats the FPL message for the copy button", () => {
    expect(fplMessage(SAMPLE_NAVLOG.flightPlan)).toBe(
      "(FPL-N738ZU-VG\n-C172/L-SG/C\n-KSTP1400\n-N0110VFR DCT\n-KRST0033\n-DOF/261006\n-E/0707 P/1)",
    )
  })
})
