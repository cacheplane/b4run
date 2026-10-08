import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const CSS = readFileSync(
  fileURLToPath(new URL("../../src/react/styles.css", import.meta.url)),
  "utf8",
)
const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "")

/** Every class the kit emits (spec §5.6 plus the blocks), read from the TSX so the two cannot drift. */
const KIT_SOURCES = [
  "Disclosure.tsx",
  "icons.tsx",
  "StatusText.tsx",
  "SourceChips.tsx",
  "StepDetail.tsx",
  "Step.tsx",
  "PlanStep.tsx",
  "ReasoningStep.tsx",
  "StepGroup.tsx",
  "SubagentStep.tsx",
  "TurnActivity.tsx",
  "ApprovalCard.tsx",
]
  .map((f) =>
    readFileSync(fileURLToPath(new URL(`../../src/react/activity/${f}`, import.meta.url)), "utf8"),
  )
  .join("\n")
const emittedClasses = [
  ...new Set(
    [...KIT_SOURCES.matchAll(/[cC]lassName=\{?["'`]([^"'`$]+)/g)].flatMap((m) =>
      (m[1] ?? "").split(/\s+/),
    ),
  ),
].filter(Boolean)

const TOKENS = [
  "surface",
  "surface-alt",
  "border",
  "text",
  "muted",
  "running",
  "running-bg",
  "complete",
  "failed",
  "failed-bg",
  "primary",
  "on-primary",
  "radius",
  "radius-card",
  "radius-pill",
  "font-mono",
]

describe("styles.css", () => {
  test("every rule lives in @layer b4-activity", () => {
    const beforeLayer = withoutComments.slice(0, withoutComments.indexOf("@layer b4-activity"))
    expect(beforeLayer.trim()).toBe("")
    expect(withoutComments.match(/@layer b4-activity\s*\{/g)?.length).toBe(1)
  })
  test("defines every §5.1 token in light, media-dark and explicit-dark blocks", () => {
    for (const token of TOKENS) {
      const occurrences =
        withoutComments.match(new RegExp(`--b4-activity-${token}:`, "g"))?.length ?? 0
      expect(occurrences, token).toBeGreaterThanOrEqual(
        token === "radius" || token.startsWith("radius-") || token === "font-mono" ? 1 : 3,
      )
    }
    expect(withoutComments).toContain(":where(:root)")
    expect(withoutComments).toContain("@media (prefers-color-scheme: dark)")
    expect(withoutComments).toContain(':where(:root[data-b4-theme="dark"]')
    expect(withoutComments).toContain(".dark")
    expect(withoutComments).toContain('[data-theme="dark"]')
    expect(withoutComments).toContain("--b4-activity-complete: #15803d")
  })
  test("every emitted class has at least one rule, and every selector is prefixed", () => {
    for (const cls of emittedClasses) expect(withoutComments, cls).toContain(`.${cls}`)
    const selectors = [...withoutComments.matchAll(/(^|[}{;])\s*([^{}@]+?)\s*\{/g)]
      .map((m) => (m[2] ?? "").trim())
      .filter(Boolean)
    for (const selector of selectors) {
      for (const part of selector.split(",").map((p) => p.trim())) {
        const unwrapped = /^:where\((.*)\)$/.exec(part)?.[1] ?? part
        const ok =
          /(^|[\s>+~(])\.b4-/.test(unwrapped) ||
          /^:root/.test(unwrapped) ||
          /^\.dark\b|^\[data-theme="dark"\]/.test(unwrapped) ||
          unwrapped === "to"
        expect(ok, selector).toBe(true)
      }
    }
  })
  test("carries no rule or token beyond the kit's (the legacy cards' are gone)", () => {
    const sheetClasses = new Set(
      [...withoutComments.matchAll(/\.(b4-[\w-]+)/g)].map((m) => m[1] ?? ""),
    )
    for (const cls of sheetClasses) expect(emittedClasses, cls).toContain(cls)
    expect(withoutComments).not.toMatch(/\.b4-activity\b/)
    const tokens = new Set(
      [...withoutComments.matchAll(/--b4-activity-([\w-]+):/g)].map((m) => m[1] ?? ""),
    )
    expect([...tokens].sort()).toEqual([...TOKENS].sort())
  })
  test("motion: the shimmer, the 200ms chevron, and a reduced-motion block that turns both off", () => {
    expect(withoutComments).toMatch(
      /\.b4-turn__text\[data-live="true"\][^}]*animation:\s*b4-shimmer 2\.2s linear infinite/,
    )
    expect(withoutComments).toMatch(/\.b4-chevron[^}]*transition:\s*transform 200ms/)
    const start = withoutComments.indexOf("@media (prefers-reduced-motion: reduce)")
    expect(start).toBeGreaterThan(0)
    const reduced = withoutComments.slice(start)
    expect(reduced).toContain("animation: none")
    expect(reduced).toContain("transition: none")
  })
  test("accessibility: visible focus ring, 24px disclosure targets, a visually-hidden utility", () => {
    expect(withoutComments).toMatch(
      /\.b4-turn__summary:focus-visible,\s*\.b4-step__line:focus-visible,\s*\.b4-step__raw:focus-visible,\s*\.b4-approval__button:focus-visible\s*\{[^}]*outline/,
    )
    expect(withoutComments).toMatch(/\.b4-step__line\s*\{[^}]*min-height:\s*26px/)
    expect(withoutComments).toMatch(/\.b4-step__raw\s*\{[^}]*min-height:\s*24px/)
    expect(withoutComments).toMatch(/\.b4-visually-hidden\s*\{[^}]*clip/)
  })
  test("a subagent's description sits on its own muted line beneath the step", () => {
    expect(withoutComments).toMatch(
      /\.b4-step__note\s*\{[^}]*display:\s*block[^}]*color:\s*var\(--b4-activity-muted\)/,
    )
  })
})
