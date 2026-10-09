# Navlog LLA Look (PR 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the navlog web client to LiveLoveApp's rules (Hanken Grotesk + JetBrains Mono, ink + one cobalt accent, pill buttons, light only, no gradients/glass/shadows/uppercase/letter-spacing) without changing its layout or behaviour.

**Architecture:** Almost everything is token and class work in `app/theme.css`, plus font loading in `app/layout.tsx`, a shared `Wordmark` component that replaces the gradient brand mark, and a `design-rules.test.ts` that scans `app/` so the rules cannot drift back. The floating layout stays; PR 2 (a separate plan, written after this merges) replaces it. Every file under `examples/navlog/web/app` has a byte-for-byte twin under `packages/devkit/templates/app-navlog/web/app` (test files carry a `.template` suffix), enforced by `packages/devkit/test/templates.test.ts`, so every task mirrors its changes there.

**Tech Stack:** Next.js 16 (`next/font/google`), Tailwind CSS 4 (`@theme inline`), Leaflet, Vitest (node environment, `renderToStaticMarkup`), CopilotKit v2 CSS tokens, `@b4run/ag-ui` activity-kit tokens.

**Spec:** `docs/superpowers/specs/2026-10-08-navlog-lla-shell-design.md` (sections 1 and 4).

---

## Before you start

- Work from the repo root: `/Users/blove/repos/dawn/.claude/worktrees/b4-release-029b2a`. Branch for this PR: create `blove/navlog-lla-look` from `blove/navlog-design-direction-17ed04` (which holds the spec and this plan): `git switch -c blove/navlog-lla-look`.
- Node 24 (`nvm use 24`). If `node_modules` is missing: `pnpm install`.
- Web app commands (run from repo root):
  - unit tests: `pnpm --filter @b4-example/navlog-web test`
  - one file: `pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts app/design-rules.test.ts`
  - lint: `pnpm --filter @b4-example/navlog-web lint`
  - typecheck: `pnpm --filter @b4-example/navlog-web typecheck`
- Template parity test: `pnpm --filter @b4run/devkit exec vitest --run test/templates.test.ts`
- Never run bare `biome check --write` (it reformats the workspace). Use the package's `lint` script.

### Mirroring a file into the template

After changing an example file, copy it over. Source files keep their name; test files gain `.template`:

```bash
cp examples/navlog/web/app/theme.css packages/devkit/templates/app-navlog/web/app/theme.css
cp examples/navlog/web/app/components/ConnectScreen.test.tsx packages/devkit/templates/app-navlog/web/app/components/ConnectScreen.test.tsx.template
```

Each task lists exactly which files to mirror.

## File map

| File | Change |
|---|---|
| `examples/navlog/web/app/design-rules.test.ts` | Create. Scans `app/` for banned styling. |
| `examples/navlog/web/app/layout.tsx` | Load the two fonts; drop the dark-mode script and theme colours; `data-b4-theme="light"`. |
| `examples/navlog/web/app/theme.css` | New palette and font tokens; delete dark blocks, gradients, glass, shadows, uppercase and letter-spacing; pill buttons; ink route; grey map. |
| `examples/navlog/web/app/components/Wordmark.tsx` | Create. "B4.run / navlog" in ink type. |
| `examples/navlog/web/app/components/ChatDock.tsx` | Use `Wordmark` in the `h1`. |
| `examples/navlog/web/app/components/ConnectScreen.tsx` | Use `Wordmark`; primary "Try again" is an ink pill. |
| `examples/navlog/web/app/components/ThreadRail.tsx` | "Recent" label without uppercase/tracking. |
| `examples/navlog/web/app/components/MemoryPanel.tsx` | Summary label without uppercase/tracking. |
| `examples/navlog/web/app/components/RouteMap.tsx` | Leg highlight uses `--wb-accent`. |
| `examples/navlog/web/app/components/ui.ts` | `neutralButton` becomes a pill; add `primaryButton`. |
| Tests: `ConnectScreen.test.tsx`, `AppShell.test.tsx`, `WorkbenchLayout.test.tsx` | Wordmark text assertions. |
| Template twins of all of the above | Mirror. |
| `packages/devkit/test/templates.test.ts` | `.test.ts.template` count 14 → 15. |
| `examples/navlog/web/README.md`, `packages/devkit/templates/app-navlog/web/README.md` | Restyling section and map bullet. |

---

### Task 1: The design-rules test (red)

**Files:**
- Create: `examples/navlog/web/app/design-rules.test.ts`

- [ ] **Step 1: Write the test**

```ts
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
      offenders(/tracking-(wide|wider|widest)\b|tracking-\[0?\.\d|letter-spacing:\s*0?\.\d+em/),
    ).toEqual([])
  })

  test("uses no gradients, shadows or glass", () => {
    expect(offenders(/gradient|shadow-|box-shadow|drop-shadow|backdrop-blur|backdrop-filter/)).toEqual(
      [],
    )
  })

  test("has no dark scheme", () => {
    expect(offenders(/prefers-color-scheme:\s*dark|data-wb-theme|\bdark:/)).toEqual([])
  })

  test("loads only Hanken Grotesk and JetBrains Mono", () => {
    const names = files.flatMap(({ source }) =>
      [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']next\/font\/google["']/g)].flatMap(
        (match) => (match[1] ?? "").split(",").map((name) => name.trim()),
      ),
    )
    expect(new Set(names.filter(Boolean))).toEqual(new Set(["Hanken_Grotesk", "JetBrains_Mono"]))
  })
})
```

- [ ] **Step 2: Run it and confirm it fails for the right reasons**

Run: `pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts app/design-rules.test.ts`

Expected: "scans the app's source" passes. The other five fail, listing offenders:
- uppercase: `theme.css`, `components/MemoryPanel.tsx`, `components/ThreadRail.tsx`
- letter-spacing: `theme.css`, `components/MemoryPanel.tsx`, `components/ThreadRail.tsx`
- gradients/shadows: `theme.css`
- dark: `layout.tsx`, `theme.css`
- fonts: the set is empty

If `import.meta.dirname` is undefined (it needs Node ≥ 20.11), use `fileURLToPath(new URL(".", import.meta.url))` from `node:url` instead.

- [ ] **Step 3: Commit (red is fine on this branch; the next tasks make it green)**

```bash
git add examples/navlog/web/app/design-rules.test.ts
git commit -m "test(navlog-web): scan app/ for LiveLoveApp's design rules"
```

The template twin and the count change land in Task 7, once the test passes.

---

### Task 2: Fonts and light only in `layout.tsx`

**Files:**
- Modify: `examples/navlog/web/app/layout.tsx`

- [ ] **Step 1: Replace the file's contents**

```tsx
import type { Viewport } from "next"
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google"
import type { ReactNode } from "react"
import "@copilotkit/react-core/v2/styles.css"
// Required, not optional polish: the activity kit carries no inline styles, so
// without this import each turn's plan, steps and subagents render as bare markup.
// Restyle by overriding the `--b4-activity-*` tokens.
import "@b4run/ag-ui/styles.css"
import "leaflet/dist/leaflet.css"
import "./theme.css"

export const metadata = { title: "B4.run navlog — a C172N VFR flight planner" }

// LiveLoveApp's two faces. `theme.css` maps these variables onto Tailwind's
// `font-sans` / `font-mono`, CopilotChat's `--cpk-font-*` and the activity
// kit's `--b4-activity-font-mono`.
const sans = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken", display: "swap" })
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" })

// `viewport-fit=cover` so the phone's bottom sheet can pad itself clear of the
// home indicator (`env(safe-area-inset-bottom)` is 0 without it); the theme
// color matches `--wb-bg` so the browser chrome blends with the app.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f4f5",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Light only. `data-b4-theme="light"` pins the activity kit's own tokens
    // to light even when the OS is dark.
    <html lang="en" data-b4-theme="light" className={`${sans.variable} ${mono.variable}`}>
      <body className="m-0 font-sans bg-wb-bg text-wb-text">{children}</body>
    </html>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @b4-example/navlog-web typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add examples/navlog/web/app/layout.tsx
git commit -m "feat(navlog-web): load Hanken Grotesk and JetBrains Mono, light only"
```

---

### Task 3: The palette and tokens in `theme.css`

**Files:**
- Modify: `examples/navlog/web/app/theme.css`

Make these edits in order. Each shows the text to find and its replacement.

- [ ] **Step 1: Header comment and `:root` palette (lines 3–28)**

Replace from `/*\n * The workbench palette, its Tailwind tokens` through the closing `}` of the first `:root` block with:

```css
/*
 * The workbench palette, its Tailwind tokens, and the markdown styling.
 * Restyling the app is editing this file.
 *
 * LiveLoveApp's rules: Hanken Grotesk and JetBrains Mono, ink plus one cobalt
 * accent (links, the focus ring and the selected thread only), pill buttons,
 * solid fills. Light only. `app/design-rules.test.ts` scans for the rest.
 *
 * (The activity kit's tokens are all mapped onto this palette in the
 * `--b4-activity-*` block below, status colors included, so the kit and
 * CopilotChat follow the workbench.)
 */
:root {
  color-scheme: light;

  --wb-bg: #f4f4f5;
  --wb-surface: #ffffff;
  --wb-border: #e4e4e7;
  --wb-text: #0d0d0d;
  --wb-muted: #52525b;
  --wb-rail: #f4f4f5;
  --wb-accent: #002fa7;
  --wb-radius: 14px;
}
```

- [ ] **Step 2: `@theme inline` (lines 30–53)**

Replace the `@theme inline { … }` block and the comment above it so the comment no longer mentions dark mode, the accent pair becomes one token, and fonts are added:

```css
/*
 * The palette as Tailwind tokens: `bg-wb-surface`, `border-wb-border`,
 * `text-wb-muted`, `rounded-wb`, `font-sans`, `font-mono`.
 *
 * `@theme inline`, not plain `@theme`. Inline substitutes the *value* into the
 * generated utility, so `bg-wb-bg` compiles to `background-color: var(--wb-bg)`
 * and the `--wb-*` variables above stay the single source of truth, including
 * for the --b4-activity-* mapping.
 */
@theme inline {
  --color-wb-bg: var(--wb-bg);
  --color-wb-surface: var(--wb-surface);
  --color-wb-border: var(--wb-border);
  --color-wb-text: var(--wb-text);
  --color-wb-muted: var(--wb-muted);
  --color-wb-rail: var(--wb-rail);
  --color-wb-accent: var(--wb-accent);

  --radius-wb: var(--wb-radius);
  --radius-wb-sm: calc(var(--wb-radius) - 3px);

  --font-sans: var(--font-hanken), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-jetbrains), ui-monospace, monospace;
}
```

- [ ] **Step 3: Focus ring (lines 55–61)**

In `@utility wb-focus`, change `outline: 2px solid var(--wb-accent-from);` to `outline: 2px solid var(--wb-accent);`.

- [ ] **Step 4: Activity-kit mapping (lines 72–86)**

In the `:root { --b4-activity-surface: … }` block, change `--b4-activity-running: var(--wb-route);` and `--b4-activity-running-bg: color-mix(in srgb, var(--wb-route) 10%, var(--wb-surface));` to use `--wb-running`, and add the mono font:

```css
  --b4-activity-running: var(--wb-running);
  --b4-activity-running-bg: color-mix(in srgb, var(--wb-running) 10%, var(--wb-surface));
```

and add, as the block's last line:

```css
  --b4-activity-font-mono: var(--font-jetbrains), ui-monospace, monospace;
```

- [ ] **Step 5: CopilotChat tokens (lines 88–112)**

In `:root [data-copilotkit] { … }`, change `--ring: var(--wb-accent-from);` to `--ring: var(--wb-accent);` and add before the closing brace:

```css
  --cpk-font-sans: var(--font-hanken), ui-sans-serif, system-ui, sans-serif;
  --cpk-font-mono: var(--font-jetbrains), ui-monospace, monospace;
```

Remove the words "in both schemes" and ".dark [data-copilotkit]" from the comment above it so it reads: `CopilotChat's shadcn tokens (declared unlayered on [data-copilotkit]). (0,2,0) and imported after the CopilotKit sheet in layout.tsx, so these win; :root rather than .wb-dock so Radix tooltip/menu portals match too.`

- [ ] **Step 6: Delete the dark palette (lines 123–146)**

Delete the whole `@media (prefers-color-scheme: dark) { :root:not([data-wb-theme="light"]) { --wb-bg … } }`, the `:root[data-wb-theme="light"] { color-scheme: light; }` block and the `:root[data-wb-theme="dark"] { … }` block.

- [ ] **Step 7: Layout and status tokens (lines 148–183)**

Replace the layout-tokens `:root { … }` block (keep its comment) with:

```css
:root {
  --wb-dock-width: min(380px, 34vw);
  --wb-sheet-max: 46vh;
  --wb-gutter: 16px;
  /* The route line is ink; the categories and statuses below carry the color. */
  --wb-route: var(--wb-text);
  --wb-route-casing: #ffffff;
  /* The activity kit's "running" and the dock's Running badge. */
  --wb-running: #1d4ed8;
  --wb-cat-vfr: #15803d;
  --wb-cat-mvfr: #1d4ed8;
  --wb-cat-ifr: #b91c1c;
  --wb-cat-lifr: #a21caf;
  --wb-cat-vfr-bg: #dcfce7;
  --wb-cat-mvfr-bg: #dbeafe;
  --wb-cat-ifr-bg: #fee2e2;
  --wb-cat-lifr-bg: #fae8ff;

  /* Go/no-go and hazards. CAUTION and amber hazards share the amber; NO-GO and red hazards the red. */
  --wb-go: #15803d;
  --wb-go-bg: #f0fdf4;
  --wb-go-border: #bbf7d0;
  --wb-caution: #b45309;
  --wb-caution-bg: #fffbeb;
  --wb-caution-border: #fde68a;
  --wb-nogo: #b91c1c;
  --wb-nogo-bg: #fef2f2;
  --wb-nogo-border: #fecaca;

  /* The color under the tiles while they load: the grey of the desaturated map. */
  --wb-map-bg: #e8e8e8;
}
```

`--wb-float`, `--wb-float-border` and `--wb-shadow` are gone; Steps 9–12 remove their uses.

- [ ] **Step 8: Delete the dark status tokens and tile inversion (lines 185–252)**

Delete the `@media (prefers-color-scheme: dark)` block that starts `--wb-route: #60a5fa;`, the `:root[data-wb-theme="dark"] { --wb-route: #60a5fa; … }` block, and both dark tile-filter blocks. Replace the remaining light tile rule and its comment with:

```css
/* The OpenStreetMap tiles in grey, so the ink route and the category colors carry the map. */
.wb-map .leaflet-tile-pane {
  filter: grayscale(1) contrast(0.92) brightness(1.04);
}
```

- [ ] **Step 9: Map controls (lines 288–329)**

In `.wb-map.leaflet-container .leaflet-control-zoom`, replace the body with:

```css
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  overflow: hidden;
  background: var(--wb-surface);
```

In the zoom buttons' `:focus-visible` rule change `var(--wb-accent-from)` to `var(--wb-accent)`.

In `.wb-map.leaflet-container .leaflet-control-attribution`, replace the body with:

```css
  border-radius: 999px;
  background: var(--wb-surface);
  padding: 1px 8px;
  font-size: 10.5px;
  color: var(--wb-muted);
```

- [ ] **Step 10: Waypoints and heading labels (lines 360–422)**

- `.wb-map .wb-wp-dot`: delete `box-shadow: 0 1px 3px rgb(0 0 0 / 0.35);`.
- `.wb-map .wb-wp-label`: change `border: 1px solid var(--wb-float-border);` to `border: 1px solid var(--wb-border);`, `border-radius: 6px;` to `border-radius: 999px;`, `background: var(--wb-float);` to `background: var(--wb-surface);`, delete `box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);` and delete `letter-spacing: 0.01em;`.
- `.wb-map .wb-hdg-label`: delete `box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);`.

- [ ] **Step 11: Panels (lines 424–441)**

Replace `.wb-panel` and its comment, and `.wb-sheet`'s background:

```css
/* A surface: solid white, a hairline, the workbench radius. No glass, no lift. */
.wb-panel {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
}

.wb-sheet {
  background: var(--wb-surface);
}
```

(Delete the old "The sheet holds a dense table: a little more opaque" comment with it. Keep `.wb-sheet.wb-sheet-flat` and `.wb-strip` as they are.)

- [ ] **Step 12: Labels, buttons and tabs (lines 447–507)**

Replace `.wb-eyebrow` and its comment:

```css
/* A section's own heading inside a panel ("Planning brief", "Go / no-go"): sentence case, muted. */
.wb-eyebrow {
  font-size: 12px;
  font-weight: 600;
  color: var(--wb-muted);
}
```

In `.wb-button` change `border-radius: calc(var(--wb-radius) - 3px);` to `border-radius: 999px;` and `padding: 0 10px;` to `padding: 0 12px;`. In its `@media (pointer: coarse)` rule change `padding: 0 12px;` to `padding: 0 14px;`.

In `.wb-tab[aria-selected="true"]` change `border-bottom-color: var(--wb-accent-from);` to `border-bottom-color: var(--wb-text);`.

- [ ] **Step 13: Verdict letter-spacing (lines 617–666)**

Delete `letter-spacing: 0.04em;` from `.wb-verdict-pill`, `letter-spacing: 0.02em;` from `.wb-verdict-word`, and `letter-spacing: 0.02em;` from `.wb-verdict-pill-raised`.

- [ ] **Step 14: Stat labels and table headers (lines 732–783)**

In `.wb-stat dt` delete `letter-spacing: 0.06em;` and `text-transform: uppercase;`, and change `font-size: 10.5px;` to `font-size: 12px;`. In `.wb-navlog-table thead th` delete `letter-spacing: 0.04em;` and `text-transform: uppercase;`, and change `font-size: 11px;` to `font-size: 12px;`.

- [ ] **Step 15: Bottom line (line 810)**

In `.wb-bottom-line` change `border-left: 3px solid var(--wb-accent-from);` to `border-left: 3px solid var(--wb-text);`.

- [ ] **Step 16: Print rule**

In the `@media print` block's `.wb-sheet` rule, delete the two lines:

```css
    /* biome-ignore lint/complexity/noImportantStyles: print must override the sheet's screen styles */
    box-shadow: none !important;
```

and in the block's top comment change "the sheet's own position, height and panel shadow come from rules (utilities and the dark-mode `.wb-panel` selector)" to "the sheet's own position, height and border come from rules (utilities and `.wb-panel`)".

- [ ] **Step 17: Brand mark and primary action (lines 914–924)**

Replace `.wb-brand-mark { … }` and `.wb-primary-action { … }` with:

```css
/* The app's name, "B4.run / navlog", in ink type (`Wordmark.tsx`). */
.wb-wordmark {
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--wb-text);
}

.wb-wordmark-product {
  font-family: var(--font-mono);
  font-weight: 400;
  color: var(--wb-muted);
}
```

- [ ] **Step 18: Prose code font (line 1025)**

In `.wb-prose code` change `font-family: ui-monospace, SFMono-Regular, Menlo, monospace;` to `font-family: var(--font-mono);`.

- [ ] **Step 19: Chat-dock dark tokens (lines 1073–1099)**

Keep the light `:root { --wb-chat-warn … }` block. Delete the `@media (prefers-color-scheme: dark)` block and the `:root[data-wb-theme="dark"]` block after it. Replace the block's comment with:

```css
/*
 * The chat dock's two signal colors: a warning (an approval waiting, a denied
 * call) and a failure.
 */
```

- [ ] **Step 20: Check no stale token remains**

Run: `grep -n -E "accent-from|accent-to|wb-float|wb-shadow|data-wb-theme|prefers-color-scheme|uppercase|backdrop|box-shadow|gradient" examples/navlog/web/app/theme.css`
Expected: no output except inside comments you deliberately kept (there should be none).

- [ ] **Step 21: Run the design-rules test**

Run: `pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts app/design-rules.test.ts`
Expected: `theme.css` and `layout.tsx` no longer listed. Remaining failures: `components/MemoryPanel.tsx` and `components/ThreadRail.tsx` (uppercase, letter-spacing). The fonts test passes.

- [ ] **Step 22: Commit**

```bash
git add examples/navlog/web/app/theme.css
git commit -m "feat(navlog-web): LiveLoveApp palette, pill buttons, grey map, light only"
```

---

### Task 4: Components: labels, buttons, map highlight

**Files:**
- Modify: `examples/navlog/web/app/components/ThreadRail.tsx:59-63`
- Modify: `examples/navlog/web/app/components/MemoryPanel.tsx:170,176`
- Modify: `examples/navlog/web/app/components/RouteMap.tsx:153`
- Modify: `examples/navlog/web/app/components/ui.ts`

- [ ] **Step 1: ThreadRail "Recent" label**

Change the `<p>`'s className from

```tsx
        className={`px-4 ${showCreate ? "pt-6" : "pt-1"} pb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-wb-muted`}
```

to

```tsx
        className={`px-4 ${showCreate ? "pt-6" : "pt-1"} pb-2 text-[12px] font-medium text-wb-muted`}
```

- [ ] **Step 2: MemoryPanel summary label**

Change the `<summary>` className from

```tsx
        <summary className="wb-focus flex cursor-pointer list-none items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-wb-muted">
```

to

```tsx
        <summary className="wb-focus flex cursor-pointer list-none items-center gap-1.5 px-1 text-[12px] font-medium text-wb-muted">
```

and in the comment above it change "at a size that fights an 11px uppercase label" to "at a size that fights a 12px label".

- [ ] **Step 3: RouteMap leg highlight**

Change `{ color: cssVar("--wb-accent-from"), weight: 9, opacity: 0, interactive: false },` to `{ color: cssVar("--wb-accent"), weight: 9, opacity: 0, interactive: false },`.

- [ ] **Step 4: Pill buttons in `ui.ts`**

Replace the file's contents with:

```ts
/**
 * The workbench's two buttons, at the two sizes they appear in. Both are
 * pills, per LiveLoveApp's rules.
 *
 * `neutralButton` is the quiet one: `RunError`'s Retry and Dismiss and
 * `MemoryPanel`'s decisions. `primaryButton` is the one action a surface
 * exists for, in ink: `ConnectScreen`'s "Try again".
 *
 * The scope stops there, deliberately. The rail's thread rows are not this
 * button at another size — they are a borderless list row with their own
 * hover and active states — so folding them in would mean a `variant`
 * argument that exists only to be branched on. `wb-focus` is what they
 * genuinely share, and that lives in `app/theme.css`.
 */
function scale(size: "sm" | "md"): string {
  return size === "sm" ? "px-3 py-1 text-[12px]" : "px-4 py-1.5 text-[13px]"
}

export function neutralButton(size: "sm" | "md"): string {
  return `wb-focus rounded-full border border-wb-border bg-wb-surface font-medium tracking-tight transition-colors hover:border-wb-muted ${scale(size)}`
}

export function primaryButton(size: "sm" | "md"): string {
  return `wb-focus rounded-full border border-wb-text bg-wb-text font-medium tracking-tight text-wb-surface transition-colors hover:bg-wb-muted hover:border-wb-muted ${scale(size)}`
}
```

- [ ] **Step 5: Run the design-rules test and the component tests**

Run: `pnpm --filter @b4-example/navlog-web test`
Expected: `design-rules.test.ts` passes entirely. All other files pass (no test asserts these class strings; if one does, update the expectation to the new class and note it in the commit).

- [ ] **Step 6: Commit**

```bash
git add examples/navlog/web/app/components/ThreadRail.tsx examples/navlog/web/app/components/MemoryPanel.tsx examples/navlog/web/app/components/RouteMap.tsx examples/navlog/web/app/components/ui.ts
git commit -m "feat(navlog-web): sentence-case labels, pill buttons, cobalt leg highlight"
```

---

### Task 5: The `Wordmark` replaces the gradient brand mark

**Files:**
- Create: `examples/navlog/web/app/components/Wordmark.tsx`
- Modify: `examples/navlog/web/app/components/ChatDock.tsx:119-121`
- Modify: `examples/navlog/web/app/components/ConnectScreen.tsx:47-49,67`
- Test: `examples/navlog/web/app/components/ConnectScreen.test.tsx:45-48`, `AppShell.test.tsx:262`, `WorkbenchLayout.test.tsx:61`

- [ ] **Step 1: Update the tests first**

In `ConnectScreen.test.tsx` replace

```tsx
  test("renders the brand mark, same as the empty state", () => {
    const html = render()
    expect(html).toContain("wb-brand-mark")
  })
```

with

```tsx
  test("renders the wordmark, same as the dock", () => {
    const html = render()
    expect(html).toContain('class="wb-wordmark"')
    expect(html).toContain("B4.run")
    expect(html).toContain("/ navlog")
  })

  test("Try again is the primary (ink) button", () => {
    const html = render()
    expect(html).toMatch(/<button[^>]*bg-wb-text[^>]*>Try again<\/button>/)
  })
```

In `AppShell.test.tsx` change `expect(text()).toContain("B4.run navlog")` to `expect(text()).toContain("B4.run / navlog")`.

In `WorkbenchLayout.test.tsx` change `expect(html).toContain("B4.run navlog")` to `expect(html).toContain('class="wb-wordmark"')`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts app/components/ConnectScreen.test.tsx app/components/AppShell.test.tsx app/components/WorkbenchLayout.test.tsx`
Expected: the three changed assertions and the new "Try again" test fail.

- [ ] **Step 3: Create `Wordmark.tsx`**

```tsx
/**
 * The app's name, "B4.run / navlog", as plain ink type. It replaces the old
 * gradient brand mark: LiveLoveApp's rules allow no gradients and no text
 * with a gradient fill. Styles: `.wb-wordmark` in `app/theme.css`.
 */
export function Wordmark() {
  return (
    <span className="wb-wordmark">
      B4.run <span className="wb-wordmark-product">/ navlog</span>
    </span>
  )
}
```

- [ ] **Step 4: Use it in `ChatDock.tsx`**

Add `import { Wordmark } from "./Wordmark"` with the other local imports (keep imports sorted: after `import { useHydrated } from "../lib/use-hydrated"`). Replace

```tsx
        <h1 className="wb-brand-mark mr-auto shrink-0 text-[13px] font-semibold tracking-tight max-md:sr-only">
          B4.run navlog
        </h1>
```

with

```tsx
        <h1 className="mr-auto shrink-0 text-[14px] max-md:sr-only">
          <Wordmark />
        </h1>
```

- [ ] **Step 5: Use it in `ConnectScreen.tsx`**

Change the `ui` import to `import { primaryButton } from "./ui"` (it currently imports `neutralButton`; check that nothing else in the file uses `neutralButton` after this step) and add `import { Wordmark } from "./Wordmark"`. Replace

```tsx
        <span className="wb-brand-mark text-[15px] font-semibold tracking-tight">
          B4.run navlog
        </span>
```

with

```tsx
        <span className="text-[16px]">
          <Wordmark />
        </span>
```

and change the button's className from `` `${neutralButton("md")} mt-8` `` to `` `${primaryButton("md")} mt-8` ``.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @b4-example/navlog-web test`
Expected: all pass.

- [ ] **Step 7: Lint and typecheck**

Run: `pnpm --filter @b4-example/navlog-web lint && pnpm --filter @b4-example/navlog-web typecheck`
Expected: exit 0. If Biome reports formatting, run `pnpm --filter @b4-example/navlog-web exec biome check --write --config-path ../../../packages/config-biome/biome.json app` (scoped to this package), then re-run lint and check `git diff --stat` touches only your files.

- [ ] **Step 8: Commit**

```bash
git add examples/navlog/web/app/components/Wordmark.tsx examples/navlog/web/app/components/ChatDock.tsx examples/navlog/web/app/components/ConnectScreen.tsx examples/navlog/web/app/components/ConnectScreen.test.tsx examples/navlog/web/app/components/AppShell.test.tsx examples/navlog/web/app/components/WorkbenchLayout.test.tsx
git commit -m "feat(navlog-web): ink wordmark replaces the gradient brand mark"
```

---

### Task 6: README restyling section

**Files:**
- Modify: `examples/navlog/web/README.md` (the "Route map" bullet around line 23 and "## Restyling it", around lines 179–196)
- Modify: `packages/devkit/templates/app-navlog/web/README.md` (its "Route map" bullet and any restyling/dark-mode text)

- [ ] **Step 1: Example README, map bullet**

Replace "muted in light mode and inverted in dark so the route carries the color." with "shown in grey so the ink route and the flight-category colors carry the map."

- [ ] **Step 2: Example README, "Restyling it"**

Replace the first three paragraphs of "## Restyling it" (from "`app/theme.css` is the one file to edit." through "`data-wb-theme=\"dark\"` on `<html>` — `theme.css` defines both branches.") with:

```markdown
`app/theme.css` is the one file to edit. The whole palette is defined there as CSS
variables and re-exported as Tailwind tokens via `@theme inline`, which is why the app's
utilities read `bg-wb-surface`, `border-wb-border`, `text-wb-muted`, `rounded-wb`,
`font-sans`. Change a `--wb-*` value and the activity-card tokens, CopilotChat's tokens
and every utility move together. The same file holds the single focus ring (`wb-focus`),
the wordmark (`.wb-wordmark`), and the `.wb-prose` rules for rendered markdown.

The look follows [LiveLoveApp](https://liveloveapp.com)'s design rules: Hanken Grotesk
and JetBrains Mono (loaded with `next/font/google` in `app/layout.tsx`), ink `#0d0d0d`
plus one cobalt accent `#002fa7` used only for links, focus and the selected thread,
pill buttons, solid fills. The app is light only. The flight-category, verdict and
status colors are the one exception to the single accent: they are data, shown only as
labelled chips and dots. `app/design-rules.test.ts` fails the build on uppercase,
positive letter-spacing, gradients, shadows, glass, a dark scheme, or any other font.

It also holds the map workbench's tokens: `--wb-dock-width`, `--wb-sheet-max` and
`--wb-gutter` for the layout, `--wb-route` for the route line, the `--wb-cat-*`
flight-category colors the chips and the markers share, the filter that turns the map
tiles grey, and the print rules.
```

- [ ] **Step 3: Template README**

Open `packages/devkit/templates/app-navlog/web/README.md`. Search for `dark`, `gradient`, `invert` and `brand`. Rewrite each sentence that describes dark mode, the inverted tiles or the gradient brand mark to match Step 1 and Step 2's facts, in that README's own voice (it is shorter and addressed to a generated app; do not paste the example's paragraphs wholesale, and keep its `{{appName}}` token). If none of those words appear, leave it unchanged.

- [ ] **Step 4: Check the docs script**

Run: `node scripts/check-docs.mjs`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add examples/navlog/web/README.md packages/devkit/templates/app-navlog/web/README.md
git commit -m "docs(navlog-web): restyling section for the LiveLoveApp look"
```

---

### Task 7: Mirror into the scaffold template

**Files:**
- Modify (copy): every changed file under `packages/devkit/templates/app-navlog/web/app/`
- Modify: `packages/devkit/test/templates.test.ts` (the `.test.ts.template` count)

- [ ] **Step 1: Run the parity test to see the drift**

Run: `pnpm --filter @b4run/devkit exec vitest --run test/templates.test.ts -t "navlog web"`
Expected: FAIL. `contentDriftedPaths` lists `app/layout.tsx`, `app/theme.css`, the six component files and three test files; `missingTemplatePaths` lists `app/design-rules.test.ts` and `app/components/Wordmark.tsx`.

- [ ] **Step 2: Copy the files**

```bash
E=examples/navlog/web/app
T=packages/devkit/templates/app-navlog/web/app
cp $E/layout.tsx $T/layout.tsx
cp $E/theme.css $T/theme.css
for f in Wordmark.tsx ChatDock.tsx ConnectScreen.tsx ThreadRail.tsx MemoryPanel.tsx RouteMap.tsx ui.ts; do cp $E/components/$f $T/components/$f; done
cp $E/design-rules.test.ts $T/design-rules.test.ts.template
for f in ConnectScreen AppShell WorkbenchLayout; do cp $E/components/$f.test.tsx $T/components/$f.test.tsx.template; done
```

- [ ] **Step 3: Update the template test-file count**

In `packages/devkit/test/templates.test.ts`, in "normalizes every template-suffixed web path onto an existing example path", change

```ts
    expect(templateSuffixedPaths.filter((path) => path.endsWith(".test.ts.template"))).toHaveLength(
      14,
    )
```

to

```ts
    expect(templateSuffixedPaths.filter((path) => path.endsWith(".test.ts.template"))).toHaveLength(
      15,
    )
```

- [ ] **Step 4: Run the devkit tests**

Run: `pnpm --filter @b4run/devkit test`
Expected: all pass, including both navlog parity suites.

- [ ] **Step 5: Commit**

```bash
git add packages/devkit/templates/app-navlog/web packages/devkit/test/templates.test.ts
git commit -m "chore(devkit): mirror the navlog LiveLoveApp look into the scaffold template"
```

---

### Task 8: Verify

- [ ] **Step 1: Package gates**

Run, from the repo root:

```bash
pnpm --filter @b4-example/navlog-web lint
pnpm --filter @b4-example/navlog-web typecheck
pnpm --filter @b4-example/navlog-web test
pnpm --filter @b4-example/navlog-web build
pnpm --filter @b4run/devkit test
```

Expected: all exit 0. `build` downloads the two Google fonts; it needs network.

- [ ] **Step 2: Browser e2e (transport only, must pass unchanged)**

Run: `pnpm --filter @b4-example/navlog-web test:e2e`
Expected: PASS. If Playwright browsers are missing: `pnpm --filter @b4-example/navlog-web exec playwright install chromium`.

- [ ] **Step 3: Harness framework lane (drives the scaffolded Workbench in Chromium, including axe colour-contrast)**

Run: `pnpm build && pnpm verify:harness:framework`
Expected: the workbench journeys pass. The accessible names the harness clicks ("+ New conversation", "Threads", "Send", "Memory candidates", `section[aria-label="Chat"]`) are unchanged by this PR; a failure here is most likely axe colour-contrast. Fix it with a darker token in `theme.css`, mirror, and re-run.

- [ ] **Step 4: Live check**

Start the navlog server and web app (`examples/navlog/README.md` has the commands; the server needs a real `OPENAI_API_KEY` in `examples/navlog/server/.env`). Open http://localhost:3010 in the browser pane at desktop width and at 375 px (`resize_window` preset `mobile`), and with the OS (or `resize_window` `colorScheme: "dark"`) in dark mode. Check:
- Hanken Grotesk on text, JetBrains Mono on navlog figures and "/ navlog".
- No gradient anywhere; the wordmark is ink.
- Panels are solid white with a hairline, no blur or shadow.
- Buttons are pills; focus rings are cobalt (Tab through the dock).
- The map is grey, the route is ink, waypoint dots keep their category colours.
- The app stays light with the OS in dark mode, including CopilotChat and the activity cards.
- Plan KPAO → KMRY through the filing approval; Print shows the navlog.
- Stop the server: the connect screen shows the ink wordmark and an ink "Try again" pill.

Take a desktop and a phone screenshot for the PR description.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin blove/navlog-lla-look
gh pr create --title "navlog-web: LiveLoveApp look (fonts, palette, light only)" --body "$(cat <<'EOF'
PR 1 of 2 for docs/superpowers/specs/2026-10-08-navlog-lla-shell-design.md: the look, in the current floating layout. PR 2 replaces the layout.

- Hanken Grotesk + JetBrains Mono via next/font/google
- LiveLoveApp palette: ink #0d0d0d, cobalt #002fa7 for links/focus/selection only, grey canvas, pill buttons, solid panels
- Light only: dark palette, dark-class script and tile inversion removed
- Ink wordmark "B4.run / navlog" replaces the gradient brand mark
- Grey map tiles, ink route; flight-category/verdict/status colours kept as labelled chips and dots
- app/design-rules.test.ts scans app/ for uppercase, positive letter-spacing, gradients, shadows, glass, dark scheme and other fonts
- Mirrored into packages/devkit/templates/app-navlog (byte parity)

Screenshots: (desktop, phone)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then bind the PR with the ccd_pr tools and read its CI. The spec and plan commits from `blove/navlog-design-direction-17ed04` ride along in this PR.
