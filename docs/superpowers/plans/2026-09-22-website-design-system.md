# Website Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One token source for b4.run, shared primitives, every surface migrated onto them, the old amber palette and its workarounds deleted, AA contrast everywhere, and a test that fails if any of it comes back.

**Architecture:** `apps/web/app/styles/tokens.css` is the single `@theme` (colour roles, composite text tokens, radius/shadow removed). `base.css`, `prose.css`, `ui.css` hold the global rules that today live inside `[data-docs-brand]`, `.blog` and `.home`. Primitives under `app/components/ui/` carry `data-ui` attributes that the stylesheets target. A vitest file pins values, mirror parity, contrast, and greps the app for forbidden legacy tokens and classes.

**Tech Stack:** Next.js 16 App Router, Tailwind 4 (`@theme`), CSS modules for page layout only, Shiki + rehype-pretty-code, Vitest 4 (node + jsdom), playwright-core + axe-core for the verification pass (not a dependency).

**Spec:** [`docs/superpowers/specs/2026-09-22-website-design-system-design.md`](../specs/2026-09-22-website-design-system-design.md)

---

## Working state

- Worktree `/Users/blove/repos/dawn/.claude/worktrees/zen-curie-dd3701`, branch `blove/website-design-system`, based on `origin/main` 0ed98818. Dependencies are installed.
- `source ~/.nvm/nvm.sh && nvm use 24` before any command.
- Run web gates from `apps/web`: `pnpm exec vitest --run`, `pnpm exec tsc --noEmit`, `pnpm lint`. Root gates: `node scripts/check-docs.mjs`, `pnpm exec biome check --config-path packages/config-biome/biome.json package.json scripts test`.
- Never run `biome check --write` on the whole repo. `pnpm --dir apps/web lint -- --write` is scoped to the web package and is fine.
- `pnpm --dir apps/web seo:lastmod` before the final commit (any `apps/web` edit changes the manifest).
- Scratch dir for screenshots and scripts: `$SCRATCH` = `/private/tmp/claude-501/-Users-blove-repos-dawn--claude-worktrees-zen-curie-dd3701/b5389230-70f4-48ec-815e-352d91c34fc0/scratchpad`.
- Dev server for captures: `pnpm --filter @b4run/web dev --port 3219` from the repo root (background). Stop it before running `next build`.

## File structure

| File | Responsibility |
| --- | --- |
| `apps/web/app/styles/tokens.css` (new) | The `@theme` block and `:root` layout vars. The only place a colour value is written. |
| `apps/web/app/styles/base.css` (new) | `html`/`body`, selection, focus ring, text-wrap, skip link, footer-hide rule, print. |
| `apps/web/app/styles/prose.css` (new) | `.prose-b4` rules: headings, links, inline code, code frames, Shiki lines, tables, callouts, steps, tabs, related cards, pagination, prose width. |
| `apps/web/app/styles/ui.css` (new) | `[data-ui="…"]` primitives: eyebrow, button, copy-command, card, icon, nav-item, chip, search overlay, page-actions menu, external-link arrow. |
| `apps/web/app/styles/design-system.test.ts` (new) | Token values, mirror parity, contrast, forbidden-pattern guard, declared-var contract. |
| `apps/web/lib/design-tokens.ts` (new) | TS mirror of the colour roles for Satori OG images and `viewport.themeColor`. |
| `apps/web/lib/shiki-theme.ts` (new) | The single `paper-relay` Shiki theme. |
| `apps/web/app/components/ui/{Icon,Eyebrow,Button,SiteLink,Card,CopyCommand}.tsx` | Primitives. `CopyCommand` moves here from `app/components/`. |
| `apps/web/app/globals.css` | Layer order + imports only. |
| `apps/web/app/docs/docs-brand.css` | Deleted. |
| `docs/brand/website-design-system.md` (new) | Token reference, primitives, rules, dark-mode path. |

---

### Task 1: Baseline captures (before any code changes)

**Files:**
- Create: `$SCRATCH/visual/shots.mjs`, `$SCRATCH/visual/axe.mjs`, `$SCRATCH/visual/diff.mjs`

- [ ] **Step 1: Write the screenshot script**

```js
// $SCRATCH/visual/shots.mjs — usage: node shots.mjs <outDir> [port]
import { chromium } from "/Users/blove/repos/dawn/.claude/worktrees/zen-curie-dd3701/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs"
import fs from "node:fs"
const out = process.argv[2]
const B = `http://localhost:${process.argv[3] ?? "3219"}`
fs.mkdirSync(out, { recursive: true })
const pages = {
  home: "/",
  blog: "/blog",
  post: "/blog/why-we-built-b4",
  gs: "/docs/getting-started",
  memory: "/docs/memory",
  config: "/docs/configuration",
  nf: "/definitely-missing-xyz",
}
const widths = [390, 768, 1024, 1440]
const browser = await chromium.launch()
for (const w of widths) {
  for (const [k, p] of Object.entries(pages)) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.goto(B + p, { waitUntil: "networkidle" })
    await page.screenshot({ path: `${out}/${k}-${w}.png`, fullPage: true })
    await ctx.close()
  }
}
// Mobile menu open, on the homepage and a docs page.
for (const [k, p] of [["mm-home", "/"], ["mm-docs", "/docs/getting-started"]]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  await page.goto(B + p, { waitUntil: "networkidle" })
  await page.getByRole("button", { name: "Open menu" }).click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${out}/${k}-390.png` })
  await ctx.close()
}
await browser.close()
console.log("wrote", out)
```

- [ ] **Step 2: Write the axe script**

```js
// $SCRATCH/visual/axe.mjs — usage: node axe.mjs [port]  → prints violations per page/width, exits 1 on any
import { chromium } from "/Users/blove/repos/dawn/.claude/worktrees/zen-curie-dd3701/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs"
import fs from "node:fs"
const B = `http://localhost:${process.argv[2] ?? "3219"}`
const axe = fs.readFileSync("/Users/blove/repos/ag-ui/node_modules/.pnpm/axe-core@4.11.0/node_modules/axe-core/axe.min.js", "utf8")
const pages = ["/", "/blog", "/blog/why-we-built-b4", "/docs/getting-started", "/docs/memory", "/docs/configuration", "/definitely-missing-xyz"]
const browser = await chromium.launch()
let failed = 0
for (const w of [390, 1440]) {
  for (const p of pages) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(B + p, { waitUntil: "networkidle" })
    if (w === 390) await page.getByRole("button", { name: "Open menu" }).click().catch(() => {})
    await page.addScriptTag({ content: axe })
    const result = await page.evaluate(() => globalThis.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] }))
    for (const v of result.violations) {
      failed++
      console.log(`${p}@${w} ${v.id} (${v.impact}) x${v.nodes.length}`)
      for (const n of v.nodes.slice(0, 3)) console.log("   ", n.target.join(" "), "—", n.failureSummary?.split("\n")[1])
    }
    await ctx.close()
  }
}
await browser.close()
console.log(failed ? `${failed} violation groups` : "axe: clean")
process.exit(failed ? 1 : 0)
```

- [ ] **Step 3: Write the pixel-diff script** (uses `sharp`, already in the workspace)

```js
// $SCRATCH/visual/diff.mjs — usage: node diff.mjs <beforeDir> <afterDir> <diffDir>
import sharp from "/Users/blove/repos/dawn/.claude/worktrees/zen-curie-dd3701/node_modules/.pnpm/sharp@0.35.4_@types+node@26.1.2/node_modules/sharp/lib/index.js"
import fs from "node:fs"
const [before, after, out] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const rows = []
for (const name of fs.readdirSync(before).filter((f) => f.endsWith(".png")).sort()) {
  if (!fs.existsSync(`${after}/${name}`)) { rows.push(`${name}: missing after`); continue }
  const a = sharp(`${before}/${name}`), b = sharp(`${after}/${name}`)
  const [ma, mb] = await Promise.all([a.metadata(), b.metadata()])
  const w = Math.max(ma.width, mb.width), h = Math.max(ma.height, mb.height)
  const pad = (img) => img.extend({ top: 0, left: 0, bottom: h - (img === a ? ma.height : mb.height), right: w - (img === a ? ma.width : mb.width), background: "#ff00ff" }).raw().toBuffer()
  const [ra, rb] = await Promise.all([pad(a), pad(b)])
  const diff = Buffer.alloc(w * h * 3)
  let changed = 0
  for (let i = 0; i < w * h; i++) {
    const o = i * 3
    const same = Math.abs(ra[o] - rb[o]) + Math.abs(ra[o + 1] - rb[o + 1]) + Math.abs(ra[o + 2] - rb[o + 2]) < 12
    if (!same) changed++
    diff[o] = same ? Math.round(rb[o] * 0.25 + 190) : 220
    diff[o + 1] = same ? Math.round(rb[o + 1] * 0.25 + 190) : 20
    diff[o + 2] = same ? Math.round(rb[o + 2] * 0.25 + 190) : 60
  }
  await sharp(diff, { raw: { width: w, height: h, channels: 3 } }).png().toFile(`${out}/${name}`)
  rows.push(`${name}: ${((changed / (w * h)) * 100).toFixed(2)}% changed, height ${ma.height}→${mb.height}`)
}
fs.writeFileSync(`${out}/summary.txt`, rows.join("\n") + "\n")
console.log(rows.join("\n"))
```

- [ ] **Step 4: Capture the baseline**

Run from the repo root:
```bash
source ~/.nvm/nvm.sh && nvm use 24 && (pnpm --filter @b4run/web dev --port 3219 > $SCRATCH/dev.log 2>&1 &) && sleep 8 && node $SCRATCH/visual/shots.mjs $SCRATCH/visual/before && node $SCRATCH/visual/axe.mjs > $SCRATCH/visual/axe-before.txt; echo "axe exit $?"
```
Expected: 30 PNGs in `$SCRATCH/visual/before`; `axe-before.txt` lists the known `color-contrast` failures (blog inline code, callout tokens). Leave the dev server running; Next HMR picks up CSS edits for later spot checks.

---

### Task 2: Tokens, TS mirror, and the value/contrast tests

**Files:**
- Create: `apps/web/app/styles/tokens.css`
- Create: `apps/web/lib/design-tokens.ts`
- Create: `apps/web/app/styles/design-system.test.ts`

- [ ] **Step 1: Write the failing test** (values, parity, contrast; the guard and contract cases are added in Task 12)

```ts
// apps/web/app/styles/design-system.test.ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { COLOR, SHIKI_FOREGROUNDS } from "../../lib/design-tokens"

const stylesDir = resolve(__dirname)
const tokensCss = readFileSync(resolve(stylesDir, "tokens.css"), "utf8")

/** Every `--name: value;` inside the `@theme { … }` block. */
export function themeTokens(css: string): Record<string, string> {
  const block = /@theme\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? ""
  const out: Record<string, string> = {}
  // `[\w*-]` so the wildcard resets (`--radius-*: initial`) are captured too.
  for (const m of block.matchAll(/^\s*(--[\w*-]+):\s*([^;]+);/gm)) out[m[1] as string] = (m[2] as string).trim()
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
    expect(names.filter((n) => /saas|ink-dim|divider|accent-(blue|green|purple)/.test(n))).toEqual([])
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
    expect(contrast(COLOR[fg as keyof typeof COLOR], COLOR[bg as keyof typeof COLOR])).toBeGreaterThanOrEqual(4.5)
  })
  it.each([
    ["focus", "page"],
    ["rule-strong", "page"],
    ["ink", "page"],
  ] as Array<[string, string]>)("%s on %s ≥ 3:1 (non-text)", (fg, bg) => {
    expect(contrast(COLOR[fg as keyof typeof COLOR], COLOR[bg as keyof typeof COLOR])).toBeGreaterThanOrEqual(3)
  })
  it("relay is a fill, not text: it fails on paper and the token table says so", () => {
    expect(contrast(COLOR.relay, COLOR.page)).toBeLessThan(3)
    expect(tokensCss).toMatch(/--color-relay: #b4ce37;\s*\/\*.*fill/i)
  })
  it.each(SHIKI_FOREGROUNDS)("Shiki foreground %s ≥ 4.5:1 on the panel", (hex) => {
    expect(contrast(hex, COLOR.panel)).toBeGreaterThanOrEqual(4.5)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run from `apps/web`: `pnpm exec vitest --run app/styles/design-system.test.ts`
Expected: FAIL — cannot resolve `../../lib/design-tokens` and `tokens.css`.

- [ ] **Step 3: Write `tokens.css`**

```css
/* apps/web/app/styles/tokens.css
   The one token source for b4.run. Names are roles, not colours; every colour
   records the contrast it was chosen for. Values reach Tailwind through @theme
   (`bg-page`, `text-ink-muted`, `text-eyebrow`, …) and CSS modules through
   `var(--color-*)`. A future dark mode restates every --color-* under
   `[data-theme="dark"]` and aliases nothing (see docs/brand/website-design-system.md). */
@theme {
  /* Surfaces */
  --color-page: #f5f4f0; /* paper */
  --color-surface: #eeeee7; /* cards, strips, table heads on paper */
  --color-surface-sunk: #e8e8df; /* inline code on paper */
  --color-rule: #d6d6cc; /* decorative rules only, never a control boundary */
  --color-rule-strong: #75796a; /* control boundaries: 3.6:1 on page */

  /* Ink */
  --color-ink: #111111; /* 17.2:1 on page */
  --color-ink-muted: #595b53; /* 6.3:1 on page; the only secondary text colour */

  /* Accent */
  --color-relay: #b4ce37; /* fills only: 1.6:1 on page, never text */
  --color-relay-tint: #e7edd1; /* selection, active nav, callout body */
  --color-relay-ink: #424d18; /* text on relay-tint: 7.6:1 */
  --color-olive: #627410; /* accent text and underlines on page: 4.7:1 */
  --color-focus: #667811; /* focus ring on page: 4.5:1 */

  /* Dark code panel */
  --color-panel: #17181b;
  --color-panel-strip: #202226; /* header / footer strip inside a panel */
  --color-panel-ink: #f5f4f0; /* 16.1:1 on panel */
  --color-panel-muted: #c4c8bc; /* 10.5:1 on panel: labels, captions */
  --color-panel-dim: #a3aa99; /* 7.4:1 on panel: line numbers, comments, inactive tabs */
  --color-panel-rule: #4d5148;
  --color-panel-accent: #b4ce37; /* 9.6:1 on panel: markers, highlighted line, copied state */

  /* Status */
  --color-ok: #1f6f3f; /* 5.9:1 on ok-tint */
  --color-ok-tint: #e3efe4;
  --color-warn: #8a5100; /* 6.0:1 on warn-tint */
  --color-warn-tint: #fff1ce;
  --color-danger: #a12f25; /* 6.2:1 on danger-tint */
  --color-danger-tint: #fbe8e5;

  /* Type */
  --font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-jetbrains-mono), ui-monospace, "SFMono-Regular", monospace;

  --text-eyebrow: 12px; /* the one eyebrow: mono, uppercase (see [data-ui="eyebrow"]) */
  --text-eyebrow--line-height: 1.6;
  --text-eyebrow--font-weight: 500;
  --text-eyebrow--letter-spacing: 0.07em;
  --text-body: 16px;
  --text-body--line-height: 1.65;
  --text-body-lg: 19px;
  --text-body-lg--line-height: 1.65;
  --text-code: 13px;
  --text-code--line-height: 1.55;
  --text-h1: clamp(36px, 4.5vw, 44px);
  --text-h1--line-height: 1.1;
  --text-h1--font-weight: 600;
  --text-h1--letter-spacing: -0.03em;
  --text-h2: 28px;
  --text-h2--line-height: 1.2;
  --text-h2--font-weight: 600;
  --text-h2--letter-spacing: -0.03em;
  --text-h3: 20px;
  --text-h3--line-height: 1.3;
  --text-h3--font-weight: 600;
  --text-h3--letter-spacing: -0.02em;
  --text-display: clamp(44px, 6.5vw, 88px);
  --text-display--line-height: 1.03;
  --text-display--font-weight: 600;
  --text-display--letter-spacing: -0.055em;

  /* Shape: square, flat. Removing the defaults makes any stray rounded-* or
     shadow-* utility emit nothing; the design-system test forbids the classes. */
  --radius-*: initial;
  --shadow-*: initial;
  --inset-shadow-*: initial;
  --drop-shadow-*: initial;
}

:root {
  /* Chrome height — the header bar is a fixed 71px row + 1px border at every
     width (header.module.css .bar). Used by ReadingLayout sticky offsets and
     anchor scroll padding. */
  --header-h: 4.5rem;
  --ring-width: 3px;
  --prose-max: 68ch;
  --column-max: 1280px;
}
```

- [ ] **Step 4: Write the TS mirror**

```ts
// apps/web/lib/design-tokens.ts
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
```

- [ ] **Step 5: Run the test**

Run: `pnpm exec vitest --run app/styles/design-system.test.ts`
Expected: PASS (all value, mirror and contrast cases). If a contrast case fails, the value in the table is wrong — fix the value, not the threshold.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/styles/tokens.css apps/web/lib/design-tokens.ts apps/web/app/styles/design-system.test.ts
git commit -m "feat(web): design tokens, TS mirror, and contrast test"
```

---

### Task 3: One Shiki theme

**Files:**
- Create: `apps/web/lib/shiki-theme.ts`
- Modify: `apps/web/lib/mdx-plugins.ts`
- Modify: `apps/web/app/components/homepage/highlight.ts`
- Modify: `apps/web/app/components/docs/docs-syntax-theme.test.ts`

- [ ] **Step 1: Rewrite the syntax test to expect one theme**

```ts
// apps/web/app/components/docs/docs-syntax-theme.test.ts
import { compile } from "@mdx-js/mdx"
import { describe, expect, it } from "vitest"
import { MDX_REHYPE_PLUGINS } from "../../../lib/mdx-plugins"
import { PAPER_RELAY_THEME } from "../../../lib/shiki-theme"
import { SHIKI_FOREGROUNDS } from "../../../lib/design-tokens"

describe("shared syntax output", () => {
  it("emits one dark palette inline and keeps code and heading anchors", async () => {
    const plugins = await Promise.all(
      MDX_REHYPE_PLUGINS.map(async ([name, options]) => [(await import(name)).default, options]),
    )
    const compiled = String(
      await compile(
        '# Example\n\n```ts\n// greeting\nconst message: string = "hello"\nexport function greet() {}\n```',
        { rehypePlugins: plugins as never },
      ),
    )
    expect(compiled).not.toContain("--shiki-light")
    expect(compiled).not.toContain("--shiki-dark")
    expect(compiled).toMatch(/color:#c5d985/i) // keyword
    expect(compiled).toMatch(/color:#e5cb9b/i) // string
    expect(compiled).toMatch(/color:#a3aa99/i) // comment
    expect(compiled).toMatch(/color:#a8d4e0/i) // type
    expect(compiled).toContain('id: "example"')
    expect(compiled).toContain("greeting")
    expect(compiled).toContain("hello")
  })

  it("only uses foregrounds the contrast test covers", () => {
    const used = new Set<string>([PAPER_RELAY_THEME.colors["editor.foreground"]])
    for (const rule of PAPER_RELAY_THEME.settings) used.add(rule.settings.foreground.toLowerCase())
    for (const hex of used) expect(SHIKI_FOREGROUNDS).toContain(hex)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest --run app/components/docs/docs-syntax-theme.test.ts`
Expected: FAIL — `../../../lib/shiki-theme` not found.

- [ ] **Step 3: Write the theme**

```ts
// apps/web/lib/shiki-theme.ts
/**
 * The single Shiki theme for docs, blog, and homepage code. Every foreground is
 * ≥ 4.5:1 on --color-panel (#17181b); lib/design-tokens.ts lists them and
 * app/styles/design-system.test.ts checks the ratios. Add a scope here rather
 * than a second theme when a language renders flat.
 */
import type { ThemeRegistrationRaw } from "shiki"

// `satisfies` keeps the literal types (the test reads settings[].settings.foreground)
// while staying assignable to shiki's mutable-array theme type; `as const` is not.
export const PAPER_RELAY_THEME = {
  name: "paper-relay",
  type: "dark",
  colors: { "editor.background": "#17181b", "editor.foreground": "#f5f4f0" },
  settings: [
    { scope: ["keyword", "storage", "keyword.control", "keyword.operator.new"], settings: { foreground: "#c5d985" } },
    { scope: ["string", "constant.numeric", "constant.language", "constant.character"], settings: { foreground: "#e5cb9b" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#a3aa99" } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class"], settings: { foreground: "#a8d4e0" } },
    { scope: ["entity.name.function", "support.function", "variable", "variable.other", "entity.name.tag", "entity.other.attribute-name"], settings: { foreground: "#f5f4f0" } },
    { scope: ["punctuation", "keyword.operator", "meta.brace"], settings: { foreground: "#c4c8bc" } },
    { scope: ["markup.heading", "markup.inserted"], settings: { foreground: "#c5d985" } },
    { scope: ["markup.bold"], settings: { foreground: "#f5f4f0", fontStyle: "bold" } },
    { scope: ["markup.deleted"], settings: { foreground: "#f0ae95" } },
  ],
} satisfies ThemeRegistrationRaw
```

- [ ] **Step 4: Point rehype-pretty-code and the homepage at it**

In `apps/web/lib/mdx-plugins.ts` add `import { PAPER_RELAY_THEME } from "./shiki-theme"` and replace the rehype-pretty-code entry:

```ts
  [
    "rehype-pretty-code",
    {
      // One theme everywhere: no dual --shiki-light/--shiki-dark spans.
      theme: PAPER_RELAY_THEME,
      keepBackground: false,
      defaultLang: "plaintext",
    },
  ],
```

In `apps/web/app/components/homepage/highlight.ts` replace the inline theme object in `createHighlighter({ … themes: [ { name: "paper-relay", … } ] })` with:

```ts
import { PAPER_RELAY_THEME } from "../../../lib/shiki-theme"
// …
const highlighter = createHighlighter({
  langs: ["typescript", "markdown", "diff", "json"],
  themes: [PAPER_RELAY_THEME],
})
```

- [ ] **Step 5: Run the syntax test and the homepage test**

Run: `pnpm exec vitest --run app/components/docs/docs-syntax-theme.test.ts app/components/homepage/homepage.test.tsx`
Expected: PASS. If `theme` is rejected by rehype-pretty-code's types, cast the option: `theme: PAPER_RELAY_THEME as unknown as Record<string, unknown>` — `MdxPluginSpec` options are `Record<string, unknown>`.

- [ ] **Step 6: Verify Turbopack still serializes the plugin options**

Run from the repo root: `curl -s http://localhost:3219/docs/getting-started | grep -o 'color:#c5d985' | head -1`
Expected: `color:#c5d985` (the dev server compiles MDX through `next.config.ts` with the same list).

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/shiki-theme.ts apps/web/lib/mdx-plugins.ts apps/web/app/components/homepage/highlight.ts apps/web/app/components/docs/docs-syntax-theme.test.ts
git commit -m "feat(web): one paper-relay Shiki theme for docs, blog, and homepage"
```

---

### Task 4: `base.css`, `prose.css`, `ui.css`; `globals.css` becomes imports; delete `docs-brand.css`

**Files:**
- Create: `apps/web/app/styles/base.css`, `apps/web/app/styles/prose.css`, `apps/web/app/styles/ui.css`
- Modify: `apps/web/app/globals.css` (replace whole file)
- Delete: `apps/web/app/docs/docs-brand.css`
- Modify: `apps/web/app/docs/layout.tsx`
- Modify: `apps/web/app/site-chrome.test.tsx`, `apps/web/app/components/docs/inline-code-responsive.test.ts`

- [ ] **Step 1: Update the two tests that read `globals.css`**

In `apps/web/app/site-chrome.test.tsx`, the footer case:
```ts
  it("is hidden by CSS only where the docs layout renders its marker", () => {
    expect(read("docs/layout.tsx")).toMatch(/<div data-docs-layout>/)
    expect(read("styles/base.css")).toMatch(
      /body:has\(\[data-docs-layout\]\) \[data-site-footer\] \{\s*display: none;/,
    )
  })
```
The code-tabs case: replace `expect(read("docs/docs-brand.css")).not.toMatch(/overflow-x: auto/)` with `expect(read("styles/prose.css")).not.toMatch(/\[data-code-header\][^{]*\{[^}]*overflow-x: auto/)`.
Replace the whole `describe("homepage contrast", …)` block with:
```ts
describe("homepage tokens", () => {
  it("uses tokens for every colour, and the AA olive for accent text", () => {
    const css = read("components/homepage/homepage.module.css")
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    // The two olive text uses (.flowNumber and the ::after arrow); the .receipt
    // border also uses olive but is `border-left: … var(--color-olive)`.
    expect(css.match(/(^|\s)color: var\(--color-olive\);/gm)).toHaveLength(2)
  })
})
```
(That case stays red until Task 10; run it then.)

In `apps/web/app/components/docs/inline-code-responsive.test.ts` change the path to `"../../styles/prose.css"` and keep both assertions.

- [ ] **Step 2: Write `base.css`**

```css
/* apps/web/app/styles/base.css — document-level rules on the tokens. */
html {
  color-scheme: light;
  scroll-padding-top: var(--header-h);
}

@layer base {
  body {
    @apply bg-page text-ink font-sans antialiased;
    margin: 0;
    min-height: 100vh;
  }
}

::selection {
  background: var(--color-relay-tint);
  color: var(--color-ink);
}

/* One focus ring for the whole site. Controls on the dark panel restate
   --color-focus (see prose.css [data-code-frame]). */
:focus-visible {
  outline: var(--ring-width) solid var(--color-focus);
  outline-offset: 3px;
}

/* The skip link focuses the main landmark programmatically; it is a target,
   not a control, so it gets no focus ring. */
main#content:focus {
  outline: none;
}

h1,
h2,
h3 {
  text-wrap: balance;
}
p,
li {
  text-wrap: pretty;
}

/* Docs pages have their own sidebar and prev/next links, so they skip the
   site footer. Keyed off an attribute app/docs/layout.tsx renders on the
   server, so the server HTML and the hydrated tree always agree (a
   usePathname() check dropped the footer only on the client and threw a
   hydration error on /docs/* 404s, which render without the docs layout). */
body:has([data-docs-layout]) [data-site-footer] {
  display: none;
}

/* First focusable element on every page (app/layout.tsx). */
.skip-link {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 100;
  padding: 0.625rem 1rem;
  background: var(--color-ink);
  color: var(--color-page);
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: underline;
  text-decoration-color: var(--color-relay);
  text-underline-offset: 4px;
  transform: translateY(calc(-100% - 1rem));
}
.skip-link:focus {
  transform: none;
  outline-color: var(--color-relay);
}

@media print {
  header,
  footer,
  aside,
  [data-page-actions],
  [data-mobile-docs-toc],
  button {
    display: none !important;
  }
  [data-code-frame],
  pre {
    background: transparent !important;
    color: black !important;
    border: 1px solid black;
  }
  a[href^="http"]::after {
    content: " (" attr(href) ")";
    font-size: 0.85em;
  }
}
```

- [ ] **Step 3: Write `prose.css`** — every `[data-docs-brand]` rule, unscoped, plus the Shiki/inline-code/link rules from the old `globals.css`

```css
/* apps/web/app/styles/prose.css — MDX prose for docs and blog, and the shared
   code frame that the homepage CodePanel mirrors. Unlayered on purpose: these
   rules must beat Tailwind utilities on the same elements. */

.prose-b4 :is(h1, h2, h3, h4) {
  font-family: var(--font-sans);
  font-variation-settings: normal;
  font-weight: 600;
  text-wrap: balance;
}
.prose-b4 h1 {
  font-size: var(--text-h1);
  line-height: var(--text-h1--line-height);
  letter-spacing: var(--text-h1--letter-spacing);
}
.prose-b4 h2 {
  position: relative;
  border-top: 1px solid var(--color-rule);
  padding-top: 1.5rem;
}
/* The dot hangs in the left margin so heading text aligns with body text. */
.prose-b4 h2::before {
  content: "";
  position: absolute;
  left: -1.25rem;
  top: calc(1.5rem + 0.5lh - 0.25rem);
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--color-relay);
}
@media (max-width: 47.999rem) {
  .prose-b4 h2::before {
    left: -1rem;
  }
}

/* Reading measure: text blocks stop at --prose-max; code, tables, tabs and
   card grids keep the full column. */
.prose-b4 :where(p, ul, ol, blockquote, h1, h2, h3, h4, [data-callout-type], [data-prose-steps]):not([data-prose-table] *) {
  max-width: var(--prose-max);
}

/* Links: ink text, olive underline, thicker on hover. The ↗ for off-site links
   comes from ui.css, never from markup. */
.prose-b4 a:not([data-ui]) {
  color: var(--color-ink);
  text-decoration: underline;
  text-decoration-color: var(--color-olive);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  transition: text-decoration-thickness 120ms ease;
}
.prose-b4 a:not([data-ui]):hover {
  text-decoration-thickness: 2px;
}

/* Inline code (rendered by InlineCode MDX override) */
.mdx-inline-code {
  background: var(--color-surface-sunk);
  color: var(--color-ink);
  border: 1px solid var(--color-rule);
  padding: 0.0625rem 0.375rem;
  font-size: 0.875em;
  font-family: var(--font-mono);
  /* Long signatures must wrap at every width, or they widen the page. */
  white-space: normal;
  overflow-wrap: break-word;
}
@media (max-width: 47.999rem) {
  .mdx-inline-code {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  pre .mdx-inline-code {
    white-space: inherit;
    overflow-wrap: normal;
  }
}
/* Block code (`<code>` inside `<pre>`) inherits the same MDX `code:` override and
   therefore gets the .mdx-inline-code class. Strip the chip treatment when it's
   nested inside a <pre> so shiki's tokenized output renders as a normal block. */
pre .mdx-inline-code {
  background: transparent;
  color: inherit;
  border: 0;
  padding: 0;
  font-size: inherit;
  font-family: inherit;
  white-space: inherit;
}
/* Inside a table the wrapper scrolls, so a token never breaks mid-word. */
[data-prose-table] .mdx-inline-code {
  white-space: nowrap;
  overflow-wrap: normal;
}

/* Code frame: the dark panel shared by Pre, RehypeFigure, CodeGroup. Ink and
   rule are restated here so children that use the generic roles follow. This
   is the template a future dark theme block would follow. */
[data-code-frame] {
  --color-ink: var(--color-panel-ink);
  --color-ink-muted: var(--color-panel-muted);
  --color-rule: var(--color-panel-rule);
  --color-rule-strong: var(--color-panel-muted);
  --color-focus: var(--color-panel-accent);
  background: var(--color-panel);
  color: var(--color-panel-ink);
  border: 1px solid var(--color-panel-rule);
}
[data-code-header] {
  background: var(--color-panel-strip);
  border-bottom: 1px solid var(--color-panel-rule);
  gap: 0.5rem;
}
/* Tabs wrap instead of scrolling (see CodeHeaderRow). */
[data-code-header] > :first-child {
  min-width: 0;
}
[data-code-header] > :last-child {
  flex-shrink: 0;
}
/* A tab stays on one line until it alone is wider than the strip, then a
   long file name breaks rather than overflowing the frame. */
[data-code-tab] {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--color-panel-dim);
}
[data-code-tab]:is([data-active="true"], [aria-selected="true"]),
[data-code-tab]:hover {
  color: var(--color-panel-ink);
}
[data-code-active-marker] {
  background: var(--color-panel-accent);
}
pre {
  background: var(--color-panel);
  color: var(--color-panel-ink);
  font-family: var(--font-mono);
  font-size: var(--text-code);
  line-height: var(--text-code--line-height);
}
/* Shiki line container — rehype-pretty-code wraps each line in <span data-line>
   and emits a literal "\n" newline between adjacent lines. With <pre>'s default
   white-space: pre, those newlines render as visible empty lines (~doubled
   spacing). Use grid on the inner <code> so its children flow as grid cells —
   grid containers collapse whitespace text nodes between items. */
pre > code {
  display: grid;
}
/* Scope to <pre> only so inline-code <code> chips (which also receive a [data-line]
   wrapper from rehype-pretty-code) don't get block-level line styling. */
pre [data-line] {
  display: block;
  padding: 0 0.75rem;
  border-left: 2px solid transparent;
}
/* Highlighted lines (e.g. ```ts {1,3-5} ```) */
pre [data-highlighted-line] {
  background: color-mix(in srgb, var(--color-panel-accent) 15%, transparent);
  border-left-color: var(--color-panel-accent);
}
/* Diff markers ([!code ++] / [!code --]) */
pre [data-highlighted-line-id="add"],
pre .line.diff.add {
  background: color-mix(in srgb, #c5d985 15%, transparent);
  border-left-color: #c5d985;
}
pre [data-highlighted-line-id="remove"],
pre .line.diff.remove {
  background: color-mix(in srgb, #f0ae95 15%, transparent);
  border-left-color: #f0ae95;
}

/* Callouts */
[data-callout-type] {
  background: var(--color-relay-tint);
  border: 1px solid var(--color-rule-strong);
  border-left: 3px solid var(--color-ink);
  padding: 1.25rem;
}
[data-callout-type] > span {
  color: var(--color-ink);
}
[data-callout-label] {
  color: var(--color-ink);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin: 0 0 0.5rem;
}
[data-callout-type="tip"] > span {
  color: var(--color-ok);
}
[data-callout-type="warn"] {
  background: var(--color-warn-tint);
  border-color: var(--color-warn);
}
[data-callout-type="warn"] > span {
  color: var(--color-warn);
}
[data-callout-type="danger"] {
  background: var(--color-danger-tint);
  border-color: var(--color-danger);
}
[data-callout-type="danger"] > span {
  color: var(--color-danger);
}

/* Tables, tabs, steps */
[data-prose-table] {
  border: 1px solid var(--color-rule);
}
.prose-b4 th,
[data-prose-tabs] > [role="tablist"] {
  background: var(--color-relay-tint);
}
[data-prose-tabs] {
  border: 1px solid var(--color-rule);
}
[data-prose-tabs] [aria-selected="true"] {
  color: var(--color-ink);
  background: var(--color-relay-tint);
  border-bottom-color: var(--color-ink);
}
[data-prose-steps] > li > span {
  background: var(--color-relay-tint);
  color: var(--color-ink);
  border: 1px solid var(--color-rule-strong);
}

/* Related cards and pagination share the card hover. */
[data-related-cards] > a,
nav[aria-label="Pagination"] > a {
  text-decoration: none;
  border: 1px solid var(--color-rule);
}
[data-related-cards] > a:hover,
nav[aria-label="Pagination"] > a:hover {
  background: var(--color-relay-tint);
  border-color: var(--color-rule-strong);
}
```

- [ ] **Step 4: Write `ui.css`**

```css
/* apps/web/app/styles/ui.css — primitives. Components carry data-ui / data-variant
   attributes; presentation lives here on the tokens. Unlayered on purpose. */

/* Off-site links get the arrow from CSS, so an internal link can never carry one.
   Icon-only links opt out with data-no-arrow. */
a[href^="http"]:not([data-no-arrow])::after {
  content: " ↗";
  white-space: nowrap;
}

[data-ui="eyebrow"] {
  font-family: var(--font-mono);
  font-size: var(--text-eyebrow);
  line-height: var(--text-eyebrow--line-height);
  font-weight: var(--text-eyebrow--font-weight);
  letter-spacing: var(--text-eyebrow--letter-spacing);
  text-transform: uppercase;
  color: var(--color-ink-muted);
  margin: 0;
}
[data-ui="eyebrow"][data-tone="olive"] {
  color: var(--color-olive);
}
[data-ui="eyebrow"][data-tone="panel"] {
  color: var(--color-panel-muted);
}

[data-ui="button"] {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  padding: 0 1.25rem;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1;
  text-decoration: none;
  border: 1px solid var(--color-ink);
  background: var(--color-relay);
  color: var(--color-ink);
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
[data-ui="button"]:hover {
  background: var(--color-relay-tint);
}
[data-ui="button"][data-variant="secondary"] {
  background: transparent;
  color: var(--color-ink);
}
[data-ui="button"][data-variant="secondary"]:hover {
  background: var(--color-relay-tint);
}
[data-ui="button"][data-variant="ghost"] {
  background: transparent;
  border-color: var(--color-rule-strong);
  color: var(--color-ink-muted);
  font-weight: 500;
}
[data-ui="button"][data-variant="ghost"]:hover {
  color: var(--color-ink);
  border-color: var(--color-ink);
}
[data-ui="button"][data-size="sm"] {
  min-height: 2rem;
  padding: 0 0.75rem;
  font-size: 0.75rem;
  font-family: var(--font-mono);
  font-weight: 500;
}

/* The `$ command` chip in the header, mobile menu, homepage and blog CTA. */
[data-ui="copy-command"] {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.5rem 0.5rem 1rem;
  font-family: var(--font-mono);
  font-size: var(--text-code);
  line-height: 1.4;
  color: var(--color-ink-muted);
  background: var(--color-surface);
  border: 1px solid var(--color-rule);
}
[data-ui="copy-command"] > span > span {
  color: var(--color-olive);
}
[data-ui="copy-command"] > button {
  display: inline-flex;
  padding: 0.25rem;
  margin-left: 0.25rem;
  color: var(--color-ink-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: color 120ms ease, background-color 120ms ease;
}
[data-ui="copy-command"] > button:hover {
  color: var(--color-ink);
  background: var(--color-relay-tint);
}
[data-ui="copy-command"] > button[data-copied="true"] {
  color: var(--color-olive);
}
[data-ui="copy-command"][data-variant="dark"] {
  color: var(--color-panel-muted);
  background: var(--color-panel-strip);
  border-color: var(--color-panel-rule);
  --color-focus: var(--color-panel-accent);
}
[data-ui="copy-command"][data-variant="dark"] > span > span,
[data-ui="copy-command"][data-variant="dark"] > button[data-copied="true"] {
  color: var(--color-panel-accent);
}
[data-ui="copy-command"][data-variant="dark"] > button {
  color: var(--color-panel-muted);
}
[data-ui="copy-command"][data-variant="dark"] > button:hover {
  color: var(--color-panel-ink);
  background: var(--color-panel-rule);
}

[data-ui="card"] {
  display: block;
  border: 1px solid var(--color-rule);
  background: var(--color-page);
  color: inherit;
  text-decoration: none;
  transition: background-color 120ms ease, border-color 120ms ease;
}
a[data-ui="card"]:hover {
  background: var(--color-relay-tint);
  border-color: var(--color-rule-strong);
}

[data-ui="icon"] {
  display: inline-block;
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: none;
}
[data-ui="icon"][data-size="md"] {
  width: 1.25rem;
  height: 1.25rem;
}

/* Docs sidebar / mobile docs nav / TOC entries. */
[data-ui="nav-item"] {
  display: block;
  border-left: 3px solid transparent;
  color: var(--color-ink-muted);
  transition: color 120ms ease, background-color 120ms ease;
}
[data-ui="nav-item"]:hover {
  color: var(--color-ink);
  background: var(--color-surface);
}
[data-ui="nav-item"]:is([aria-current="page"], [aria-current="location"]) {
  background: var(--color-relay-tint);
  color: var(--color-ink);
  border-left-color: var(--color-ink);
  font-weight: 600;
}

/* Icon buttons in the header and mobile menu (44px targets). */
[data-ui="icon-button"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  color: var(--color-ink-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: color 120ms ease, background-color 120ms ease;
}
[data-ui="icon-button"]:hover {
  color: var(--color-ink);
  background: var(--color-surface);
}

/* Small square keycap / ESC chips. */
[data-ui="kbd"] {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-ink-muted);
  border: 1px solid var(--color-rule-strong);
  padding: 0.125rem 0.375rem;
}

/* Docs search dialog */
[data-docs-search-overlay] {
  background: color-mix(in srgb, var(--color-ink) 40%, transparent);
}
[data-docs-search-overlay] > div {
  background: var(--color-page);
  border: 1px solid var(--color-rule-strong);
}
[data-docs-search-overlay] [data-active="true"] {
  background: var(--color-relay-tint);
}

/* Page-actions menu */
[data-page-actions] [role="menu"] {
  background: var(--color-page);
  border: 1px solid var(--color-rule-strong);
  max-width: calc(100vw - 3rem);
}

[data-docs-sidebar] > p > span {
  background: var(--color-relay);
}
```

- [ ] **Step 5: Replace `globals.css`**

```css
/* apps/web/app/globals.css — layer order and imports only. Tokens live in
   styles/tokens.css; everything else is a rule file on those tokens. */
@layer theme, base, components, utilities;
@import "tailwindcss";
@import "./styles/tokens.css";
@import "./styles/base.css";
@import "./styles/prose.css";
@import "./styles/ui.css";
```

- [ ] **Step 6: Delete `docs-brand.css` and its import; drop the attribute**

```bash
git rm apps/web/app/docs/docs-brand.css
```
In `apps/web/app/docs/layout.tsx` remove `import "./docs-brand.css"` and change `<div data-docs-brand data-docs-layout>` to `<div data-docs-layout>`.

- [ ] **Step 7: Run the affected tests and the dev server**

Run: `pnpm exec vitest --run app/site-chrome.test.tsx app/components/docs/inline-code-responsive.test.ts`
Expected: PASS except `homepage tokens` (red until Task 10 — note it, do not skip it).
Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3219/docs/getting-started` → `200`; check `$SCRATCH/dev.log` for CSS errors (Tailwind rejects unknown `@theme` syntax loudly). Then `pnpm lint`. Biome parses `tokens.css` with `--css-parse-tailwind-directives=true`; if it rejects the wildcard declarations (`--radius-*: initial`), replace the four wildcard lines with Tailwind 4.3's named defaults, which reset the same utilities:
```css
  --radius-xs: initial; --radius-sm: initial; --radius-md: initial; --radius-lg: initial;
  --radius-xl: initial; --radius-2xl: initial; --radius-3xl: initial; --radius-4xl: initial;
  --shadow-2xs: initial; --shadow-xs: initial; --shadow-sm: initial; --shadow-md: initial;
  --shadow-lg: initial; --shadow-xl: initial; --shadow-2xl: initial;
  --inset-shadow-2xs: initial; --inset-shadow-xs: initial; --inset-shadow-sm: initial;
  --drop-shadow-xs: initial; --drop-shadow-sm: initial; --drop-shadow-md: initial;
  --drop-shadow-lg: initial; --drop-shadow-xl: initial; --drop-shadow-2xl: initial;
```
and change the two wildcard rows in the design-system test's value table to `["--radius-md", "initial"]` and `["--shadow-md", "initial"]`. Say which form landed in the commit message.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/globals.css apps/web/app/styles apps/web/app/docs/layout.tsx apps/web/app/site-chrome.test.tsx apps/web/app/components/docs/inline-code-responsive.test.ts
git commit -m "feat(web): global base/prose/ui stylesheets replace the docs-brand scope"
```

---

### Task 5: Primitives — Icon, Eyebrow, Button, SiteLink, Card, CopyCommand

**Files:**
- Create: `apps/web/app/components/ui/Icon.tsx`, `Button.tsx`, `SiteLink.tsx`, `Card.tsx`
- Modify: `apps/web/app/components/ui/Eyebrow.tsx`
- Move: `apps/web/app/components/CopyCommand.tsx` → `apps/web/app/components/ui/CopyCommand.tsx`
- Create: `apps/web/app/components/ui/primitives.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/app/components/ui/primitives.test.tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Button } from "./Button"
import { Card } from "./Card"
import { CopyCommand } from "./CopyCommand"
import { Eyebrow } from "./Eyebrow"
import { Icon } from "./Icon"
import { SiteLink } from "./SiteLink"

describe("primitives", () => {
  it("Eyebrow renders a data-ui paragraph with a tone", () => {
    expect(renderToStaticMarkup(<Eyebrow>Docs</Eyebrow>)).toBe('<p data-ui="eyebrow" data-tone="muted">Docs</p>')
    expect(renderToStaticMarkup(<Eyebrow tone="olive">Blog</Eyebrow>)).toContain('data-tone="olive"')
  })

  it("Button is a <button> without href and an <a> with one", () => {
    const button = renderToStaticMarkup(<Button>Go</Button>)
    expect(button).toMatch(/^<button [^>]*type="button"/)
    expect(button).toContain('data-ui="button" data-variant="primary"')
    const link = renderToStaticMarkup(<Button href="/docs" variant="secondary" size="sm">Go</Button>)
    expect(link).toMatch(/^<a /)
    expect(link).toContain('data-ui="button" data-variant="secondary" data-size="sm"')
    expect(link).toContain('href="/docs"')
  })

  it("SiteLink opens off-site hrefs in a new tab and never writes the arrow itself", () => {
    const external = renderToStaticMarkup(<SiteLink href="https://github.com/cacheplane/b4run">GitHub</SiteLink>)
    expect(external).toBe('<a href="https://github.com/cacheplane/b4run" target="_blank" rel="noopener noreferrer">GitHub</a>')
    const internal = renderToStaticMarkup(<SiteLink href="/docs/agents">Agents</SiteLink>)
    expect(internal).toBe('<a href="/docs/agents">Agents</a>')
    expect(external + internal).not.toContain("↗")
  })

  it("Card is a link when given an href", () => {
    const link = renderToStaticMarkup(<Card href="/x">x</Card>)
    expect(link).toMatch(/^<a /)
    expect(link).toContain('data-ui="card"')
    expect(link).toContain('href="/x"')
    expect(renderToStaticMarkup(<Card>x</Card>)).toBe('<div data-ui="card">x</div>')
  })

  it("Icon renders a 24-grid svg with a size", () => {
    const html = renderToStaticMarkup(<Icon name="copy" />)
    expect(html).toMatch(/^<svg data-ui="icon" data-size="sm" viewBox="0 0 24 24" aria-hidden="true"/)
    expect(renderToStaticMarkup(<Icon name="close" size="md" />)).toContain('data-size="md"')
  })

  it("CopyCommand renders the light variant by default and the dark one on request", () => {
    const light = renderToStaticMarkup(<CopyCommand command="npm create b4-app@latest" />)
    expect(light).toMatch(/^<div data-ui="copy-command" data-variant="light"/)
    expect(light).toContain("<span>$</span> npm create b4-app@latest")
    expect(light).toContain('aria-label="Copy command: npm create b4-app@latest"')
    expect(renderToStaticMarkup(<CopyCommand command="x" variant="dark" />)).toContain('data-variant="dark"')
    expect(light).not.toMatch(/rounded|accent-saas/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest --run app/components/ui/primitives.test.tsx`
Expected: FAIL — `./Button` etc. not found.

- [ ] **Step 3: Write `Icon.tsx`**

```tsx
// apps/web/app/components/ui/Icon.tsx
import type { SVGProps } from "react"

const PATHS = {
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M6 18L18 6" />,
  arrowUpRight: (
    <>
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
} as const

export type IconName = keyof typeof PATHS

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  readonly name: IconName
  /** sm = 16px, md = 20px. Stroke is 1.5 at both sizes. */
  readonly size?: "sm" | "md"
}

/** Decorative by default; give the parent control its accessible name. */
export function Icon({ name, size = "sm", ...rest }: IconProps) {
  return (
    <svg data-ui="icon" data-size={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...rest}>
      {PATHS[name]}
    </svg>
  )
}
```

- [ ] **Step 4: Rewrite `Eyebrow.tsx`**

```tsx
// apps/web/app/components/ui/Eyebrow.tsx
import type { ReactNode } from "react"

interface EyebrowProps {
  readonly children: ReactNode
  /** muted on paper (default), olive for an accent label, panel on the dark panel. */
  readonly tone?: "muted" | "olive" | "panel"
  readonly className?: string
}

/** The one eyebrow: JetBrains Mono 12px, uppercase, 0.07em (ui.css). */
export function Eyebrow({ children, tone = "muted", className }: EyebrowProps) {
  return (
    <p data-ui="eyebrow" data-tone={tone} {...(className ? { className } : {})}>
      {children}
    </p>
  )
}
```

- [ ] **Step 5: Write `Button.tsx`**

```tsx
// apps/web/app/components/ui/Button.tsx
import type { ButtonHTMLAttributes, ReactNode } from "react"

type Variant = "primary" | "secondary" | "ghost"

interface Common {
  readonly children: ReactNode
  readonly variant?: Variant
  readonly size?: "sm"
  readonly className?: string
}
interface LinkButton extends Common {
  readonly href: string
  readonly download?: boolean
}
interface RealButton extends Common, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  readonly href?: undefined
}

/** Square, ink-bordered. Renders <a> when given an href (plain anchor: the
    homepage and 404 link to files and anchors next/link does not handle). */
export function Button(props: LinkButton | RealButton) {
  const { children, variant = "primary", size, className } = props
  const shared = {
    "data-ui": "button",
    "data-variant": variant,
    ...(size ? { "data-size": size } : {}),
    ...(className ? { className } : {}),
  }
  if (props.href !== undefined) {
    return (
      <a {...shared} href={props.href} {...(props.download ? { download: true } : {})}>
        {children}
      </a>
    )
  }
  const { href: _href, variant: _v, size: _s, className: _c, children: _ch, ...rest } = props
  return (
    <button type="button" {...shared} {...rest}>
      {children}
    </button>
  )
}
```

- [ ] **Step 6: Write `SiteLink.tsx`**

```tsx
// apps/web/app/components/ui/SiteLink.tsx
import Link from "next/link"
import type { AnchorHTMLAttributes, ReactNode } from "react"

interface SiteLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  readonly href: string
  readonly children: ReactNode
}

export function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//.test(href) || href.startsWith("mailto:")
}

/** Internal hrefs get next/link; off-site hrefs open in a new tab. The ↗ is
    drawn by ui.css from the href, so this component never writes it. */
export function SiteLink({ href, children, ...rest }: SiteLinkProps) {
  if (isExternalHref(href) || rest.download !== undefined) {
    return (
      <a href={href} {...(isExternalHref(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})} {...rest}>
        {children}
      </a>
    )
  }
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  )
}
```

- [ ] **Step 7: Write `Card.tsx`**

```tsx
// apps/web/app/components/ui/Card.tsx
import Link from "next/link"
import type { ReactNode } from "react"

interface CardProps {
  readonly children: ReactNode
  readonly href?: string
  readonly className?: string
}

/** A bordered paper block; a link card when given an href (hover = relay tint). */
export function Card({ children, href, className }: CardProps) {
  const attrs = { "data-ui": "card", ...(className ? { className } : {}) }
  if (href !== undefined) {
    return (
      <Link {...attrs} href={href}>
        {children}
      </Link>
    )
  }
  return <div {...attrs}>{children}</div>
}
```

- [ ] **Step 8: Move and rewrite `CopyCommand.tsx`**

```bash
git mv apps/web/app/components/CopyCommand.tsx apps/web/app/components/ui/CopyCommand.tsx
```

```tsx
// apps/web/app/components/ui/CopyCommand.tsx
"use client"

import { useState } from "react"
import { Icon } from "./Icon"

interface Props {
  readonly command: string
  /** light on paper (default); dark on the code panel (blog CTA, homepage takeaway). */
  readonly variant?: "light" | "dark"
  readonly className?: string
}

export function CopyCommand({ command, variant = "light", className }: Props) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // clipboard unavailable — silent no-op
    }
  }

  return (
    <div data-ui="copy-command" data-variant={variant} {...(className ? { className } : {})}>
      <span>
        <span>$</span> {command}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        data-copied={copied}
        aria-label={copied ? "Copied" : `Copy command: ${command}`}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  )
}
```

- [ ] **Step 9: Fix the imports that pointed at the old path**

`grep -rn 'from "\(\.\./\)*CopyCommand"\|/CopyCommand"' apps/web/app` — `HeaderInner.tsx`, `MobileMenu.tsx`, `homepage/DeveloperHome.tsx`, `blog/BlogCta.tsx`. Change each to the `ui/CopyCommand` path (`./ui/CopyCommand`, `../ui/CopyCommand`).

- [ ] **Step 10: Run the tests and typecheck**

Run: `pnpm exec vitest --run app/components/ui/primitives.test.tsx app/components/homepage app/components/homepage/header.test.tsx && pnpm exec tsc --noEmit`
Expected: PASS, no type errors. (`header.test.tsx` compares the bar markup across pages; CopyCommand's markup is identical everywhere so it still matches.)

- [ ] **Step 11: Commit**

```bash
git add apps/web/app/components/ui apps/web/app/components/HeaderInner.tsx apps/web/app/components/MobileMenu.tsx apps/web/app/components/homepage/DeveloperHome.tsx apps/web/app/components/blog/BlogCta.tsx
git commit -m "feat(web): Icon, Eyebrow, Button, SiteLink, Card and CopyCommand primitives"
```

---

### Task 6: Header, footer, mobile menu, 404, layout, manifest

**Files:**
- Modify: `apps/web/app/components/HeaderInner.tsx`, `Footer.tsx`, `MobileMenu.tsx`, `homepage/header.module.css`, `app/not-found.tsx`, `app/layout.tsx`, `public/site.webmanifest`
- Modify: `apps/web/app/components/homepage/header.test.tsx`

- [ ] **Step 1: `header.module.css` on tokens**

Replace the first rule:
```css
.header {
  background: var(--color-page);
  border-bottom-color: var(--color-rule);
}
```
and change `max-width: 1280px;` to `max-width: var(--column-max);`. Nothing else changes.

- [ ] **Step 2: `HeaderInner.tsx`**

- Import `Icon` from `./ui/Icon` and `SiteLink` from `./ui/SiteLink`; the `CopyCommand` import is already `./ui/CopyCommand`.
- `MobileDocsSearchButton`: className becomes `"md:hidden"` and the button gets `data-ui="icon-button"`; replace its inline `<svg …>` with `<Icon name="search" size="md" />`.
- The GitHub link: replace the `<a href={repoUrl} target="_blank" rel="noopener noreferrer" …>` with
  ```tsx
  <SiteLink
    href={repoUrl}
    aria-label="GitHub"
    data-no-arrow
    className="inline-flex items-center gap-1.5 text-ink-muted hover:text-ink transition-colors"
  >
    <GitHubIcon />
  </SiteLink>
  ```
  (`data-no-arrow` because the link is icon-only; the arrow would float beside the logo.)
- Keep `linkClass` and the `Docs`/`Blog` `next/link`s exactly as they are — `header.test.tsx` strips those classes when comparing pages.
- Update `header.test.tsx`'s search-button regex: `w-11 h-11` no longer appears; change `(?=[^>]*w-11 h-11)` to `(?=[^>]*data-ui="icon-button")`.

- [ ] **Step 3: `Footer.tsx`**

- Import `Eyebrow` from `./ui/Eyebrow` and `SiteLink` from `./ui/SiteLink`.
- Replace `FooterLink` with:
  ```tsx
  function FooterLink({ label, href }: LinkItem) {
    return (
      <SiteLink href={href} className="text-sm text-ink-muted hover:text-ink transition-colors block py-0.5">
        {label}
      </SiteLink>
    )
  }
  ```
  and drop `external` from `LinkItem` and from the `COLUMNS` entries (SiteLink infers it from the href).
- `<footer data-site-footer className="bg-page border-t border-rule">` with **no** `style` prop.
- Column headings: `<Eyebrow className="mb-3">{col.heading}</Eyebrow>`.
- Bottom row: `text-xs text-ink-dim` → `text-xs text-ink-muted`; `border-divider` → `border-rule`.

- [ ] **Step 4: `MobileMenu.tsx`**

- Imports: `Icon` from `./ui/Icon`, `Eyebrow` from `./ui/Eyebrow`, `SiteLink` from `./ui/SiteLink`; drop `Link` from next/link.
- Drop `external` from `SITE_LINKS` entries and the `SiteLink` interface (keep `download`).
- Trigger button: `className="md:hidden"` + `data-ui="icon-button"`; body `<Icon name="menu" size="md" />`.
- Dialog: `border-0 bg-page p-0` stays; `border-divider` → `border-rule` (two places).
- Header strip label: `<Eyebrow>Menu</Eyebrow>`; close button `data-ui="icon-button"` with `<Icon name="close" size="md" />`.
- Section labels: `<Eyebrow className="mb-3">Site</Eyebrow>` and `<Eyebrow className="mb-3">Documentation</Eyebrow>`.
- The link list item becomes one branch:
  ```tsx
  <SiteLink
    href={link.href}
    {...(link.download ? { download: true } : {})}
    onClick={() => setIsOpen(false)}
    className="block text-base px-3 py-2.5 text-ink-muted hover:text-ink hover:bg-surface transition-colors"
  >
    {link.label}
  </SiteLink>
  ```
  (no literal `↗`; ui.css draws it for the GitHub href.)
- `mobile-menu.test.ts` reads the source for `<dialog`, `.showModal()`, `onCancel=`, etc. — all kept.

- [ ] **Step 5: `not-found.tsx`**

```tsx
import type { Metadata } from "next"
import headerStyles from "./components/homepage/header.module.css"
import { Eyebrow } from "./components/ui/Eyebrow"
import { SiteLink } from "./components/ui/SiteLink"

export const metadata: Metadata = {
  title: "Page not found",
  description: "We couldn't find that page. Try the docs, blog, or the homepage.",
}

interface DestinationProps {
  readonly href: string
  readonly label: string
  readonly download?: boolean
}

const linkClass =
  "inline-flex items-center gap-1.5 min-h-11 text-sm font-medium underline underline-offset-[5px] decoration-olive hover:decoration-2"

function Destination({ href, label, download }: DestinationProps) {
  return (
    <SiteLink href={href} className={linkClass} {...(download ? { download: true } : {})}>
      {label} <span aria-hidden="true">→</span>
    </SiteLink>
  )
}

// Homepage column (header.module.css), so the page lines up with the header
// logo and footer at every width.
export default function NotFound() {
  return (
    <main id="content" tabIndex={-1} data-not-found className="flex-1 bg-page text-ink">
      <div className={`${headerStyles.column} py-24 md:py-32`}>
        <Eyebrow>404</Eyebrow>
        <h1 className="mt-5 text-display text-balance">We couldn't find that page.</h1>
        <p className="mt-6 text-body-lg text-ink-muted max-w-[52ch]">
          The page may have moved, or the link you followed is out of date. Try one of these
          instead:
        </p>
        <ul className="mt-6 flex flex-wrap gap-x-8">
          <li>
            <Destination href="/" label="Home" />
          </li>
          <li>
            <Destination href="/docs/getting-started" label="Read the docs" />
          </li>
          <li>
            <Destination href="/blog" label="Latest from the blog" />
          </li>
          <li>
            <Destination href="/brand/b4-run-brand-assets.zip" label="Download brand kit" download />
          </li>
        </ul>
      </div>
    </main>
  )
}
```
(`text-display` is the composite token: 44–88px, 1.03, 600, −0.055em — the 404 title matches the homepage hero instead of its own 40/64px pair.)

- [ ] **Step 6: `layout.tsx` viewport + manifest**

In `app/layout.tsx` add `import type { Metadata, Viewport } from "next"`, `import { COLOR } from "../lib/design-tokens"` and
```ts
export const viewport: Viewport = {
  themeColor: COLOR.page,
  colorScheme: "light",
}
```
In `public/site.webmanifest` set `"theme_color": "#f5f4f0"` and `"background_color": "#f5f4f0"`.

- [ ] **Step 7: Run tests, typecheck, and eyeball**

Run: `pnpm exec vitest --run app/site-chrome.test.tsx app/components/homepage/header.test.tsx app/components/mobile-menu.test.ts && pnpm exec tsc --noEmit`
Expected: PASS (except the `homepage tokens` case, still pending Task 10).
Open `http://localhost:3219/nope` and the mobile menu at 390px in the built-in browser: paper background, square `$` chip with an olive dollar, olive underlines, ↗ only after "GitHub".

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/components/HeaderInner.tsx apps/web/app/components/Footer.tsx apps/web/app/components/MobileMenu.tsx apps/web/app/components/homepage/header.module.css apps/web/app/components/homepage/header.test.tsx apps/web/app/not-found.tsx apps/web/app/layout.tsx apps/web/public/site.webmanifest
git commit -m "feat(web): header, footer, mobile menu, 404 and manifest on the design tokens"
```

---

### Task 7: Docs chrome

**Files:**
- Modify: `apps/web/app/components/docs/{DocsSidebar,DocsTOC,MobileDocsNav,MobileDocsTOC,DocsSearch,PageActions,RelatedCards,DocsPrevNext,DocsBreadcrumb}.tsx`, `apps/web/app/docs/not-found.tsx`
- Modify tests: `mobile-docs-nav.test.ts`, `docs-brand.test.tsx`

- [ ] **Step 1: Update the two tests first**

`mobile-docs-nav.test.ts`: replace the `focus-visible:ring-2` loop with
```ts
    for (const summary of markup.matchAll(/<summary class="([^"]+)"/g)) {
      // The global :focus-visible ring must not be suppressed.
      expect(summary[1]).not.toContain("focus-visible:outline-none")
      expect(summary[1]).not.toMatch(/rounded/)
    }
```
`docs-brand.test.tsx`: the last assertion becomes `expect(dialog?.hasAttribute("data-docs-search-overlay")).toBe(true)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest --run app/components/docs/mobile-docs-nav.test.ts app/components/docs/docs-brand.test.tsx`
Expected: FAIL on the `rounded` and overlay assertions.

- [ ] **Step 3: `DocsSidebar.tsx`**

- Import `Eyebrow` from `../ui/Eyebrow`.
- Title: `<Eyebrow className="mb-4 flex items-center gap-2"><span className="inline-block w-1 h-1 bg-relay" aria-hidden />Documentation</Eyebrow>` (the `[data-docs-sidebar] > p > span` rule in ui.css colours the dot; drop `rounded-full` — the dot is a 4px square, matching square corners everywhere).
- Section labels: `<Eyebrow className="mb-1.5 px-3">{section.label}</Eyebrow>`.
- Nav item:
  ```tsx
  <Link
    href={item.href}
    data-docs-nav-item
    data-ui="nav-item"
    aria-current={active ? "page" : undefined}
    className="text-sm pl-[9px] pr-3 py-1.5"
  >
  ```

- [ ] **Step 4: `DocsTOC.tsx`**

- `<Eyebrow className="mb-3">On this page</Eyebrow>`.
- `<ul className="space-y-2 border-l border-rule">`.
- Anchor: `className="block py-0.5 transition-colors -ml-px border-l [overflow-wrap:anywhere] ${activeId === h.id ? "text-ink border-ink font-semibold" : "text-ink-muted border-transparent hover:text-ink"}"`.

- [ ] **Step 5: `MobileDocsNav.tsx`**

- Summary becomes (a `<p>` is not allowed inside `<summary>`, so the eyebrow is a span carrying the same attributes the `Eyebrow` component would):
  ```tsx
  <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-ink-muted hover:bg-surface hover:text-ink">
    <span data-ui="eyebrow" data-tone="muted">{section.label}</span>
    <span aria-hidden className="text-xs transition-transform group-open:rotate-90">›</span>
  </summary>
  ```
- Link: `data-ui="nav-item"`, `className="text-sm px-3 py-2"`, keep the `aria-current` spread.

- [ ] **Step 6: `MobileDocsTOC.tsx`**

- `<details … className="group lg:hidden mb-6 border border-rule text-sm">`.
- summary: drop `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-divider-strong`; the label `<span className="text-xs uppercase tracking-widest">` → `<span data-ui="eyebrow" data-tone="muted">On this page</span>` (a span, not `Eyebrow`: `<p>` is invalid inside `<summary>`).
- `border-divider` → `border-rule`; link `className="flex min-h-11 items-center pr-3 text-ink-muted hover:bg-surface hover:text-ink [overflow-wrap:anywhere]"`.

- [ ] **Step 7: `DocsSearch.tsx`**

- Import `Icon` from `../ui/Icon`.
- Trigger: `className="w-full flex items-center justify-between gap-3 px-3 py-2 border border-rule-strong bg-page text-sm text-ink-muted hover:border-ink hover:text-ink transition-colors mb-6"`; icon `<Icon name="search" />`; the kbd `<kbd data-ui="kbd">⌘K</kbd>` with no className.
- Portal root: remove `data-docs-brand`; keep `data-docs-search-overlay`; `className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] backdrop-blur-sm"`.
- Panel: `className="w-full max-w-xl mx-4 overflow-hidden"` (ui.css supplies background and border).
- Input row: `border-divider` → `border-rule`; the svg → `<Icon name="search" className="text-ink-muted" />`; input `className="flex-1 bg-transparent text-ink placeholder:text-ink-muted text-sm"` (remove `focus:outline-none`: the input is the only control focused on open and needs the ring); ESC button `<button type="button" onClick={close} aria-label="Close search" data-ui="kbd" className="hover:text-ink">ESC</button>`.
- Result rows: `bg-accent-saas/10` → `""` (ui.css `[data-active="true"]` handles it); `text-accent-saas` (both) → `text-ink`; `text-ink-dim` → `text-ink-muted` (three places).

- [ ] **Step 8: `PageActions.tsx`** (only the classNames on lines 256–310)

- line 256: `hover:bg-surface focus:bg-surface focus:outline-none` → `hover:bg-relay-tint focus:bg-relay-tint focus:outline-none` (menu items are a roving-focus list inside a `[role=menu]`; the highlighted background is the indicator, as before).
- lines 258, 263: `text-ink-dim` → `text-ink-muted`.
- line 275: `className="hidden md:inline-flex"` and add `data-ui="button" data-variant="secondary" data-size="sm"` to that button.
- line 299: `className="inline-flex items-center justify-center h-7 w-7 border border-rule-strong text-ink-muted hover:text-ink hover:border-ink transition-colors"`.
- line 308: `className="absolute right-0 top-full mt-2 w-72 z-30 py-1 focus:outline-none"`.

- [ ] **Step 9: `RelatedCards.tsx`, `DocsPrevNext.tsx`, `DocsBreadcrumb.tsx`, `docs/not-found.tsx`**

`RelatedCards`: import `Card` from `../ui/Card` and `Icon` from `../ui/Icon`; delete `ArrowIcon`; each item:
```tsx
<Card key={item.href} href={item.href} className="group relative px-4 py-3">
  <span className="absolute top-[17px] right-3 text-ink-muted group-hover:text-ink transition-colors">
    <Icon name="arrowUpRight" className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
  </span>
  <div className="pr-6">
    <div className="text-base font-semibold text-ink">{item.title}</div>
    {item.subtitle && <div className="mt-1 text-sm text-ink-muted leading-snug">{item.subtitle}</div>}
  </div>
</Card>
```
`DocsPrevNext`: `border-divider` → `border-rule`; each link becomes `<Card href={prev.href} className="group p-4">` (add `text-right` for next); inner spans `text-ink-dim` → `text-ink-muted`, drop `group-hover:text-accent-saas transition-colors`.
`DocsBreadcrumb`: `text-ink-dim` → `text-ink-muted`.
`app/components/ReadingLayout.tsx`: both `border-divider` → `border-rule`.
`app/components/docs/DocsBrandProvider.tsx`: `grep -n className` it; replace any `text-ink-dim`/`accent-saas` the same way (the label element is styled by `[data-callout-label]` in prose.css, so it needs no colour class).
`docs/not-found.tsx`: `<Eyebrow className="mb-4">404</Eyebrow>` (import from `../components/ui/Eyebrow`); the link `className="text-ink underline underline-offset-4 decoration-olive"`.

- [ ] **Step 10: Run tests + typecheck + grep**

Run: `pnpm exec vitest --run app/components/docs && pnpm exec tsc --noEmit && grep -rn "accent-saas\|ink-dim\|divider\|rounded" app/components/docs app/docs; echo "grep exit $?"`
Expected: tests PASS, no type errors, `grep exit 1` (no matches).

- [ ] **Step 11: Commit**

```bash
git add apps/web/app/components/docs apps/web/app/docs/not-found.tsx
git commit -m "feat(web): docs chrome on the design system primitives"
```

---

### Task 8: MDX components

**Files:**
- Modify: `apps/web/mdx-components.tsx`, `apps/web/app/components/mdx/{Callout,CodeBlock,CodeGroup,Steps,Tabs}.tsx`, `apps/web/app/components/CopyPromptButton.tsx`

- [ ] **Step 1: `mdx-components.tsx`**

Replace the element overrides (keep the component map and the `id` comment):
```tsx
    h1: ({ children, id }) => (
      <h1 id={id} className="text-h1 text-ink mb-6">{children}</h1>
    ),
    h2: ({ children, id }) => (
      <h2 id={id} className="text-h2 text-ink mt-10 mb-4">{children}</h2>
    ),
    h3: ({ children, id }) => (
      <h3 id={id} className="text-h3 text-ink mt-8 mb-3">{children}</h3>
    ),
    h4: ({ children, id }) => (
      <h4 id={id} className="text-base font-semibold text-ink mt-6 mb-2">{children}</h4>
    ),
    p: ({ children }) => <p className="text-ink-muted leading-7 mb-4">{children}</p>,
    code: InlineCode,
    pre: Pre,
    figure: RehypeFigure,
    ul: ({ children }) => (
      <ul className="list-disc list-inside text-ink-muted leading-7 mb-4 space-y-1">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal list-inside text-ink-muted leading-7 mb-4 space-y-1">{children}</ol>
    ),
    li: ({ children }) => <li className="text-ink-muted">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-4 border-relay bg-surface px-5 py-3 my-6 text-ink-muted italic">
        {children}
      </blockquote>
    ),
    strong: ({ children }) => <strong className="text-ink font-semibold">{children}</strong>,
    table: ({ children }) => (
      // A named, focusable region so keyboard users can scroll a wide table
      // (axe scrollable-region-focusable).
      <section
        data-prose-table
        aria-label="Table"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus to scroll by keyboard
        tabIndex={0}
        className="my-6 overflow-x-auto"
      >
        <table className="w-full text-sm">{children}</table>
      </section>
    ),
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody className="[&>tr]:border-t [&>tr]:border-rule">{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => (
      <th className="text-left px-4 py-2 text-xs font-semibold text-ink uppercase tracking-wide border-b border-rule">
        {children}
      </th>
    ),
    td: ({ children }) => <td className="px-4 py-2 text-ink-muted align-top">{children}</td>,
    a: ({ children, href }) => <a href={href}>{children}</a>,
```
(`prose.css` styles the links; a bare `<a>` keeps MDX links and `SiteLink`-free — MDX links to other sites get `target` from nothing, which is the existing behaviour, and the ↗ from CSS.)

- [ ] **Step 2: `Callout.tsx`**

```tsx
import type { ReactNode } from "react"
import { DocsCalloutLabel } from "../docs/DocsBrandProvider"

type CalloutType = "info" | "tip" | "warn" | "danger"

interface Props {
  readonly type?: CalloutType
  readonly title?: string
  readonly children: ReactNode
}

const GLYPH: Record<CalloutType, string> = {
  info: "ⓘ", // ⓘ
  tip: "✨", // ✨
  warn: "⚠", // ⚠
  danger: "✖", // ✖
}

/** Colours and borders come from prose.css [data-callout-type]. */
export function Callout({ type = "info", title, children }: Props) {
  return (
    <aside data-callout-type={type} className="my-6 flex gap-3 items-start" role="note">
      <span className="text-base mt-0.5 shrink-0" aria-hidden>
        {GLYPH[type]}
      </span>
      <div className="flex-1 min-w-0">
        <DocsCalloutLabel type={type} />
        {title && <p className="font-semibold text-ink mb-1 text-sm">{title}</p>}
        <div className="text-sm text-ink-muted leading-relaxed [&>p]:m-0 [&>p+p]:mt-2">{children}</div>
      </div>
    </aside>
  )
}
```

- [ ] **Step 3: `CodeBlock.tsx`**

- Delete the local `CopyIcon`/`CheckIcon`; `import { Icon } from "../ui/Icon"`.
- Both `<pre …>` classNames: `overflow-x-auto pl-3 pr-4 py-3 ${className ?? ""}` (font/size come from `prose.css pre`).
- Frame wrappers (`Pre` non-headless branch and `RehypeFigure`): `className="relative my-6 overflow-hidden"`.
- `CodeHeaderRow` root: `className="flex items-end justify-between pl-[18px] pr-3 pt-2"`.
- `TabPill`: `baseClasses = "relative px-2 py-1.5 text-left font-mono text-xs transition-colors"` (colour from `[data-code-tab]` rules); the marker `<span aria-hidden data-code-active-marker className="absolute left-1 right-1 -bottom-px h-[2px]" />`.
- `CopyButton`:
  ```tsx
  <button
    type="button"
    onClick={onCopy}
    aria-label={copied ? "Copied" : "Copy code"}
    data-copied={copied}
    className={`p-1.5 border transition-colors ${
      copied ? "border-panel-accent text-panel-accent" : "border-panel-rule text-panel-dim hover:text-panel-ink hover:border-panel-muted"
    }`}
  >
    {copied ? <Icon name="check" /> : <Icon name="copy" />}
  </button>
  ```

- [ ] **Step 4: `CodeGroup.tsx`, `Steps.tsx`, `Tabs.tsx`**

`CodeGroup` frame: `<div data-code-frame className="my-6 overflow-hidden">`.
`Steps` badge: `className="w-7 h-7 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5"` (colours from prose.css).
`Tabs`: root `className="my-6 overflow-hidden"`; tablist `className="flex border-b border-rule"`; tab button `className="px-4 py-2 text-xs font-mono transition-colors border-b-2 ${active === i ? "" : "text-ink-muted border-transparent hover:text-ink"}"`.

- [ ] **Step 5: `CopyPromptButton.tsx`**

Replace the `baseClass` logic and the button with the `Button` primitive:
```tsx
import { Button } from "./ui/Button"
import { Icon } from "./ui/Icon"
// …
  const isHero = variant === "hero"
  return (
    <Button
      onClick={handleCopy}
      variant={isHero ? "primary" : "secondary"}
      {...(isHero ? {} : { size: "sm" as const, className: "mb-4" })}
      aria-label={copied ? "Prompt copied" : (ariaLabel ?? `${label} to clipboard`)}
    >
      <Icon name={copied ? "check" : "copy"} />
      {copied ? "Copied" : label}
    </Button>
  )
```
Delete the two inline SVGs and the `isHero ? "14" : "12"` sizing.

- [ ] **Step 6: Run the web suite and check a docs page**

Run: `pnpm exec vitest --run && pnpm exec tsc --noEmit`
Expected: PASS except `homepage tokens` (Task 10).
Load `http://localhost:3219/docs/memory` and `/docs/configuration` at 390px: table inline code no longer splits (`AGENTS.md` on one line, the table scrolls); callouts square; code frames dark with a `#202226` strip.

- [ ] **Step 7: Commit**

```bash
git add apps/web/mdx-components.tsx apps/web/app/components/mdx apps/web/app/components/CopyPromptButton.tsx
git commit -m "feat(web): MDX components on the shared prose rules"
```

---

### Task 9: Blog

**Files:**
- Modify: `apps/web/app/components/blog/{blog.module.css,BlogCta,PostMeta,PostHeader,PostCard,FeaturedPostCard,TagChips}.tsx`, `apps/web/app/blog/layout.tsx`, `apps/web/app/blog/page.tsx`, `apps/web/app/blog/tags/[tag]/page.tsx`

- [ ] **Step 1: `blog.module.css`** — delete the `.blog` block and the `.blog :is(h1…)` / `.blog :focus-visible` rules (global now); replace every hex:

```css
.card {
  display: block;
  padding: 28px;
  border: 1px solid var(--color-rule);
  background: var(--color-page);
}
.card:hover {
  border-color: var(--color-rule-strong);
  background: var(--color-relay-tint);
}
.featured {
  padding: 36px;
  margin-bottom: 24px;
  border-left: 4px solid var(--color-relay);
  background: var(--color-relay-tint);
}
/* Block-level so the badge is exactly as tall as the essay eyebrow (16px) and
   titles in the same card row line up. */
.version {
  display: block;
  width: fit-content;
  font:
    11px / 12px var(--font-mono),
    monospace;
  padding: 2px 8px;
  background: var(--color-relay-tint);
  color: var(--color-relay-ink);
}
.chip {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--color-rule);
  color: var(--color-ink-muted);
  font-size: 12px;
}
.chip:hover {
  border-color: var(--color-ink);
  color: var(--color-ink);
}
.active {
  background: var(--color-relay);
  color: var(--color-ink);
  border-color: var(--color-ink);
}
.cta {
  padding: 64px 0;
  background: var(--color-panel);
  color: var(--color-panel-ink);
  --color-focus: var(--color-panel-accent);
}
```
`.cta p { color: var(--color-panel-muted); }`, `.cta h2` font → `var(--font-sans)`, and `.ctaLinks > a { … text-decoration-color: var(--color-panel-accent); }`. Everything else (layout, media queries) unchanged. The `.featured` background moves from `#e9eddb` to relay-tint and `.card:hover` from olive to rule-strong + tint: intended, matches every other card.

- [ ] **Step 2: `blog/layout.tsx`** returns `<>{children}</>`; remove the `styles` import.

- [ ] **Step 3: Components**

- `BlogCta.tsx`: `<CopyCommand command="…" variant="dark" />`; the anchor loses the literal ` ↗` (text is `Read the developer walkthrough`).
- `PostMeta.tsx`: import `Eyebrow`; the four `<div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">` → `<Eyebrow className="mb-2">…</Eyebrow>`; `border-divider` → `border-rule`; author link `className="text-ink underline decoration-olive underline-offset-4"` (external, arrow from CSS); the avatar keeps `rounded-full`? No — square everywhere: replace `className="rounded-full"` with nothing (28px square avatar) in `PostMeta` and `PostHeader`.
- `PostHeader.tsx`: `<Eyebrow tone="olive">`; `border-divider` → `border-rule`; h1 `className="text-h1 text-ink mb-3"`; date `text-ink-dim` → `text-ink-muted`; author link as in PostMeta.
- `PostCard.tsx`: `text-ink-dim` → `text-ink-muted`.
- `FeaturedPostCard.tsx`: `<Eyebrow tone="olive">`; h2 `className="text-h2 mt-2 mb-2"`.
- `TagChips.tsx`: unchanged.
- `blog/page.tsx`: `<Eyebrow tone="olive">Blog</Eyebrow>`; h1 `className="text-h1 text-ink mb-3"`.
- `blog/tags/[tag]/page.tsx`: back link `text-ink-dim` → `text-ink-muted`; `<span className="text-accent-saas">{tag}</span>` → `<span className="text-olive">{tag}</span>`; h1 `className="text-h1 text-ink mb-8"`.

- [ ] **Step 4: Run tests and grep**

Run: `pnpm exec vitest --run app/components/blog app/blog && pnpm exec tsc --noEmit && grep -rn "accent-saas\|ink-dim\|divider\|rounded\|#[0-9a-f]\{6\}" app/components/blog app/blog --include=*.tsx --include=*.css | grep -v opengraph; echo "grep exit $?"`
Expected: PASS; `grep exit 1`.
Load `/blog` and `/blog/why-we-built-b4`: dark square code blocks, inline code on sunk paper (ink), olive eyebrow, tint on hover.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/blog apps/web/app/blog
git commit -m "feat(web): blog on the design tokens, dark code like docs"
```

---

### Task 10: Homepage

**Files:**
- Modify: `apps/web/app/components/homepage/{homepage.module.css,CodePanel,DeveloperHome,Narrative,ProjectOverview}.tsx`

- [ ] **Step 1: `homepage.module.css` — locals become tokens**

Delete the six `--paper/--ink/--relay/--quiet/--rule/--dark` declarations from `.home` and the `.home :focus-visible` rule, then run these substitutions over the file (BSD sed, from `apps/web`):

```bash
f=app/components/homepage/homepage.module.css
sed -i '' \
 -e 's/var(--paper)/var(--color-page)/g' \
 -e 's/var(--ink)/var(--color-ink)/g' \
 -e 's/var(--relay)/var(--color-relay)/g' \
 -e 's/var(--quiet)/var(--color-ink-muted)/g' \
 -e 's/var(--rule)/var(--color-rule)/g' \
 -e 's/var(--dark)/var(--color-panel)/g' \
 -e 's/var(--font-jetbrains-mono)/var(--font-mono)/g' \
 -e 's/var(--font-inter), Arial, sans-serif/var(--font-sans)/g' \
 -e 's/#c3c6bb/var(--color-panel-muted)/g' \
 -e 's/#b6b8ae/var(--color-panel-dim)/g' \
 -e 's/#96998e/var(--color-panel-dim)/g' \
 -e 's/#dce4c1/var(--color-panel-ink)/g' \
 -e 's/#e5efb9/var(--color-panel-ink)/g' \
 -e 's/#41433d/var(--color-panel-rule)/g' \
 -e 's/#565a4d/var(--color-panel-rule)/g' \
 -e 's/#26282c/var(--color-panel-strip)/g' \
 -e 's/#17181b/var(--color-panel)/g' \
 -e 's/#f5f4f0/var(--color-panel-ink)/g' \
 -e 's/#eeeee7/var(--color-surface)/g' \
 -e 's/#e8ecd9/var(--color-relay-tint)/g' \
 -e 's/#e0e7c7/var(--color-relay-tint)/g' \
 -e 's/#454a37/var(--color-relay-ink)/g' \
 -e 's/#424d18/var(--color-relay-ink)/g' \
 -e 's/#b9bdae/var(--color-rule)/g' \
 -e 's/#95492f/var(--color-danger)/g' \
 -e 's/#b4ce37/var(--color-panel-accent)/g' \
 -e 's/#d6d6cc/var(--color-rule)/g' \
 -e 's/#111;/var(--color-ink);/g' \
 -e 's/#627410; \/\* 4.74:1 on --paper; #667811 was 4.48:1 \*\//var(--color-olive);/g' \
 -e 's/border-left: 3px solid #667811/border-left: 3px solid var(--color-olive)/g' \
 -e 's/background: #31391c;/background: color-mix(in srgb, var(--color-panel-accent) 15%, transparent);/g' \
 $f
grep -n "#[0-9a-fA-F]\{3,6\}" $f
```
Expected: the final grep prints nothing. `.highlightLine`'s `border-left-color` and `.fileTabs button[aria-pressed]`'s border now read `var(--color-panel-accent)`. Add `--color-focus: var(--color-panel-accent);` to `.codePanel`, `.agentSource` and `.takeaway` so focus rings on the dark panels stay visible.

- [ ] **Step 2: Homepage eyebrow → primitive**

`.eyebrow` in the module keeps only layout (`margin: 0`) — replace the rule with:
```css
.eyebrow {
  margin: 0;
}
```
and keep the `.agentSource > .eyebrow`, `.takeaway .eyebrow`, `@media (max-width: 430px) .eyebrow { font-size: 11px }` rules. Then in `DeveloperHome.tsx`, `Narrative.tsx`, `ProjectOverview.tsx` replace every `<p className={styles.eyebrow}>…</p>` with `<Eyebrow className={styles.eyebrow}>…</Eyebrow>` (import `Eyebrow` from `../ui/Eyebrow`); the two on dark panels get `tone="panel"` (`.takeaway` "Get started"; `.agentSource` in `Walkthrough.tsx` — check `grep -n eyebrow app/components/homepage/Walkthrough.tsx` and convert it too). The `<span className={styles.eyebrow}>See it in action</span>` inside `<summary>` stays a span: give it `data-ui="eyebrow" data-tone="muted"` instead (a `<p>` inside `<summary>` is invalid).

- [ ] **Step 3: Links**

- `DeveloperHome.tsx`: the four `<a … className={styles.textLink|reportLink}>` lose their literal ` ↗`; the two internal ones (`/docs/cli#b4-add`) stay plain `<a>` (no arrow now); externals get theirs from CSS.
- `Narrative.tsx`: the six chapter links lose ` ↗` (they are internal).
- `CodePanel.tsx`: `{code.linkLabel ?? "Full source"}` without ` ↗`.

- [ ] **Step 4: Run the homepage tests, the whole suite, and the grep**

`Walkthrough.tsx` is not listed above but uses `styles.*` classes and may carry an eyebrow or `↗`: `grep -n "eyebrow\|↗\|className=\"" app/components/homepage/Walkthrough.tsx` and apply the same two conversions there.

Run: `pnpm exec vitest --run && pnpm exec tsc --noEmit && grep -rn "↗" app --include=*.tsx; echo "grep exit $?"`
Expected: all PASS including `homepage tokens`; `grep exit 1`.

- [ ] **Step 5: Screenshot the homepage at 1440 and diff against the baseline**

Run: `node $SCRATCH/visual/shots.mjs $SCRATCH/visual/mid && node $SCRATCH/visual/diff.mjs $SCRATCH/visual/before $SCRATCH/visual/mid $SCRATCH/visual/mid-diff | grep home`
Expected: `home-*.png` under ~3% changed — the eyebrow weight (400→500), the strip colour, the removed arrows, `#41433d`→`#4d5148` rules. Anything larger means a substitution went wrong; open the diff PNG.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/components/homepage
git commit -m "feat(web): homepage on the design tokens; internal links drop the arrow"
```

---

### Task 11: OG images use the mirror

**Files:**
- Modify: `apps/web/app/opengraph-image.tsx`, `apps/web/app/blog/[slug]/opengraph-image.tsx`

- [ ] **Step 1:** In both files `import { COLOR } from "../lib/design-tokens"` (root) / `"../../../lib/design-tokens"` (blog) and replace: `"#f5f4f0"` → `COLOR.page`, `"#111111"` → `COLOR.ink`, `"#595b53"` and `"#55594f"` → `COLOR["ink-muted"]`, `"#b4ce37"` → `COLOR.relay`, `"1px solid #d6d6cc"` → `` `1px solid ${COLOR.rule}` ``.

- [ ] **Step 2:** Run: `pnpm exec vitest --run app/blog && grep -n "#[0-9a-f]\{6\}" app/opengraph-image.tsx 'app/blog/[slug]/opengraph-image.tsx'; echo "grep exit $?"`
Expected: PASS (the blog OG test's `no https?://` and `no fetch(` assertions still hold — the wordmark data URI is not `http`), `grep exit 1`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/opengraph-image.tsx 'apps/web/app/blog/[slug]/opengraph-image.tsx'
git commit -m "feat(web): OG images read the token mirror"
```

---

### Task 12: The guard and the declared-variable contract

**Files:**
- Modify: `apps/web/app/styles/design-system.test.ts`

- [ ] **Step 1: Append the guard cases**

```ts
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const webRoot = resolve(stylesDir, "../..")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(tsx?|css|webmanifest)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

const sources = [
  ...walk(resolve(webRoot, "app")),
  ...walk(resolve(webRoot, "lib")),
  resolve(webRoot, "mdx-components.tsx"),
  resolve(webRoot, "public/site.webmanifest"),
].map((path) => ({ path: path.slice(webRoot.length + 1), text: readFileSync(path, "utf8") }))

describe("guard: the old palette and its classes stay gone", () => {
  const forbidden: Array<[string, RegExp]> = [
    ["amber/white palette hex", /#(b45309|fef3c7|fafaf7|14110d|5a554c|6b6657|e6e3da|cfcabd|50534a|616459|55594f|62665b|d0d2c6|ffffff)\b/i],
    ["legacy token names", /\b(accent-saas|accent-green|accent-blue|accent-purple|ink-dim|divider(-strong)?|text-display-(xl|l)|--b4-font-sans|--docs-(relay|tint))\b/],
    ["rounded-* / shadow-* utilities", /\b(rounded(-[a-z0-9\[\]]+)?|shadow-[a-z0-9]+)\b/],
    ["classes that match no token", /\b(text-bg-primary|hover:border-text-muted|placeholder-text-muted)\b/],
    ["the docs-brand scope", /data-docs-brand/],
    ["dual Shiki output", /--shiki-(light|dark)/],
    ["literal ↗ in markup", /↗/],
    ["focus-visible utilities (the ring is global)", /focus-visible:(ring|outline)/],
  ]
  it.each(forbidden)("no %s", (_label, pattern) => {
    const hits = sources.flatMap(({ path, text }) => {
      if (pattern.source.includes("↗") && path.endsWith(".css")) return [] // ui.css draws it
      const m = text.match(pattern)
      return m ? [`${path}: ${m[0]}`] : []
    })
    expect(hits).toEqual([])
  })

  it("has no hex colour outside tokens.css, the Shiki theme, and the OG image routes", () => {
    const allowed = /(styles\/tokens\.css|lib\/shiki-theme\.ts|lib\/design-tokens\.ts|opengraph-image\.tsx|styles\/prose\.css|site\.webmanifest)$/
    const hits = sources
      .filter(({ path }) => !allowed.test(path))
      .flatMap(({ path, text }) => {
        const m = text.match(/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/i)
        return m ? [`${path}: ${m[0]}`] : []
      })
    expect(hits).toEqual([])
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
  it("resolves every var(--color-*) and var(--text-*) to tokens.css", () => {
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
    const roles = new Set(Object.keys(tokens).filter((n) => n.startsWith("--color-")).map((n) => n.slice(8)))
    const missing = sources
      .filter(({ path }) => path.endsWith(".tsx"))
      .flatMap(({ path, text }) =>
        [...text.matchAll(/\b(?:text|bg|border|decoration|placeholder:text|hover:text|hover:bg|hover:border|focus:bg|group-hover:text)-([a-z][a-z-]*?)(?=[\s"'`/\]:])/g)]
          .map((m) => m[1] as string)
          .filter((name) => !roles.has(name) && !/^(left|right|center|justify|nowrap|wrap|clip|ellipsis|xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|balance|pretty|transparent|current|inherit|t|b|l|r|x|y|display|h1|h2|h3|body|body-lg|code|eyebrow|none)$/.test(name))
          .map((name) => `${path}: ${name}`),
      )
    expect([...new Set(missing)]).toEqual([])
  })
})
```
Note `prose.css` is in the hex allow-list only for the two diff-line colours (`#c5d985`, `#f0ae95`) that mirror the Shiki theme; nothing else in it may be hex — check by eye.

- [ ] **Step 2: Run it and fix what it finds**

Run: `pnpm exec vitest --run app/styles/design-system.test.ts`
Expected: the first run usually lists a handful of stragglers (a `rounded` in a file not touched above, an `ink-dim` in `ReadingLayout`/`DocsPage`, `border-divider` in `ReadingLayout.tsx`). Fix each at the source (`border-divider` → `border-rule`, `text-ink-dim` → `text-ink-muted`, drop `rounded-*`), never by widening the regex. Re-run until green.

- [ ] **Step 3: Prove the guard binds (mutation check)**

Add `rounded-md` to `Card.tsx`'s attrs → run → expect FAIL naming `app/components/ui/Card.tsx: rounded-md` → revert. Add `--color-nope` to a `var()` in `ui.css` → expect the contract case to FAIL → revert.

- [ ] **Step 4: Full web gates**

Run from `apps/web`: `pnpm exec vitest --run && pnpm exec tsc --noEmit && pnpm lint`
Expected: all green. (Task 4 step 7 already ran `pnpm lint` once; see there for the wildcard fallback.)

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "test(web): guard against the old palette, rounded/shadow utilities and undeclared tokens"
```

---

### Task 13: Design-system doc

**Files:**
- Create: `docs/brand/website-design-system.md`
- Modify: `docs/brand/guidelines.md` (one pointer line after the `## Color` intro paragraph)

- [ ] **Step 1: Write the doc**

```markdown
# Website design system

How b4.run (`apps/web`) is styled: one token file, four rule files, a handful of
`data-ui` primitives, and a test that keeps it that way. The brand itself
(logo, palette rationale, typography) is in [`guidelines.md`](./guidelines.md);
this page is the implementation contract.

## Where things live

| File | Holds |
| --- | --- |
| `apps/web/app/styles/tokens.css` | The `@theme` block: every colour, type, radius and shadow token. The only file that may contain a colour value (plus the Shiki theme). |
| `apps/web/app/styles/base.css` | `html`/`body`, `::selection`, the global `:focus-visible` ring, `text-wrap`, skip link, print. |
| `apps/web/app/styles/prose.css` | MDX prose: headings, links, inline code, the dark code frame, Shiki lines, tables, callouts, steps, tabs, related cards. |
| `apps/web/app/styles/ui.css` | `[data-ui="…"]` primitives and the off-site link arrow. |
| `apps/web/lib/design-tokens.ts` | TS mirror of the colour roles for Satori OG images and `viewport.themeColor`. |
| `apps/web/lib/shiki-theme.ts` | The single `paper-relay` syntax theme. |
| `apps/web/app/components/ui/` | `Eyebrow`, `Button`, `SiteLink`, `Card`, `Icon`, `CopyCommand`. |
| `apps/web/app/styles/design-system.test.ts` | Pins values, mirror parity, contrast, and forbids the old palette and classes. |

CSS modules (`homepage.module.css`, `blog.module.css`, `header.module.css`)
hold page layout only and consume tokens through `var(--color-*)`.

## Tokens

Names are roles. Tailwind exposes each `--color-x` as `bg-x`, `text-x`,
`border-x`, `decoration-x`; each composite `--text-x` as `text-x`.

### Surfaces (5)

| Token | Value | Use |
| --- | --- | --- |
| `page` | `#f5f4f0` | Paper. The body background and every card. |
| `surface` | `#eeeee7` | Strips, table heads, the copy-command chip. |
| `surface-sunk` | `#e8e8df` | Inline code. |
| `rule` | `#d6d6cc` | Decorative rules. Never the only boundary of a control. |
| `rule-strong` | `#75796a` | Control boundaries (3.6:1 on page). |

### Ink (2)

| Token | Value | Contrast on page |
| --- | --- | --- |
| `ink` | `#111111` | 17.2:1 |
| `ink-muted` | `#595b53` | 6.3:1 — the only secondary text colour |

### Accent (5)

| Token | Value | Use |
| --- | --- | --- |
| `relay` | `#b4ce37` | Fills only (1.6:1 on page). Never text on paper. |
| `relay-tint` | `#e7edd1` | Selection, active nav, callout body, hover on cards. |
| `relay-ink` | `#424d18` | Text on relay-tint (7.6:1). |
| `olive` | `#627410` | Accent text and link underlines on page (4.7:1). |
| `focus` | `#667811` | The focus ring on page (4.5:1). |

### Dark code panel (7)

| Token | Value | Use |
| --- | --- | --- |
| `panel` | `#17181b` | Code blocks, homepage panels, blog CTA. |
| `panel-strip` | `#202226` | Header/footer strip inside a panel. |
| `panel-ink` | `#f5f4f0` | Text (16.1:1). |
| `panel-muted` | `#c4c8bc` | Labels, captions (10.5:1). |
| `panel-dim` | `#a3aa99` | Line numbers, comments, inactive tabs (7.4:1). |
| `panel-rule` | `#4d5148` | Rules inside the panel. |
| `panel-accent` | `#b4ce37` | Active marker, highlighted line, copied state. Relay may be text here (9.6:1). |

### Status (6)

`ok #1f6f3f` / `ok-tint #e3efe4`, `warn #8a5100` / `warn-tint #fff1ce`,
`danger #a12f25` / `danger-tint #fbe8e5`. Each ink is ≥ 5.9:1 on its tint.

### Type

`--font-sans` (Inter) and `--font-mono` (JetBrains Mono) from `next/font`.
Composite tokens: `text-eyebrow` (12px/1.6, 500, 0.07em, mono, uppercase),
`text-body` 16/1.65, `text-body-lg` 19/1.65, `text-code` 13/1.55,
`text-h1` clamp(36–44)/1.1/600/−0.03em, `text-h2` 28/1.2/600, `text-h3`
20/1.3/600, `text-display` clamp(44–88)/1.03/600/−0.055em.

### Shape and layout

`--radius-*` and `--shadow-*` are reset to `initial`: corners are square and
nothing casts a shadow. The only curves are the relay dots (`border-radius: 50%`).
`:root` holds `--header-h 4.5rem`, `--ring-width 3px`, `--prose-max 68ch`,
`--column-max 1280px`.

## Primitives

| Component | Markup | Variants |
| --- | --- | --- |
| `Eyebrow` | `<p data-ui="eyebrow" data-tone>` | `muted` (default), `olive`, `panel` |
| `Button` | `<button\|a data-ui="button" data-variant data-size>` | `primary` (relay fill, ink border), `secondary` (ink border), `ghost`; `size="sm"` mono |
| `SiteLink` | `next/link` or `<a target=_blank rel=noopener>` | Chosen from the href. Never writes ↗. |
| `Card` | `<a\|div data-ui="card">` | Link cards get the relay-tint hover. |
| `Icon` | `<svg data-ui="icon" data-size>` | `sm` 16px, `md` 20px, stroke 1.5 |
| `CopyCommand` | `<div data-ui="copy-command" data-variant>` | `light`, `dark` |
| `data-ui="nav-item"` | docs sidebar / mobile nav / TOC links | active = tint + ink left border + 600 |
| `data-ui="icon-button"` | 44px icon controls | |
| `data-ui="kbd"` | ⌘K / ESC chips | |

## Rules

- Square corners, no shadows. The guard test fails on any `rounded-*` or `shadow-*` class.
- Relay is a fill. Text on paper is ink, ink-muted or olive; on the panel it may be panel-accent.
- ↗ means off-site. It is drawn by `a[href^="http"]::after`; markup never contains the glyph. Icon-only links add `data-no-arrow`.
- One eyebrow (`Eyebrow`), one focus ring (`:focus-visible` in base.css; dark surfaces restate `--color-focus`), one link style in prose (ink text, olive underline, 2px on hover).
- Prose text stops at `--prose-max` (68ch); code, tables, tabs and card grids keep the column.
- Inline code inside a table never wraps; the table scrolls.
- No hex outside `tokens.css`, `shiki-theme.ts`, `design-tokens.ts` and the OG routes.

## Adding a token

1. Add it to the `@theme` block in `tokens.css` with a comment giving its contrast pair.
2. Add it to `COLOR` in `lib/design-tokens.ts` (colours only).
3. Add the value to the table in `design-system.test.ts` and, if it is text, its pair to the contrast list.
4. Add a row above.

## Dark mode (not shipped)

When it comes: add `[data-theme="dark"] { … }` to `tokens.css` and restate
**every** `--color-*` with a dark value — alias nothing, so a paper-white
`surface` cannot survive into dark by omission. Components already read roles
only, and `[data-code-frame]` in `prose.css` shows the pattern (it restates
`--color-ink`, `--color-rule` and `--color-focus` for the panel). Add
`color-scheme: dark` in the same block and a second contrast table to the test.
```

- [ ] **Step 2: Pointer in `guidelines.md`**

After the paragraph "Paper Relay is the default system…" add: `The website's implementation of this palette — token names, primitives, and the test that pins them — is in [website-design-system.md](./website-design-system.md).`

- [ ] **Step 3: Check-docs and root lint**

Run from the root: `node scripts/check-docs.mjs && pnpm exec biome check --config-path packages/config-biome/biome.json package.json scripts test`
Expected: both pass (`docs/brand/` is scanned for the banned phrases; none are used).

- [ ] **Step 4: Commit**

```bash
git add docs/brand/website-design-system.md docs/brand/guidelines.md
git commit -m "docs(brand): website design system reference"
```

---

### Task 14: Verification pass, screenshots, PR

- [ ] **Step 1: After captures, diff, axe**

```bash
node $SCRATCH/visual/shots.mjs $SCRATCH/visual/after && node $SCRATCH/visual/diff.mjs $SCRATCH/visual/before $SCRATCH/visual/after $SCRATCH/visual/diff && node $SCRATCH/visual/axe.mjs > $SCRATCH/visual/axe-after.txt; echo "axe exit $?"
```
Expected: `axe exit 0` (`axe: clean`). Read `$SCRATCH/visual/diff/summary.txt`: `home-*` and `gs/memory/config-*` low single digits; `blog-*`, `post-*`, `mm-*`, `nf-*` larger (intended). Open every diff PNG above 5% and confirm the changed regions are the listed fixes (prose width, eyebrows, code blocks, chip, arrows). Anything else is a bug: fix it and recapture.

- [ ] **Step 2: Character-per-line check**

```js
// $SCRATCH/visual/cpl.mjs — prints characters per line for the first four long paragraphs
import { chromium } from "/Users/blove/repos/dawn/.claude/worktrees/zen-curie-dd3701/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs"
const browser = await chromium.launch()
for (const path of ["/docs/memory", "/docs/configuration", "/blog/why-we-built-b4"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(`http://localhost:3219${path}`, { waitUntil: "networkidle" })
  const cpl = await page.evaluate(() =>
    [...document.querySelectorAll("main p")]
      .filter((p) => p.textContent.length > 200 && p.getBoundingClientRect().width > 0)
      .slice(0, 4)
      .map((p) => {
        const cs = getComputedStyle(p)
        const c = document.createElement("canvas").getContext("2d")
        c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        return Math.round(p.getBoundingClientRect().width / (c.measureText(p.textContent).width / p.textContent.length))
      }),
  )
  console.log(path, cpl)
  await page.close()
}
await browser.close()
```
Run: `node $SCRATCH/visual/cpl.mjs`. Expected: every value 60–72 (was 85–90).

- [ ] **Step 3: Full gates**

From `apps/web`: `pnpm exec vitest --run && pnpm exec tsc --noEmit && pnpm lint`. Stop the dev server, then `pnpm --filter @b4run/web build` from the root (catches Tailwind/Turbopack CSS errors the dev server tolerates). From the root: `node scripts/check-docs.mjs && pnpm exec biome check --config-path packages/config-biome/biome.json package.json scripts test`.
Then `pnpm --dir apps/web seo:lastmod` and commit the regenerated manifest with `chore(web): regenerate SEO lastmod`.

- [ ] **Step 4: Changeset?**

`node scripts/check-changesets.mjs` — `@b4run/web` is private; if the script asks for one anyway, add `.changeset/website-design-system.md` with `"@b4run/web": patch` and the one-line summary.

- [ ] **Step 5: Push and open the PR (do not merge)**

```bash
git push -u origin blove/website-design-system
gh pr create --title "feat(web): one design system for b4.run" --body-file $SCRATCH/pr-body.md
```
PR body: the adopt/not-adopt summary, the token table link, the intended visual changes (blog code dark/square, `$` chip square/olive, mobile menu on paper, 404 on paper, prose 68ch, arrows off-site only, eyebrow unified, `ink-dim` merged), the diff summary table, axe before/after counts, and before/after screenshots at 390/768/1024/1440 for the eight views uploaded with `gh` (drag the PNGs from `$SCRATCH/visual/{before,after}` into the PR description or upload via the browser). End with the attribution line.

- [ ] **Step 6: CI**

`validate` is the required check (~50 min). `review` failing while credits are out is not a code signal. `vercel-native`/`harness-verify` flake: re-run once before debugging.
