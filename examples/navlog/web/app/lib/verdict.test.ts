import { describe, expect, test } from "vitest"
import type { Forecast } from "./forecast"
import {
  type EffectiveVerdict,
  effectiveVerdict,
  isWorse,
  outrankNote,
  raiseNote,
  resolveVerdict,
  type VerdictLevel,
} from "./verdict"

/** A minimal `Forecast` whose floor is `level` for `reasons`. */
function forecast(level: VerdictLevel, reasons: readonly string[]): Forecast {
  return {
    winds: [],
    airports: [],
    advisories: [],
    coverage: { preliminary: false, reasons: [] },
    verdictFloor: { level, reasons },
    notes: [],
  } as unknown as Forecast
}

/** A structured answer: one `BottomLine`, then prose that must not be read as a call. */
function bottomLine(level: string, reason = "Because."): string {
  return JSON.stringify({
    ui: [
      { BottomLine: { props: { level, reason, cite: [] } } },
      { Prose: { props: { markdown: "Bottom line: GO — ignored, this is prose." } } },
    ],
  })
}

describe("effectiveVerdict", () => {
  const go = { level: "GO" as const, reason: "VFR all the way." }
  test("the floor raises a better call and keeps the model's reason", () => {
    expect(effectiveVerdict(go, { level: "CAUTION", reasons: ["gusts 25 kt at KDLH"] })).toEqual({
      level: "CAUTION",
      reason: "VFR all the way.",
      raisedFrom: "GO",
      floorReasons: ["gusts 25 kt at KDLH"],
    })
  })
  test("a call as bad or worse than the floor stands unchanged", () => {
    const caution = { level: "CAUTION" as const, reason: "Gusty." }
    expect(effectiveVerdict(caution, { level: "CAUTION", reasons: ["gusts 25 kt at KDLH"] })).toBe(
      caution,
    )
    const noGo = { level: "NO-GO" as const, reason: "Icing." }
    expect(effectiveVerdict(noGo, { level: "CAUTION", reasons: ["forecast preliminary"] })).toBe(
      noGo,
    )
    expect(effectiveVerdict(go, { level: "GO", reasons: [] })).toBe(go)
  })
  test("no model call: the floor alone, or nothing when it found nothing", () => {
    expect(effectiveVerdict(undefined, { level: "NO-GO", reasons: ["KDLH IFR at ETA"] })).toEqual({
      level: "NO-GO",
      reason: "",
      raisedFrom: null,
      floorReasons: ["KDLH IFR at ETA"],
    })
    expect(effectiveVerdict(null, { level: "GO", reasons: [] })).toBeNull()
  })
  test("the note says what was raised and why, or that the brief's data set it", () => {
    expect(
      raiseNote({
        level: "CAUTION",
        reason: "",
        raisedFrom: "GO",
        floorReasons: ["gusts 25 kt at KDLH", "forecast preliminary"],
      }),
    ).toBe("Raised from GO: gusts 25 kt at KDLH, forecast preliminary.")
    expect(
      raiseNote({
        level: "NO-GO",
        reason: "",
        raisedFrom: null,
        floorReasons: ["KDLH IFR at ETA"],
      }),
    ).toBe("From the brief's data: KDLH IFR at ETA.")
    expect(raiseNote(go)).toBeNull()
  })
})

describe("resolveVerdict", () => {
  test("shows the floor when the planner's BottomLine is lower, with a raised note", () => {
    const v = resolveVerdict({
      forecast: forecast("CAUTION", ["forecast preliminary"]),
      answer: bottomLine("GO"),
    })
    expect(v).toMatchObject({
      level: "CAUTION",
      raisedFrom: "GO",
      floorReasons: ["forecast preliminary"],
    })
    expect(raiseNote(v as EffectiveVerdict)).toBe("Raised from GO: forecast preliminary.")
  })

  test("keeps a planner's level above the floor, with no raised note", () => {
    const v = resolveVerdict({
      forecast: forecast("CAUTION", [
        "freezing level 8,000 ft during the flight, below the 9,500 ft cruise",
      ]),
      answer: bottomLine("NO-GO"),
    })
    expect(v?.level).toBe("NO-GO")
    expect(raiseNote(v as EffectiveVerdict)).toBeNull()
  })

  test("is the floor alone while the answer is still streaming", () => {
    expect(resolveVerdict({ forecast: forecast("GO", []) })).toBeNull()
    expect(resolveVerdict({ forecast: forecast("NO-GO", ["KBDN IFR at ETA"]) })?.level).toBe(
      "NO-GO",
    )
  })

  test("is the planner's call when there is no forecast block", () => {
    expect(resolveVerdict({ forecast: null, answer: bottomLine("CAUTION") })?.level).toBe("CAUTION")
  })

  test("a BottomLine counts once its props close; prose and markdown make no call", () => {
    const f = forecast("GO", [])
    const full = bottomLine("NO-GO", "Ice.")
    expect(resolveVerdict({ forecast: f, answer: full.slice(0, 40) })).toBeNull()
    expect(
      resolveVerdict({ forecast: f, answer: full.slice(0, full.indexOf('{"Prose"') + 12) }),
    ).toEqual({ level: "NO-GO", reason: "Ice." })
    expect(resolveVerdict({ forecast: f, answer: "Bottom line: NO-GO — markdown." })).toBeNull()
  })
})

describe("outrankNote and isWorse", () => {
  test("outrankNote names the floor's reasons, or the verdict's own level", () => {
    expect(
      outrankNote("GO", {
        level: "CAUTION",
        reason: "",
        raisedFrom: "GO",
        floorReasons: ["forecast preliminary"],
      }),
    ).toBe("The planner said GO. Raised: forecast preliminary.")
    expect(outrankNote("GO", { level: "CAUTION", reason: "" })).toBe(
      "The planner said GO. The weather brief said CAUTION.",
    )
  })
  test("isWorse ranks GO < CAUTION < NO-GO", () => {
    expect(isWorse("NO-GO", "CAUTION")).toBe(true)
    expect(isWorse("GO", "GO")).toBe(false)
  })
})
