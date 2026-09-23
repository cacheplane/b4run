// apps/web/app/styles/design-system.test.ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { COLOR, SHIKI_FOREGROUNDS } from "../../lib/design-tokens"

const stylesDir = resolve(__dirname)
const tokensCss = readFileSync(resolve(stylesDir, "tokens.css"), "utf8")

/** Every `--name: value;` inside the `@theme { … }` block. */
// biome-ignore lint/suspicious/noExportsInTest: later tasks import this helper to test tokens.css elsewhere
export function themeTokens(css: string): Record<string, string> {
  const block = /@theme\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? ""
  const out: Record<string, string> = {}
  // `[\w*-]` so the wildcard resets (`--radius-*: initial`) are captured too.
  for (const m of block.matchAll(/^\s*(--[\w*-]+):\s*([^;]+);/gm))
    out[m[1] as string] = (m[2] as string).trim()
  return out
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

// biome-ignore lint/suspicious/noExportsInTest: later tasks import this helper to test contrast elsewhere
export function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number]
  return (a + 0.05) / (b + 0.05)
}

const tokens = themeTokens(tokensCss)

describe("token values", () => {
  it.each([
    ["--color-page", "#f5f4f0"],
    ["--color-surface", "#eeeee7"],
    ["--color-surface-sunk", "#e8e8df"],
    ["--color-rule", "#d6d6cc"],
    ["--color-rule-strong", "#75796a"],
    ["--color-ink", "#111111"],
    ["--color-ink-muted", "#595b53"],
    ["--color-relay", "#b4ce37"],
    ["--color-relay-tint", "#e7edd1"],
    ["--color-relay-ink", "#424d18"],
    ["--color-olive", "#627410"],
    ["--color-focus", "#667811"],
    ["--color-panel", "#17181b"],
    ["--color-panel-strip", "#202226"],
    ["--color-panel-ink", "#f5f4f0"],
    ["--color-panel-muted", "#c4c8bc"],
    ["--color-panel-dim", "#a3aa99"],
    ["--color-panel-rule", "#4d5148"],
    ["--color-panel-accent", "#b4ce37"],
    ["--color-ok", "#1f6f3f"],
    ["--color-ok-tint", "#e3efe4"],
    ["--color-warn", "#8a5100"],
    ["--color-warn-tint", "#fff1ce"],
    ["--color-danger", "#a12f25"],
    ["--color-danger-tint", "#fbe8e5"],
    ["--text-eyebrow", "12px"],
    ["--text-eyebrow--letter-spacing", "0.07em"],
    ["--text-code", "13px"],
    ["--radius-*", "initial"],
    ["--shadow-*", "initial"],
  ])("%s is %s", (name, value) => {
    expect(tokens[name]).toBe(value)
  })

  it("declares no colour outside the roles (no accent-saas, ink-dim, divider, accent-blue)", () => {
    const names = Object.keys(tokens).filter((n) => n.startsWith("--color-"))
    expect(names.filter((n) => /saas|ink-dim|divider|accent-(blue|green|purple)/.test(n))).toEqual(
      [],
    )
  })
})

describe("TS mirror", () => {
  it("matches every --color-* token in tokens.css exactly", () => {
    const fromCss = Object.fromEntries(
      Object.entries(tokens)
        .filter(([n]) => n.startsWith("--color-"))
        .map(([n, v]) => [n.slice("--color-".length), v]),
    )
    expect(COLOR).toEqual(fromCss)
  })
})

describe("contrast (WCAG AA)", () => {
  const text: Array<[string, string]> = [
    ["ink", "page"],
    ["ink-muted", "page"],
    ["ink-muted", "surface"],
    ["olive", "page"],
    ["relay-ink", "relay-tint"],
    ["ink", "relay"],
    ["ink", "relay-tint"],
    ["ok", "ok-tint"],
    ["ok", "relay-tint"],
    ["warn", "warn-tint"],
    ["danger", "danger-tint"],
    ["panel-ink", "panel"],
    ["panel-muted", "panel"],
    ["panel-dim", "panel"],
    ["panel-accent", "panel"],
    ["panel-muted", "panel-strip"],
  ]
  it.each(text)("%s on %s ≥ 4.5:1", (fg, bg) => {
    expect(
      contrast(COLOR[fg as keyof typeof COLOR], COLOR[bg as keyof typeof COLOR]),
    ).toBeGreaterThanOrEqual(4.5)
  })
  it.each([
    ["focus", "page"],
    ["rule-strong", "page"],
    ["ink", "page"],
  ] as Array<[string, string]>)("%s on %s ≥ 3:1 (non-text)", (fg, bg) => {
    expect(
      contrast(COLOR[fg as keyof typeof COLOR], COLOR[bg as keyof typeof COLOR]),
    ).toBeGreaterThanOrEqual(3)
  })
  it("relay is a fill, not text: it fails on paper and the token table says so", () => {
    expect(contrast(COLOR.relay, COLOR.page)).toBeLessThan(3)
    expect(tokensCss).toMatch(/--color-relay: #b4ce37;\s*\/\*.*fill/i)
  })
  it.each(SHIKI_FOREGROUNDS)("Shiki foreground %s ≥ 4.5:1 on the panel", (hex) => {
    expect(contrast(hex, COLOR.panel)).toBeGreaterThanOrEqual(4.5)
  })
})
