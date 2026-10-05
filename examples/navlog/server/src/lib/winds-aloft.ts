export interface WindAtLevel {
  readonly dirDegTrue: number
  readonly speedKt: number
  readonly tempC: number | null
}

export type StationWinds = Readonly<Record<number, WindAtLevel>>

export interface WindsAloftProduct {
  readonly basedOn: string | null
  readonly validAt: string | null
  readonly forUse: string | null
  readonly levelsFt: readonly number[]
  readonly stations: Readonly<Record<string, StationWinds>>
}

/** Decode one FB group: ddff, ddff+tt, ddff-tt, or ddfftt (temps negative above 24,000 ft). */
function decodeGroup(group: string, levelFt: number): WindAtLevel {
  const wind = group.slice(0, 4)
  const rest = group.slice(4)
  let tempC: number | null = null
  if (rest.length > 0) {
    const signed = rest.startsWith("+") || rest.startsWith("-")
    const magnitude = Number.parseInt(signed ? rest.slice(1) : rest, 10)
    if (!Number.isNaN(magnitude)) {
      tempC = rest.startsWith("-") || (!signed && levelFt > 24000) ? -magnitude : magnitude
    }
  }
  // Light and variable; the temperature, when given, still applies.
  if (wind === "9900") return { dirDegTrue: 0, speedKt: 0, tempC }
  let dir = Number.parseInt(wind.slice(0, 2), 10) * 10
  let speed = Number.parseInt(wind.slice(2, 4), 10)
  if (dir > 360) {
    dir -= 500
    speed += 100
  }
  if (dir === 360) dir = 0
  return { dirDegTrue: dir, speedKt: speed, tempC }
}

/** Parse the FB (windtemp) text product. Missing groups (blank columns) are left out. */
export function parseWindsAloft(text: string): WindsAloftProduct {
  const lines = text.split(/\r?\n/)
  const basedOn = /DATA BASED ON (\d{6}Z)/.exec(text)?.[1] ?? null
  const validAt = /VALID (\d{6}Z)/.exec(text)?.[1] ?? null
  const forUse = /FOR USE (\d{4}-\d{4}Z)/.exec(text)?.[1] ?? null
  const headerIndex = lines.findIndex((line) => line.startsWith("FT "))
  if (headerIndex < 0) throw new Error("winds aloft product has no FT header line")
  const header = lines[headerIndex] as string
  const columns: { levelFt: number; start: number }[] = []
  for (const match of header.matchAll(/\d+/g)) {
    columns.push({ levelFt: Number(match[0]), start: match.index ?? 0 })
  }
  const stations: Record<string, Record<number, WindAtLevel>> = {}
  for (const line of lines.slice(headerIndex + 1)) {
    if (!/^[A-Z0-9]{3} /.test(line)) continue
    const id = line.slice(0, 3)
    const row: Record<number, WindAtLevel> = {}
    for (const column of columns) {
      // Each group is right-aligned under its header number; take the token that ends at or after the header's end.
      const end = column.start + String(column.levelFt).length
      const slice = line.slice(Math.max(4, end - 7), end + 1)
      const token = slice.trim().split(/\s+/).pop() ?? ""
      if (!/^\d{4}([+-]?\d{2})?$/.test(token)) continue
      row[column.levelFt] = decodeGroup(token, column.levelFt)
    }
    stations[id] = row
  }
  return { basedOn, validAt, forUse, levelsFt: columns.map((column) => column.levelFt), stations }
}

function lerpAngle(a: number, b: number, t: number): number {
  const delta = ((b - a + 540) % 360) - 180
  return (a + delta * t + 360) % 360
}

/** Wind at an altitude between two forecast levels of one station. */
export function interpolateWind(station: StationWinds, altitudeFt: number): WindAtLevel {
  const levels = Object.keys(station)
    .map(Number)
    .sort((a, b) => a - b)
  const lowest = levels[0]
  const highest = levels.at(-1)
  if (
    lowest === undefined ||
    highest === undefined ||
    altitudeFt < lowest ||
    altitudeFt > highest
  ) {
    throw new Error(
      `altitude ${altitudeFt} ft is outside this station's forecast levels (${lowest ?? "none"} to ${highest ?? "none"})`,
    )
  }
  const exact = station[altitudeFt]
  if (exact) return exact
  const lower = [...levels].reverse().find((level) => level < altitudeFt) as number
  const upper = levels.find((level) => level > altitudeFt) as number
  const lo = station[lower] as WindAtLevel
  const hi = station[upper] as WindAtLevel
  const t = (altitudeFt - lower) / (upper - lower)
  // A calm level has no direction; take the other level's.
  const direction =
    lo.speedKt === 0
      ? hi.dirDegTrue
      : hi.speedKt === 0
        ? lo.dirDegTrue
        : lerpAngle(lo.dirDegTrue, hi.dirDegTrue, t)
  const tempC = lo.tempC !== null && hi.tempC !== null ? lo.tempC + (hi.tempC - lo.tempC) * t : null
  return {
    dirDegTrue: Math.round(direction),
    speedKt: lo.speedKt + (hi.speedKt - lo.speedKt) * t,
    tempC,
  }
}
