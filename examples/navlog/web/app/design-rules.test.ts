import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, test } from "vitest"

/**
 * LiveLoveApp's design rules, the subset a scan can check (see
 * docs/superpowers/specs/2026-10-08-navlog-lla-shell-design.md). Modelled on
 * LLA's own `src/lib/design-rules.test.ts`.
 *
 * Comments are stripped before matching, so prose that explains why a rule
 * exists does not trip it. The flight-category, verdict and status colours
 * are allowed: they are data, and no rule here is about colour.
 */
const APP = join(import.meta.dirname)

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
}

const files = walk(APP).map((path) => ({
  file: relative(APP, path),
  source: stripComments(readFileSync(path, "utf8")),
}))

const offenders = (pattern: RegExp): string[] =>
  files.filter(({ source }) => pattern.test(source)).map(({ file }) => file)

describe("design rules", () => {
  test("scans the app's source", () => {
    expect(files.map(({ file }) => file)).toContain("theme.css")
    expect(files.map(({ file }) => file)).toContain("layout.tsx")
  })

  test("uses no uppercase text transform", () => {
    expect(offenders(/\buppercase\b|text-transform:\s*uppercase/)).toEqual([])
  })

  test("uses no positive letter-spacing", () => {
    expect(
      offenders(
        /tracking-(wide|wider|widest)\b|tracking-\[0?\.?\d|letter-spacing:\s*(?!-)\.?\d*[1-9]/,
      ),
    ).toEqual([])
  })

  test("uses no gradients, shadows or glass", () => {
    expect(
      offenders(
        /gradient|\bshadow\b|shadow-|box-shadow|text-shadow|drop-shadow|backdrop-blur|backdrop-filter/,
      ),
    ).toEqual([])
  })

  test("has no dark scheme", () => {
    expect(
      offenders(/prefers-color-scheme:\s*dark|data-wb-theme|\bdark:|\.dark\b|color-scheme:\s*dark/),
    ).toEqual([])
  })

  test("loads only Hanken Grotesk and JetBrains Mono from Google Fonts", () => {
    const names = files.flatMap(({ source }) =>
      [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']next\/font\/google["']/g)].flatMap(
        (match) => (match[1] ?? "").split(",").map((name) => name.trim()),
      ),
    )
    expect(new Set(names.filter(Boolean))).toEqual(new Set(["Hanken_Grotesk", "JetBrains_Mono"]))
  })
})
