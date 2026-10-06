/**
 * How a tool call reads to a pilot rather than to a developer.
 *
 * The transcript's tool cards used to print the tool name, its raw JSON
 * arguments and the raw result. That is the right material for a "Details"
 * disclosure and the wrong headline. This module turns a call into a title
 * ("Current weather (METAR) for KFCM, KDLH") and, where it is cheap and honest,
 * a one-line summary of the result ("2 airports VFR").
 *
 * Pure and React-free so every mapping is unit-tested. Everything here is
 * defensive: a tool whose arguments or result do not have the expected shape
 * still gets a title (the generic one), never a throw, and never a summary that
 * claims something the result did not say.
 *
 * Why a client-side map at all when the server ships `display` labels on the
 * live stream (`b4.step`)? Because those labels are not persisted: a restored
 * conversation never sees them, and the cards would read differently after a
 * reload. The map keeps the two paths identical; the server's label is still
 * used for any tool this map does not know (see `ToolCallCard`).
 */

import { formatHhmm } from "./format"

/** Where a call is: still running, finished, finished with an error, or refused by the person. */
export type ToolOutcome = "running" | "done" | "error" | "denied"

export interface ToolPresentation {
  /** The card's headline, in plain words. */
  readonly title: string
  /** One short line about the result, when one can be said without guessing. */
  readonly summary?: string
}

type Args = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "5500" → "5,500". Grouped by hand so the output never depends on the runtime's locale. */
export function formatFeet(feet: number): string {
  return String(Math.round(feet)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** A result string as JSON when it is JSON, else undefined. */
function parseJson(result: string | undefined): unknown {
  if (result === undefined) return undefined
  try {
    return JSON.parse(result) as unknown
  } catch {
    return undefined
  }
}

/** First line, trimmed, and bounded — a summary is one line, never a paragraph. */
function oneLine(text: string, limit = 90): string {
  const first = (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim()
  const chars = [...first]
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : first
}

const MEMORY_ID = /\bmemory_[0-9a-f]{6,}\b:?\s*/gi

/**
 * A `recall` result line is `<memory id>: <content>`. The id is the store's,
 * meaningless to a pilot, so it never reaches a human-facing line.
 */
export function stripMemoryIds(text: string): string {
  return text.replace(MEMORY_ID, "")
}

/** The id list a weather tool was asked about: `ids: ["kfcm", "kdlh"]` → "KFCM, KDLH". */
function stationList(args: Args): string | undefined {
  const ids = args.ids
  if (Array.isArray(ids)) {
    const list = ids
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.toUpperCase())
    return list.length > 0 ? list.join(", ") : undefined
  }
  return str(ids)?.toUpperCase()
}

/** "poh/cruise-performance.md" → "POH: cruise performance". */
function docTitle(path: string): string {
  const base = (path.split("/").at(-1) ?? path).replace(/\.mdx?$/i, "").replace(/[-_]+/g, " ")
  if (/^poh\//i.test(path)) return `POH: ${base}`
  if (/^regs?\//i.test(path)) return `regulations: ${base}`
  if (/^skills?\//i.test(path)) return `guide: ${base}`
  return path
}

/** "computeNavlog" → "Compute navlog": the fallback for a tool this map has never heard of. */
export function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
  return words.length === 0 ? name : `${words[0]?.toUpperCase()}${words.slice(1)}`
}

/**
 * A subagent's display name: `weather` → "Weather briefer". The two navlog
 * subagents brief the pilot, so that is what they are called; any other name
 * keeps its own word.
 */
export function subagentTitle(name: string | undefined): string {
  if (name === undefined) return "Helper"
  const known: Record<string, string> = {
    weather: "Weather briefer",
    performance: "Performance briefer",
  }
  return known[name] ?? `${name[0]?.toUpperCase()}${name.slice(1)} helper`
}

function metarSummary(result: unknown): string | undefined {
  if (!Array.isArray(result) || result.length === 0) return undefined
  const rows = result
    .filter(isRecord)
    .map((row) => ({ id: str(row.id), category: str(row.flightCategory) }))
    .filter((row): row is { id: string; category: string } => !!row.id && !!row.category)
  if (rows.length === 0) return undefined
  const categories = new Set(rows.map((row) => row.category))
  if (categories.size === 1) {
    return `${plural(rows.length, "airport")} ${rows[0]?.category}`
  }
  return rows.map((row) => `${row.id} ${row.category}`).join(" · ")
}

function advisoriesSummary(result: unknown): string | undefined {
  if (!Array.isArray(result)) return undefined
  if (result.length === 0) return "None on the route"
  const kinds = [
    ...new Set(
      result
        .filter(isRecord)
        .map((row) => [str(row.product), str(row.hazard)].filter(Boolean).join(" ")),
    ),
  ].filter((kind) => kind.length > 0)
  const head = plural(result.length, "advisory", "advisories")
  return kinds.length > 0 ? `${head}: ${kinds.slice(0, 3).join(", ")}` : head
}

function navlogSummary(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.totals)) return undefined
  const { distanceNm, eteMin, fuelGal } = result.totals
  const parts = [
    num(distanceNm) !== undefined ? `${Math.round(distanceNm as number)} nm` : undefined,
    num(eteMin) !== undefined ? formatHhmm(eteMin as number) : undefined,
    num(fuelGal) !== undefined ? `${(fuelGal as number).toFixed(1)} gal` : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

function recallSummary(result: string | undefined): string | undefined {
  if (result === undefined) return undefined
  const lines = result.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0 || /^\(no memories found\)$/i.test(result.trim())) {
    return "Nothing saved yet"
  }
  return plural(lines.length, "saved fact")
}

/**
 * The flight plan in one line, from its ICAO items. Each field is read only
 * when it has the shape `app/lib/fpl.ts` on the server writes, and dropped
 * otherwise, so a malformed plan yields a shorter line rather than a wrong one.
 *
 * `{ item7: "N738ZU", item13: "KFCM1500", item15: "N0109VFR DCT",
 *    item16: "KDLH0125", item18: "DOF/261007", item19: "E/0716 P/1" }` →
 * `N738ZU · KFCM → KDLH · depart 1500Z 7 Oct · 109 kt VFR direct ·
 *  en route 1:25 · endurance 7:16 · 1 aboard`
 */
export function flightPlanSummary(flightPlan: unknown): string | undefined {
  if (!isRecord(flightPlan)) return undefined
  const tail = str(flightPlan.item7)
  const item13 = /^([A-Z0-9]{4})(\d{4})$/.exec(str(flightPlan.item13) ?? "")
  const item16 = /^([A-Z0-9]{4})(\d{2})(\d{2})$/.exec(str(flightPlan.item16) ?? "")
  const dof = /^DOF\/\d{2}(\d{2})(\d{2})$/.exec(str(flightPlan.item18) ?? "")
  const item15 = /^N(\d{4})(VFR|IFR)?\s*(.*)$/.exec(str(flightPlan.item15) ?? "")
  const item19 = str(flightPlan.item19) ?? ""
  const endurance = /E\/(\d{2})(\d{2})/.exec(item19)
  const persons = /P\/(\d+)/.exec(item19)

  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  const month = dof ? months[Number(dof[1]) - 1] : undefined
  const date = dof && month ? ` ${Number(dof[2])} ${month}` : ""

  let route: string | undefined
  if (item15) {
    const fixes = (item15[3] ?? "")
      .split(/\s+/)
      .filter((token) => token.length > 0 && token !== "DCT")
    const speed = `${Number(item15[1])} kt`
    const rules = item15[2] ?? ""
    const path = fixes.length === 0 ? "direct" : `via ${fixes.join(" ")}`
    route = [speed, rules, path].filter((part) => part.length > 0).join(" ")
  }

  const parts = [
    tail,
    item13 && item16 ? `${item13[1]} → ${item16[1]}` : undefined,
    item13 ? `depart ${item13[2]}Z${date}` : undefined,
    route,
    item16 ? `en route ${Number(item16[2])}:${item16[3]}` : undefined,
    endurance ? `endurance ${Number(endurance[1])}:${endurance[2]}` : undefined,
    persons ? `${persons[1]} aboard` : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

/**
 * The title and summary for one call. `phase` picks the tense: "Checking…"
 * while it runs, "Checked" once it is done. `result` is the tool's output text
 * and is read only for a finished call.
 */
export function presentTool(
  name: string,
  args: Args,
  result: string | undefined,
  phase: "running" | "done",
): ToolPresentation {
  const running = phase === "running"
  const json = running ? undefined : parseJson(result)
  const pick = (whileRunning: string, whenDone: string) => (running ? whileRunning : whenDone)

  switch (name) {
    case "recall": {
      const query = str(args.query) ?? ""
      const subject = /aircraft|profile|tail/i.test(query)
        ? "saved aircraft profile"
        : "saved notes"
      return {
        title: pick(`Checking ${subject}`, `Checked ${subject}`),
        ...(running ? {} : optional(recallSummary(result))),
      }
    }
    case "remember": {
      const content = str(args.content)
      return {
        title: pick("Saving to memory", "Saved to memory"),
        ...optional(content ? oneLine(stripMemoryIds(content)) : undefined),
      }
    }
    case "getMetar": {
      const ids = stationList(args)
      return {
        title: `Current weather (METAR)${ids ? ` for ${ids}` : ""}`,
        ...optional(metarSummary(json)),
      }
    }
    case "getTaf": {
      const ids = stationList(args)
      return {
        title: `Forecasts (TAF)${ids ? ` for ${ids}` : ""}`,
        ...optional(Array.isArray(json) ? plural(json.length, "forecast") : undefined),
      }
    }
    case "getWindsAloft": {
      const altitude = num(args.altitudeFt)
      const station = str(args.station)?.toUpperCase()
      const wind = isRecord(json) && isRecord(json.wind) ? json.wind : undefined
      const dir = wind ? num(wind.dirDegTrue) : undefined
      const speed = wind ? num(wind.speedKt) : undefined
      return {
        title: `Winds aloft${altitude !== undefined ? ` at ${formatFeet(altitude)} ft` : ""}${station ? ` near ${station}` : ""}`,
        ...optional(
          dir !== undefined && speed !== undefined
            ? `${String(Math.round(dir)).padStart(3, "0")}° at ${Math.round(speed)} kt`
            : undefined,
        ),
      }
    }
    case "getAdvisories": {
      const lat = num(args.lat)
      const lon = num(args.lon)
      return {
        title: `Advisories${lat !== undefined && lon !== undefined ? ` near ${lat.toFixed(2)}, ${lon.toFixed(2)}` : ""}`,
        ...optional(advisoriesSummary(json)),
      }
    }
    case "lookupAirport": {
      const id = str(args.id)?.toUpperCase()
      const airport = isRecord(json) ? json : undefined
      const airportName = airport ? str(airport.name) : undefined
      const elevation = airport ? num(airport.elevationFt) : undefined
      return {
        title: `Airport info${id ? `: ${id}` : ""}`,
        ...optional(
          airportName
            ? `${airportName}${elevation !== undefined ? ` · elev ${formatFeet(elevation)} ft` : ""}`
            : undefined,
        ),
      }
    }
    case "readDoc":
    case "readFile": {
      const path = str(args.path)
      return {
        title: path
          ? `${pick("Reading", "Read")} ${docTitle(path)}`
          : pick("Reading a file", "Read a file"),
      }
    }
    case "computeNavlog":
      return {
        title: pick("Computing the navlog", "Computed the navlog"),
        ...optional(navlogSummary(json)),
      }
    case "fileFlightPlan": {
      const path = isRecord(json) ? str(json.path) : undefined
      return {
        title: pick("Recording flight plan", "Recorded flight plan"),
        ...optional(
          path
            ? `Saved to ${path} · not transmitted`
            : flightPlanSummary(isRecord(args) ? args.flightPlan : undefined),
        ),
      }
    }
    case "writeFile": {
      const path = str(args.path)
      const isReport = path !== undefined && /^reports\//i.test(path)
      return {
        title: isReport
          ? pick("Saving report", "Saved report")
          : pick("Saving a file", "Saved a file"),
        ...optional(path),
      }
    }
    case "renderChart": {
      const chartTitle = str(args.title)
      return {
        title: chartTitle
          ? `${pick("Drawing chart", "Chart")}: ${chartTitle}`
          : pick("Drawing a chart", "Chart"),
      }
    }
    case "writeTodos":
      return { title: pick("Updating the plan", "Updated the plan") }
    case "task": {
      const subagent = str(args.subagent) ?? str(args.subagent_type) ?? str(args.name)
      const brief = str(args.description) ?? str(args.input)
      return { title: subagentTitle(subagent), ...optional(brief ? oneLine(brief) : undefined) }
    }
    default:
      return { title: humanizeToolName(name) }
  }
}

function optional(summary: string | undefined): { summary?: string } {
  return summary === undefined || summary.length === 0 ? {} : { summary }
}

/**
 * Whether a finished call worked, read from its result text.
 *
 * The wire carries no success flag for a tool result (see `app/lib/hydrate.ts`),
 * so this reads only the two shapes B4.run itself produces: a refused gate
 * returns "Permission denied by user: …" as the result, and a tool that threw
 * comes back as an error message. Anything else is "done" — a card never claims
 * a failure the result does not state.
 */
export function outcomeFromResult(result: string | undefined): Exclude<ToolOutcome, "running"> {
  if (result === undefined) return "done"
  const text = result.trim()
  if (/^Permission denied\b/i.test(text)) return "denied"
  if (/^(Error\b|Tool error\b|B4_E\d+)/.test(text)) return "error"
  const json = parseJson(text)
  if (isRecord(json) && typeof json.error === "string" && Object.keys(json).length <= 3)
    return "error"
  return "done"
}
