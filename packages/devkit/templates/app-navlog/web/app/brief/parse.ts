import type { Verdict, VerdictLevel } from "../lib/weather-selectors"

/**
 * Reading a structured answer outside React: no hashbrown, no streaming, just
 * the finished answer's JSON. The verdict reads its bottom line from here.
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
    const props = (
      node as { BottomLine?: { props?: { level?: unknown; reason?: unknown } } } | null
    )?.BottomLine?.props
    if (props === undefined) continue
    const { level, reason } = props
    if (typeof level === "string" && LEVELS.includes(level) && typeof reason === "string") {
      return { bottomLine: { level: level as VerdictLevel, reason } }
    }
  }
  return {}
}
