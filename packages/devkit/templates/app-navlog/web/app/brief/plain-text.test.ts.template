import { describe, expect, test } from "vitest"
import { briefPlainText } from "./plain-text"

const ANSWER = JSON.stringify({
  ui: [
    {
      BottomLine: {
        props: { level: "CAUTION", reason: "Gusts to 25 kt at KRST.", cite: ["c2"] },
      },
    },
    {
      RouteSummary: {
        props: {
          from: "KSTP",
          to: "KRST",
          via: ["KOWA"],
          altitudeFt: 4500,
          departureUtc: "2026-10-10 1500Z",
        },
      },
    },
    {
      WatchFor: {
        props: {
          items: [
            {
              what: "Gusty crosswind at KRST",
              when: "1530Z–1600Z",
              severity: "caution",
              cite: ["c2"],
            },
            { what: "Haze", when: null, severity: "info", cite: [] },
          ],
        },
      },
    },
    {
      KeyNumbers: {
        props: {
          items: [
            { label: "ETE", value: "1:12", unit: null, cite: [] },
            { label: "Fuel burned", value: "9.4", unit: "gal", cite: ["c1"] },
          ],
        },
      },
    },
    {
      Assumptions: {
        props: { items: [{ statement: "Full fuel, 40 gal usable.", origin: "default" }] },
      },
    },
    {
      Citations: {
        props: {
          items: [
            { id: "c1", source: "poh/cruise-performance.md", locator: "Figure 5-7" },
            { id: "c2", source: "METAR KRST", locator: "1353Z" },
          ],
        },
      },
    },
    { Prose: { props: { markdown: 'recall({ query: "x" })\nWant me to **file** it?' } } },
  ],
})

describe("briefPlainText", () => {
  test("reads a planning answer as lines a pilot can paste anywhere", () => {
    expect(briefPlainText(ANSWER)).toBe(
      [
        "Bottom line: CAUTION. Gusts to 25 kt at KRST. [2]",
        "",
        "Route: KSTP → KOWA → KRST at 4,500 ft, departing 2026-10-10 1500Z",
        "",
        "Watch for:",
        "- Caution: Gusty crosswind at KRST (1530Z–1600Z) [2]",
        "- Info: Haze",
        "",
        "Key numbers:",
        "- ETE: 1:12",
        "- Fuel burned: 9.4 gal [1]",
        "",
        "Assumptions:",
        "- Full fuel, 40 gal usable. (Default)",
        "",
        "Sources:",
        "1. poh/cruise-performance.md, Figure 5-7",
        "2. METAR KRST, 1353Z",
        "",
        "Want me to **file** it?",
      ].join("\n"),
    )
  })

  test("a single Prose is just its text", () => {
    expect(
      briefPlainText(JSON.stringify({ ui: [{ Prose: { props: { markdown: "Filed." } } }] })),
    ).toBe("Filed.")
  })

  test("empty lists: nothing to watch is said, empty numbers and assumptions are left out", () => {
    const text = briefPlainText(
      JSON.stringify({
        ui: [
          { WatchFor: { props: { items: [] } } },
          { KeyNumbers: { props: { items: [] } } },
          { Assumptions: { props: { items: [] } } },
        ],
      }),
    )
    expect(text).toBe("Watch for: nothing during the flight")
  })

  test("markdown, a partial answer, or JSON that is not an answer is null", () => {
    expect(briefPlainText("**Filed.**")).toBeNull()
    expect(briefPlainText('{"ui":[{"Prose":{"props":{"markdown":"Fi')).toBeNull()
    expect(briefPlainText('{"ui": 3}')).toBeNull()
  })
})
