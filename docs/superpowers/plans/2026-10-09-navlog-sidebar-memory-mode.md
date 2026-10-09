# Navlog Sidebar, Memory Mode and Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the navlog web sidebar collapse to a 64px icon rail, turn memory review into a sidebar-toggled mode that replaces the map column, and align the shell to one spacing/header/radius/icon system.

**Architecture:** A `useSidebarState` hook persists expanded/collapsed in `localStorage`; `SideNav` renders an expanded or a rail branch and a Memory toggle. `WorkbenchLayout` owns `memoryOpen` and renders the memory panel (a render prop from `AppShell`) over the right column (desktop) or as a fourth stacked panel (phone), keeping the map mounted beneath. Shared tokens (`--wb-header-h`, `--wb-radius-row`, `--wb-motion`) and an `icons.tsx` set carry the polish.

**Tech Stack:** Next.js 16, React 19 (`inert`), Tailwind 4, Leaflet, Vitest (jsdom + `renderToStaticMarkup`), Playwright harness, `docs/brand/demo/capture.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-09-navlog-sidebar-memory-mode-design.md`.

---

## Before you start

- Repo root `/Users/blove/repos/dawn/.claude/worktrees/b4-release-029b2a`, branch `blove/navlog-sidebar-memory-mode` (from `main` after #1008). Run every command from the root.
- Shared worktree: never `git checkout/switch/stash/reset/rebase/commit --amend`; stage by explicit path; never bare `biome check --write` (use `pnpm --filter @b4-example/navlog-web lint`, or scoped `pnpm --filter @b4-example/navlog-web exec biome check --write --config-path ../../../packages/config-biome/biome.json <files>`, then check `git diff --stat`). Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: `pnpm --filter @b4-example/navlog-web test|lint|typecheck`; one file: `pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts <path>`.
- `app/design-rules.test.ts` must stay green (no `uppercase`, positive letter-spacing, `gradient`, `shadow`, `backdrop`, dark scheme, other Google fonts).
- `exactOptionalPropertyTypes` is on: conditional spreads, never `{ x: undefined }`.
- Every `examples/navlog/web/app` file has a byte-identical twin in `packages/devkit/templates/app-navlog/web/app` (tests get `.template`). Task 11 mirrors.

## File map

| File | Change |
|---|---|
| `app/components/icons.tsx` | Create: one icon set. |
| `app/lib/use-sidebar-state.ts` (+ `.test.ts`) | Create: persisted expanded/collapsed. |
| `app/theme.css` | Tokens, header row, row radius, rail, tooltip, badge, quiet icon button, map corner, motion. |
| `app/components/SideNav.tsx` (+ test) | Expanded and rail branches; collapse toggle; Memory toggle. |
| `app/components/ThreadRail.tsx` | Row radius and 16px text inset. |
| `app/components/MemoryPanel.tsx` (+ test) | Full-height panel: header, uncapped list, empty state, close, heading focus. |
| `app/components/ChatDock.tsx` (+ test) | No memory slot; 56px header; 16px inset. |
| `app/components/WorkbenchLayout.tsx` (+ test) | Sidebar state; Memory mode on desktop and phone; icons. |
| `app/components/AppShell.tsx` | Memory as a render prop. |
| `app/components/memory-anchor.ts` | Delete. |
| `test/harness/workbench-suggestions.ts` (+ test), `docs/brand/demo/capture.mjs`, `docs/brand/demo/demo.test.mjs` | Open Memory before the candidate wait. |
| READMEs, recipe `.mdx`, lastmod | Docs. |

---

### Task 1: Icon set

**Files:** Create `examples/navlog/web/app/components/icons.tsx`.

- [ ] **Step 1: Create the file**

```tsx
/**
 * The workbench's one icon set: 24×24 viewBox, 2px stroke, round caps and
 * joins, drawn in `currentColor`. Decorative everywhere (`aria-hidden`): the
 * control that holds an icon carries the accessible name.
 */
const PATHS = {
  plus: "M12 5v14M5 12h14",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6 6 18",
  sidebar: "M4 5h16v14H4zM9 5v14",
  memory: "M6 4h12v16l-6-4-6 4z",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14",
  navlog: "M4 6h16M4 12h16M4 18h10",
} as const

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  className = "size-5",
}: {
  readonly name: IconName
  readonly className?: string
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
```

- [ ] **Step 2:** `pnpm --filter @b4-example/navlog-web typecheck` → exit 0. Commit: `feat(navlog-web): one icon set for the workbench`.

---

### Task 2: `useSidebarState`

**Files:** Create `examples/navlog/web/app/lib/use-sidebar-state.ts` and `use-sidebar-state.test.ts`.

- [ ] **Step 1: Failing test** (`use-sidebar-state.test.ts`):

```ts
// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test } from "vitest"
import { readSidebarState, SIDEBAR_STORAGE_KEY, useSidebarState } from "./use-sidebar-state"

afterEach(() => localStorage.clear())

describe("readSidebarState", () => {
  test("defaults to expanded", () => {
    expect(readSidebarState(localStorage)).toBe("expanded")
    expect(readSidebarState(undefined)).toBe("expanded")
  })
  test("reads collapsed, and ignores anything else", () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed")
    expect(readSidebarState(localStorage)).toBe("collapsed")
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "sideways")
    expect(readSidebarState(localStorage)).toBe("expanded")
  })
  test("a storage that throws reads as expanded", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked")
      },
    }
    expect(readSidebarState(throwing)).toBe("expanded")
  })
})

describe("useSidebarState", () => {
  function mount() {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const seen: { state?: string; toggle?: () => void } = {}
    function Probe() {
      const [state, toggle] = useSidebarState()
      seen.state = state
      seen.toggle = toggle
      return null
    }
    const container = document.createElement("div")
    const root = createRoot(container)
    act(() => root.render(createElement(Probe)))
    return { seen, unmount: () => act(() => root.unmount()) }
  }

  test("restores the stored state after mount", () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed")
    const view = mount()
    expect(view.seen.state).toBe("collapsed")
    view.unmount()
  })
  test("toggle flips the state and persists it", () => {
    const view = mount()
    expect(view.seen.state).toBe("expanded")
    act(() => view.seen.toggle?.())
    expect(view.seen.state).toBe("collapsed")
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("collapsed")
    act(() => view.seen.toggle?.())
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("expanded")
    view.unmount()
  })
})
```

- [ ] **Step 2:** Run it → FAIL (module not found).

- [ ] **Step 3: Implement** `use-sidebar-state.ts`:

```ts
"use client"
import { useCallback, useEffect, useState } from "react"

/** Where the desktop sidebar's expanded/collapsed choice lives, per browser. */
export const SIDEBAR_STORAGE_KEY = "b4.workbench.sidebar"

export type SidebarState = "expanded" | "collapsed"

/** The stored state; anything missing, unknown or unreadable is expanded. */
export function readSidebarState(
  storage: Pick<Storage, "getItem"> | undefined,
): SidebarState {
  try {
    return storage?.getItem(SIDEBAR_STORAGE_KEY) === "collapsed" ? "collapsed" : "expanded"
  } catch {
    return "expanded"
  }
}

/**
 * The sidebar's state and its toggle. Starts expanded and reads storage after
 * mount, so the server render and the first client render agree; a stored
 * "collapsed" applies one frame later.
 */
export function useSidebarState(): readonly [SidebarState, () => void] {
  const [state, setState] = useState<SidebarState>("expanded")
  useEffect(() => {
    setState(readSidebarState(globalThis.localStorage))
  }, [])
  const toggle = useCallback(() => {
    const next: SidebarState = state === "expanded" ? "collapsed" : "expanded"
    setState(next)
    try {
      globalThis.localStorage?.setItem(SIDEBAR_STORAGE_KEY, next)
    } catch {
      // Storage blocked (private mode, quota): the choice lasts this page only.
    }
  }, [state])
  return [state, toggle] as const
}
```

- [ ] **Step 4:** Run the test → PASS. Commit both files: `feat(navlog-web): persisted sidebar state`.

---

### Task 3: Theme tokens and shell CSS

**Files:** Modify `examples/navlog/web/app/theme.css`.

- [ ] **Step 1: Tokens.** In the layout-tokens `:root` block (the one with `--wb-nav-width`), add:

```css
  /* One header row height across the sidebar, the chat and the memory panel. */
  --wb-header-h: 56px;
  /* List rows (threads, memory candidates); controls are pills, panels 14px. */
  --wb-radius-row: 10px;
  /* The one motion token: every transition uses it. */
  --wb-motion: 200ms ease-out;
```

In `@theme inline` add `--radius-wb-row: var(--wb-radius-row);`.

- [ ] **Step 2: Shell rules.** Add after the `.wb-panel` rule:

```css
/* The 56px row every column starts with. */
.wb-header-row {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  height: var(--wb-header-h);
}

/* A list row: threads, memory candidates. */
.wb-row {
  border-radius: var(--wb-radius-row);
}

/* The sidebar column: 200px, or the 64px rail. */
.wb-root[data-sidebar] {
  transition: grid-template-columns var(--wb-motion);
}

.wb-root[data-sidebar="collapsed"] {
  --wb-nav-width: 64px;
}

/* A count on a control: mono, tabular, ink. */
.wb-badge {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--wb-text);
  color: var(--wb-surface);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* An icon button with no fill until hovered: the rail and panel headers. */
.wb-icon-button-quiet {
  border-color: transparent;
  background: transparent;
  color: var(--wb-muted);
}

.wb-icon-button-quiet:hover {
  background: var(--wb-rail);
  color: var(--wb-text);
}

/* A pressed toggle (Memory) reads as selected, like the current thread. */
.wb-icon-button[aria-pressed="true"] {
  border-color: transparent;
  background: var(--wb-rail);
  color: var(--wb-accent);
}

/* A label for an icon-only control, on hover and on keyboard focus. */
.wb-tip {
  position: relative;
}

.wb-tip[data-tip]::after {
  position: absolute;
  top: 50%;
  left: calc(100% + 8px);
  z-index: 50;
  transform: translateY(-50%);
  border-radius: 999px;
  background: var(--wb-text);
  padding: 4px 10px;
  color: var(--wb-surface);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
  content: attr(data-tip);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--wb-motion);
}

.wb-tip[data-tip]:hover::after,
.wb-tip[data-tip]:focus-visible::after {
  opacity: 1;
}
```

- [ ] **Step 3: Map corner.** Replace the `.wb-map .leaflet-bottom.leaflet-right` rule and the `.wb-map .leaflet-bottom.leaflet-right .leaflet-control` rule with:

```css
.wb-map .leaflet-bottom.leaflet-right {
  right: 0;
  bottom: 0;
}

/* One corner on the 16px inset, the two controls 8px apart. */
.wb-map .leaflet-bottom.leaflet-right .leaflet-control {
  margin: 0 16px 8px 0;
}

.wb-map .leaflet-bottom.leaflet-right .leaflet-control:last-child {
  margin-bottom: 16px;
}
```

(Keep the comment above it, which explains the attribution requirement.)

- [ ] **Step 4: Motion.** Change every remaining transition duration in `theme.css` that is a literal (`150ms`, `240ms`, `280ms`, `120ms`) to `var(--wb-motion)` (for multi-property transitions, use it for each property). In the `@media (prefers-reduced-motion: reduce)` block add `.wb-root[data-sidebar]` and `.wb-tip[data-tip]::after` to the `transition: none` selector list.

- [ ] **Step 5:** `pnpm --filter @b4-example/navlog-web lint` and `test` (design rules) → green. Commit: `feat(navlog-web): header row, row radius, rail, tooltip and motion tokens`.

---

### Task 4: `SideNav` with the rail and the Memory toggle

**Files:** Modify `examples/navlog/web/app/components/SideNav.tsx`, replace `SideNav.test.tsx`.

- [ ] **Step 1: Replace the test** `SideNav.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { SideNav, type SideNavProps } from "./SideNav"

const props = (overrides: Partial<SideNavProps> = {}): SideNavProps => ({
  brand: "heading",
  rail: (
    <ul>
      <li>
        <button type="button">KSTP to KRST</button>
      </li>
    </ul>
  ),
  memoryCount: 0,
  memoryOpen: false,
  onNewConversation: () => {},
  onToggleMemory: () => {},
  ...overrides,
})

const collapse = (collapsed: boolean, onToggle = () => {}) => ({
  collapsed,
  onToggle,
  controls: "wb-sidenav",
})

describe("SideNav expanded", () => {
  test("the top row holds the wordmark h1 and the collapse toggle", () => {
    const html = renderToStaticMarkup(<SideNav {...props({ collapse: collapse(false) })} />)
    expect(html).toMatch(/<h1[^>]*><span class="wb-wordmark">/)
    expect(html).toMatch(
      /<button[^>]*aria-label="Collapse sidebar"[^>]*aria-expanded="true"[^>]*aria-controls="wb-sidenav"/,
    )
    expect(html).toContain("wb-header-row")
  })
  test("the drawer copy has no collapse toggle and no h1", () => {
    const html = renderToStaticMarkup(<SideNav {...props({ brand: "label" })} />)
    expect(html).not.toContain("Collapse sidebar")
    expect(html).not.toContain("<h1")
  })
  test("New plan, then the threads, then Memory", () => {
    const html = renderToStaticMarkup(<SideNav {...props()} />)
    expect(html.indexOf("New plan")).toBeLessThan(html.indexOf("KSTP to KRST"))
    expect(html.indexOf("KSTP to KRST")).toBeLessThan(html.indexOf(">Memory<"))
  })
  test("Memory is a toggle; disabled only at zero with the mode off", () => {
    const off = renderToStaticMarkup(<SideNav {...props()} />)
    expect(off).toMatch(/<button[^>]*aria-pressed="false"[^>]*disabled=""/)
    const open = renderToStaticMarkup(<SideNav {...props({ memoryOpen: true })} />)
    expect(open).toMatch(/<button[^>]*aria-pressed="true"/)
    expect(open).not.toMatch(/aria-pressed="true"[^>]*disabled=""/)
    const counted = renderToStaticMarkup(<SideNav {...props({ memoryCount: 3 })} />)
    expect(counted).toContain('class="wb-badge"')
    expect(counted).toContain("waiting for review")
  })
})

describe("SideNav collapsed (the rail)", () => {
  test("icon buttons with labels and tooltips; no thread list; wordmark kept for screen readers", () => {
    const html = renderToStaticMarkup(
      <SideNav {...props({ memoryCount: 2, collapse: collapse(true) })} />,
    )
    expect(html).not.toContain("KSTP to KRST")
    expect(html).toMatch(/<h1 class="sr-only">/)
    expect(html).toMatch(/aria-label="Expand sidebar"[^>]*aria-expanded="false"/)
    expect(html).toMatch(/aria-label="New plan"[^>]*data-tip="New plan"/)
    expect(html).toMatch(/aria-label="Memory"[^>]*data-tip="Memory"/)
    expect(html).toContain('class="wb-badge')
  })
})

describe("SideNav behaviour", () => {
  test("toggles and navigation callbacks fire", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const onToggle = vi.fn()
    const onToggleMemory = vi.fn()
    const onNavigate = vi.fn()
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    act(() =>
      root.render(
        <SideNav
          {...props({ memoryCount: 1, onToggleMemory, onNavigate, collapse: collapse(false, onToggle) })}
        />,
      ),
    )
    act(() => (container.querySelector('[aria-label="Collapse sidebar"]') as HTMLElement).click())
    expect(onToggle).toHaveBeenCalledTimes(1)
    act(() => (container.querySelector("[aria-pressed]") as HTMLElement).click())
    expect(onToggleMemory).toHaveBeenCalledTimes(1)
    act(() => (container.querySelector("li button") as HTMLElement).click())
    expect(onNavigate).toHaveBeenCalled()
    act(() => root.unmount())
  })
})
```

- [ ] **Step 2:** Run it → FAIL.

- [ ] **Step 3: Replace `SideNav.tsx`:**

```tsx
"use client"
import type { MouseEvent, ReactNode, Ref } from "react"
import { useHydrated } from "../lib/use-hydrated"
import { Icon } from "./icons"
import { primaryButton } from "./ui"
import { Wordmark } from "./Wordmark"

export interface SideNavCollapse {
  readonly collapsed: boolean
  readonly onToggle: () => void
  /** The sidebar's id, for the toggle's `aria-controls`. */
  readonly controls: string
}

export interface SideNavProps {
  /**
   * `heading`: the wordmark is the page's one h1 (desktop). `label`: plain
   * text, because on a phone the top row holds the h1 and this sits in the
   * drawer.
   */
  readonly brand: "heading" | "label"
  /** The thread list: `ThreadRail` with `showCreate={false}`. */
  readonly rail: ReactNode
  /** Memory candidates waiting for review (`MemoryPanel`'s `onCountChange`). */
  readonly memoryCount: number
  /** Whether Memory mode is on: the Memory item is a pressed toggle. */
  readonly memoryOpen: boolean
  readonly onNewConversation: () => void
  readonly onToggleMemory: () => void
  /** Called after any button inside is clicked: the phone's drawer closes on it. */
  readonly onNavigate?: () => void
  /** Desktop only: the collapse toggle and the 64px rail. The drawer has none. */
  readonly collapse?: SideNavCollapse
  readonly id?: string
  /** Where focus returns when Memory mode closes. */
  readonly memoryButtonRef?: Ref<HTMLButtonElement>
  readonly className?: string
}

/**
 * The left sidebar: the wordmark, New plan, the recent threads and Memory.
 * The desktop's first column (expanded, or collapsed to an icon rail) and the
 * phone's drawer (always expanded).
 *
 * Memory is a toggle for Memory mode, which replaces the map column with the
 * full candidate review. It is disabled only when nothing is waiting and the
 * mode is off, so the mode can always be left from here.
 *
 * "New plan" is disabled until hydration: it is in the server render, and a
 * click before its handler exists would be dropped.
 */
export function SideNav({
  brand,
  rail,
  memoryCount,
  memoryOpen,
  onNewConversation,
  onToggleMemory,
  onNavigate,
  collapse,
  id,
  memoryButtonRef,
  className = "",
}: SideNavProps) {
  const hydrated = useHydrated()
  const collapsed = collapse?.collapsed === true
  const memoryDisabled = memoryCount === 0 && !memoryOpen
  const onClick = (event: MouseEvent<HTMLElement>): void => {
    if (onNavigate === undefined) return
    if ((event.target as Element).closest("button") !== null) onNavigate()
  }
  const badge =
    memoryCount > 0 ? (
      <span className={`wb-badge${collapsed ? " absolute -right-1 -top-1" : ""}`}>
        {memoryCount}
        <span className="sr-only"> waiting for review</span>
      </span>
    ) : null
  const wordmark =
    brand === "heading" ? (
      <h1 className={collapsed ? "sr-only" : "min-w-0 truncate text-[15px]"}>
        <Wordmark />
      </h1>
    ) : (
      <p className="min-w-0 truncate text-[15px]">
        <Wordmark />
      </p>
    )
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar"
  const toggle = collapse ? (
    <button
      type="button"
      aria-label={toggleLabel}
      aria-expanded={!collapsed}
      aria-controls={collapse.controls}
      {...(collapsed ? { "data-tip": toggleLabel } : {})}
      onClick={collapse.onToggle}
      className="wb-focus wb-icon-button wb-icon-button-quiet wb-tip"
    >
      <Icon name="sidebar" />
    </button>
  ) : null

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegation only; every target inside is a real button with its own keyboard handling
    <aside
      {...(id === undefined ? {} : { id })}
      aria-label="Navigation"
      onClick={onClick}
      className={`wb-panel flex min-h-0 flex-col ${className}`}
    >
      {collapsed ? (
        <>
          <div className="wb-header-row justify-center">
            {wordmark}
            {toggle}
          </div>
          <div className="flex flex-col items-center gap-3 pt-1">
            <button
              type="button"
              aria-label="New plan"
              data-tip="New plan"
              disabled={!hydrated}
              onClick={onNewConversation}
              className="wb-focus wb-icon-button wb-icon-button-primary wb-tip"
            >
              <Icon name="plus" />
            </button>
          </div>
          <div className="flex-1" />
          <div className="flex justify-center pb-3">
            <button
              ref={memoryButtonRef}
              type="button"
              aria-label="Memory"
              data-tip="Memory"
              aria-pressed={memoryOpen}
              disabled={memoryDisabled}
              onClick={onToggleMemory}
              className="wb-focus wb-icon-button wb-icon-button-quiet wb-tip disabled:opacity-60"
            >
              <Icon name="memory" />
              {badge}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="wb-header-row justify-between gap-2 pl-4 pr-2">
            {wordmark}
            {toggle}
          </div>
          <div className="px-2 pt-1">
            <button
              type="button"
              disabled={!hydrated}
              onClick={onNewConversation}
              className={`${primaryButton("md")} inline-flex w-full items-center justify-center gap-1.5 disabled:opacity-60`}
            >
              <Icon name="plus" className="size-4" />
              New plan
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col pt-3">{rail}</div>
          <div className="px-2 pb-2">
            <button
              ref={memoryButtonRef}
              type="button"
              aria-pressed={memoryOpen}
              disabled={memoryDisabled}
              onClick={onToggleMemory}
              className="wb-focus wb-row flex w-full items-center justify-between gap-2 px-2 py-2 text-left text-[13px] font-medium text-wb-muted transition-colors hover:bg-wb-rail hover:text-wb-text aria-pressed:bg-wb-rail aria-pressed:text-wb-accent disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-wb-muted pointer-coarse:py-3"
            >
              <span className="flex items-center gap-2">
                <Icon name="memory" className="size-4" />
                <span>Memory</span>
              </span>
              {badge}
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
```

Note: the test's `>Memory<` matcher finds the inner `<span>Memory</span>`. In the expanded branch the Memory button's accessible name is "Memory" plus the badge text (e.g. "Memory 3 waiting for review"); the harness matches it with `/^Memory/`.

- [ ] **Step 4:** Run `SideNav.test.tsx` → PASS (adjust only regex attribute-order details if needed, keeping every asserted fact). `WorkbenchLayout.tsx` will not typecheck until Task 8; do not fix it here. Commit `SideNav.tsx`, `SideNav.test.tsx`: `feat(navlog-web): collapsible sidebar rail and a Memory toggle`.

---

### Task 5: `ThreadRail` alignment

**Files:** Modify `examples/navlog/web/app/components/ThreadRail.tsx`.

- [ ] **Step 1:** `ROW_BASE`: replace `rounded-wb px-2.5` with `wb-row px-2`. The `<ul>` keeps `px-2` (row fill at 8px, row text at 16px from the panel edge). The "Recent" `<p>` keeps `px-4` (text at 16px). Change the `<p>`'s `pt-1` branch to `pt-0` (SideNav now provides the 12px group gap).
- [ ] **Step 2:** Run `ThreadRail.test.tsx` → PASS (update a class-string assertion only if one pins `rounded-wb`). Commit: `style(navlog-web): thread rows on the row radius and the 16px inset`.

---

### Task 6: `MemoryPanel` as a full panel

**Files:** Modify `examples/navlog/web/app/components/MemoryPanel.tsx` and `MemoryPanel.test.tsx`.

- [ ] **Step 1: Update tests first.** In `MemoryPanel.test.tsx`:
  - Delete tests that assert the view renders `null` when empty, the `MAX_VISIBLE` cap / "more not shown" line, the `<details>`/`<summary>` disclosure, and the `MEMORY_PANEL_ID` anchor test (and its import).
  - Add (using the file's existing `render` helper / `CANDIDATE` fixture, adapted to the new props):

```tsx
describe("memory panel (Memory mode)", () => {
  const view = (overrides: Partial<MemoryPanelViewProps> = {}) =>
    renderToStaticMarkup(
      <MemoryPanelView
        candidates={[]}
        onApprove={() => {}}
        onReject={() => {}}
        isBusy={false}
        outcome={null}
        loadFailure={null}
        {...overrides}
      />,
    )
  const candidate = (id: string) => ({ id, content: `Fact ${id}`, namespace: "pilot", tags: ["aircraft"] })

  test("always renders the region with a 56px header, even when empty", () => {
    const html = view()
    expect(html).toContain('aria-label="Memory candidates"')
    expect(html).toContain("wb-header-row")
    expect(html).toContain("Nothing waiting for review.")
  })
  test("lists every candidate, with namespace and tags as metadata", () => {
    const html = view({ candidates: ["a", "b", "c", "d", "e"].map(candidate) })
    for (const id of ["a", "b", "c", "d", "e"]) expect(html).toContain(`Fact ${id}`)
    expect(html).toContain("pilot · aircraft")
    expect(html).not.toContain("more not shown")
  })
  test("the close button appears only with onClose", () => {
    expect(view()).not.toContain('aria-label="Close memory"')
    expect(view({ onClose: () => {} })).toContain('aria-label="Close memory"')
  })
  test("the count sits in the heading", () => {
    expect(view({ candidates: [candidate("a"), candidate("b")] })).toMatch(/<h2[^>]*>Memory<span[^>]*>· 2<\/span>/)
  })
})
```

  Add `type MemoryPanelViewProps` to the import from `./MemoryPanel` if not already imported. Keep the existing tests for approve/reject accessible names, `isBusy` disabling, outcome/failure text and the container's fetch behaviour, updating them only where they relied on the removed cap/disclosure.

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement.** In `MemoryPanel.tsx`:
  - Remove the `MEMORY_PANEL_ID` import, the `MAX_VISIBLE` constant and its comment.
  - Add imports: `import { type Ref, useCallback, useEffect, useRef, useState } from "react"` (merge with the existing react import), `import { Icon } from "./icons"`, and `primaryButton` alongside `neutralButton` from `./ui`.
  - Add to `MemoryPanelViewProps`:

```ts
  /** Shown as the header's close button (Memory mode). */
  readonly onClose?: () => void
  /** The heading, focused when Memory mode opens. */
  readonly headingRef?: Ref<HTMLHeadingElement>
```

  - Replace the body of `MemoryPanelView` (everything from the "Empty is the NORMAL state" comment to the end of the function) with:

```tsx
  return (
    <section
      aria-label="Memory candidates"
      aria-busy={isBusy}
      className="wb-panel flex h-full min-h-0 flex-col"
    >
      <header className="wb-header-row gap-2 border-b border-wb-border pl-4 pr-2">
        {/* Focused on open (tabIndex -1: a target, not a tab stop). */}
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 flex-1 text-[14px] font-semibold leading-5 tracking-tight focus:outline-none"
        >
          Memory<span className="ml-1.5 font-mono font-normal text-wb-muted">· {candidates.length}</span>
        </h2>
        {onClose ? (
          <button
            type="button"
            aria-label="Close memory"
            onClick={onClose}
            className="wb-focus wb-icon-button wb-icon-button-quiet"
          >
            <Icon name="close" />
          </button>
        ) : null}
      </header>
      {/*
        A live region that is always present, with its text swapped: screen
        readers announce a change to a region already in the tree far more
        reliably than an inserted one. Polite (`role="status"`): it must not
        interrupt.
      */}
      <p role="status" className="px-4 pt-3 text-[12px] leading-4 text-wb-muted">
        {outcome ??
          loadFailure ??
          (isBusy ? "Saving…" : "Approving stores the memory. Deleting is permanent.")}
      </p>
      {candidates.length === 0 ? (
        <div className="px-4 pt-6">
          <p className="text-[13px] font-medium">Nothing waiting for review.</p>
          <p className="mt-1 text-[12px] leading-5 text-wb-muted">
            When the planner proposes something to remember, it appears here for you to approve
            or delete.
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-3">
          {candidates.map((candidate) => (
            <li
              key={candidate.id}
              className="wb-row flex items-start gap-3 border border-wb-border bg-wb-surface px-2 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-[13px] leading-5">{candidate.content}</p>
                <p className="mt-0.5 truncate font-mono text-[12px] text-wb-muted">
                  {[candidate.namespace, ...(candidate.tags ?? [])].join(" · ")}
                  {typeof candidate.confidence === "number"
                    ? ` · confidence ${candidate.confidence}`
                    : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {/*
                  `aria-label` carries which candidate a button acts on: rows
                  of identical "Approve" buttons are otherwise
                  indistinguishable to anyone navigating by control.
                */}
                <button
                  type="button"
                  disabled={isBusy}
                  aria-label={`Approve: ${shortLabel(candidate.content)}`}
                  onClick={() => onApprove(candidate.id)}
                  className={`${primaryButton("sm")} disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-4`}
                >
                  Approve
                </button>
                {/*
                  "Delete", not "Reject": the endpoint is `…/reject`, but it
                  hard-deletes the candidate. Naming the button after the
                  effect is the warning.
                */}
                <button
                  type="button"
                  disabled={isBusy}
                  aria-label={`Delete permanently: ${shortLabel(candidate.content)}`}
                  onClick={() => onReject(candidate.id)}
                  className={`${neutralButton("sm")} disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-4`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
```

  Destructure `onClose` and `headingRef` in `MemoryPanelView`'s parameters (pass them through with conditional spreads where needed for `exactOptionalPropertyTypes`). Update the `MemoryPanelView` doc comment: "(empty, populated, busy, failed)".

  - Change the container signature and add focus:

```tsx
export interface MemoryPanelProps {
  /** Told the number of waiting candidates whenever it changes (the sidebar's count). */
  readonly onCountChange?: (count: number) => void
  /** Whether Memory mode is showing this panel. Opening focuses the heading. */
  readonly open?: boolean
  /** Closes Memory mode (the header's close button). */
  readonly onClose?: () => void
}

export function MemoryPanel({ onCountChange, open = false, onClose }: MemoryPanelProps = {}) {
```

  and inside it, after the existing hooks:

```tsx
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (open) heading.current?.focus()
  }, [open])
```

  and pass `headingRef={heading}` and `{...(onClose ? { onClose } : {})}` to `<MemoryPanelView>`.

- [ ] **Step 4:** Run `MemoryPanel.test.tsx` → PASS. Commit: `feat(navlog-web): the memory panel as a full-height Memory mode panel`.

---

### Task 7: `ChatDock` without the memory slot

**Files:** Modify `examples/navlog/web/app/components/ChatDock.tsx`, `ChatDock.test.tsx`.

- [ ] **Step 1: Tests.** In `ChatDock.test.tsx` remove `memory={<p>memory</p>}` from `render`, delete the `<p>memory</p>` ordering assertion from the slots test (keep banner → notices → main ordering), and add:

```tsx
  test("the header is the shared 56px row", () => {
    expect(render("Plan")).toMatch(/<header class="wb-header-row[^"]*"/)
  })
```

- [ ] **Step 2: Implement.** In `ChatDock.tsx`: remove `memory` from `ChatDockProps` and the component's parameters; delete the `<div className="max-h-[30%] …">{memory}</div>` block; change the header to `<header className="wb-header-row gap-2 border-b border-wb-border px-4">` (drop `flex shrink-0 items-center … px-3 py-2.5`); change the banner wrapper to `px-4 pt-2`. Rewrite the doc comment's memory paragraph to: "Memory review is a mode (`MemoryPanel`, opened from the sidebar), not part of this column."

- [ ] **Step 3:** Run `ChatDock.test.tsx` → PASS. Commit: `refactor(navlog-web): the chat column drops the inline memory panel`.

---

### Task 8: `WorkbenchLayout`: sidebar state and Memory mode

**Files:** Modify `examples/navlog/web/app/components/WorkbenchLayout.tsx`, `WorkbenchLayout.test.tsx`, `AppShell.tsx`; delete `memory-anchor.ts`.

- [ ] **Step 1: Tests.** In `WorkbenchLayout.test.tsx`:
  - Change the props factory's `memory: <p>memory</p>` to `memory: ({ open }) => <p data-memory-open={String(open)}>memory</p>`, and add `memoryCount: 0` if absent.
  - Replace the test "the memory panel stays above the conversation; the sidenav counts it" with tests below. Mock `../lib/use-sidebar-state` like `use-media-query`:

```tsx
const sidebar = vi.hoisted(() => ({ state: "expanded" as "expanded" | "collapsed", toggle: vi.fn() }))
vi.mock("../lib/use-sidebar-state", () => ({
  useSidebarState: () => [sidebar.state, sidebar.toggle] as const,
}))
```

```tsx
describe("WorkbenchLayout sidebar and Memory mode (desktop)", () => {
  beforeEach(() => {
    viewport.desktop = true
    sidebar.state = "expanded"
  })
  test("the root carries the sidebar state for the grid", () => {
    expect(renderToStaticMarkup(<WorkbenchLayout {...props()} />)).toContain('data-sidebar="expanded"')
    sidebar.state = "collapsed"
    expect(renderToStaticMarkup(<WorkbenchLayout {...props()} />)).toContain('data-sidebar="collapsed"')
  })
  test("the chat column has no memory panel", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    const chat = html.slice(html.indexOf('aria-label="Chat"'), html.indexOf("</section>", html.indexOf('aria-label="Chat"')))
    expect(chat).not.toContain("memory")
  })
  test("Memory swaps the right column; the map stays mounted, invisible and inert", () => {
    const view = mount({ memoryCount: 2 })
    const mapColumn = () => view.container.querySelector("[data-map-column]")
    const memoryColumn = () => view.container.querySelector("[data-memory-column]")
    expect(mapColumn()?.hasAttribute("inert")).toBe(false)
    expect(memoryColumn()?.className).toContain("invisible")
    view.click('aside [aria-pressed="false"]')
    expect(mapColumn()?.className).toContain("invisible")
    expect(mapColumn()?.hasAttribute("inert")).toBe(true)
    expect(view.container.querySelector('[data-testid="map"]')).not.toBeNull()
    expect(memoryColumn()?.className).not.toContain("invisible")
    expect(view.container.querySelector("[data-memory-open]")?.getAttribute("data-memory-open")).toBe("true")
    view.unmount()
  })
  test("Escape inside the memory column leaves the mode", () => {
    const view = mount({ memoryCount: 1 })
    view.click('aside [aria-pressed="false"]')
    act(() => {
      view.container
        .querySelector("[data-memory-column]")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(view.container.querySelector('aside [aria-pressed="true"]')).toBeNull()
    view.unmount()
  })
  test("New plan leaves the mode", () => {
    const view = mount({ memoryCount: 1 })
    view.click('aside [aria-pressed="false"]')
    const newPlan = [...view.container.querySelectorAll("aside button")].find((b) =>
      b.textContent?.includes("New plan"),
    ) as HTMLElement
    act(() => newPlan.click())
    expect(view.container.querySelector('aside [aria-pressed="true"]')).toBeNull()
    view.unmount()
  })
})

describe("WorkbenchLayout Memory mode (phone)", () => {
  beforeEach(() => {
    viewport.desktop = false
  })
  test("Memory from the drawer shows the memory panel and deselects every tab; a tab leaves it", () => {
    const view = mount({ memoryCount: 1 })
    view.click('button[aria-label="Open navigation"]')
    view.click('[role="dialog"] [aria-pressed="false"]')
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    for (const id of ["chat", "map", "navlog"]) {
      expect(view.container.querySelector(`#wb-tab-${id}`)?.getAttribute("aria-selected")).toBe("false")
    }
    expect(view.container.querySelector("[data-memory-column]")?.className).not.toContain("invisible")
    view.click("#wb-tab-chat")
    expect(view.container.querySelector("#wb-tab-chat")?.getAttribute("aria-selected")).toBe("true")
    expect(view.container.querySelector("[data-memory-column]")?.className).toContain("invisible")
    view.unmount()
  })
})
```

  (`mount`, `click` and the `act` import already exist in this file; reuse them. If the Tab-wrap drawer test from #1008 relied on the old SideNav's button order, keep its intent and update selectors.)

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement** in `WorkbenchLayout.tsx`:
  - Imports: remove `revealMemoryPanel`; add `import { useSidebarState } from "../lib/use-sidebar-state"` and `import { Icon, type IconName } from "./icons"`. Delete the local `Icon` function; change `PHONE_TABS` entries' `icon` strings to `icon: "chat" | "map" | "navlog"` typed as `IconName`, and render `<Icon name={item.icon} />`. The phone header's menu and plus icons become `<Icon name="menu" />` and `<Icon name="plus" />`.
  - Props: export

```ts
export interface MemoryControls {
  /** Whether Memory mode is showing the panel. */
  readonly open: boolean
  readonly onClose: () => void
}
```

    and change `readonly memory: ReactNode` to `readonly memory: (controls: MemoryControls) => ReactNode`.
  - State, after `drawerOpen`:

```tsx
  const [memoryOpen, setMemoryOpen] = useState(false)
  const memoryButton = useRef<HTMLButtonElement>(null)
  const [sidebar, toggleSidebar] = useSidebarState()
  const sidenavId = useId()
```

  - Replace `showMemory` with:

```tsx
  const closeMemory = useCallback(() => {
    setMemoryOpen(false)
    // Back to the control that opened it (the drawer's copy is gone on a phone).
    requestAnimationFrame(() => memoryButton.current?.focus())
  }, [])

  const toggleMemory = useCallback(() => {
    if (memoryOpen) {
      closeMemory()
      return
    }
    setDrawerOpen(false)
    setMemoryOpen(true)
  }, [memoryOpen, closeMemory])

  const newConversation = useCallback(() => {
    setMemoryOpen(false)
    onNewConversation()
  }, [onNewConversation])

  // Escape anywhere inside the memory column leaves the mode.
  const onMemoryKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && memoryOpen) closeMemory()
  }
```

    (import `type KeyboardEvent` from react). Thread switches need nothing: `AppShell` keys the workbench by thread, so a switch remounts the layout with `memoryOpen` false.
  - The approval effect becomes:

```tsx
  useEffect(() => {
    if (!awaitingApproval) return
    setTab("chat")
    // On a phone the chat is hidden while Memory mode shows; the card must be seen.
    if (!isDesktop) setMemoryOpen(false)
  }, [awaitingApproval, isDesktop])
```

  - `selectTab` also calls `setMemoryOpen(false)`.
  - The memory node: `const memoryPanel = memory({ open: memoryOpen, onClose: closeMemory })`.
  - Pass `chat` without `memory` to `ChatDock`.
  - Desktop return: the root div gets `data-sidebar={sidebar}`. The `SideNav` becomes:

```tsx
          <SideNav
            id={sidenavId}
            brand="heading"
            rail={rail}
            memoryCount={memoryCount}
            memoryOpen={memoryOpen}
            memoryButtonRef={memoryButton}
            onNewConversation={newConversation}
            onToggleMemory={toggleMemory}
            collapse={{
              collapsed: sidebar === "collapsed",
              onToggle: toggleSidebar,
              controls: sidenavId,
            }}
            className="wb-print-hide"
          />
```

    and the right column (replacing the current `<div className="flex min-h-0 min-w-0 flex-col gap-…">…</div>`):

```tsx
          <div className="relative min-h-0 min-w-0">
            <div
              data-map-column=""
              inert={memoryOpen}
              className={`flex h-full min-h-0 flex-col gap-[var(--wb-gutter)] ${memoryOpen ? "invisible" : ""}`}
            >
              {/* …the existing map panel and navlog sheet, unchanged except the strip inset below… */}
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape is handled for the whole column; its controls are real buttons */}
            <div
              data-memory-column=""
              inert={!memoryOpen}
              onKeyDown={onMemoryKeyDown}
              className={`absolute inset-0 print:hidden ${memoryOpen ? "" : "invisible"}`}
            >
              {memoryPanel}
            </div>
          </div>
```

    In the map panel, the strip wrapper's `inset-x-3 top-3` becomes `inset-x-4 top-4` (16px).
  - Phone return: add a fourth stacked panel after the navlog panel:

```tsx
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape is handled for the whole panel; its controls are real buttons */}
          <div
            data-memory-column=""
            inert={!memoryOpen}
            onKeyDown={onMemoryKeyDown}
            className={`${PANEL_BOX} print:hidden ${memoryOpen ? "" : "invisible"}`}
          >
            {memoryPanel}
          </div>
```

    Each of the three existing panels uses `const visible = !memoryOpen && activeTab === "<id>"` for its `inert` and `invisible`. Each tab's `aria-selected` becomes `!memoryOpen && activeTab === item.id`. The phone header's New plan button calls `newConversation`. The phone strip wrapper `inset-x-2 top-2` becomes `inset-x-4 top-4`. The drawer's `SideNav` gets `memoryOpen={memoryOpen}`, `onToggleMemory={toggleMemory}`, `onNewConversation={newConversation}` and no `collapse`; it does not receive `memoryButtonRef` (the desktop copy owns it).
  - Update the component's doc comment to mention the collapsible sidebar and Memory mode replacing the right column.

- [ ] **Step 4: `AppShell.tsx`.** Change `memory={<MemoryPanel onCountChange={setMemoryCount} />}` to:

```tsx
        memory={(controls) => <MemoryPanel onCountChange={setMemoryCount} {...controls} />}
```

  and `ThreadWorkbenchProps.memory` to `(controls: MemoryControls) => ReactNode` (import `type MemoryControls` from `./WorkbenchLayout`).

- [ ] **Step 5:** `git rm examples/navlog/web/app/components/memory-anchor.ts`; confirm `grep -rn "memory-anchor\|revealMemoryPanel\|MEMORY_PANEL_ID" examples/navlog/web/app` is empty.

- [ ] **Step 6:** Run `pnpm --filter @b4-example/navlog-web typecheck`, `lint`, `test` → all green. Commit: `feat(navlog-web): Memory mode replaces the map column; the sidebar collapses to a rail`.

---

### Task 9: Composer and transcript alignment (live measurement)

**Files:** Modify `examples/navlog/web/app/theme.css` only if a measurement is off.

- [ ] **Step 1:** Start the servers (`.claude/launch.json`: `navlog-server`, `navlog-web`), open http://localhost:3010 in the browser pane, `resize_window` 1440×900, open a thread with a transcript, and measure with `javascript_tool`, relative to `section[aria-label="Chat"]`'s left edge: the h2's text left, the first assistant paragraph's left, and the composer box's left (the element wrapping the `textarea` that carries the visible border). Target: all three at 16px (±1 for the border).
- [ ] **Step 2:** If the transcript or composer is off, add one scoped rule under the `.wb-dock [data-copilotkit]` comment in `theme.css` that sets the offending CopilotKit container's horizontal padding so its content lands at 16px. Identify the container by inspecting the DOM (`data-slot` or class) and target that exact selector; do not use `!important` and do not touch CopilotKit's own files. Re-measure.
- [ ] **Step 3:** Also measure: the three header rows (`aside .wb-header-row`, the chat `header`, and, after pressing Memory, the memory panel `header`) each 56px tall with equal `top`; map chips 16px from the map panel's top and right; zoom control's right and bottom 16px from the panel edge. Fix any outlier in the component that owns it.
- [ ] **Step 4:** Commit any change: `style(navlog-web): composer and transcript on the 16px inset`. Stop the servers.

---

### Task 10: Harness and demo journeys open Memory

**Files:** `test/harness/workbench-suggestions.ts`, `test/harness/workbench-suggestions.test.ts`, `docs/brand/demo/capture.mjs`, `docs/brand/demo/demo.test.mjs`.

- [ ] **Step 1: Harness.** In `teachJourney`, after `await journey.waitForWorkbenchRunCompletion(page)` and before `const panel = page.getByLabel("Memory candidates")`, add:

```ts
  // Memory review is a mode now (the sidebar's Memory toggle), not an inline
  // panel: open it once the run has proposed the candidate (the button is
  // disabled until the count is non-zero, and Playwright waits for enabled).
  await page
    .getByRole("button", { name: /^Memory/ })
    .click({ timeout: LOCATOR_TIMEOUT_MS })
```

  Update the panel comment ("it renders null when empty…") to: "the panel is always rendered in Memory mode; the candidate text appears once the post-run reload lands." In `workbench-suggestions.test.ts`'s golden call list, insert `"click page > button=/^Memory/"` immediately before the `waitFor:visible page > label=Memory candidates …` entry (match the fake browser's description format for a RegExp name; see how `button=/^Teach it the aircraft/` is recorded).
- [ ] **Step 2:** `npx vitest --run test/harness/workbench-suggestions.test.ts` → PASS.
- [ ] **Step 3: Demo capture.** In `docs/brand/demo/capture.mjs`, `assertMemoryCandidate`: before the region wait, open Memory mode if it isn't open:

```js
  const memory = page.getByRole("button", { name: /^Memory/ })
  if ((await memory.getAttribute("aria-pressed", { timeout: 60_000 })) !== "true") {
    await memory.click({ timeout: 60_000 })
  }
```

  and update its doc comment ("The memory panel (under the chat's header)…" → "Memory mode (the sidebar's Memory toggle) lists the suggested candidate in the right column…"). In `demo.test.mjs`, update the fake pages so `getByRole("button", { name: /^Memory/ })` returns a fake with `getAttribute("aria-pressed")` and `click`, and update any call-sequence assertion for the memory beat. Run `pnpm test:brand-demo` → PASS.
- [ ] **Step 4:** Commit the four files: `test(harness): open Memory mode before reviewing the taught memory`.

---

### Task 11: Docs, template mirror, lastmod

- [ ] **Step 1: READMEs.** In `examples/navlog/web/README.md` and `packages/devkit/templates/app-navlog/web/README.md`, wherever the memory panel is described as inline above the conversation or the sidenav Memory item as a count that scrolls to it: describe Memory mode (the sidebar's Memory toggle replaces the map column with the full candidate review; the badge counts what's waiting), and add that the desktop sidebar collapses to a 64px icon rail remembered per browser. Keep each README's voice and the template's `{{appName}}`.
- [ ] **Step 2: Recipe page** `apps/web/content/docs/recipes/flight-planner-web-ui.mdx`: the Sidenav bullet → "New plan, the list of threads, and Memory, which opens Memory mode with a count of the candidates waiting; the sidebar collapses to an icon rail."; the MemoryPanel paragraph's "renders the candidates above the conversation…" → "renders the candidates in Memory mode, which replaces the map column, with Approve and Delete on each". `node scripts/check-docs.mjs` → exit 0. Commit the three docs files: `docs(navlog-web): Memory mode and the collapsible sidebar`.
- [ ] **Step 3: lastmod** (after the content commit): `pnpm --dir apps/web seo:lastmod && pnpm --dir apps/web seo:lastmod:routes`; only the recipe route may change. Commit `apps/web/app/seo/lastmod.generated.json`: `chore(web): lastmod for the flight-planner recipe`.
- [ ] **Step 4: Mirror.**

```bash
E=examples/navlog/web/app; T=packages/devkit/templates/app-navlog/web/app
(cd $E && find . -type f) | while read f; do case "$f" in *.test.ts|*.test.tsx) t="$T/$f.template";; *) t="$T/$f";; esac; cmp -s "$E/$f" "$t" || { mkdir -p "$(dirname "$t")"; cp "$E/$f" "$t"; echo "sync $f"; }; done
git rm -q --ignore-unmatch $T/components/memory-anchor.ts
```

  In `packages/devkit/test/templates.test.ts`, the `.test.ts.template` count rises by one (the new `use-sidebar-state.test.ts`): in the `expect(templateSuffixedPaths.filter((path) => path.endsWith(".test.ts.template"))).toHaveLength(` call, change its argument (the line `      15,`) to `      16,`; leave the `.test.tsx.template` count (16) alone. Run `pnpm --filter @b4run/devkit test` → PASS. Commit: `chore(devkit): mirror the sidebar rail and Memory mode into the scaffold template`.

---

### Task 12: Verify and ship

- [ ] **Step 1:** `pnpm build && pnpm lint && pnpm --filter @b4-example/navlog-web typecheck && pnpm --filter @b4-example/navlog-web test && pnpm --filter @b4run/devkit test && npx vitest --run test/harness/workbench- && pnpm test:brand-demo && pnpm --filter @b4run/web test && node scripts/check-docs.mjs && pnpm --filter @b4-example/navlog-web test:e2e`.
- [ ] **Step 2:** Stop the dev servers, then `pnpm verify:harness:framework` (about 6 minutes; nothing else heavy meanwhile). On an axe failure, read the selector and contrast from `artifacts/testing/harness-*/framework/vitest-report.json`.
- [ ] **Step 3: Live check** at 1440×900 and 375px: collapse/expand (persists across reload; tooltips on hover and Tab focus); Memory mode open/close via the item, ×, Escape, New plan; the map keeps its view after leaving the mode; the phone drawer → Memory → a tab; re-measure the §3 numbers from Task 9.
- [ ] **Step 4:** Push `blove/navlog-sidebar-memory-mode`, open a PR to `main` titled `navlog-web: collapsible sidebar, Memory mode and alignment polish` (body: what changed, the before/after measurements, verification, follow-up: demo camera presets), ending with the Claude Code attribution line. Bind it with the ccd_pr tools.
