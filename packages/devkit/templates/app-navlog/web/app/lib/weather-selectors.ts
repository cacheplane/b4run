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

/**
 * The subset of a subagent run this selector reads: a `SubagentRun` from
 * `useSubagentRuns(agent).runs.values()`, in start order.
 */
export interface SubagentRunLike {
  readonly name: string
  readonly status: string
  readonly result?: unknown
}

export function categoryOf(text: string): FlightCategory {
  const m = /\b(LIFR|MVFR|IFR|VFR)\b/i.exec(text)
  return m ? ((m[1] as string).toUpperCase() as FlightCategory) : "UNKNOWN"
}

const EMPTY: WeatherBrief = { airports: [], winds: [], advisories: [], note: "" }

type Section = "airports" | "winds" | "advisories" | "note"

const HEADERS: readonly { readonly section: Section; readonly pattern: RegExp }[] = [
  { section: "airports", pattern: /^airports:(?:\*\*)?\s*(.*)$/i },
  { section: "winds", pattern: /^winds per leg:(?:\*\*)?\s*(.*)$/i },
  { section: "advisories", pattern: /^advisories:(?:\*\*)?\s*(.*)$/i },
  { section: "note", pattern: /^go\/no-go note:(?:\*\*)?\s*(.*)$/i },
]

/** Drop the markdown a model tends to add: a bullet or heading marker, and bold around the line. */
const stripMarkdown = (line: string): string =>
  line
    .replace(/^\s*(?:[-*]\s+|#+\s+)?(?:\*\*)?/, "")
    .replace(/\*\*\s*$/, "")
    .trim()

/** `KSTP: …`, `KSTP, …` or `**KSTP**: …` (the leading `**` is already stripped). */
const AIRPORT_LINE = /^([A-Z0-9]{3,4})(?:\*\*)?\s*[:,]\s*(.*)$/
/** Where the raw report starts: a routine METAR or a special SPECI. */
const RAW_REPORT = /\b(METAR|SPECI)\b/

function parseAirport(line: string): AirportWeather | null {
  const m = AIRPORT_LINE.exec(line)
  if (!m) return null
  const [, id, rest] = m as unknown as [string, string, string]
  const reportAt = rest.search(RAW_REPORT)
  const tafAt = rest.search(/\bTAF\b/)
  const head = reportAt >= 0 ? rest.slice(0, reportAt).trim() : rest
  const metar =
    reportAt >= 0 ? rest.slice(reportAt, tafAt > reportAt ? tafAt : undefined).trim() : ""
  const taf = tafAt >= 0 ? rest.slice(tafAt).trim() : ""
  const [nowText = "", etaText = ""] = head.split(",")
  return { id, now: categoryOf(nowText), atEta: categoryOf(etaText), line: head, metar, taf }
}

/**
 * Parse the weather subagent's brief. The subagent is prompted to a fixed
 * shape (sections "Airports:", "Winds per leg:", "Advisories:", "Go/no-go
 * note:"), but a model may still bullet it, bold the headers, or start the
 * first airport on the header line, so each line is unwrapped from that
 * markdown first. Anything else degrades to an empty brief rather than a throw.
 */
export function parseWeatherBrief(text: string): WeatherBrief {
  let section: Section | null = null
  const airports: AirportWeather[] = []
  const winds: string[] = []
  const advisories: string[] = []
  const note: string[] = []

  const add = (line: string): void => {
    if (line === "") return
    if (section === "airports") {
      const airport = parseAirport(line)
      if (airport) airports.push(airport)
    } else if (section === "winds") winds.push(line)
    else if (section === "advisories" && !/^none\.?$/i.test(line)) advisories.push(line)
    else if (section === "note") note.push(line)
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = stripMarkdown(raw)
    if (line === "") continue
    let matched = false
    for (const header of HEADERS) {
      const m = header.pattern.exec(line)
      if (!m) continue
      section = header.section
      // Content on the header line itself ("Airports: KSTP: …", "Advisories: none").
      add(stripMarkdown(m[1] ?? ""))
      matched = true
      break
    }
    if (!matched) add(line)
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
