/**
 * Test fixtures, imported only by `*.test.ts(x)` files. Nothing in the app
 * imports this module, so it never reaches a page bundle.
 */
import type { Navlog } from "./navlog-types"

/**
 * The navlog the tests share: KSTP to KRST at 4500 ft in N738ZU,
 * 2400 RPM, wind 320/20 at 5 °C, departing 2026-10-06 1400Z. It is the
 * server's `computeNavlog` output for that input, pasted verbatim, so the
 * numbers are the tool's own rather than hand-written.
 */
export const SAMPLE_NAVLOG: Navlog = {
  aircraft: {
    tailNumber: "N738ZU",
    type: "C172",
    cruiseRpm: 2400,
    tasKt: 109.75,
    gph: 7.0249999999999995,
    usableFuelGal: 50,
  },
  altitudeFt: 4500,
  departureTimeUtc: "2026-10-06T14:00:00.000Z",
  waypoints: [
    {
      id: "KSTP",
      lat: 44.9346,
      lon: -93.0603,
      elevationFt: 705,
      magneticVariationDeg: 0,
      kind: "airport",
    },
    {
      id: "KRST",
      lat: 43.9083,
      lon: -92.49,
      elevationFt: 1317,
      magneticVariationDeg: 0,
      kind: "airport",
    },
  ],
  legs: [
    {
      from: "KSTP",
      to: "KRST",
      trueCourse: 158,
      variation: 0,
      magneticCourse: 158,
      wind: { dir: 320, kt: 20 },
      segment: "climb",
      wca: 0,
      trueHeading: 158,
      magneticHeading: 158,
      tasKt: 72,
      groundspeedKt: 80,
      distanceNm: 8,
      eteMin: 6,
      fuelGal: 2.3,
      etaUtc: "2026-10-06T14:06:00.000Z",
      fuelRemainingGal: 47.7,
      remainingNm: 58,
    },
    {
      from: "KSTP",
      to: "KRST",
      trueCourse: 158,
      variation: 0,
      magneticCourse: 158,
      wind: { dir: 320, kt: 20 },
      segment: "cruise",
      wca: 3,
      trueHeading: 161,
      magneticHeading: 161,
      tasKt: 109.75,
      groundspeedKt: 129,
      distanceNm: 58,
      eteMin: 27,
      fuelGal: 3.2,
      etaUtc: "2026-10-06T14:33:00.000Z",
      fuelRemainingGal: 44.5,
      remainingNm: 0,
    },
  ],
  totals: {
    distanceNm: 66,
    eteMin: 33,
    fuelGal: 5.5,
    fuelRemainingGal: 44.5,
    reserveMin: 380,
    reserveOk: true,
  },
  flightPlan: {
    item7: "N738ZU",
    item8: "VG",
    item9: "C172/L",
    item10: "SG/C",
    item13: "KSTP1400",
    item15: "N0110VFR DCT",
    item16: "KRST0033",
    item18: "DOF/261006",
    item19: "E/0707 P/1",
  },
  sources: [
    { figure: "Figure 5-6", path: "poh/time-fuel-distance-to-climb.md" },
    { figure: "Figure 5-7", path: "poh/cruise-performance.md" },
  ],
}
