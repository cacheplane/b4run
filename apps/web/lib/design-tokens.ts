/**
 * TS mirror of the colour roles in app/styles/tokens.css, for the places that
 * cannot read CSS variables: Satori Open Graph images and `viewport.themeColor`.
 * app/styles/design-system.test.ts fails if this drifts from the CSS.
 */
export const COLOR = {
  page: "#f5f4f0",
  surface: "#eeeee7",
  "surface-sunk": "#e8e8df",
  rule: "#d6d6cc",
  "rule-strong": "#75796a",
  ink: "#111111",
  "ink-muted": "#595b53",
  relay: "#b4ce37",
  "relay-tint": "#e7edd1",
  "relay-ink": "#424d18",
  olive: "#627410",
  focus: "#667811",
  panel: "#17181b",
  "panel-strip": "#202226",
  "panel-ink": "#f5f4f0",
  "panel-muted": "#c4c8bc",
  "panel-dim": "#a3aa99",
  "panel-rule": "#4d5148",
  "panel-accent": "#b4ce37",
  ok: "#1f6f3f",
  "ok-tint": "#e3efe4",
  warn: "#8a5100",
  "warn-tint": "#fff1ce",
  danger: "#a12f25",
  "danger-tint": "#fbe8e5",
} as const

/** Every foreground the Shiki theme emits; each must be ≥ 4.5:1 on COLOR.panel. */
export const SHIKI_FOREGROUNDS = [
  "#f5f4f0", // default / variables / functions
  "#c5d985", // keywords, storage, inserted lines, headings
  "#e5cb9b", // strings, numbers, constants
  "#a3aa99", // comments
  "#a8d4e0", // types, classes, support types
  "#c4c8bc", // punctuation, operators
  "#f0ae95", // deleted lines
] as const
