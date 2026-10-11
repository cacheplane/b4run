import type { StepView, TurnsView, TurnView } from "@b4run/ag-ui/view"
import type { Verdict, VerdictLevel } from "./verdict"

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
  /** The "Verdict:" line, when the brief has one (briefs written before the verdict contract do not). */
  readonly verdict?: Verdict
  /** The "Forecast horizon:" sentence, when the brief has one. */
  readonly horizon?: string
}

/**
 * A raw report as a card shows it, under its own "METAR" or "TAF" label: the
 * report without that same leading word (a "METAR METAR KPAO …" line reads
 * twice), "none" when the briefer said the station issues none ("TAF none"),
 * and "missing" when the brief carries nothing for it. A SPECI keeps its word,
 * because the label alone would hide that it is a special observation.
 */
export type ReportView =
  | { readonly kind: "report"; readonly body: string }
  | { readonly kind: "none" }
  | { readonly kind: "missing" }

/** How to show a METAR or TAF line from the brief (see `ReportView`). */
export function reportView(text: string, label: "METAR" | "TAF"): ReportView {
  const trimmed = text.trim()
  if (trimmed === "") return { kind: "missing" }
  if (new RegExp(`^${label}\\s+none\\.?$`, "i").test(trimmed)) return { kind: "none" }
  // Every leading copy of the word, with or without a colon: a briefer that
  // labels its line ("METAR: METAR KPAO …") repeats it.
  // A trailing period is the briefer's sentence, never part of a report.
  const body = trimmed.replace(new RegExp(`^(?:${label}:?\\s+)+`), "").replace(/\.$/, "")
  if (/^none\.?$/i.test(body)) return { kind: "none" }
  return { kind: "report", body }
}

/** The first flight category a text names, or `UNKNOWN`. */
export function categoryOf(text: string): FlightCategory {
  const m = /\b(LIFR|MVFR|IFR|VFR)\b/i.exec(text)
  return m ? ((m[1] as string).toUpperCase() as FlightCategory) : "UNKNOWN"
}

/** Worst first. UNKNOWN sorts last, so a known category always wins over it. */
const SEVERITY: readonly FlightCategory[] = ["LIFR", "IFR", "MVFR", "VFR", "UNKNOWN"]

/**
 * The one category an airport is shown in, on the chip and on its map marker:
 * the worse of now and at ETA, whichever way the weather is trending. An
 * improving airport (MVFR now, VFR at ETA) is MVFR, because the pilot may have
 * to depart or divert into the weather as it is now.
 */
export function worstCategory(airport: Pick<AirportWeather, "now" | "atEta">): FlightCategory {
  return SEVERITY.indexOf(airport.now) <= SEVERITY.indexOf(airport.atEta)
    ? airport.now
    : airport.atEta
}

const EMPTY: WeatherBrief = { airports: [], winds: [], advisories: [], note: "" }

type Section = "airports" | "winds" | "advisories" | "note" | "verdict" | "horizon"

/**
 * A section header, after `stripMarkdown`: the name, bold closed before or
 * after the colon (`Airports**:`, `Airports:**`), then the line's content. A
 * line that is only the name (`### Airports`) is a header too; a name followed
 * by words and no colon ("Advisories expire before departure") is prose.
 */
const header = (name: string): RegExp =>
  new RegExp(`^${name}(?:\\*\\*)?(?::(?:\\*\\*)?\\s*(.*)|\\s*)$`, "i")

const HEADERS: readonly { readonly section: Section; readonly pattern: RegExp }[] = [
  { section: "verdict", pattern: header("verdict") },
  { section: "horizon", pattern: header("forecast horizon") },
  { section: "airports", pattern: header("airports") },
  { section: "winds", pattern: header("winds per leg") },
  { section: "advisories", pattern: header("advisories") },
  { section: "note", pattern: header("go\\/no-go note") },
]

/** Drop the markdown a model tends to add: a bullet (`-`, `*`, `•`, `1.`, `1)`) or heading marker, and bold around the line. */
const stripMarkdown = (line: string): string =>
  line
    .replace(/^\s*(?:[-*\u2022]\s+|\d+[.)]\s+|#+\s+)?(?:\*\*)?/, "")
    .replace(/\*\*\s*$/, "")
    .trim()

/**
 * An airport line: the id (its leading `**` already stripped), an optional
 * name in parentheses, then a colon, a comma, a dash or an en or em dash:
 * `KSTP: …`, `**KSTP** — …`, `KSTP (St Paul): …`, `KSTP - …`. A hyphen needs
 * spaces round it, so a hyphenated word is never read as the separator.
 */
const AIRPORT_LINE =
  /^([A-Z0-9]{3,4})(?:\*\*)?(?:\s*\([^)]*\))?(?:\s*[:,]|\s*[\u2013\u2014]|\s+-\s)\s*(.*)$/
/** Where the raw report starts: a routine METAR or a special SPECI. */
const RAW_REPORT = /\b(METAR|SPECI)\b/
/** Where the raw TAF starts: `TAF KPAO …`, `TAF AMD KPAO …`, or `TAF none` for a station without one. */
const RAW_TAF = /\bTAF(?:\s+(?:AMD|COR))?\s+(?:[A-Z0-9]{3,4}\b|none\b)/

/** An airport line by its content, not its section: id, separator, a category, and "now" or a METAR. */
function looksLikeAirportLine(line: string): boolean {
  const m = AIRPORT_LINE.exec(line)
  if (!m) return false
  const rest = m[2] ?? ""
  return /\b(LIFR|MVFR|IFR|VFR)\b/.test(rest) && /\bnow\b|\b(METAR|SPECI)\b/i.test(rest)
}

function parseAirport(line: string): AirportWeather | null {
  const m = AIRPORT_LINE.exec(line)
  if (!m) return null
  const [, id, rest] = m as unknown as [string, string, string]
  const reportAt = rest.search(RAW_REPORT)
  // The raw TAF follows the raw METAR. The summary before them can say "TAF"
  // too ("TAF coverage at ETA"), so the search starts at the report and wants
  // a report's shape: "TAF", an optional AMD or COR, then a station or "none".
  const tafFrom = Math.max(reportAt, 0)
  const tafOffset = rest.slice(tafFrom).search(RAW_TAF)
  const tafAt = tafOffset >= 0 ? tafFrom + tafOffset : -1
  const head = reportAt >= 0 ? rest.slice(0, reportAt).trim() : rest
  const metar =
    reportAt >= 0 ? rest.slice(reportAt, tafAt > reportAt ? tafAt : undefined).trim() : ""
  const taf = tafAt >= 0 ? rest.slice(tafAt).trim() : ""
  const [nowText = "", etaText = ""] = head.split(",")
  return { id, now: categoryOf(nowText), atEta: categoryOf(etaText), line: head, metar, taf }
}

/**
 * Parse the weather subagent's brief. The subagent is prompted to a fixed
 * shape (sections "Verdict:", "Forecast horizon:", "Airports:", "Winds per
 * leg:", "Advisories:", "Go/no-go note:"; the first two are newer, so a brief
 * without them still parses), but a model may still bullet it, bold the
 * headers, or start the first airport on the header line, so each line is
 * unwrapped from that markdown first. Anything else degrades to an empty brief
 * rather than a throw.
 */
export function parseWeatherBrief(text: string): WeatherBrief {
  let section: Section | null = null
  const airports: AirportWeather[] = []
  const winds: string[] = []
  const advisories: string[] = []
  const note: string[] = []
  const verdictText: string[] = []
  const horizon: string[] = []

  const add = (line: string): void => {
    if (line === "") return
    if (section === "airports") {
      const airport = parseAirport(line)
      if (airport) airports.push(airport)
    } else if (section === "winds") winds.push(line)
    else if (section === "advisories" && !/^none\.?$/i.test(line)) advisories.push(line)
    else if (section === "note") note.push(line)
    else if (section === "verdict") verdictText.push(line)
    else if (section === "horizon") horizon.push(line)
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
    if (!matched) {
      // A model sometimes drops the "Airports:" header and writes the airport
      // lines straight after "Forecast horizon:". An unmistakable airport line
      // (an id, a separator, a flight category, and "now" or a raw METAR) opens
      // the airports section wherever it appears.
      if (section !== "airports" && looksLikeAirportLine(line)) section = "airports"
      add(line)
    }
  }
  const verdict = verdictText.length > 0 ? parseVerdictText(verdictText.join(" ")) : null
  const horizonText = horizon.join(" ")
  if (
    airports.length === 0 &&
    winds.length === 0 &&
    advisories.length === 0 &&
    note.length === 0 &&
    verdict === null
  ) {
    return EMPTY
  }
  return {
    airports,
    winds,
    advisories,
    note: note.join(" "),
    ...(verdict !== null ? { verdict } : {}),
    ...(horizonText !== "" ? { horizon: horizonText } : {}),
  }
}

/**
 * `GO — one sentence why`, `CAUTION: …`, `NO-GO - …` (also `NO GO`, `NOGO`,
 * any case, optionally bold) into a verdict, or null when the text does not
 * start with one of the three levels.
 */
export function parseVerdictText(text: string): Verdict | null {
  const m = /^\s*(?:\*\*)?\s*(NO[\s-]?GO|CAUTION|GO)\b(?:\*\*)?\s*[—–:.,-]*\s*([\s\S]*)$/i.exec(
    text,
  )
  if (!m) return null
  const word = (m[1] as string).toUpperCase().replace(/[\s-]/g, "")
  const level: VerdictLevel = word === "NOGO" ? "NO-GO" : word === "CAUTION" ? "CAUTION" : "GO"
  const reason = (m[2] ?? "").replace(/\*\*/g, "").trim()
  // The reason reads as a sentence under the verdict word, whatever case the model used.
  return { level, reason: reason.charAt(0).toUpperCase() + reason.slice(1) }
}

/**
 * True when the forecast-horizon sentence says the departure lies beyond the
 * forecasts, so the brief is preliminary; false when it is within them.
 */
export function isPreliminary(horizon: string | undefined): boolean {
  if (horizon === undefined || horizon.trim() === "") return false
  return /\bpreliminary\b|\bdo(?:es)? not (?:yet )?(?:reach|cover)|\bbeyond\b|\bnot yet\b/i.test(
    horizon,
  )
}

/** A result that arrived JSON-encoded (`"Verdict: …"`) is unwrapped once. */
function unwrapText(result: unknown): string | null {
  if (typeof result !== "string") return null
  if (result.startsWith('"')) {
    try {
      const inner: unknown = JSON.parse(result)
      if (typeof inner === "string") return inner
    } catch {
      // Not JSON: the text itself.
    }
  }
  return result
}

function findWeatherText(turn: TurnView): string | null {
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    const step: StepView | undefined = turn.steps[i]
    if (step?.kind !== "subagent") continue
    const nested = findWeatherText(step.turn)
    if (nested !== null) return nested
    if (step.name !== "weather" || step.status !== "done") continue
    const text = unwrapText(step.result)
    if (text !== null && parseWeatherBrief(text).airports.length > 0) return text
  }
  return null
}

/**
 * The latest `weather` subagent step with status "done" (any depth) whose
 * result (a string, or a JSON-encoded string unwrapped once) parses to at
 * least one airport. A string so callers can memoize the parse on it.
 */
export function latestWeatherBriefText(view: TurnsView): string | null {
  const { turns } = view
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn === undefined) continue
    const found = findWeatherText(turn)
    if (found !== null) return found
  }
  return null
}
