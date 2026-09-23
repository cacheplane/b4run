import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { contrast, themeTokens } from "../../lib/design-system-checks"
import { COLOR, SHIKI_FOREGROUNDS } from "../../lib/design-tokens"

const stylesDir = resolve(__dirname)
const tokensCss = readFileSync(resolve(stylesDir, "tokens.css"), "utf8")

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

const webRoot = resolve(stylesDir, "../..")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(tsx?|css|webmanifest)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

/** Drops `// …` and `/* … *\/` comments so a guard on markup does not trip on a doc comment. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
}

const sources = [
  ...walk(resolve(webRoot, "app")),
  ...walk(resolve(webRoot, "lib")),
  resolve(webRoot, "mdx-components.tsx"),
  resolve(webRoot, "public/site.webmanifest"),
].map((path) => ({ path: path.slice(webRoot.length + 1), text: readFileSync(path, "utf8") }))

describe("guard: the old palette and its classes stay gone", () => {
  const forbidden: Array<[string, RegExp]> = [
    [
      "amber/white palette hex",
      /#(b45309|fef3c7|fafaf7|14110d|5a554c|6b6657|e6e3da|cfcabd|50534a|616459|55594f|62665b|d0d2c6|ffffff)\b/i,
    ],
    [
      "legacy token names",
      /\b(accent-saas|accent-green|accent-blue|accent-purple|ink-dim|divider(-strong)?|text-display-(xl|l)|--b4-font-sans|--docs-(relay|tint))\b/,
    ],
    ["rounded-* / shadow-* utilities", /\b(rounded(-[a-z0-9[\]]+)?|shadow-[a-z0-9]+)\b/],
    [
      "classes that match no token",
      /\b(text-bg-primary|hover:border-text-muted|placeholder-text-muted)\b/,
    ],
    ["the docs-brand scope", /data-docs-brand/],
    ["dual Shiki output", /--shiki-(light|dark)/],
    ["literal ↗ in markup", /↗/],
    ["focus-visible utilities (the ring is global)", /focus-visible:(ring|outline)/],
  ]
  it.each(forbidden)("no %s", (_label, pattern) => {
    const arrow = pattern.source.includes("↗")
    const hits = sources.flatMap(({ path, text }) => {
      if (arrow && path.endsWith(".css")) return [] // ui.css draws it
      // The arrow guard is about JSX: a doc comment may name the glyph it replaces.
      const m = (arrow ? stripComments(text) : text).match(pattern)
      return m ? [`${path}: ${m[0]}`] : []
    })
    expect(hits).toEqual([])
  })

  it("has no hex colour outside tokens.css, the TS mirror, the Shiki theme, and the OG image routes", () => {
    const allowed =
      /(styles\/tokens\.css|lib\/shiki-theme\.ts|lib\/design-tokens\.ts|opengraph-image\.tsx|site\.webmanifest)$/
    // ui.css paints diff lines in the two Shiki foregrounds it mirrors; nothing else in it may be hex.
    const shikiMirror = /^#(c5d985|f0ae95)$/i
    const hits = sources
      .filter(({ path }) => !allowed.test(path))
      .flatMap(({ path, text }) =>
        [...text.matchAll(/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/gi)]
          .map((m) => m[0])
          .filter((hex) => !(path.endsWith("styles/ui.css") && shikiMirror.test(hex)))
          .map((hex) => `${path}: ${hex}`),
      )
    expect([...new Set(hits)]).toEqual([])
  })

  it("has no border-radius other than 0 or 50% in CSS", () => {
    const hits = sources
      .filter(({ path }) => path.endsWith(".css"))
      .flatMap(({ path, text }) =>
        [...text.matchAll(/border-radius:\s*([^;]+);/g)]
          .filter((m) => !/^(0|50%)$/.test((m[1] as string).trim()))
          .map((m) => `${path}: ${m[0]}`),
      )
    expect(hits).toEqual([])
  })
})

describe("contract: every referenced token is declared", () => {
  it("resolves every var(--color-*), var(--text-*) and var(--font-*) to tokens.css", () => {
    const declared = new Set(Object.keys(tokens))
    const missing = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/var\((--(?:color|text|font)-[\w-]+)/g)]
        .map((m) => m[1] as string)
        .filter((name) => !declared.has(name) && !/^--font-(inter|jetbrains-mono)$/.test(name))
        .map((name) => `${path}: ${name}`),
    )
    expect([...new Set(missing)]).toEqual([])
  })

  it("resolves every Tailwind colour utility to a declared role", () => {
    const roles = new Set(
      Object.keys(tokens)
        .filter((n) => n.startsWith("--color-"))
        .map((n) => n.slice(8)),
    )
    const nonColour =
      /^(left|right|center|justify|nowrap|wrap|clip|ellipsis|xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|balance|pretty|transparent|current|inherit|t|b|l|r|x|y|display|h1|h2|h3|body|body-lg|code|eyebrow|none)$/
    const missing = sources
      .filter(({ path }) => path.endsWith(".tsx"))
      .flatMap(({ path, text }) =>
        [
          ...text.matchAll(
            /\b(?:text|bg|border|decoration|placeholder:text|hover:text|hover:bg|hover:border|focus:bg|group-hover:text)-([a-z][a-z-]*?)(?=[\s"'`/\]:])/g,
          ),
        ]
          .map((m) => m[1] as string)
          .filter((name) => !roles.has(name) && !nonColour.test(name))
          .map((name) => `${path}: ${name}`),
      )
    expect([...new Set(missing)]).toEqual([])
  })
})
