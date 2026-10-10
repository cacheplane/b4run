import { describe, expect, test } from "vitest"
import { type Navlog, SAMPLE_NAVLOG } from "./navlog-types"
import {
  type DraftWaypoint,
  draftDistanceNm,
  draftFromNavlog,
  draftReducer,
  EMPTY_DRAFT,
  type RouteDraft,
  replanMessage,
  sameRoute,
} from "./route-draft"

const KPAO: DraftWaypoint = {
  id: "KPAO",
  kind: "airport",
  type: "airport",
  lat: 37.4611,
  lon: -122.115,
}
const SNS: DraftWaypoint = {
  id: "SNS",
  kind: "navaid",
  type: "VORTAC",
  lat: 36.6628,
  lon: -121.6064,
}
const KSBA: DraftWaypoint = {
  id: "KSBA",
  kind: "airport",
  type: "airport",
  lat: 34.4262,
  lon: -119.8404,
}

const draft = (overrides: Partial<RouteDraft>): RouteDraft => ({ ...EMPTY_DRAFT, ...overrides })

describe("EMPTY_DRAFT", () => {
  test("has no waypoints, altitude or departure", () => {
    expect(EMPTY_DRAFT).toEqual({
      waypoints: [],
      altitudeFt: "",
      departure: "",
      departureFromPlan: null,
    })
  })
})

describe("draftFromNavlog", () => {
  test("takes the plan's waypoints, altitude and departure", () => {
    expect(draftFromNavlog(SAMPLE_NAVLOG)).toEqual({
      waypoints: [
        { id: "KSTP", kind: "airport", type: "airport", lat: 44.9346, lon: -93.0603 },
        { id: "KRST", kind: "airport", type: "airport", lat: 43.9083, lon: -92.49 },
      ],
      altitudeFt: "4500",
      departure: "1400Z",
      departureFromPlan: "2026-10-06T14:00:00.000Z",
    })
  })

  test("formats the departure as HHMMZ with zero padding", () => {
    const navlog: Navlog = { ...SAMPLE_NAVLOG, departureTimeUtc: "2026-10-11T09:05:00Z" }
    const result = draftFromNavlog(navlog)
    expect(result.departure).toBe("0905Z")
    expect(result.departureFromPlan).toBe("2026-10-11T09:05:00Z")
  })

  test("formats the departure in UTC whatever the offset", () => {
    const navlog: Navlog = { ...SAMPLE_NAVLOG, departureTimeUtc: "2026-10-11T00:30:00-07:00" }
    expect(draftFromNavlog(navlog).departure).toBe("0730Z")
  })

  test("maps navaids to navaid and fixes to airport", () => {
    const navlog: Navlog = {
      ...SAMPLE_NAVLOG,
      waypoints: [
        { id: "KPAO", lat: 1, lon: 2, kind: "airport", magneticVariationDeg: 0 },
        { id: "SNS", lat: 3, lon: 4, kind: "navaid", magneticVariationDeg: 0 },
        { id: "FIX", lat: 5, lon: 6, kind: "fix", magneticVariationDeg: 0 },
      ],
    }
    expect(
      draftFromNavlog(navlog).waypoints.map(({ id, kind, type }) => ({ id, kind, type })),
    ).toEqual([
      { id: "KPAO", kind: "airport", type: "airport" },
      { id: "SNS", kind: "navaid", type: "navaid" },
      { id: "FIX", kind: "airport", type: "airport" },
    ])
  })
})

describe("draftReducer", () => {
  test("add appends a waypoint", () => {
    const state = draftReducer(draft({ waypoints: [KPAO] }), { type: "add", waypoint: SNS })
    expect(state.waypoints).toEqual([KPAO, SNS])
  })

  test("add ignores a repeat of the last waypoint", () => {
    const start = draft({ waypoints: [KPAO, SNS] })
    expect(draftReducer(start, { type: "add", waypoint: SNS })).toBe(start)
  })

  test("add accepts a waypoint seen earlier but not last", () => {
    const state = draftReducer(draft({ waypoints: [KPAO, SNS] }), { type: "add", waypoint: KPAO })
    expect(state.waypoints.map((w) => w.id)).toEqual(["KPAO", "SNS", "KPAO"])
  })

  test("remove drops the waypoint at an index", () => {
    const state = draftReducer(draft({ waypoints: [KPAO, SNS, KSBA] }), {
      type: "remove",
      index: 1,
    })
    expect(state.waypoints).toEqual([KPAO, KSBA])
  })

  test("remove ignores an index out of range", () => {
    const start = draft({ waypoints: [KPAO] })
    expect(draftReducer(start, { type: "remove", index: 3 })).toBe(start)
    expect(draftReducer(start, { type: "remove", index: -1 })).toBe(start)
  })

  test("removeLast drops the last waypoint, and does nothing when empty", () => {
    expect(
      draftReducer(draft({ waypoints: [KPAO, SNS] }), { type: "removeLast" }).waypoints,
    ).toEqual([KPAO])
    expect(draftReducer(EMPTY_DRAFT, { type: "removeLast" })).toBe(EMPTY_DRAFT)
  })

  test("altitude sets the typed altitude and keeps the plan departure", () => {
    const start = draftFromNavlog(SAMPLE_NAVLOG)
    const state = draftReducer(start, { type: "altitude", value: "6500" })
    expect(state.altitudeFt).toBe("6500")
    expect(state.departureFromPlan).toBe(start.departureFromPlan)
  })

  test("departure sets the typed text and clears the plan departure", () => {
    const state = draftReducer(draftFromNavlog(SAMPLE_NAVLOG), {
      type: "departure",
      value: "1600Z",
    })
    expect(state.departure).toBe("1600Z")
    expect(state.departureFromPlan).toBeNull()
  })

  test("reset replaces the draft", () => {
    const next = draftFromNavlog(SAMPLE_NAVLOG)
    expect(draftReducer(draft({ waypoints: [KPAO] }), { type: "reset", draft: next })).toBe(next)
  })
})

describe("replanMessage", () => {
  const ready = draft({ waypoints: [KPAO, SNS, KSBA], altitudeFt: "5500", departure: "1400Z" })

  test("names the route, altitude and typed departure; navaids carry their type", () => {
    expect(replanMessage(ready)).toBe(
      "Plan KPAO → SNS (VORTAC) → KSBA at 5500 ft, departing 1400Z.",
    )
  })

  test("trims the typed departure and altitude", () => {
    expect(replanMessage({ ...ready, departure: "  tomorrow 1400Z ", altitudeFt: " 5500 " })).toBe(
      "Plan KPAO → SNS (VORTAC) → KSBA at 5500 ft, departing tomorrow 1400Z.",
    )
  })

  test("sends the plan's ISO instant while the departure is untouched", () => {
    expect(replanMessage(draftFromNavlog(SAMPLE_NAVLOG))).toBe(
      "Plan KSTP → KRST at 4500 ft, departing 2026-10-06T14:00:00.000Z.",
    )
  })

  test("sends the typed departure once it is edited", () => {
    const edited = draftReducer(draftFromNavlog(SAMPLE_NAVLOG), {
      type: "departure",
      value: "1600Z",
    })
    expect(replanMessage(edited)).toBe("Plan KSTP → KRST at 4500 ft, departing 1600Z.")
  })

  test("labels a navaid of unknown type as navaid", () => {
    const plain: DraftWaypoint = { ...SNS, type: "navaid" }
    expect(replanMessage({ ...ready, waypoints: [KPAO, plain] })).toBe(
      "Plan KPAO → SNS (navaid) at 5500 ft, departing 1400Z.",
    )
  })

  test("is null with fewer than 2 waypoints", () => {
    expect(replanMessage({ ...ready, waypoints: [KPAO] })).toBeNull()
    expect(replanMessage({ ...ready, waypoints: [] })).toBeNull()
  })

  test("accepts the altitude bounds and rejects values outside them", () => {
    expect(replanMessage({ ...ready, altitudeFt: "1000" })).not.toBeNull()
    expect(replanMessage({ ...ready, altitudeFt: "17500" })).not.toBeNull()
    for (const altitudeFt of ["999", "17501", "", "abc", "5500.5", "-5500", "5,500"]) {
      expect(replanMessage({ ...ready, altitudeFt })).toBeNull()
    }
  })

  test("is null with no departure", () => {
    expect(replanMessage({ ...ready, departure: "" })).toBeNull()
    expect(replanMessage({ ...ready, departure: "   " })).toBeNull()
  })
})

describe("draftDistanceNm", () => {
  test("is 0 with fewer than 2 waypoints", () => {
    expect(draftDistanceNm(EMPTY_DRAFT)).toBe(0)
    expect(draftDistanceNm(draft({ waypoints: [KPAO] }))).toBe(0)
  })

  test("matches the plan's total for the sample route", () => {
    expect(draftDistanceNm(draftFromNavlog(SAMPLE_NAVLOG))).toBe(SAMPLE_NAVLOG.totals.distanceNm)
  })

  test("sums the legs and rounds the total", () => {
    const total = draftDistanceNm(draft({ waypoints: [KPAO, SNS, KSBA] }))
    const legs =
      draftDistanceNm(draft({ waypoints: [KPAO, SNS] })) +
      draftDistanceNm(draft({ waypoints: [SNS, KSBA] }))
    expect(total).toBe(213)
    expect(Math.abs(total - legs)).toBeLessThanOrEqual(1)
  })

  test("one degree of latitude is 60 nm", () => {
    const a: DraftWaypoint = { ...KPAO, lat: 0, lon: 0 }
    const b: DraftWaypoint = { ...KPAO, lat: 1, lon: 0 }
    expect(draftDistanceNm(draft({ waypoints: [a, b] }))).toBe(60)
  })
})

describe("sameRoute", () => {
  test("is false with no plan", () => {
    expect(sameRoute(draftFromNavlog(SAMPLE_NAVLOG), null)).toBe(false)
  })

  test("is true when the ids match in order", () => {
    expect(sameRoute(draftFromNavlog(SAMPLE_NAVLOG), SAMPLE_NAVLOG)).toBe(true)
  })

  test("is false when the order, length or ids differ", () => {
    const [stp, rst] = draftFromNavlog(SAMPLE_NAVLOG).waypoints
    if (!stp || !rst) throw new Error("sample navlog has two waypoints")
    expect(sameRoute(draft({ waypoints: [rst, stp] }), SAMPLE_NAVLOG)).toBe(false)
    expect(sameRoute(draft({ waypoints: [stp] }), SAMPLE_NAVLOG)).toBe(false)
    expect(sameRoute(draft({ waypoints: [stp, rst, KSBA] }), SAMPLE_NAVLOG)).toBe(false)
    expect(sameRoute(draft({ waypoints: [stp, KSBA] }), SAMPLE_NAVLOG)).toBe(false)
  })
})
