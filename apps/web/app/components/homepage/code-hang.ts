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
 * dropping the tags is enough.
 */
export function hangForHtml(html: string): number {
  return hangFor(html.replace(/<[^>]*>/g, ""))
}

/**
 * A shell command line ending in ` \` shows the space before the backslash
 * as a no-break space, so the `\` never wraps onto a line of its own. Display
 * only: the command text itself keeps its ordinary space.
 */
export function keepContinuation(line: string): string {
  return line.replace(/ \\$/, "\u00a0\\")
}
