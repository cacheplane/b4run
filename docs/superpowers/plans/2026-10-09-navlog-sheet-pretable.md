# Navlog Sheet on pretable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the navlog's legs table the primary element of the sheet, rendered with pretable on desktop, scrolling in its own region, with a verdict strip above and Legs / Totals & plan / Brief tabs.

**Architecture:** Column definitions move to `lib/navlog-columns.ts`, shared by the existing `NavlogTable` (print copy and phone cards) and a new `NavlogGrid` (pretable wrapper). `NavlogSheet` gains a verdict strip, a tablist and one scroll region per tab; the selected tab and the selected leg are lifted into `WorkbenchLayout`, which drives the map highlight and `SheetControl.openSheet`.

**Tech Stack:** Next.js 16, React 19, Tailwind 4, `@pretable/react` + `@pretable/ui` 0.20.x, Vitest (jsdom, `vi.mock` of `@pretable/react`), Playwright harness.

**Spec:** `docs/superpowers/specs/2026-10-09-navlog-sheet-pretable-design.md`.

---

## Before you start

- Repo root `/Users/blove/repos/dawn/.claude/worktrees/b4-release-029b2a`, branch `blove/navlog-sheet-pretable` (from `main` after #1009). Run commands from the root.
- Shared worktree: never `git checkout/switch/stash/reset/rebase/commit --amend`; stage by explicit path; never bare `biome check --write` (scoped: `pnpm --filter @b4-example/navlog-web exec biome check --write --config-path ../../../packages/config-biome/biome.json <files>`, then `git diff --stat`). Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: `pnpm --filter @b4-example/navlog-web test|lint|typecheck`; one file: `pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts <path>`.
- `app/design-rules.test.ts` stays green; `exactOptionalPropertyTypes` is on.
- The template twin (`packages/devkit/templates/app-navlog/web/app`, tests `.template`) is mirrored in Task 7.
- pretable facts (0.20.2, verified from the published types): `<Pretable ariaLabel columns rows getRowId …>`; `PretableColumn` has `id`, `header?: string`, `pinned?: "left" | "right"`, `flex?`, `widthPx?`, `minWidthPx?`, `align?`, `sortable?`, `filterable?`, `resizable?`, `reorderable?`, `value?: (row) => unknown`; selection is reported by `onSelectedRowIdChange?: (rowId: string | null) => void` on the surface props (confirm it is forwarded by `Pretable`; if only `PretableSurface` takes it, use `PretableSurface` with the same props). Styles: `@pretable/ui/themes/pretable.css` and `@pretable/ui/grid.css`; grid tokens are `--pretable-*` custom properties. The theme switches to dark only under `[data-theme="dark"]`, which this app never sets.

## File map

| File | Change |
|---|---|
| `examples/navlog/web/package.json`, `pnpm-lock.yaml`, `packages/devkit/templates/app-navlog/web/package.json.template` | Add the two pretable packages. |
| `app/layout.tsx` | Import pretable's theme and grid CSS before `theme.css`. |
| `app/theme.css` | Map `--pretable-*` onto `--wb-*` inside `.wb-navlog-grid`; tab and strip styles. |
| `app/lib/navlog-columns.ts` (+ `.test.ts`) | Create: shared columns, `legName`, `totalFor`, `VARIATION_SOURCE`. |
| `app/components/NavlogTable.tsx` | Import from `navlog-columns`. |
| `app/components/NavlogGrid.tsx` (+ `.test.tsx`) | Create: the pretable wrapper. |
| `app/components/NavlogSheet.tsx` (+ test) | Verdict strip, tabs, per-tab scroll, totals strip, print copy. |
| `app/components/WorkbenchLayout.tsx` (+ test) | `sheetTab` and `selectedLeg` state; `openSheet` → Legs. |
| `docs/brand/demo/capture.mjs`, `test/harness/*` | Audit; update only if broken. |
| READMEs, recipe `.mdx`, lastmod, template mirror | Task 7. |

---

### Task 1: Dependency and styles

- [ ] **Step 1: Add the packages.**

```bash
pnpm --filter @b4-example/navlog-web add @pretable/react@^0.20.2 @pretable/ui@^0.20.2
```

  Confirm `examples/navlog/web/package.json` lists both under `dependencies` with `^0.20.2`, and `git diff --stat pnpm-lock.yaml` shows only additions for `@pretable/*` (and `@pretable/core`, pulled transitively). In `packages/devkit/templates/app-navlog/web/package.json.template`, add the same two lines to `dependencies`, keeping the file's alphabetical order and its existing version style.

- [ ] **Step 2: Template guards.** Run `pnpm --filter @b4run/devkit test`. If a dependency-allowlist test (e.g. `test/template-copilotkit-dependencies.test.ts`) pins the template's dependency set, update its expectation to include the two packages, and nothing else.

- [ ] **Step 3: CSS imports.** In `examples/navlog/web/app/layout.tsx`, add after the `leaflet/dist/leaflet.css` import and before `./theme.css`:

```tsx
// pretable's house theme and grid skin; `theme.css` maps its tokens onto ours
// inside `.wb-navlog-grid`.
import "@pretable/ui/themes/pretable.css"
import "@pretable/ui/grid.css"
```

- [ ] **Step 4: Token mapping.** Append to `examples/navlog/web/app/theme.css`, before the `@media print` block:

```css
/*
 * The navlog grid (pretable). Its tokens mapped onto the workbench's, so it
 * reads as this app rather than pretable's house look: our fonts, ink, rules
 * and cobalt focus; flat (no shadows) per LiveLoveApp's rules.
 */
.wb-navlog-grid {
  --pretable-font-sans: var(--font-hanken), ui-sans-serif, system-ui, sans-serif;
  --pretable-font-size-cell: 13px;
  --pretable-font-size-header: 12px;
  --pretable-text-cell: var(--wb-text);
  --pretable-text-header: var(--wb-muted);
  --pretable-text-dim: var(--wb-muted);
  --pretable-bg-grid: var(--wb-surface);
  --pretable-bg-header: var(--wb-surface);
  --pretable-bg-hover: var(--wb-rail);
  --pretable-bg-selected: color-mix(in srgb, var(--wb-accent) 8%, var(--wb-surface));
  --pretable-selection-bg: color-mix(in srgb, var(--wb-accent) 8%, var(--wb-surface));
  --pretable-text-selected: var(--wb-text);
  --pretable-rule: var(--wb-border);
  --pretable-rule-header: var(--wb-border);
  --pretable-accent: var(--wb-accent);
  --pretable-focus-ring: var(--wb-accent);
  --pretable-cell-padding-x: 8px;
  --pretable-shadow-card: none;
  --pretable-shadow-header: none;
  --pretable-shadow-overlay: none;
  font-variant-numeric: tabular-nums;
}

/* Figures in mono; the leg name stays in the text face. */
.wb-navlog-grid [role="gridcell"]:not([data-column-id="leg"]) {
  font-family: var(--font-mono);
}
```

  Use the token names that actually appear in `node_modules/@pretable/ui/grid.css` (`grep -o "var(--pretable-[a-z0-9-]*" … | sort -u`); drop any line above whose token the skin does not read, and confirm the cell attribute for the column id (`data-column-id` or similar) by reading `grid.css`/the rendered DOM in Task 8, correcting the selector there if needed.

- [ ] **Step 5:** `pnpm --filter @b4-example/navlog-web lint && pnpm --filter @b4-example/navlog-web typecheck && pnpm --filter @b4-example/navlog-web test` → green. Commit `examples/navlog/web/package.json`, `pnpm-lock.yaml`, the template `package.json.template`, any devkit test change, `layout.tsx`, `theme.css`: `feat(navlog-web): add pretable and map its tokens onto the workbench`.

---

### Task 2: Shared navlog columns

**Files:** Create `examples/navlog/web/app/lib/navlog-columns.ts` and `navlog-columns.test.ts`; modify `app/components/NavlogTable.tsx`.

- [ ] **Step 1: Failing test** (`navlog-columns.test.ts`):

```ts
import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "./navlog-types"
import { LEG_COLUMNS, legName, totalFor } from "./navlog-columns"

describe("navlog columns", () => {
  test("the fourteen figures, in paper-navlog order", () => {
    expect(LEG_COLUMNS.map((c) => c.label)).toEqual([
      "TC", "Var", "MC", "Wind", "WCA", "MH", "TAS", "GS", "Dist", "Rem", "ETE", "ETA", "Fuel", "Fuel rem",
    ])
    for (const c of LEG_COLUMNS) expect(c.title.length).toBeGreaterThan(0)
  })
  test("every column formats a leg", () => {
    const leg = SAMPLE_NAVLOG.legs[0]
    if (leg === undefined) throw new Error("sample has no legs")
    for (const c of LEG_COLUMNS) expect(typeof c.value(leg)).toBe("string")
    expect(legName(leg)).toBe(`${leg.from} → ${leg.to} (${leg.segment})`)
  })
  test("totals exist for distance, ETE and fuel only", () => {
    expect(totalFor(SAMPLE_NAVLOG, "dist")).toBe(String(SAMPLE_NAVLOG.totals.distanceNm))
    expect(totalFor(SAMPLE_NAVLOG, "mh")).toBe("")
  })
})
```

  (The list must equal today's `COLUMNS` order in `NavlogTable.tsx` exactly.)

- [ ] **Step 2:** Run → FAIL (module not found).

- [ ] **Step 3: Move, don't rewrite.** Create `lib/navlog-columns.ts` by moving from `NavlogTable.tsx`, unchanged: the `legName` helper (export it), the `Column` interface (export as `LegColumn`), `VARIATION_SOURCE`, the `COLUMNS` array (export as `LEG_COLUMNS`), and `totalFor` (export). Keep their doc comments. `NavlogTable.tsx` imports them (`import { LEG_COLUMNS, legName, totalFor, VARIATION_SOURCE, type LegColumn } from "../lib/navlog-columns"`), renames local uses (`COLUMNS` → `LEG_COLUMNS`, `Column` → `LegColumn`), and re-exports `VARIATION_SOURCE` if other files import it from `NavlogTable` (grep first: `grep -rn "VARIATION_SOURCE" examples/navlog/web/app`).

- [ ] **Step 4:** Run the new test and `NavlogTable.test.tsx` → PASS (the table's output must not change). Commit: `refactor(navlog-web): share the navlog columns between the table and the grid`.

---

### Task 3: `NavlogGrid`

**Files:** Create `examples/navlog/web/app/components/NavlogGrid.tsx` and `NavlogGrid.test.tsx`.

- [ ] **Step 1: Failing test** (`NavlogGrid.test.tsx`), stubbing pretable at its public API:

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, test, vi } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"

const grid = vi.hoisted(
  () =>
    ({}) as {
      props?: {
        ariaLabel: string
        columns: { id: string; header?: string; pinned?: string; sortable?: boolean; filterable?: boolean; align?: string }[]
        rows: { id: string }[]
        getRowId: (row: { id: string }) => string
        onSelectedRowIdChange?: (id: string | null) => void
        copyWithHeaders?: boolean
      }
    },
)
vi.mock("@pretable/react", () => ({
  Pretable: (props: NonNullable<typeof grid.props>) => {
    grid.props = props
    return <div data-testid="pretable" />
  },
}))

const { NavlogGrid } = await import("./NavlogGrid")

function mount(onSelectLeg = vi.fn()) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<NavlogGrid navlog={SAMPLE_NAVLOG} onSelectLeg={onSelectLeg} />))
  return { container, onSelectLeg, unmount: () => act(() => root.unmount()) }
}

describe("NavlogGrid", () => {
  test("Leg pinned left, then the figures, right-aligned; no sort or filter", () => {
    const view = mount()
    const columns = grid.props?.columns ?? []
    expect(columns[0]).toMatchObject({ id: "leg", header: "Leg", pinned: "left" })
    expect(columns.slice(1).every((c) => c.align === "right")).toBe(true)
    expect(columns.every((c) => c.sortable === false && c.filterable === false)).toBe(true)
    expect(grid.props?.ariaLabel).toBe("Navlog legs")
    expect(grid.props?.copyWithHeaders).toBe(true)
    view.unmount()
  })
  test("one row per leg, in route order", () => {
    const view = mount()
    expect(grid.props?.rows).toHaveLength(SAMPLE_NAVLOG.legs.length)
    expect(grid.props?.rows.map((r) => grid.props?.getRowId(r))).toEqual(
      SAMPLE_NAVLOG.legs.map((_, i) => `leg-${i}`),
    )
    view.unmount()
  })
  test("selecting a row reports its leg index; clearing reports null", () => {
    const view = mount()
    act(() => grid.props?.onSelectedRowIdChange?.("leg-1"))
    expect(view.onSelectLeg).toHaveBeenLastCalledWith(1)
    act(() => grid.props?.onSelectedRowIdChange?.(null))
    expect(view.onSelectLeg).toHaveBeenLastCalledWith(null)
    view.unmount()
  })
})
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement** `NavlogGrid.tsx`:

```tsx
"use client"
import { Pretable, type PretableColumn } from "@pretable/react"
import { useMemo } from "react"
import { LEG_COLUMNS, legName } from "../lib/navlog-columns"
import type { Navlog, NavlogLeg } from "../lib/navlog-types"

interface LegRow {
  readonly id: string
  readonly leg: NavlogLeg
}

const rowId = (index: number): string => `leg-${index}`
const indexOf = (id: string): number | null => {
  const match = /^leg-(\d+)$/.exec(id)
  return match ? Number(match[1]) : null
}

/** Leg pinned left, then the paper navlog's figures. Route order is the meaning, so no sort or filter. */
const COLUMNS: PretableColumn<LegRow>[] = [
  {
    id: "leg",
    header: "Leg",
    pinned: "left",
    flex: 1,
    minWidthPx: 150,
    sortable: false,
    filterable: false,
    reorderable: false,
    value: (row) => legName(row.leg),
  },
  ...LEG_COLUMNS.map(
    (column): PretableColumn<LegRow> => ({
      id: column.key,
      header: column.label,
      align: "right",
      sortable: false,
      filterable: false,
      value: (row) => column.value(row.leg),
    }),
  ),
]

export interface NavlogGridProps {
  readonly navlog: Navlog
  /** The selected leg (by index), or null when the selection clears: the map highlights it. */
  readonly onSelectLeg: (index: number | null) => void
}

/**
 * The navlog's legs in pretable: the desktop sheet's primary element. Scrolls
 * inside its own region; the print copy is `NavlogTable` (pretable virtualizes
 * rows, so it cannot print every leg).
 */
export function NavlogGrid({ navlog, onSelectLeg }: NavlogGridProps) {
  const rows = useMemo(
    () => navlog.legs.map((leg, index): LegRow => ({ id: rowId(index), leg })),
    [navlog],
  )
  return (
    <div className="wb-navlog-grid h-full min-h-0 print:hidden">
      <Pretable
        ariaLabel="Navlog legs"
        columns={COLUMNS}
        rows={rows}
        getRowId={(row) => row.id}
        copyWithHeaders
        onSelectedRowIdChange={(id) => onSelectLeg(id === null ? null : indexOf(id))}
      />
    </div>
  )
}
```

  If `Pretable` does not accept `onSelectedRowIdChange` (typecheck tells you), switch the import to `PretableSurface` with the same props and adjust the mock's export name. If `PretableColumn` rejects a field above, drop only that field and note it in the commit. Header tooltips: if `PretableColumn` has no title/description field, leave the abbreviations (the print table and phone cards keep their `title`s) and note the gap for an upstream pretable issue in your report; do not hand-roll header DOM.

- [ ] **Step 4:** Run → PASS; `typecheck` → green. Commit: `feat(navlog-web): NavlogGrid, the legs in pretable`.

---

### Task 4: `NavlogSheet`: verdict strip, tabs, totals strip, print copy

**Files:** Modify `examples/navlog/web/app/components/NavlogSheet.tsx`, `NavlogSheet.test.tsx`; `app/theme.css`.

- [ ] **Step 1: Props.** Add to `NavlogSheetProps` (replacing `onHoverLeg`):

```ts
  /** The selected tab (lifted so `openSheet` can pick Legs). */
  readonly tab: SheetTab
  readonly onTabChange: (tab: SheetTab) => void
  /** The selected leg reported by the grid (desktop), for the map highlight. */
  readonly onSelectLeg?: (index: number | null) => void
```

  and export `export type SheetTab = "legs" | "plan" | "brief"`.

- [ ] **Step 2: Tests first.** In `NavlogSheet.test.tsx` (mock `@pretable/react` exactly as in Task 3's test, so `NavlogGrid` renders a stub), update the render helper to pass `tab="legs"` and `onTabChange={() => {}}`, remove `onHoverLeg` uses, and add:

```tsx
describe("navlog sheet: strip and tabs", () => {
  test("a verdict strip region, then Legs · Totals & plan · Brief with Legs selected", () => {
    const html = render({ tab: "legs" })
    expect(html).toMatch(/aria-label="Go\/no-go verdict"/)
    expect(html).toContain('role="tablist"')
    expect(html).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>Legs</)
    expect(html).toContain(">Totals &amp; plan<")
    expect(html).toContain(">Brief<")
  })
  test("Legs: the grid, the totals strip, and a print-only table with every leg", () => {
    const html = render({ tab: "legs", variant: "table" })
    expect(html).toContain('data-testid="pretable"')
    expect(html).toMatch(/aria-label="Totals"[^>]*>/)
    expect(html).toContain("print:table")
    for (const leg of SAMPLE_NAVLOG.legs) expect(html).toContain(`${leg.from} → ${leg.to}`)
  })
  test("the reserve warning shows in the totals strip", () => {
    const short = { ...SAMPLE_NAVLOG, totals: { ...SAMPLE_NAVLOG.totals, reserveOk: false } }
    expect(render({ tab: "legs", navlog: short })).toContain("under 45 min")
  })
  test("phones keep the cards on Legs, with no grid", () => {
    const html = render({ tab: "legs", variant: "cards", collapsible: false })
    expect(html).not.toContain('data-testid="pretable"')
    expect(html).toContain("wb-leg-card")
  })
  test("inactive panels stay mounted but hidden, and print", () => {
    const html = render({ tab: "brief" })
    expect(html).toMatch(/role="tabpanel"[^>]*id="[^"]*-legs"[^>]*hidden/)
  })
  test("arrow keys move between tabs", () => {
    const onTabChange = vi.fn()
    const view = mountSheet({ tab: "legs", onTabChange })
    act(() => {
      view.container
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    })
    expect(onTabChange).toHaveBeenCalledWith("plan")
    view.unmount()
  })
})
```

  Adapt `render`/`mountSheet` to the file's existing helpers (add a jsdom `mountSheet` like other component tests if the file only uses `renderToStaticMarkup`; that requires `// @vitest-environment jsdom` at the top, which is fine for the whole file). Keep existing tests that still apply (collapsed header totals, Print, Copy FPL); delete only those asserting the removed layout (stat tiles above the table, the big card at the top of the open body).

- [ ] **Step 3:** Run → FAIL.

- [ ] **Step 4: Implement.** In `NavlogSheet.tsx`:
  - Import `NavlogGrid` and `type SheetTab` usage; keep `VerdictCard` and `VerdictPill`.
  - Header row: change the header wrapper to `wb-header-row … px-4` (keep its contents: the disclosure button with title/meta, Print, Copy FPL).
  - Below the header, when `shown`, render the verdict strip (only if `verdict`):

```tsx
        <section
          aria-label="Go/no-go verdict"
          className="wb-verdict-strip flex items-center gap-3 border-t border-wb-border px-4 py-2"
          data-level={verdict.level}
        >
          <VerdictPill verdict={verdict} />
          <button
            type="button"
            title={verdict.reason}
            onClick={() => onTabChange("brief")}
            className="wb-focus min-w-0 flex-1 truncate text-left text-[13px] text-wb-muted hover:text-wb-text"
          >
            {verdict.reason}
          </button>
        </section>
```

  - Tabs (when `shown`):

```tsx
const SHEET_TABS: readonly { readonly id: SheetTab; readonly label: string }[] = [
  { id: "legs", label: "Legs" },
  { id: "plan", label: "Totals & plan" },
  { id: "brief", label: "Brief" },
]
```

```tsx
        <div role="tablist" aria-label="Navlog views" className="flex gap-1 border-y border-wb-border px-2">
          {SHEET_TABS.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${bodyId}-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`${bodyId}-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => onTabChange(item.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
                const step = event.key === "ArrowRight" ? 1 : -1
                const next = SHEET_TABS[(i + step + SHEET_TABS.length) % SHEET_TABS.length]
                if (next) onTabChange(next.id)
              }}
              className="wb-focus wb-sheet-tab"
            >
              {item.label}
            </button>
          ))}
        </div>
```

    (After a keyboard change, move focus to the new tab: in the `onKeyDown`, also `requestAnimationFrame(() => document.getElementById(`${bodyId}-tab-${next.id}`)?.focus())`.)
  - Body: replace the current `wb-sheet-body` contents with three panels, all mounted; the inactive ones `hidden print:block`:

```tsx
        <div
          role="tabpanel"
          id={`${bodyId}-legs`}
          aria-labelledby={`${bodyId}-tab-legs`}
          hidden={tab !== "legs"}
          className="flex min-h-0 flex-1 flex-col print:!flex"
        >
          {variant === "table" ? (
            <div className="min-h-0 flex-1">
              <NavlogGrid navlog={navlog} onSelectLeg={onSelectLeg ?? (() => {})} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
              <NavlogTable navlog={navlog} variant="cards" />
            </div>
          )}
          <TotalsStrip navlog={navlog} />
          {/* Print copy: pretable virtualizes rows, so print reads this table. */}
          {variant === "table" ? (
            <div className="hidden print:block">
              <NavlogTable navlog={navlog} variant="table" />
            </div>
          ) : null}
        </div>
        <div role="tabpanel" id={`${bodyId}-plan`} aria-labelledby={`${bodyId}-tab-plan`} hidden={tab !== "plan"} className="min-h-0 flex-1 overflow-auto px-4 pb-4 print:!block">
          {/* the existing <dl className="wb-stats …" aria-label="Totals"> tiles, moved here unchanged */}
          <FlightPlanBlock plan={navlog.flightPlan} />
        </div>
        <div role="tabpanel" id={`${bodyId}-brief`} aria-labelledby={`${bodyId}-tab-brief`} hidden={tab !== "brief"} className="min-h-0 flex-1 overflow-auto px-4 pb-4 print:!block">
          {card ? <div className="pt-3">{card}</div> : null}
          {brief ? <PlanningBrief text={brief} verdict={verdict} /> : null}
        </div>
```

    The `hidden` attribute is used (not a class) so inactive panels leave the accessibility tree; `print:!block`/`print:!flex` override it for print. If Biome or the design-rules test objects to `!` utilities, use a `.wb-print-show` class in the print block instead (`[hidden].wb-print-show { display: block !important }` with the biome-ignore comment the file already uses).
    The `aria-label="Totals"` tiles keep their label; give the strip `aria-label="Leg totals"` instead so the two regions differ, and update the test's `aria-label="Totals"` matcher accordingly.
  - Add `TotalsStrip` in the same file:

```tsx
/** The Legs tab's fixed footer: the numbers that matter while the grid scrolls. */
function TotalsStrip({ navlog }: { readonly navlog: Navlog }) {
  const { totals } = navlog
  const items: readonly [string, string, boolean][] = [
    ["Distance", `${totals.distanceNm} nm`, false],
    ["ETE", formatHhmm(totals.eteMin), false],
    ["Fuel burned", `${formatGal(totals.fuelGal)} gal`, false],
    ["At landing", `${formatGal(totals.fuelRemainingGal)} gal`, false],
    ["Reserve", totals.reserveOk ? formatHhmm(totals.reserveMin) : `${formatHhmm(totals.reserveMin)} · under 45 min`, !totals.reserveOk],
  ]
  return (
    <dl aria-label="Leg totals" className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 border-t border-wb-border px-4 py-2.5">
      {items.map(([label, value, danger]) => (
        <div key={label} className="flex items-baseline gap-2">
          <dt className="text-[12px] text-wb-muted">{label}</dt>
          <dd className={`font-mono text-[13px] font-semibold tabular-nums ${danger ? "wb-text-danger" : ""}`}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
```

  - The section: when `collapsible` and `shown`, it must have a definite height so the Legs panel can fill it: change `max-h-[var(--wb-sheet-max)]` to `h-[var(--wb-sheet-max)]` while open (keep `max-h` behaviour when collapsed, where only the header shows).
  - Remove `onHoverLeg` from props and the `NavlogTable` call.

- [ ] **Step 5: CSS.** Add to `theme.css` near the other sheet rules:

```css
/* The sheet's tabs: 40px targets, ink underline on the selected one. */
.wb-sheet-tab {
  min-height: 40px;
  border-bottom: 2px solid transparent;
  padding: 0 10px;
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-muted);
}

.wb-sheet-tab[aria-selected="true"] {
  border-bottom-color: var(--wb-text);
  color: var(--wb-text);
}
```

  In the `@media print` block, add `.wb-sheet [role="tablist"], .wb-verdict-strip` to the `display: none !important` selector list (the print copy has its own verdict card in the Brief panel).

- [ ] **Step 6:** Run `NavlogSheet.test.tsx` → PASS; full suite (WorkbenchLayout may fail to typecheck until Task 5; the tests should still run). Commit `NavlogSheet.tsx`, `NavlogSheet.test.tsx`, `theme.css`: `feat(navlog-web): the sheet leads with the legs grid; verdict strip and tabs`.

---

### Task 5: `WorkbenchLayout` wiring

**Files:** Modify `examples/navlog/web/app/components/WorkbenchLayout.tsx`, `WorkbenchLayout.test.tsx`.

- [ ] **Step 1: Tests.** In `WorkbenchLayout.test.tsx` (mock `@pretable/react` as in Task 3 so the sheet renders), update the desktop sheet-control test:

```tsx
  test("on a desktop, a step's openSheet opens the sheet on the Legs tab", () => {
    viewport.desktop = true
    const view = mount()
    view.click('section[aria-label="Navlog"] [role="tab"]:nth-child(3)')
    view.click('section[aria-label="Navlog"] button[aria-expanded]')
    view.click("[data-open-sheet]")
    const toggle = view.container.querySelector('section[aria-label="Navlog"] button[aria-expanded]')
    expect(toggle?.getAttribute("aria-expanded")).toBe("true")
    expect(
      view.container.querySelector('section[aria-label="Navlog"] [role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("Legs")
    view.unmount()
  })
```

  and add a map-highlight test: capture the map stub's `highlightedLeg` prop (extend the `next/dynamic` mock to record `mapProps.highlightedLeg`), call the stubbed grid's `onSelectedRowIdChange("leg-0")`, and assert the recorded `highlightedLeg` equals `pairIndexOf(SAMPLE_NAVLOG, 0)` (import `pairIndexOf` from `../lib/route-geometry`).

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement.**
  - Replace `const [hoveredLeg, setHoveredLeg] = useState<number | null>(null)` with `const [selectedLeg, setSelectedLeg] = useState<number | null>(null)` and `const [sheetTab, setSheetTab] = useState<SheetTab>("legs")` (import `type SheetTab` from `./NavlogSheet`); `highlightedLeg` uses `selectedLeg`.
  - `openSheet`: desktop → `setSheetOpen(true); setSheetTab("legs")`; phone → `selectTab("navlog"); setSheetTab("legs")`.
  - Both `NavlogSheet` instances get `tab={sheetTab}` and `onTabChange={setSheetTab}`; the desktop one gets `onSelectLeg={setSelectedLeg}` (replacing `onHoverLeg`).
  - A new navlog (thread or replan) clears the selection: `useEffect(() => setSelectedLeg(null), [navlog])`.

- [ ] **Step 4:** `pnpm --filter @b4-example/navlog-web typecheck`, `lint`, `test` → all green. Commit: `feat(navlog-web): the selected leg lights the map; openSheet opens Legs`.

---

### Task 6: Harness and demo audit

- [ ] **Step 1:** Read `docs/brand/demo/capture.mjs` `assertWeatherVerdict` (region "Go/no-go verdict" + verdict word) and `assertNavlogSheet` (region "Navlog" + `${distanceNm} nm`), and grep `test/harness` and `test/generated` for "Navlog", "Totals", "nm", "Go/no-go". With Task 4's markup, the strip region carries the verdict pill's word, and the visible Legs totals strip shows `${distanceNm} nm`; both should still resolve to one visible element (`.first()` is used). If any assertion now targets markup that moved behind an inactive tab, update it to select that tab first (by `getByRole("tab", { name })`) and update the matching fake in `docs/brand/demo/demo.test.mjs`.
- [ ] **Step 2:** `pnpm test:brand-demo` and `npx vitest --run test/harness/workbench-` → PASS. Commit only if something changed: `test(demo): navlog assertions follow the sheet's tabs`.

---

### Task 7: Docs, template mirror, lastmod

- [ ] **Step 1:** In `examples/navlog/web/README.md` and `packages/devkit/templates/app-navlog/web/README.md`, rewrite the Navlog sheet bullet: the sheet leads with the legs grid (pretable, `NavlogGrid.tsx`; Leg pinned, selecting a row lights that leg on the map), a verdict strip above it, tabs for Legs / Totals & plan / Brief, a fixed totals strip under the grid; phones keep one card per leg; Print still prints every leg (a print-only table). Remove "Hovering or focusing a row highlights that leg on the map".
- [ ] **Step 2:** In `apps/web/content/docs/recipes/flight-planner-web-ui.mdx`, update any sentence describing the sheet's contents or the hover highlight the same way. `node scripts/check-docs.mjs` → exit 0. Commit the three docs: `docs(navlog-web): the navlog sheet on pretable`. Then `pnpm --dir apps/web seo:lastmod && pnpm --dir apps/web seo:lastmod:routes` (only the recipe route may change; skip if the `.mdx` did not change) and commit the manifest.
- [ ] **Step 3: Mirror.**

```bash
E=examples/navlog/web/app; T=packages/devkit/templates/app-navlog/web/app
(cd $E && find . -type f) | while read f; do case "$f" in *.test.ts|*.test.tsx) t="$T/$f.template";; *) t="$T/$f";; esac; cmp -s "$E/$f" "$t" || { mkdir -p "$(dirname "$t")"; cp "$E/$f" "$t"; echo "sync $f"; }; done
```

  In `packages/devkit/test/templates.test.ts`, the `.test.ts.template` count rises by one (`navlog-columns.test.ts`) and the `.test.tsx.template` count by one (`NavlogGrid.test.tsx`): update both literals. `pnpm --filter @b4run/devkit test` → PASS. Commit: `chore(devkit): mirror the navlog sheet on pretable into the scaffold template`.

---

### Task 8: Verify and ship

- [ ] **Step 1:** `pnpm install --frozen-lockfile` (proves the lockfile is consistent), then `pnpm build && pnpm lint && pnpm --filter @b4-example/navlog-web typecheck && pnpm --filter @b4-example/navlog-web test && pnpm --filter @b4run/devkit test && npx vitest --run test/harness/workbench- && pnpm test:brand-demo && pnpm --filter @b4run/web test && node scripts/check-docs.mjs && pnpm --filter @b4-example/navlog-web test:e2e`.
- [ ] **Step 2:** Stop dev servers; `pnpm verify:harness:framework` (the generated app installs `@pretable/*` from the template's `package.json`; an install failure here means the template dependency lines are wrong).
- [ ] **Step 3: Live check** (servers via `.claude/launch.json`) at 1440×900: open a thread with a navlog; the sheet opens on Legs; the grid fills the sheet and scrolls on its own; the window does not scroll (`document.documentElement.scrollHeight === innerHeight`); the totals strip stays fixed; Leg stays pinned when scrolling sideways; clicking a row lights the leg on the map, Escape clears it; the grid uses Hanken/JetBrains with no shadow; the tabs switch with arrow keys; the verdict strip's reason opens Brief; Print preview (emulate print media via `javascript_tool` is not possible — instead assert the print copy exists: `document.querySelectorAll('.wb-sheet table.wb-navlog-table tbody tr').length === legs`). Correct the Task 1 cell selector if the figures are not mono. At 375px: Navlog tab shows the strip, tabs and cards.
- [ ] **Step 4:** Re-fetch `main` (`git fetch origin && git log HEAD..origin/main --oneline`); if `pnpm-lock.yaml` changed on `main`, merge `origin/main` (do not rebase — shared worktree rule) and re-run `pnpm install --frozen-lockfile`. Push `blove/navlog-sheet-pretable`, open a PR to `main` titled `navlog-web: the navlog sheet leads with a pretable legs grid`, body summarising the change and verification, ending with the Claude Code attribution line. Bind it with the ccd_pr tools.
