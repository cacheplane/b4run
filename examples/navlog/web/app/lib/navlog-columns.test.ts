import { describe, expect, test } from "vitest"
import { LEG_COLUMNS, legName, totalFor } from "./navlog-columns"
import { SAMPLE_NAVLOG } from "./navlog-types"

describe("navlog columns", () => {
  test("the fourteen figures, in paper-navlog order", () => {
    expect(LEG_COLUMNS.map((c) => c.label)).toEqual([
      "TC",
      "Var",
      "MC",
      "Wind",
      "WCA",
      "MH",
      "TAS",
      "GS",
      "Dist",
      "Rem",
      "ETE",
      "ETA",
      "Fuel",
      "Fuel rem",
    ])
    for (const c of LEG_COLUMNS) expect(c.title.length).toBeGreaterThan(0)
  })
  test("every column formats a leg", () => {
    const leg = SAMPLE_NAVLOG.legs[0]
    if (leg === undefined) throw new Error("sample has no legs")
    for (const c of LEG_COLUMNS) expect(typeof c.value(leg)).toBe("string")
    expect(legName(leg)).toBe(`${leg.from} → ${leg.to} (${leg.segment})`)
  })
  test("totals exist for distance, ETE and fuel only", () => {
    expect(totalFor(SAMPLE_NAVLOG, "dist")).toBe(String(SAMPLE_NAVLOG.totals.distanceNm))
    expect(totalFor(SAMPLE_NAVLOG, "mh")).toBe("")
  })
})
