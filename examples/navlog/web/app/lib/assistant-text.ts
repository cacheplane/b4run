import { parseVerdictText, type Verdict } from "./weather-selectors"

/**
 * Cleaning and reading the assistant's prose for display outside the
 * transcript (the navlog sheet's brief). Pure string functions, no React, so
 * the chat dock can reuse `stripToolEchoes` for its own bubbles.
 */

/** `recall({ query: "…" })`, `` `writeFile({…})` ``, `- task({ subagent: "weather" })`. */
const ECHO_LINE = /^\s*(?:[-*]\s+)?`?[A-Za-z_][\w.]*\(\s*\{.*\}\s*\)`?\s*;?\s*$/
/** The first line of an echo that spans lines: `name({` with no close on it. */
const ECHO_OPEN = /^\s*(?:[-*]\s+)?`?[A-Za-z_][\w.]*\(\s*\{[^}]*$/
const ECHO_CLOSE = /^\s*\}\s*\)`?\s*;?\s*$/
/** `Plan and todos`, `**Plan and todos:**`, `## Plan and todos`. */
const PLAN_HEADER = /^\s*(?:#+\s*)?(?:\*\*)?\s*plan\s+(?:and|&)\s+todos\s*:?\s*(?:\*\*)?\s*:?\s*$/i
/** `[completed] Fetch the METARs`, `- [in_progress] …`. */
const TODO_LINE = /^\s*(?:[-*]\s+|\d+\.\s+)?\[(?:completed|pending|in[_ -]progress)\]/i

/**
 * Removes the plumbing a model sometimes echoes into its answer: lines that are
 * only a tool call (`name({ … })`, on one line or across several), and a
 * "Plan and todos" header with its `[completed]`/`[pending]`/`[in_progress]`
 * lines. Everything else is kept as written; runs of blank lines left behind
 * collapse to one, and the result is trimmed.
 */
export function stripToolEchoes(text: string): string {
  const out: string[] = []
  const lines = text.split(/\r?\n/)
  let inEcho = false
  let inPlan = false
  for (const line of lines) {
    if (inEcho) {
      if (ECHO_CLOSE.test(line)) inEcho = false
      continue
    }
    if (inPlan) {
      if (TODO_LINE.test(line) || line.trim() === "") continue
      inPlan = false
    }
    if (ECHO_LINE.test(line)) continue
    if (ECHO_OPEN.test(line)) {
      inEcho = true
      continue
    }
    if (PLAN_HEADER.test(line)) {
      inPlan = true
      continue
    }
    out.push(line)
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export interface PlanningSection {
  readonly title: string
  readonly items: readonly string[]
}

/** The final planning answer in its structured shape. */
export interface PlanningAnswer {
  /** Null when "Bottom line:" does not start with GO, CAUTION or NO-GO. */
  readonly verdict: Verdict | null
  /** The bottom line as written, after the label. */
  readonly bottomLine: string
  /** "Watch for", "Numbers", "Assumptions" and any other labelled section, in order. */
  readonly sections: readonly PlanningSection[]
  /**
   * The closing the answer ends on, after its last section — typically the
   * question offering next steps ("Would you like me to file …?"). Present
   * only when there is one, so it never lands in a section as a bullet.
   */
  readonly closing?: string
}

const unbold = (text: string): string => text.replace(/\*\*/g, "").trim()
const BULLET = /^\s*(?:[-*•]\s+|\d+[.)]\s+)/
const SECTION = /^\s*(?:#+\s*)?(?:\*\*)?\s*([A-Z][A-Za-z /&-]{1,30}?)\s*:\s*(?:\*\*)?\s*(.*)$/
const BOTTOM_LINE = /^\s*(?:#+\s*)?(?:\*\*)?\s*bottom line\s*:?\s*(?:\*\*)?\s*:?\s*(.*)$/i
/** Labels that open a section; anything else with a colon is content. */
const KNOWN_SECTIONS =
  /^(watch for|numbers|assumptions|sources|notes?|next steps?|weather|route|fuel)$/i

/**
 * A question offering next steps: "Would you like me to file …?", "Shall I
 * re-brief …?", "Want me to try 6,500 ft?". It is the chat's to answer, not a
 * section item, wherever it appears.
 */
const NEXT_STEP_QUESTION =
  /^(?:would you like|would you prefer|do you want|shall i|should i|want me to|can i|may i|let me know)\b[\s\S]*\?\s*$/i

interface RawItem {
  readonly text: string
  /** The line's position in the answer, to keep the closing in reading order. */
  readonly at: number
  /** Written as a bullet or numbered item. */
  readonly bullet: boolean
  /** Indented: a wrapped continuation, never a closing. */
  readonly indented: boolean
  /** The content on the section's header line ("Assumptions: 2400 RPM"). */
  readonly onHeader: boolean
}

/**
 * Where the closing starts in the last section's items, or the item count
 * when there is none. A closing is a run of plain (non-bullet) lines at the
 * very end, each a question or written after the section's bullets ("-
 * standard temperature", then "Fly safe."). A section written as plain lines
 * keeps them, except a trailing question.
 */
function closingStart(items: readonly RawItem[]): number {
  let start = items.length
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as RawItem
    if (item.bullet || item.onHeader || item.indented) break
    const question = /\?\s*$/.test(item.text)
    const afterBullets = items.slice(0, i).some((earlier) => earlier.bullet)
    if (!question && !afterBullets) break
    start = i
  }
  return start
}

/**
 * Reads the parent's final planning answer — "Bottom line: GO|CAUTION|NO-GO —
 * …", then "Watch for:", "Numbers:", "Assumptions:" — into sections, or null
 * when the text has no "Bottom line:" (an answer written before that
 * contract, which the sheet renders as formatted text instead).
 *
 * The answer usually ends on a question offering next steps after its last
 * section's bullets. That line is the `closing`, not one more item: any
 * question offering next steps, wherever it is, and a trailing run of plain
 * lines after the last section's bullets (with or without a blank line
 * before it).
 */
export function parsePlanningAnswer(text: string): PlanningAnswer | null {
  const lines = stripToolEchoes(text).split("\n")
  const start = lines.findIndex((line) => BOTTOM_LINE.test(line))
  if (start < 0) return null
  const bottom = BOTTOM_LINE.exec(lines[start] as string)
  const bottomParts: string[] = [unbold(bottom?.[1] ?? "")]
  interface OpenSection {
    readonly title: string
    readonly items: RawItem[]
    /** The closing took items out of it. */
    trimmed: boolean
  }
  const sections: OpenSection[] = []
  const closing: RawItem[] = []
  let current: OpenSection | null = null
  for (const [at, line] of lines.slice(start + 1).entries()) {
    if (line.trim() === "") continue
    const bullet = BULLET.test(line)
    const header = bullet ? null : SECTION.exec(line)
    if (header && KNOWN_SECTIONS.test((header[1] as string).trim())) {
      current = { title: (header[1] as string).trim(), items: [], trimmed: false }
      sections.push(current)
      const rest = unbold(header[2] ?? "")
      if (rest !== "") {
        current.items.push({ text: rest, at, bullet: false, indented: false, onHeader: true })
      }
      continue
    }
    const item: RawItem = {
      text: unbold(line.replace(BULLET, "")),
      at,
      bullet,
      indented: /^\s/.test(line),
      onHeader: false,
    }
    if (NEXT_STEP_QUESTION.test(item.text)) {
      closing.push(item)
      if (current !== null) current.trimmed = true
    } else if (current === null) bottomParts.push(item.text)
    else current.items.push(item)
  }
  const last = sections.at(-1)
  if (last !== undefined) {
    const from = closingStart(last.items)
    if (from < last.items.length) {
      closing.push(...last.items.splice(from))
      last.trimmed = true
    }
  }
  const bottomLine = bottomParts.filter((part) => part !== "").join(" ")
  const closingText = closing
    .sort((a, b) => a.at - b.at)
    .map((item) => item.text)
    .join(" ")
  return {
    verdict: parseVerdictText(bottomLine),
    bottomLine,
    // A section the closing emptied ("Assumptions:" over only the question) goes.
    sections: sections
      .filter((section) => !(section.trimmed && section.items.length === 0))
      .map((section) => ({ title: section.title, items: section.items.map((item) => item.text) })),
    ...(closingText !== "" ? { closing: closingText } : {}),
  }
}

/** A block of markdown-ish prose: what the sheet renders for a free-text answer. */
export type TextBlock =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "paragraph"; readonly text: string }

/**
 * Splits prose into headings (`#`, or a whole-line `**bold:**`), bullet or
 * numbered lists, and paragraphs. Deliberately small: the answers are short
 * and the sheet only needs the shape, not full markdown.
 */
export function textBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") })
    paragraph = []
    if (list !== null) blocks.push({ kind: "list", ordered: list.ordered, items: list.items })
    list = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "") {
      flush()
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line) ?? /^\*\*([^*]+)\*\*:?$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: "heading", text: (heading[1] as string).replace(/:$/, "") })
      continue
    }
    const bullet = /^(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (bullet) {
      if (paragraph.length > 0) {
        blocks.push({ kind: "paragraph", text: paragraph.join(" ") })
        paragraph = []
      }
      const ordered = bullet[2] !== undefined
      if (list === null || list.ordered !== ordered) {
        if (list !== null) blocks.push({ kind: "list", ordered: list.ordered, items: list.items })
        list = { ordered, items: [] }
      }
      list.items.push(bullet[3] as string)
      continue
    }
    if (list !== null) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items })
      list = null
    }
    paragraph.push(line)
  }
  flush()
  return blocks
}

/** `a **b** c` into `[{ text: "a ", bold: false }, { text: "b", bold: true }, …]`. */
export function inlineSegments(text: string): { readonly text: string; readonly bold: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter((part) => part !== "")
    .map((part) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4
        ? { text: part.slice(2, -2), bold: true }
        : { text: part, bold: false },
    )
}
