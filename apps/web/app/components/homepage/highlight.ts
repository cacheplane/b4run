import "server-only"
import { type BundledLanguage, createHighlighter } from "shiki"
import { COLOR } from "../../../lib/design-tokens"
import { syntaxClassesFor } from "../../../lib/shiki-classes"
import { PAPER_RELAY_THEME } from "../../../lib/shiki-theme"
import type { DisplayCode } from "./types"

const highlighter = createHighlighter({
  langs: ["typescript", "markdown", "json"],
  themes: [PAPER_RELAY_THEME],
})
const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

export async function highlightCode(
  raw: string,
  lang: BundledLanguage,
  path: string,
  url: string,
  firstLine = 1,
): Promise<DisplayCode> {
  const tokens = (await highlighter).codeToTokens(raw.trimEnd(), {
    lang,
    theme: "paper-relay",
  }).tokens
  return {
    raw,
    path,
    url,
    firstLine,
    lines: tokens.map(
      (line) =>
        line
          .map((token) => {
            // Colour only, as before; app/styles/syntax.css holds the classes.
            const style = `color:${token.color ?? COLOR["panel-ink"]}`
            const classes = syntaxClassesFor(style)
            const attribute = classes ? `class="${classes.join(" ")}"` : `style="${style}"`
            return `<span ${attribute}>${escapeHtml(token.content)}</span>`
          })
          .join("") || " ",
    ),
  }
}
