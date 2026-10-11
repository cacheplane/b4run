import { describe, expect, test } from "vitest"
import { parseWindsLine, windsSummary } from "./winds"

describe("winds aloft", () => {
  test("the older, wordy line reads compactly and drops temp NA", () => {
    const raw =
      "leg 1: 318/26, temp NA at 5,500 ft, MSP, based on 060000Z, valid 070000Z (FB chi region, 24-hour forecast used)"
    expect(parseWindsLine(raw)).toMatchObject({
      leg: 1,
      dir: 318,
      kt: 26,
      tempC: null,
      altitudeFt: 5500,
      station: "MSP",
      forecastHours: 24,
    })
    expect(windsSummary(raw)).toBe("Winds 5,500 ft: 318° at 26 kt (MSP, 24 h forecast)")
  })
  test("the contract line keeps its temperature", () => {
    expect(windsSummary("leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z")).toBe(
      "Winds 4,500 ft: 320° at 29 kt, −3 °C (MSP)",
    )
    expect(windsSummary("leg 2: 090/05 at 3000 ft")).toBe("Winds 3,000 ft: 090° at 5 kt")
  })
  test("an unparseable line passes through", () => {
    expect(windsSummary("winds unavailable")).toBe("winds unavailable")
  })
})
