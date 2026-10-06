import { describe, expect, test } from "vitest"
import {
  flightPlanSummary,
  formatFeet,
  humanizeToolName,
  outcomeFromResult,
  presentTool,
  stripMemoryIds,
  subagentTitle,
} from "./tool-presentation"

const FLIGHT_PLAN = {
  item7: "N738ZU",
  item8: "VG",
  item9: "C172/L",
  item10: "SG/C",
  item13: "KFCM1500",
  item15: "N0109VFR DCT",
  item16: "KDLH0125",
  item18: "DOF/261007",
  item19: "E/0716 P/1",
}

describe("presentTool titles", () => {
  test.each([
    [
      "recall",
      { query: "aircraft profile and pilot preferences" },
      "Checked saved aircraft profile",
    ],
    ["recall", { query: "favorite fuel stop" }, "Checked saved notes"],
    ["getMetar", { ids: ["kfcm", "kdlh"] }, "Current weather (METAR) for KFCM, KDLH"],
    ["getTaf", { ids: ["KFCM"] }, "Forecasts (TAF) for KFCM"],
    [
      "getWindsAloft",
      { station: "msp", altitudeFt: 5500, region: "us" },
      "Winds aloft at 5,500 ft near MSP",
    ],
    ["getAdvisories", { lat: 44.8312, lon: -93.4711 }, "Advisories near 44.83, -93.47"],
    ["lookupAirport", { id: "kfcm" }, "Airport info: KFCM"],
    ["readDoc", { path: "poh/cruise-performance.md" }, "Read POH: cruise performance"],
    ["computeNavlog", {}, "Computed the navlog"],
    ["fileFlightPlan", {}, "Recorded flight plan"],
    ["writeFile", { path: "reports/KFCM-KDLH.md" }, "Saved report"],
    ["writeFile", { path: "notes.txt" }, "Saved a file"],
    ["renderChart", { title: "Fuel remaining" }, "Chart: Fuel remaining"],
    ["task", { subagent: "weather" }, "Weather briefer"],
    ["task", { subagent: "performance" }, "Performance briefer"],
    ["mysteryTool", {}, "Mystery tool"],
  ] as const)("%s %j → %s", (name, args, title) => {
    expect(presentTool(name, args, undefined, "done").title).toBe(title)
  })

  test("uses the present tense while a call runs", () => {
    expect(presentTool("computeNavlog", {}, undefined, "running").title).toBe(
      "Computing the navlog",
    )
    expect(
      presentTool("readDoc", { path: "poh/cruise-performance.md" }, undefined, "running").title,
    ).toBe("Reading POH: cruise performance")
  })

  test("never echoes the tool's own name as the title, so the name tag stays unique", () => {
    for (const name of ["recall", "getMetar", "readDoc", "computeNavlog", "writeFile", "task"]) {
      expect(presentTool(name, {}, undefined, "done").title).not.toBe(name)
    }
  })
})

describe("presentTool summaries", () => {
  test("counts saved facts and never shows a memory id", () => {
    const result =
      "memory_98f81ea4afc0e25a: Aircraft tail number N738ZU\nmemory_aa11bb22cc: Cruise 2400 RPM\nmemory_ffee0011: Usable fuel 40 gal"
    const { summary } = presentTool("recall", { query: "aircraft profile" }, result, "done")
    expect(summary).toBe("3 saved facts")
    expect(presentTool("recall", {}, "(no memories found)", "done").summary).toBe(
      "Nothing saved yet",
    )
  })

  test("METARs: one category for all, or each airport's", () => {
    const same = JSON.stringify([
      { id: "KFCM", flightCategory: "VFR" },
      { id: "KDLH", flightCategory: "VFR" },
    ])
    expect(presentTool("getMetar", {}, same, "done").summary).toBe("2 airports VFR")
    const mixed = JSON.stringify([
      { id: "KFCM", flightCategory: "VFR" },
      { id: "KDLH", flightCategory: "MVFR" },
    ])
    expect(presentTool("getMetar", {}, mixed, "done").summary).toBe("KFCM VFR · KDLH MVFR")
  })

  test("navlog totals as distance · time · fuel", () => {
    const result = JSON.stringify({ totals: { distanceNm: 132, eteMin: 85, fuelGal: 11.4 } })
    expect(presentTool("computeNavlog", {}, result, "done").summary).toBe(
      "132 nm · 1:25 · 11.4 gal",
    )
  })

  test("winds, advisories, airport, forecasts", () => {
    expect(
      presentTool(
        "getWindsAloft",
        {},
        JSON.stringify({ wind: { dirDegTrue: 70, speedKt: 18.4 } }),
        "done",
      ).summary,
    ).toBe("070° at 18 kt")
    expect(presentTool("getAdvisories", {}, "[]", "done").summary).toBe("None on the route")
    expect(
      presentTool(
        "getAdvisories",
        {},
        JSON.stringify([
          { product: "AIRMET", hazard: "IFR" },
          { product: "AIRMET", hazard: "IFR" },
        ]),
        "done",
      ).summary,
    ).toBe("2 advisories: AIRMET IFR")
    expect(
      presentTool(
        "lookupAirport",
        { id: "KFCM" },
        JSON.stringify({ name: "Flying Cloud", elevationFt: 906 }),
        "done",
      ).summary,
    ).toBe("Flying Cloud · elev 906 ft")
    expect(presentTool("getTaf", {}, "[{},{}]", "done").summary).toBe("2 forecasts")
  })

  test("a recorded flight plan names where it went and that it was not sent", () => {
    const result = JSON.stringify({ status: "recorded", path: "flight-plans/261007-KFCM-KDLH.txt" })
    expect(presentTool("fileFlightPlan", { flightPlan: FLIGHT_PLAN }, result, "done").summary).toBe(
      "Saved to flight-plans/261007-KFCM-KDLH.txt · not transmitted",
    )
  })

  test("a result of the wrong shape yields no summary rather than a wrong one", () => {
    expect(presentTool("computeNavlog", {}, "not json", "done").summary).toBeUndefined()
    expect(presentTool("getMetar", {}, '{"oops":1}', "done").summary).toBeUndefined()
  })
})

describe("flightPlanSummary", () => {
  test("reads the ICAO items into one plain line", () => {
    expect(flightPlanSummary(FLIGHT_PLAN)).toBe(
      "N738ZU · KFCM → KDLH · depart 1500Z 7 Oct · 109 kt VFR direct · en route 1:25 · endurance 7:16 · 1 aboard",
    )
  })

  test("names the fixes of a routed plan", () => {
    expect(flightPlanSummary({ ...FLIGHT_PLAN, item15: "N0110VFR DCT KSTC DCT DCT" })).toContain(
      "110 kt VFR via KSTC",
    )
  })

  test("drops what it cannot read instead of guessing", () => {
    expect(flightPlanSummary({ item7: "N738ZU", item13: "garbage" })).toBe("N738ZU")
    expect(flightPlanSummary(undefined)).toBeUndefined()
    expect(flightPlanSummary({})).toBeUndefined()
  })
})

describe("helpers", () => {
  test("stripMemoryIds", () => {
    expect(stripMemoryIds("memory_98f81ea4afc0e25a: Aircraft tail number")).toBe(
      "Aircraft tail number",
    )
  })

  test("formatFeet groups thousands without the locale", () => {
    expect(formatFeet(5500)).toBe("5,500")
    expect(formatFeet(12500)).toBe("12,500")
    expect(formatFeet(906)).toBe("906")
  })

  test("humanizeToolName and subagentTitle", () => {
    expect(humanizeToolName("getWindsAloft")).toBe("Get winds aloft")
    expect(subagentTitle("weather")).toBe("Weather briefer")
    expect(subagentTitle("research")).toBe("Research helper")
    expect(subagentTitle(undefined)).toBe("Helper")
  })

  test("outcomeFromResult reads only the failure shapes B4.run produces", () => {
    expect(outcomeFromResult("Permission denied by user: tool fileFlightPlan")).toBe("denied")
    expect(outcomeFromResult("Error: upstream timed out")).toBe("error")
    expect(outcomeFromResult('{"error":"bad station"}')).toBe("error")
    expect(outcomeFromResult("All good, no Error here")).toBe("done")
    expect(outcomeFromResult(undefined)).toBe("done")
  })
})
