/**
 * Cessna 172N (1978) POH Section 5 tables, 2300 lb, transcribed. The Markdown
 * twins in workspace/poh are what the model reads; test/corpus-sync.test.ts
 * keeps the two equal.
 */

export interface CruiseCell {
  readonly bhpPct: number
  readonly tasKt: number
  readonly gph: number
}
export interface CruiseRow {
  readonly pressureAltitudeFt: number
  readonly rpm: number
  readonly below: CruiseCell | null
  readonly standard: CruiseCell
  readonly above: CruiseCell
}
const c = (bhpPct: number, tasKt: number, gph: number): CruiseCell => ({ bhpPct, tasKt, gph })
const r = (
  pressureAltitudeFt: number,
  rpm: number,
  below: CruiseCell | null,
  standard: CruiseCell,
  above: CruiseCell,
): CruiseRow => ({ pressureAltitudeFt, rpm, below, standard, above })

/** Figure 5-7. */
export const CRUISE_TABLE: readonly CruiseRow[] = [
  r(2000, 2500, null, c(75, 116, 8.4), c(71, 115, 7.9)),
  r(2000, 2400, c(72, 111, 8.0), c(67, 111, 7.5), c(63, 110, 7.1)),
  r(2000, 2300, c(64, 106, 7.1), c(60, 105, 6.7), c(56, 105, 6.3)),
  r(2000, 2200, c(56, 101, 6.3), c(53, 100, 6.1), c(50, 99, 5.8)),
  r(2000, 2100, c(50, 95, 5.8), c(47, 94, 5.6), c(45, 93, 5.4)),
  r(4000, 2550, null, c(75, 118, 8.4), c(71, 118, 7.9)),
  r(4000, 2500, c(76, 116, 8.5), c(71, 115, 8.0), c(67, 115, 7.5)),
  r(4000, 2400, c(68, 111, 7.6), c(64, 110, 7.1), c(60, 109, 6.7)),
  r(4000, 2300, c(60, 105, 6.8), c(57, 105, 6.4), c(54, 104, 6.1)),
  r(4000, 2200, c(54, 100, 6.1), c(51, 99, 5.9), c(48, 98, 5.7)),
  r(4000, 2100, c(48, 94, 5.6), c(46, 93, 5.5), c(44, 92, 5.3)),
  r(6000, 2600, null, c(75, 120, 8.4), c(71, 120, 7.9)),
  r(6000, 2500, c(72, 116, 8.1), c(67, 115, 7.6), c(64, 114, 7.1)),
  r(6000, 2400, c(64, 110, 7.2), c(60, 109, 6.8), c(57, 109, 6.4)),
  r(6000, 2300, c(57, 105, 6.5), c(54, 104, 6.2), c(52, 103, 5.9)),
  r(6000, 2200, c(51, 99, 5.9), c(49, 98, 5.7), c(47, 97, 5.5)),
  r(6000, 2100, c(46, 93, 5.5), c(44, 92, 5.4), c(42, 91, 5.2)),
  r(8000, 2650, null, c(75, 122, 8.4), c(71, 122, 7.9)),
  r(8000, 2600, c(76, 120, 8.6), c(71, 120, 8.0), c(67, 119, 7.5)),
  r(8000, 2500, c(68, 115, 7.7), c(64, 114, 7.2), c(60, 113, 6.8)),
  r(8000, 2400, c(61, 110, 6.9), c(58, 109, 6.5), c(55, 108, 6.2)),
  r(8000, 2300, c(55, 104, 6.2), c(52, 103, 6.0), c(50, 102, 5.8)),
  r(8000, 2200, c(49, 98, 5.7), c(47, 97, 5.5), c(45, 96, 5.4)),
  r(10000, 2650, c(76, 122, 8.5), c(71, 122, 8.0), c(67, 121, 7.5)),
  r(10000, 2600, c(72, 120, 8.1), c(68, 119, 7.6), c(64, 118, 7.1)),
  r(10000, 2500, c(65, 114, 7.3), c(61, 114, 6.8), c(58, 112, 6.5)),
  r(10000, 2400, c(58, 109, 6.5), c(55, 108, 6.2), c(52, 107, 6.0)),
  r(10000, 2300, c(52, 103, 6.0), c(50, 102, 5.8), c(48, 101, 5.6)),
  r(10000, 2200, c(47, 97, 5.6), c(45, 96, 5.4), c(44, 95, 5.3)),
  r(12000, 2600, c(68, 119, 7.7), c(64, 118, 7.2), c(61, 117, 6.8)),
  r(12000, 2500, c(62, 114, 6.9), c(58, 113, 6.5), c(55, 111, 6.2)),
  r(12000, 2400, c(56, 108, 6.3), c(53, 107, 6.0), c(51, 106, 5.8)),
  r(12000, 2300, c(50, 102, 5.8), c(48, 101, 5.6), c(46, 100, 5.5)),
  r(12000, 2200, c(46, 96, 5.5), c(44, 95, 5.4), c(43, 94, 5.3)),
]

export type CruiseTemperature = "below" | "standard" | "above"

const round1 = (n: number): number => Math.round(n * 10) / 10

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Cruise row for a pressure altitude (interpolated between the table's altitudes) and a listed RPM. */
export function cruiseAt(input: {
  readonly pressureAltitudeFt: number
  readonly rpm: number
  readonly temperature?: CruiseTemperature
}): CruiseCell {
  const temperature = input.temperature ?? "standard"
  const altitudes = [...new Set(CRUISE_TABLE.map((row) => row.pressureAltitudeFt))].sort(
    (a, b) => a - b,
  )
  const alt = input.pressureAltitudeFt
  if (alt < (altitudes[0] ?? 0) || alt > (altitudes.at(-1) ?? 0)) {
    throw new Error("cruise table covers 2000 to 12,000 ft pressure altitude (Figure 5-7)")
  }
  const lower = [...altitudes].reverse().find((a) => a <= alt) ?? altitudes[0] ?? 0
  const upper = altitudes.find((a) => a >= alt) ?? lower
  const cellAt = (altitudeFt: number): CruiseCell => {
    const row = CRUISE_TABLE.find(
      (entry) => entry.pressureAltitudeFt === altitudeFt && entry.rpm === input.rpm,
    )
    if (!row)
      throw new Error(`cruise RPM ${input.rpm} is not listed at ${altitudeFt} ft (Figure 5-7)`)
    const cell = row[temperature]
    if (cell === null)
      throw new Error(
        `cruise ${input.rpm} RPM at ${altitudeFt} ft is not available 20 °C below standard (Figure 5-7)`,
      )
    return cell
  }
  const lo = cellAt(lower)
  if (lower === upper) return lo
  const hi = cellAt(upper)
  const t = (alt - lower) / (upper - lower)
  return {
    bhpPct: Math.round(lerp(lo.bhpPct, hi.bhpPct, t)),
    tasKt: lerp(lo.tasKt, hi.tasKt, t),
    gph: lerp(lo.gph, hi.gph, t),
  }
}

export interface ClimbRow {
  readonly pressureAltitudeFt: number
  readonly timeMin: number
  readonly fuelGal: number
  readonly distanceNm: number
}

/** Figure 5-6, cumulative from sea level, standard temperature. */
export const CLIMB_TABLE: readonly ClimbRow[] = [
  { pressureAltitudeFt: 0, timeMin: 0, fuelGal: 0.0, distanceNm: 0 },
  { pressureAltitudeFt: 1000, timeMin: 1, fuelGal: 0.3, distanceNm: 2 },
  { pressureAltitudeFt: 2000, timeMin: 3, fuelGal: 0.6, distanceNm: 3 },
  { pressureAltitudeFt: 3000, timeMin: 4, fuelGal: 0.9, distanceNm: 5 },
  { pressureAltitudeFt: 4000, timeMin: 6, fuelGal: 1.2, distanceNm: 8 },
  { pressureAltitudeFt: 5000, timeMin: 8, fuelGal: 1.6, distanceNm: 10 },
  { pressureAltitudeFt: 6000, timeMin: 10, fuelGal: 1.9, distanceNm: 12 },
  { pressureAltitudeFt: 7000, timeMin: 12, fuelGal: 2.3, distanceNm: 15 },
  { pressureAltitudeFt: 8000, timeMin: 15, fuelGal: 2.7, distanceNm: 19 },
  { pressureAltitudeFt: 9000, timeMin: 17, fuelGal: 3.2, distanceNm: 22 },
  { pressureAltitudeFt: 10000, timeMin: 21, fuelGal: 3.7, distanceNm: 27 },
  { pressureAltitudeFt: 11000, timeMin: 24, fuelGal: 4.2, distanceNm: 32 },
  { pressureAltitudeFt: 12000, timeMin: 29, fuelGal: 4.9, distanceNm: 38 },
]

/** Cumulative climb figures from sea level to a pressure altitude, interpolated, rounded like the table. */
export function climbFromSeaLevel(pressureAltitudeFt: number): {
  timeMin: number
  fuelGal: number
  distanceNm: number
} {
  if (pressureAltitudeFt <= 0) return { timeMin: 0, fuelGal: 0, distanceNm: 0 }
  const top = CLIMB_TABLE.at(-1)
  if (!top || pressureAltitudeFt > top.pressureAltitudeFt)
    throw new Error("climb table ends above 12,000 ft (Figure 5-6)")
  const lower =
    [...CLIMB_TABLE].reverse().find((row) => row.pressureAltitudeFt <= pressureAltitudeFt) ??
    CLIMB_TABLE[0]
  const upper = CLIMB_TABLE.find((row) => row.pressureAltitudeFt >= pressureAltitudeFt) ?? lower
  if (!lower || !upper) throw new Error("climb table is empty")
  if (lower === upper)
    return { timeMin: lower.timeMin, fuelGal: lower.fuelGal, distanceNm: lower.distanceNm }
  const t =
    (pressureAltitudeFt - lower.pressureAltitudeFt) /
    (upper.pressureAltitudeFt - lower.pressureAltitudeFt)
  return {
    timeMin: Math.round(lerp(lower.timeMin, upper.timeMin, t)),
    fuelGal: round1(lerp(lower.fuelGal, upper.fuelGal, t)),
    distanceNm: Math.round(lerp(lower.distanceNm, upper.distanceNm, t)),
  }
}

export interface FieldCell {
  readonly groundRollFt: number
  readonly over50FtFt: number
}
export interface FieldRow {
  readonly pressureAltitudeFt: number
  /** Index 0..4 = 0, 10, 20, 30, 40 °C. */
  readonly byTemperature: readonly [FieldCell, FieldCell, FieldCell, FieldCell, FieldCell]
}
const f = (groundRollFt: number, over50FtFt: number): FieldCell => ({ groundRollFt, over50FtFt })
const row = (
  pressureAltitudeFt: number,
  ...cells: [FieldCell, FieldCell, FieldCell, FieldCell, FieldCell]
): FieldRow => ({
  pressureAltitudeFt,
  byTemperature: cells,
})

/** Figure 5-4, sheet 1 (2300 lb, short field). */
export const TAKEOFF_TABLE: readonly FieldRow[] = [
  row(0, f(720, 1300), f(775, 1390), f(835, 1490), f(895, 1590), f(960, 1700)),
  row(1000, f(790, 1420), f(850, 1525), f(915, 1630), f(980, 1745), f(1050, 1865)),
  row(2000, f(865, 1555), f(930, 1670), f(1000, 1790), f(1075, 1915), f(1155, 2055)),
  row(3000, f(950, 1710), f(1025, 1835), f(1100, 1970), f(1185, 2115), f(1270, 2265)),
  row(4000, f(1045, 1880), f(1125, 2025), f(1210, 2170), f(1300, 2335), f(1395, 2510)),
  row(5000, f(1150, 2075), f(1240, 2240), f(1330, 2410), f(1435, 2595), f(1540, 2795)),
  row(6000, f(1265, 2305), f(1365, 2485), f(1475, 2680), f(1585, 2895), f(1705, 3125)),
  row(7000, f(1400, 2565), f(1510, 2770), f(1630, 3000), f(1755, 3245), f(1890, 3515)),
  row(8000, f(1550, 2870), f(1675, 3110), f(1805, 3375), f(1945, 3670), f(2095, 3990)),
]

/** Figure 5-10 (2300 lb, short field, flaps 40°). */
export const LANDING_TABLE: readonly FieldRow[] = [
  row(0, f(495, 1205), f(510, 1235), f(530, 1265), f(545, 1295), f(565, 1330)),
  row(1000, f(510, 1235), f(530, 1265), f(550, 1300), f(565, 1330), f(585, 1365)),
  row(2000, f(530, 1265), f(550, 1300), f(570, 1335), f(590, 1370), f(610, 1405)),
  row(3000, f(550, 1300), f(570, 1335), f(590, 1370), f(610, 1405), f(630, 1440)),
  row(4000, f(570, 1335), f(590, 1370), f(615, 1410), f(635, 1445), f(655, 1480)),
  row(5000, f(590, 1370), f(615, 1415), f(635, 1450), f(655, 1485), f(680, 1525)),
  row(6000, f(615, 1415), f(640, 1455), f(660, 1490), f(685, 1535), f(705, 1570)),
  row(7000, f(640, 1455), f(660, 1490), f(685, 1535), f(710, 1575), f(730, 1615)),
  row(8000, f(665, 1500), f(690, 1540), f(710, 1580), f(735, 1620), f(760, 1665)),
]

function fieldLookup(
  table: readonly FieldRow[],
  input: { readonly pressureAltitudeFt: number; readonly temperatureC: number },
  figure: string,
): FieldCell {
  const alt = input.pressureAltitudeFt
  const first = table[0]
  const last = table.at(-1)
  if (!first || !last) throw new Error(`${figure} table is empty`)
  if (alt < first.pressureAltitudeFt || alt > last.pressureAltitudeFt) {
    throw new Error(`${figure} covers sea level to ${last.pressureAltitudeFt} ft pressure altitude`)
  }
  if (input.temperatureC < 0 || input.temperatureC > 40)
    throw new Error(`${figure} covers 0 to 40 °C`)
  const lower = [...table].reverse().find((entry) => entry.pressureAltitudeFt <= alt) ?? first
  const upper = table.find((entry) => entry.pressureAltitudeFt >= alt) ?? lower
  const tAlt =
    lower === upper
      ? 0
      : (alt - lower.pressureAltitudeFt) / (upper.pressureAltitudeFt - lower.pressureAltitudeFt)
  const tempIndex = input.temperatureC / 10
  const i0 = Math.min(3, Math.floor(tempIndex))
  const i1 = Math.min(4, i0 + 1)
  const tTemp = tempIndex - i0
  const at = (entry: FieldRow, key: keyof FieldCell): number =>
    lerp(entry.byTemperature[i0]?.[key] ?? 0, entry.byTemperature[i1]?.[key] ?? 0, tTemp)
  return {
    groundRollFt: Math.round(lerp(at(lower, "groundRollFt"), at(upper, "groundRollFt"), tAlt)),
    over50FtFt: Math.round(lerp(at(lower, "over50FtFt"), at(upper, "over50FtFt"), tAlt)),
  }
}

export function takeoffDistance(input: {
  readonly pressureAltitudeFt: number
  readonly temperatureC: number
}): FieldCell {
  return fieldLookup(TAKEOFF_TABLE, input, "Figure 5-4")
}

export function landingDistance(input: {
  readonly pressureAltitudeFt: number
  readonly temperatureC: number
}): FieldCell {
  return fieldLookup(LANDING_TABLE, input, "Figure 5-10")
}
