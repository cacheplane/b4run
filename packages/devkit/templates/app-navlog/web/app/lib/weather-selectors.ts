export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR" | "UNKNOWN"

export interface AirportWeather {
  readonly id: string
  readonly now: FlightCategory
  readonly atEta: FlightCategory
  /** The rest of the airport line before the raw reports. */
  readonly line: string
  readonly metar: string
  readonly taf: string
}

export interface WeatherBrief {
  readonly airports: readonly AirportWeather[]
  readonly winds: readonly string[]
  readonly advisories: readonly string[]
  readonly note: string
}

/** The subset of a subagent run this selector reads (from `useSubagentRuns`). */
export interface SubagentRunLike {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly result?: unknown
}

export function categoryOf(text: string): FlightCategory {
  const m = /\b(LIFR|MVFR|IFR|VFR)\b/i.exec(text)
  return m ? ((m[1] as string).toUpperCase() as FlightCategory) : "UNKNOWN"
}

const EMPTY: WeatherBrief = { airports: [], winds: [], advisories: [], note: "" }

/**
 * Parse the weather subagent's brief. The subagent is prompted to a fixed
 * shape (sections "Airports:", "Winds per leg:", "Advisories:", "Go/no-go
 * note:"); anything else degrades to an empty brief rather than a throw.
 */
export function parseWeatherBrief(text: string): WeatherBrief {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  let section: "airports" | "winds" | "advisories" | "note" | null = null
  const airports: AirportWeather[] = []
  const winds: string[] = []
  const advisories: string[] = []
  const note: string[] = []
  for (const line of lines) {
    if (/^airports:/i.test(line)) {
      section = "airports"
      continue
    }
    if (/^winds per leg:/i.test(line)) {
      section = "winds"
      continue
    }
    if (/^advisories:/i.test(line)) {
      section = "advisories"
      const inline = line.replace(/^advisories:\s*/i, "")
      if (inline && !/^none$/i.test(inline)) advisories.push(inline)
      continue
    }
    if (/^go\/no-go note:/i.test(line)) {
      section = "note"
      const inline = line.replace(/^go\/no-go note:\s*/i, "")
      if (inline) note.push(inline)
      continue
    }
    if (section === "airports") {
      const m = /^([A-Z0-9]{3,4}):\s*(.*)$/.exec(line)
      if (!m) continue
      const [, id, rest] = m as unknown as [string, string, string]
      const metarAt = rest.search(/\bMETAR\b/)
      const tafAt = rest.search(/\bTAF\b/)
      const head = metarAt >= 0 ? rest.slice(0, metarAt).trim() : rest
      const metar =
        metarAt >= 0 ? rest.slice(metarAt, tafAt > metarAt ? tafAt : undefined).trim() : ""
      const taf = tafAt >= 0 ? rest.slice(tafAt).trim() : ""
      const [nowText = "", etaText = ""] = head.split(",")
      airports.push({
        id,
        now: categoryOf(nowText),
        atEta: categoryOf(etaText),
        line: head,
        metar,
        taf,
      })
    } else if (section === "winds") winds.push(line)
    else if (section === "advisories" && !/^none$/i.test(line)) advisories.push(line)
    else if (section === "note") note.push(line)
  }
  if (airports.length === 0 && winds.length === 0 && advisories.length === 0 && note.length === 0)
    return EMPTY
  return { airports, winds, advisories, note: note.join(" ") }
}

/** The most recent completed `weather` subagent run's brief, or null. */
export function latestWeatherBrief(runs: readonly SubagentRunLike[]): WeatherBrief | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]
    if (run?.name !== "weather" || run.status !== "completed") continue
    if (typeof run.result !== "string") continue
    return parseWeatherBrief(run.result)
  }
  return null
}
