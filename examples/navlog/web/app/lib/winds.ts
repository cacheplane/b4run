/**
 * The weather brief's "Winds per leg:" lines, read for display: the wind,
 * temperature, altitude and source of each leg's line, and the one-line
 * summary the Weather tab shows. Pure, no React.
 */

/** One "Winds per leg" line, read for display. */
export interface WindsAloft {
  readonly leg: number | null
  readonly dir: number
  readonly kt: number
  readonly tempC: number | null
  readonly altitudeFt: number | null
  readonly station: string
  /** `24` for "24-hour forecast used", or null. */
  readonly forecastHours: number | null
  readonly raw: string
}

/**
 * `leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z`, and the older, wordier
 * `leg 1: 318/26, temp NA at 5,500 ft, MSP, based on 060000Z, valid 070000Z
 * (FB chi region, 24-hour forecast used)`. Null when there is no `dir/kt`.
 */
export function parseWindsLine(line: string): WindsAloft | null {
  const wind = /\b(\d{1,3})\s*\/\s*(\d{1,3})\b/.exec(line)
  if (!wind) return null
  const leg = /^\s*leg\s*(\d+)/i.exec(line)
  const afterWind = line.slice(wind.index + wind[0].length)
  const temp = /^[\s,]*(?:temp\s*)?([+-]?\d{1,2})\s*°?\s*C\b/i.exec(afterWind)
  const alt = /\bat\s+([\d,]{3,6})\s*ft\b/i.exec(line)
  const afterAlt = alt ? line.slice(alt.index + alt[0].length) : ""
  const station = /^\s*,\s*([A-Z]{3,4})\b/.exec(afterAlt)
  const hours = /(\d{1,2})[\s-]*(?:hour|hr|h)\b[^)]*\bforecast/i.exec(line)
  return {
    leg: leg ? Number(leg[1]) : null,
    dir: Number(wind[1]),
    kt: Number(wind[2]),
    tempC: temp ? Number(temp[1]) : null,
    altitudeFt: alt ? Number((alt[1] as string).replace(/,/g, "")) : null,
    station: station ? (station[1] as string) : "",
    forecastHours: hours ? Number(hours[1]) : null,
    raw: line,
  }
}

/**
 * `Winds 5,500 ft: 318° at 26 kt (MSP, 24 h forecast)`, with the temperature
 * when the line has one, or the raw line when it does not parse.
 */
export function windsSummary(line: string): string {
  const w = parseWindsLine(line)
  if (w === null) return line
  const at = w.altitudeFt !== null ? ` ${w.altitudeFt.toLocaleString("en-US")} ft` : ""
  const dir = String(w.dir).padStart(3, "0")
  const temp = w.tempC !== null ? `, ${w.tempC < 0 ? "−" : ""}${Math.abs(w.tempC)} °C` : ""
  const source = [w.station, w.forecastHours !== null ? `${w.forecastHours} h forecast` : ""]
    .filter((part) => part !== "")
    .join(", ")
  return `Winds${at}: ${dir}° at ${w.kt} kt${temp}${source !== "" ? ` (${source})` : ""}`
}
