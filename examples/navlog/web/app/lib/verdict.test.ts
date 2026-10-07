import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "./navlog-types"
import {
  effectiveVerdict,
  maxGustKt,
  raiseNote,
  resolveVerdict,
  verdictFloor,
  worseLevel,
} from "./verdict"
import { parseWeatherBrief } from "./weather-selectors"

/**
 * The brief from the live run that said GO: gusts to 25 kt at both airports,
 * and a departure 21 hours out, beyond the TAFs.
 */
const GUSTY_GO = `Verdict: GO — VFR at both ends and light winds aloft.
Forecast horizon: Departure is 21 hours out; the TAFs do not reach it yet, so this brief is preliminary.
Airports:
KFCM: VFR now, VFR at ETA, ceiling none, visibility 10 mi, wind 300 at 15 gusting 25. METAR KFCM 061553Z 30015G25KT 10SM CLR 08/M02 A3012 TAF KFCM 061120Z 0612/0712 30014G24KT P6SM SKC
KDLH: VFR now, VFR at ETA, ceiling 6000 ft, visibility 10 mi, wind 310 at 14 gusting 25. METAR KDLH 061555Z 31014G25KT 10SM BKN060 04/M03 A3009 TAF KDLH 061120Z 0612/0712 31012G22KT P6SM BKN060
Winds per leg:
leg 1: 318/26 -4C at 5,500 ft, MSP, valid 070000Z
Advisories:
none
Go/no-go note: Expect a gusty crosswind on landing.`

/** A brief in the contract's shape, with the parts each test varies. */
function brief({
  verdict = "Verdict: GO — VFR all the way.",
  horizon = "Forecast horizon: Departure is 3 hours out, within TAF coverage.",
  kfcm = "VFR now, VFR at ETA. METAR KFCM 061553Z 30008KT 10SM CLR 08/M02 A3012 TAF KFCM 061120Z 0612/0712 30008KT P6SM SKC",
  kdlh = "VFR now, VFR at ETA. METAR KDLH 061555Z 31012KT 10SM BKN060 04/M03 A3009 TAF KDLH 061120Z 0612/0712 31010KT P6SM BKN060",
  advisories = ["none"],
}: {
  verdict?: string
  horizon?: string
  kfcm?: string
  kdlh?: string
  advisories?: readonly string[]
} = {}) {
  return parseWeatherBrief(
    [
      verdict,
      horizon,
      "Airports:",
      `KFCM: ${kfcm}`,
      `KDLH: ${kdlh}`,
      "Winds per leg:",
      "leg 1: 318/26 -4C at 5,500 ft, MSP, valid 070000Z",
      "Advisories:",
      ...advisories,
      "Go/no-go note: Fly it.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  )
}

describe("maxGustKt", () => {
  test("reads the highest gust group, VRB included", () => {
    expect(maxGustKt("METAR KDLH 061555Z 31014G25KT 10SM")).toBe(25)
    expect(maxGustKt("TAF KDLH 0612/0712 31012G22KT FM061800 VRB05G28KT")).toBe(28)
    expect(maxGustKt("METAR KDLH 061555Z 240110G125KT")).toBe(125)
    expect(maxGustKt("METAR KDLH 061555Z 31014KT 10SM")).toBeNull()
    // A time group or a TAF validity period is not a wind.
    expect(maxGustKt("TAF KDLH 061120Z 0612/0712")).toBeNull()
  })
})

describe("verdictFloor", () => {
  test("a clean brief and a navlog with reserve: GO, no reasons", () => {
    expect(verdictFloor(brief(), { cruiseFt: 5500, navlog: SAMPLE_NAVLOG })).toEqual({
      level: "GO",
      reasons: [],
    })
  })
  test("no brief and no navlog: GO", () => {
    expect(verdictFloor(null)).toEqual({ level: "GO", reasons: [] })
  })
  test("IFR or LIFR at the ETA is NO-GO", () => {
    expect(verdictFloor(brief({ kdlh: "VFR now, IFR at ETA" }))).toEqual({
      level: "NO-GO",
      reasons: ["KDLH IFR at ETA"],
    })
    expect(verdictFloor(brief({ kfcm: "MVFR now, LIFR at ETA" })).reasons).toEqual([
      "KFCM LIFR at ETA",
    ])
  })
  test("IFR now but VFR at the ETA is not a NO-GO", () => {
    expect(verdictFloor(brief({ kdlh: "IFR now, VFR at ETA" })).level).toBe("GO")
  })
  test("MVFR now or at the ETA is CAUTION", () => {
    expect(verdictFloor(brief({ kdlh: "MVFR now, VFR at ETA" }))).toEqual({
      level: "CAUTION",
      reasons: ["KDLH MVFR now"],
    })
    expect(verdictFloor(brief({ kdlh: "VFR now, MVFR at ETA" })).reasons).toEqual([
      "KDLH MVFR at ETA",
    ])
    expect(verdictFloor(brief({ kdlh: "MVFR now, MVFR at ETA" })).reasons).toEqual([
      "KDLH MVFR now and at ETA",
    ])
  })
  test("gusts over 20 kt in the METAR or the TAF are CAUTION; 20 kt is not", () => {
    expect(
      verdictFloor(brief({ kdlh: "VFR now, VFR at ETA. METAR KDLH 061555Z 31014G25KT 10SM" })),
    ).toEqual({ level: "CAUTION", reasons: ["gusts 25 kt at KDLH"] })
    expect(
      verdictFloor(
        brief({
          kdlh: "VFR now, VFR at ETA. METAR KDLH 061555Z 31010KT TAF KDLH 0612/0712 VRB08G23KT",
        }),
      ).reasons,
    ).toEqual(["gusts 23 kt at KDLH in the TAF"])
    expect(
      verdictFloor(
        brief({
          kdlh: "VFR now, VFR at ETA. METAR KDLH 061555Z 31014G22KT TAF KDLH 0612/0712 31015G30KT",
        }),
      ).reasons,
    ).toEqual(["gusts 22 kt at KDLH (30 kt in the TAF)"])
    expect(
      verdictFloor(brief({ kdlh: "VFR now, VFR at ETA. METAR KDLH 061555Z 31012G20KT" })).level,
    ).toBe("GO")
  })
  test("a preliminary horizon is CAUTION", () => {
    expect(
      verdictFloor(
        brief({
          horizon: "Forecast horizon: Departure is 37 hours out; this brief is preliminary.",
        }),
      ),
    ).toEqual({ level: "CAUTION", reasons: ["forecast preliminary"] })
  })
  test("a freezing level within 2,000 ft of the cruise during the flight is CAUTION", () => {
    const fzlvl = (ft: string, relevance = "during flight") =>
      brief({
        advisories: [
          `G-AIRMET FZLVL | freezing level ${ft} ft | valid 2100Z–0300Z 07 | ${relevance}`,
        ],
      })
    expect(verdictFloor(fzlvl("4,000"), { cruiseFt: 5500 })).toEqual({
      level: "CAUTION",
      reasons: ["freezing level 4,000 ft during flight"],
    })
    expect(verdictFloor(fzlvl("7,000"), { cruiseFt: 5500 }).level).toBe("CAUTION")
    expect(verdictFloor(fzlvl("8,000"), { cruiseFt: 5500 }).level).toBe("GO")
    expect(verdictFloor(fzlvl("4,000", "expires before departure"), { cruiseFt: 5500 }).level).toBe(
      "GO",
    )
    // No cruise to compare with: the advisory counts.
    expect(verdictFloor(fzlvl("8,000")).level).toBe("CAUTION")
  })
  test("LLWS, turbulence and convection during the flight are CAUTION; repeats count once", () => {
    const floor = verdictFloor(
      brief({
        advisories: [
          "G-AIRMET LLWS | SFC–2,000 ft | valid 1200Z–1500Z 07 | during flight",
          "G-AIRMET TURB-LO | SFC–FL180 | valid 1200Z–1500Z 07 | during flight",
          "G-AIRMET TURB-LO | SFC–FL180 | valid 1500Z–1800Z 07 | during flight",
          "SIGMET CONVECTIVE | tops FL290 | valid 1200Z–1400Z 07 | during flight",
          "SIGMET CONVECTIVE | tops FL350 | valid 0000Z–0200Z 07 | expires before departure",
          "G-AIRMET MT_OBSC | valid 1200Z–1500Z 07 | during flight",
        ],
      }),
      { cruiseFt: 5500 },
    )
    expect(floor).toEqual({
      level: "CAUTION",
      reasons: [
        "low-level wind shear SFC–2,000 ft during flight",
        "turbulence SFC–FL180 during flight",
        "SIGMET Convective tops FL290 during flight",
      ],
    })
  })
  test("a reserve under 45 min is NO-GO", () => {
    const thirsty = {
      ...SAMPLE_NAVLOG,
      totals: { ...SAMPLE_NAVLOG.totals, reserveMin: 38, reserveOk: false },
    }
    expect(verdictFloor(null, { navlog: thirsty })).toEqual({
      level: "NO-GO",
      reasons: ["reserve 0:38, under 45 min"],
    })
  })
  test("every rule at once: NO-GO, with the NO-GO reasons first", () => {
    const floor = verdictFloor(
      brief({
        horizon: "Forecast horizon: Departure is 30 hours out; this brief is preliminary.",
        kfcm: "MVFR now, VFR at ETA. METAR KFCM 061553Z 30015G25KT",
        kdlh: "VFR now, IFR at ETA",
      }),
      { cruiseFt: 5500 },
    )
    expect(floor.level).toBe("NO-GO")
    expect(floor.reasons).toEqual([
      "KDLH IFR at ETA",
      "KFCM MVFR now",
      "gusts 25 kt at KFCM",
      "forecast preliminary",
    ])
  })
  test("the live run's GO brief floors at CAUTION", () => {
    expect(verdictFloor(parseWeatherBrief(GUSTY_GO), { cruiseFt: 5500 })).toEqual({
      level: "CAUTION",
      reasons: ["gusts 25 kt at KFCM", "gusts 25 kt at KDLH", "forecast preliminary"],
    })
  })
  test("an old-format brief (no verdict, no horizon) is still checked", () => {
    const old = parseWeatherBrief("Airports:\nKDLH: VFR now, IFR at ETA. METAR KDLH 1")
    expect(old.verdict).toBeUndefined()
    expect(verdictFloor(old).level).toBe("NO-GO")
  })
})

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
  test("worseLevel", () => {
    expect(worseLevel("GO", "CAUTION")).toBe("CAUTION")
    expect(worseLevel("NO-GO", "CAUTION")).toBe("NO-GO")
    expect(worseLevel("GO", "GO")).toBe("GO")
  })
})

describe("resolveVerdict", () => {
  test("the live run: GO from the brief and the planner, raised to CAUTION", () => {
    const verdict = resolveVerdict({
      weather: parseWeatherBrief(GUSTY_GO),
      answer: "Bottom line: GO — VFR the whole way.\nWatch for:\n- Gusty crosswind at KDLH",
      navlog: SAMPLE_NAVLOG,
    })
    expect(verdict).toEqual({
      level: "CAUTION",
      reason: "VFR at both ends and light winds aloft.",
      raisedFrom: "GO",
      floorReasons: ["gusts 25 kt at KFCM", "gusts 25 kt at KDLH", "forecast preliminary"],
    })
  })
  test("the model's call is the worse of the brief's and the planner's", () => {
    expect(
      resolveVerdict({
        weather: brief(),
        answer: "Bottom line: CAUTION — I would wait an hour.",
        navlog: SAMPLE_NAVLOG,
      }),
    ).toEqual({ level: "CAUTION", reason: "I would wait an hour." })
    expect(
      resolveVerdict({
        weather: brief(),
        answer: "Bottom line: GO — fine.",
        navlog: SAMPLE_NAVLOG,
      }),
    ).toEqual({ level: "GO", reason: "VFR all the way." })
  })
  test("the navlog's altitude is the cruise for the freezing-level rule", () => {
    const fz = brief({
      advisories: [
        "G-AIRMET FZLVL | freezing level 9,000 ft | valid 2100Z–0300Z 07 | during flight",
      ],
    })
    // SAMPLE_NAVLOG cruises at 4,500 ft: 9,000 ft is more than 2,000 ft above it.
    expect(resolveVerdict({ weather: fz, navlog: SAMPLE_NAVLOG })?.level).toBe("GO")
    expect(resolveVerdict({ weather: fz, cruiseFt: 8000 })?.level).toBe("CAUTION")
  })
})
