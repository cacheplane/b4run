import { describe, expect, it } from "vitest"
import { flightCategory } from "../src/lib/flight-category.ts"

describe("flightCategory", () => {
  it("grades ceiling and visibility by the FAA flight categories", () => {
    expect(flightCategory(undefined, 6)).toBe("VFR")
    expect(flightCategory(3000, 10)).toBe("MVFR")
    expect(flightCategory(5000, 5)).toBe("MVFR")
    expect(flightCategory(900, 10)).toBe("IFR")
    expect(flightCategory(400, 10)).toBe("LIFR")
    expect(flightCategory(5000, 0.5)).toBe("LIFR")
    expect(flightCategory(undefined, undefined)).toBeUndefined()
  })
})
