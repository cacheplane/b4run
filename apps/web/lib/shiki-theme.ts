/**
 * The single Shiki theme for docs, blog, and homepage code. Every foreground is
 * ≥ 4.5:1 on --color-panel (#17181b); lib/design-tokens.ts lists them and
 * app/styles/design-system.test.ts checks the ratios. Add a scope here rather
 * than a second theme when a language renders flat.
 */
import type { ThemeRegistrationRaw } from "shiki"

// rehype-pretty-code only recognizes a raw JSON theme (as opposed to a
// light/dark theme map) when it carries `tokenColors`, so this mirrors
// `settings` under both keys; shiki itself reads `settings` first.
const settings = [
  {
    scope: ["keyword", "storage", "keyword.control", "keyword.operator.new"],
    settings: { foreground: "#c5d985" },
  },
  {
    scope: ["string", "constant.numeric", "constant.language", "constant.character"],
    settings: { foreground: "#e5cb9b" },
  },
  { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#a3aa99" } },
  {
    scope: [
      "entity.name.type",
      "entity.name.class",
      "support.type",
      "support.class",
      "entity.other.inherited-class",
    ],
    settings: { foreground: "#a8d4e0" },
  },
  {
    scope: [
      "entity.name.function",
      "support.function",
      "variable",
      "variable.other",
      "entity.name.tag",
      "entity.other.attribute-name",
    ],
    settings: { foreground: "#f5f4f0" },
  },
  { scope: ["punctuation", "keyword.operator", "meta.brace"], settings: { foreground: "#c4c8bc" } },
  { scope: ["markup.heading", "markup.inserted"], settings: { foreground: "#c5d985" } },
  { scope: ["markup.bold"], settings: { foreground: "#f5f4f0", fontStyle: "bold" } },
  { scope: ["markup.deleted"], settings: { foreground: "#f0ae95" } },
]

// `satisfies` keeps the literal types (the test reads settings[].settings.foreground)
// while staying assignable to shiki's mutable-array theme type; `as const` is not.
export const PAPER_RELAY_THEME = {
  name: "paper-relay",
  type: "dark",
  colors: { "editor.background": "#17181b", "editor.foreground": "#f5f4f0" },
  settings,
  tokenColors: settings,
} satisfies ThemeRegistrationRaw
