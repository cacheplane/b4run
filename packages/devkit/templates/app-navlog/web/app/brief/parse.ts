import type { Verdict, VerdictLevel } from "../lib/weather-selectors"

/**
 * Reading a structured answer outside React, without hashbrown: the finished
 * answer's JSON, or the bottom line of one still streaming. The verdict reads
 * its bottom line from here.
 */

/** What a structured answer says, as far as the rest of the app needs it. */
export interface BriefAnswer {
  /** The `BottomLine` component's call, when the answer has a well-formed one. */
  readonly bottomLine?: Verdict
}

const LEVELS: readonly string[] = ["GO", "CAUTION", "NO-GO"] satisfies VerdictLevel[]

/**
 * Whether `text` is (the start of) a structured answer, `{ "ui": [...] }`,
 * rather than markdown. True for a partial answer still streaming.
 */
export function isStructuredAnswer(text: string): boolean {
  return text.trimStart().startsWith("{")
}

/**
 * Reads a complete structured answer. Null for markdown, a partial answer, or
 * JSON that is not `{ "ui": [...] }`; `bottomLine` is absent when no
 * `BottomLine` has a known level and a reason.
 */
export function parseBriefAnswer(text: string): BriefAnswer | null {
  if (!isStructuredAnswer(text)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const ui = (parsed as { ui?: unknown } | null)?.ui
  if (!Array.isArray(ui)) return null
  for (const node of ui) {
    const props = (node as { BottomLine?: { props?: unknown } } | null)?.BottomLine?.props
    if (props === undefined) continue
    const bottomLine = verdictOf(props)
    if (bottomLine !== null) return { bottomLine }
  }
  return {}
}

/** A `BottomLine`'s props as a verdict: a known level and a reason, or null. */
function verdictOf(props: unknown): Verdict | null {
  const { level, reason } = (props ?? {}) as { level?: unknown; reason?: unknown }
  if (typeof level === "string" && LEVELS.includes(level) && typeof reason === "string") {
    return { level: level as VerdictLevel, reason }
  }
  return null
}

/** Where a streamed answer whose first component is a `BottomLine` starts its props object. */
const LEADING_BOTTOM_LINE =
  /^\s*\{\s*"ui"\s*:\s*\[\s*\{\s*"BottomLine"\s*:\s*\{\s*"props"\s*:\s*(?=\{)/

/**
 * The end (exclusive) of the JSON object that opens at `start`, or -1 when it
 * has not closed yet. Braces inside strings, escaped quotes included, do not count.
 */
function objectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === "\\") i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * The planner's call in a structured answer, complete or still streaming:
 * the `BottomLine`'s level and reason. The bottom line is the first component
 * of a planning answer, so its props close long before the answer does, and
 * the verdict card agrees with it while the rest streams. Null for markdown,
 * an answer with no usable bottom line, or one whose bottom line props are
 * still arriving.
 */
export function readBottomLine(text: string): Verdict | null {
  const complete = parseBriefAnswer(text)
  if (complete !== null) return complete.bottomLine ?? null
  const lead = LEADING_BOTTOM_LINE.exec(text)
  if (lead === null) return null
  const start = lead[0].length
  const end = objectEnd(text, start)
  if (end < 0) return null
  try {
    return verdictOf(JSON.parse(text.slice(start, end)))
  } catch {
    return null
  }
}
