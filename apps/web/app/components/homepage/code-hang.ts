import { createElement, Fragment, type ReactNode } from "react"
/**
 * The hanging indent for a wrapped code line. A line's text element carries
 * `data-hang={hangFor(text)}`, and app/styles/ui.css maps each value to
 * `padding-left: <n>ch; text-indent: -<n>ch`, so a continuation sits 4ch
 * deeper than the line's own indentation instead of at column 0.
 */

/** How much deeper than its line a continuation starts, in ch. */
export const HANG_STEP = 4
/** The deepest hang ui.css has a rule for, in ch. */
export const HANG_MAX = 20

/** The line's leading indentation plus HANG_STEP, in ch. A tab counts as 2. */
export function hangFor(text: string): number {
  let columns = 0
  for (const character of text) {
    if (character === " ") columns += 1
    else if (character === "\t") columns += 2
    else break
  }
  return Math.min(columns + HANG_STEP, HANG_MAX)
}

/**
 * The hang for a line of highlighted HTML (highlightCode's spans). Only the
 * leading whitespace counts, and highlightCode never escapes whitespace, so
 * this reads the text between tags until the first other character. It builds
 * no string from the HTML; it only counts.
 */
export function hangForHtml(html: string): number {
  let columns = 0
  let inTag = false
  for (const character of html) {
    if (inTag) {
      if (character === ">") inTag = false
    } else if (character === "<") {
      inTag = true
    } else if (character === " ") {
      columns += 1
    } else if (character === "\t") {
      columns += 2
    } else {
      break
    }
  }
  return Math.min(columns + HANG_STEP, HANG_MAX)
}

/**
 * A shell command line ending in ` \` shows the space before the backslash
 * as a no-break space, so the `\` never wraps onto a line of its own. Display
 * only: the command text itself keeps its ordinary space.
 */
export function keepContinuation(line: string): string {
  return line.replace(/ \\$/, "\u00a0\\")
}

/**
 * A long path or URL in a command (a registry reference on a phone) has no
 * space to break at, so `overflow-wrap: anywhere` splits it mid-word. A <wbr>
 * after each slash lets it break at a path segment instead; unlike a
 * zero-width space it adds nothing to the text a visitor selects or copies.
 */
export function withPathBreaks(line: string): ReactNode {
  if (!line.includes("/")) return line
  const parts = line.split("/")
  const last = parts.length - 1
  return parts.map((part, i) =>
    i < last
      ? createElement(Fragment, { key: i }, `${part}/`, createElement("wbr"))
      : createElement(Fragment, { key: i }, part),
  )
}
