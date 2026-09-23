/**
 * Class-based syntax colours. Shiki paints every token with an inline
 * `style="color:#…"`; on a long reference page that is ~1,000 attributes. The
 * theme has only a handful of distinct foregrounds, so each becomes one class
 * and the font styles become four more. `lib/rehype-syntax-classes.mjs` (MDX)
 * and `app/components/homepage/highlight.ts` emit the classes; the stylesheet
 * `app/styles/syntax.css` is generated from this module, and
 * `app/components/docs/docs-syntax-theme.test.ts` fails when the two drift.
 */
import { PAPER_RELAY_THEME } from "./shiki-theme"

/** Every foreground the theme can emit, default first, in theme order. */
export const SYNTAX_FOREGROUNDS: readonly string[] = [
  ...new Set(
    [
      PAPER_RELAY_THEME.colors["editor.foreground"],
      ...PAPER_RELAY_THEME.settings.map((rule) => rule.settings.foreground),
    ].map((hex) => hex.toLowerCase()),
  ),
]

/**
 * One inline declaration (lowercase, no spaces, as in `color:#rrggbb`) → its class.
 * A plain object so it can ride in the MDX plugin options, which Turbopack
 * requires to be serializable.
 */
export const SYNTAX_CLASSES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(SYNTAX_FOREGROUNDS.map((hex, index) => [`color:${hex}`, `sh${index}`])),
  "font-style:italic": "shi",
  "font-weight:bold": "shb",
  "text-decoration:underline": "shu",
  "text-decoration:line-through": "shs",
}

/**
 * The classes for an inline style, or `undefined` when any declaration has no
 * class (the caller then keeps the inline style, so nothing renders differently).
 */
export function syntaxClassesFor(style: string): string[] | undefined {
  const classes: string[] = []
  for (const declaration of style.split(";")) {
    const key = declaration.replaceAll(/\s+/g, "").toLowerCase()
    if (!key) continue
    const name = SYNTAX_CLASSES[key]
    if (!name) return undefined
    classes.push(name)
  }
  return classes
}

/** The contents of `app/styles/syntax.css`, formatted as Biome formats CSS. */
export function syntaxStylesheet(): string {
  const rules = Object.entries(SYNTAX_CLASSES).map(([declaration, name]) => {
    const colon = declaration.indexOf(":")
    return `.${name} {\n  ${declaration.slice(0, colon)}: ${declaration.slice(colon + 1)};\n}\n`
  })
  return [
    "/* Generated from lib/shiki-theme.ts by lib/shiki-classes.ts. Do not edit: change the\n" +
      "   theme, then run `pnpm exec vitest --run -u app/components/docs/docs-syntax-theme.test.ts`.\n" +
      "   Unlayered on purpose, so a token colour outranks layered rules as the inline\n" +
      "   style it replaces did. */\n",
    ...rules,
  ].join("")
}
