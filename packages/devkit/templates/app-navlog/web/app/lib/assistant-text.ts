/**
 * Cleaning and reading the assistant's prose for display: the chat dock's
 * bubbles and the brief kit's `Prose` component and default markdown
 * renderer. Pure string functions, no React. A structured answer's JSON is
 * read by `../brief/parse`, not here.
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

/** A block of markdown-ish prose: what the brief kit's default markdown renderer draws. */
export type TextBlock =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "paragraph"; readonly text: string }

/**
 * Splits prose into headings (`#`, or a whole-line `**bold:**`), bullet or
 * numbered lists, and paragraphs. Deliberately small: the answers are short
 * and the renderer only needs the shape, not full markdown.
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
