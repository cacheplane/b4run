# Navlog LLA Layout (PR 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the navlog web client's floating layout with the approved shell: a labelled left sidenav, docked panels on a grey canvas with no top bar on desktop, and a top row + full-screen panel + bottom tab bar (Chat · Map · Navlog) with a drawer on phones.

**Architecture:** `WorkbenchLayout` renders exactly one of two layouts (desktop grid or phone tabs), as today, so there is always one chat. A new `SideNav` composes the wordmark, the "New plan" button, the existing `ThreadRail` list and a "Memory" item with a count; on phones it lives in a new modal `Drawer`. `ChatDock` loses its brand, buttons and "Threads" disclosure and keeps the title, status, memory panel, banner, notices and conversation. The memory panel stays inline above the conversation (it appears only when a candidate is waiting); the sidenav item shows the count and scrolls to it. `RouteMap` fills its panel instead of the viewport and re-measures itself when the panel resizes.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS 4, Leaflet, Vitest (jsdom + `renderToStaticMarkup`), Playwright harness (`test/harness/workbench-*.ts`).

**Spec:** `docs/superpowers/specs/2026-10-08-navlog-lla-shell-design.md` sections 2–4. **Memory decision (spec "open for PR 2"):** keep `MemoryPanel` inline in the chat column; the sidenav "Memory" item shows the candidate count, is disabled at zero, and on click scrolls the panel into view and focuses it.

**Stacked on:** `blove/navlog-lla-look` (PR #1006). Branch `blove/navlog-lla-layout` is created from it.

---

## Before you start

- Repo root: `/Users/blove/repos/dawn/.claude/worktrees/b4-release-029b2a`. Branch `blove/navlog-lla-layout` is checked out. Run every command from the root.
- Shared worktree: never `git checkout/switch/stash/reset/rebase`; stage files by explicit path; never bare `biome check --write` (use `pnpm --filter @b4-example/navlog-web lint`, or scoped `pnpm --filter @b4-example/navlog-web exec biome check --write --config-path ../../../packages/config-biome/biome.json <files>`).
- Commands:
  - `pnpm --filter @b4-example/navlog-web test` / `lint` / `typecheck`
  - one file: `pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts app/components/X.test.tsx`
  - devkit parity: `pnpm --filter @b4run/devkit test`
  - harness unit tests: `pnpm verify:harness:self-test`
- `app/design-rules.test.ts` must stay green: no `uppercase`, positive letter-spacing, `gradient`, `shadow`, `backdrop-*`, dark scheme.
- Every file under `examples/navlog/web/app` is mirrored byte-for-byte into `packages/devkit/templates/app-navlog/web/app` (tests get `.template`). Task 9 does the mirror.

## File map

| File | Change |
|---|---|
| `app/components/memory-anchor.ts` | Create. `MEMORY_PANEL_ID`, `revealMemoryPanel()`. |
| `app/components/MemoryPanel.tsx` | `onCountChange` prop; `id={MEMORY_PANEL_ID}` on the section. |
| `app/components/SideNav.tsx` (+ `SideNav.test.tsx`) | Create. |
| `app/components/Drawer.tsx` | Create. Modal left drawer with focus trap. |
| `app/components/ChatDock.tsx` (+ test) | Drop brand, "+ New", "Threads", `rail`, `onNewConversation`. |
| `app/components/RouteMap.tsx` | Fill the parent panel; `invalidateSize` on resize; comment updates. |
| `app/components/WorkbenchLayout.tsx` (+ test) | Rewrite: desktop grid, phone tabs + drawer. |
| `app/components/AppShell.tsx` | Memory count state; pass `memoryCount`. |
| `app/theme.css` | Layout tokens, tab bar, icon buttons, drawer, print rules. |
| `test/harness/workbench-suggestions.ts` (+ `.test.ts`) | "New plan" replaces "+ New conversation"; focus entry no longer "Threads". |
| `examples/navlog/web/README.md`, template README | Layout section. |
| `apps/web/content/docs/recipes/flight-planner-web-ui.mdx` | Layout wording; then `seo:lastmod`. |
| `packages/devkit/test/templates.test.ts` | `.test.tsx.template` count 15 → 16. |

---

### Task 1: Memory anchor and count

**Files:**
- Create: `examples/navlog/web/app/components/memory-anchor.ts`
- Modify: `examples/navlog/web/app/components/MemoryPanel.tsx`
- Test: `examples/navlog/web/app/components/MemoryPanel.test.tsx`

- [ ] **Step 1: Write the failing tests** — append to `MemoryPanel.test.tsx` (it renders `MemoryPanelView` with `renderToStaticMarkup`; reuse its existing candidate fixture and render helper, whatever they are named in the file):

```tsx
describe("memory panel anchor", () => {
  test("the populated panel carries the id the sidenav scrolls to", () => {
    const html = renderToStaticMarkup(
      <MemoryPanelView
        candidates={[{ id: "a", content: "Pilot aircraft usable fuel 50 gal", namespace: "pilot" }]}
        onApprove={() => {}}
        onReject={() => {}}
        isBusy={false}
        outcome={null}
        loadFailure={null}
      />,
    )
    expect(html).toContain(`id="${MEMORY_PANEL_ID}"`)
  })
})
```

Add `import { MEMORY_PANEL_ID } from "./memory-anchor"` at the top (and `renderToStaticMarkup` if not already imported).

- [ ] **Step 2: Run it — expect FAIL** (module not found).

- [ ] **Step 3: Create `memory-anchor.ts`**

```ts
/**
 * Where the memory panel is, for the sidenav's "Memory" item.
 *
 * The panel stays inline above the conversation, because a proposed memory
 * should be in view without hunting for it; the sidenav only counts the
 * candidates and brings the panel into view. Its own module so the layout
 * can reach the panel without importing it (the panel needs CopilotKit).
 */
export const MEMORY_PANEL_ID = "wb-memory"

/** Scrolls the panel into view, opens its disclosure and focuses it. A no-op when nothing is waiting. */
export function revealMemoryPanel(): void {
  const panel = document.getElementById(MEMORY_PANEL_ID)
  if (panel === null) return
  const details = panel.querySelector("details")
  if (details !== null) details.open = true
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  panel.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" })
  panel.querySelector<HTMLElement>("summary")?.focus()
}
```

- [ ] **Step 4: Wire `MemoryPanel.tsx`**
  - `import { MEMORY_PANEL_ID } from "./memory-anchor"`.
  - On the populated `<section aria-label="Memory candidates" …>` in `MemoryPanelView`, add `id={MEMORY_PANEL_ID}`.
  - Change `export function MemoryPanel() {` to:

```tsx
export interface MemoryPanelProps {
  /** Told the number of waiting candidates whenever it changes (the sidenav's count). */
  readonly onCountChange?: (count: number) => void
}

export function MemoryPanel({ onCountChange }: MemoryPanelProps = {}) {
```

  - After the `candidates` state declaration's effects (anywhere among the hooks, before `return`), add:

```tsx
  useEffect(() => {
    onCountChange?.(candidates.length)
  }, [candidates.length, onCountChange])
```

- [ ] **Step 5: Run the web tests — expect PASS.** Commit `memory-anchor.ts`, `MemoryPanel.tsx`, `MemoryPanel.test.tsx`: `feat(navlog-web): memory panel anchor and candidate count`.

---

### Task 2: `SideNav`

**Files:**
- Create: `examples/navlog/web/app/components/SideNav.tsx`
- Test: `examples/navlog/web/app/components/SideNav.test.tsx`

- [ ] **Step 1: Write the failing test** `SideNav.test.tsx`:

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
  onNewConversation: () => {},
  onShowMemory: () => {},
  ...overrides,
})

describe("SideNav", () => {
  test("the wordmark is the h1 on desktop and plain text in the drawer", () => {
    const heading = renderToStaticMarkup(<SideNav {...props()} />)
    expect(heading).toMatch(/<h1[^>]*><span class="wb-wordmark">/)
    const label = renderToStaticMarkup(<SideNav {...props({ brand: "label" })} />)
    expect(label).not.toContain("<h1")
    expect(label).toContain('class="wb-wordmark"')
  })

  test("New plan is an ink pill, disabled until hydration", () => {
    const html = renderToStaticMarkup(<SideNav {...props()} />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*bg-wb-text[^>]*>.*New plan<\/button>/s)
  })

  test("the thread list sits between New plan and Memory", () => {
    const html = renderToStaticMarkup(<SideNav {...props()} />)
    expect(html.indexOf("New plan")).toBeLessThan(html.indexOf("KSTP to KRST"))
    expect(html.indexOf("KSTP to KRST")).toBeLessThan(html.indexOf(">Memory<"))
  })

  test("Memory is disabled with nothing waiting and shows the count otherwise", () => {
    expect(renderToStaticMarkup(<SideNav {...props()} />)).toMatch(
      /<button[^>]*disabled=""[^>]*><span>Memory<\/span><\/button>/,
    )
    const html = renderToStaticMarkup(<SideNav {...props({ memoryCount: 3 })} />)
    expect(html).toContain(">3<")
    expect(html).toContain("waiting for review")
  })

  test("any button inside reports a navigation, so the drawer can close", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const onNavigate = vi.fn()
    const onShowMemory = vi.fn()
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<SideNav {...props({ memoryCount: 1, onNavigate, onShowMemory })} />))
    act(() => (container.querySelector("li button") as HTMLElement).click())
    expect(onNavigate).toHaveBeenCalledTimes(1)
    const memory = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Memory"),
    ) as HTMLElement
    act(() => memory.click())
    expect(onShowMemory).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(2)
    act(() => root.unmount())
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (module not found).

- [ ] **Step 3: Create `SideNav.tsx`**

```tsx
"use client"
import type { MouseEvent, ReactNode } from "react"
import { useHydrated } from "../lib/use-hydrated"
import { primaryButton } from "./ui"
import { Wordmark } from "./Wordmark"

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
  readonly onNewConversation: () => void
  /** Brings the inline memory panel into view (`revealMemoryPanel`). */
  readonly onShowMemory: () => void
  /** Called after any button inside is clicked: the phone's drawer closes on it. */
  readonly onNavigate?: () => void
  readonly className?: string
}

/**
 * The left sidenav: the wordmark, "New plan", the recent threads and Memory.
 * The same component is the desktop's first column and the phone's drawer.
 *
 * Memory is a count and a shortcut, not a second home for the panel: the
 * panel stays above the conversation (see `memory-anchor.ts`). With nothing
 * waiting the item is disabled rather than hidden, so the nav does not jump.
 *
 * "New plan" is disabled until hydration for the reason the dock's header
 * buttons were: it is in the server render, and a click before its handler
 * exists is dropped.
 */
export function SideNav({
  brand,
  rail,
  memoryCount,
  onNewConversation,
  onShowMemory,
  onNavigate,
  className = "",
}: SideNavProps) {
  const hydrated = useHydrated()
  const onClick = (event: MouseEvent<HTMLElement>): void => {
    if (onNavigate === undefined) return
    if ((event.target as Element).closest("button") !== null) onNavigate()
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegation only; every target inside is a real button with its own keyboard handling
    // biome-ignore lint/a11y/noStaticElementInteractions: same delegation
    <aside
      aria-label="Navigation"
      onClick={onClick}
      className={`wb-panel flex min-h-0 flex-col gap-3 p-2 ${className}`}
    >
      {brand === "heading" ? (
        <h1 className="px-2 pt-1.5 text-[15px]">
          <Wordmark />
        </h1>
      ) : (
        <p className="px-2 pt-1.5 text-[15px]">
          <Wordmark />
        </p>
      )}
      <button
        type="button"
        disabled={!hydrated}
        onClick={onNewConversation}
        className={`${primaryButton("md")} inline-flex items-center justify-center gap-1.5 disabled:opacity-60`}
      >
        <span aria-hidden="true">+</span>
        New plan
      </button>
      <div className="flex min-h-0 flex-1 flex-col">{rail}</div>
      <button
        type="button"
        disabled={memoryCount === 0}
        onClick={onShowMemory}
        className="wb-focus flex items-center justify-between rounded-full px-3 py-2 text-left text-[13px] font-medium text-wb-muted transition-colors hover:bg-wb-rail hover:text-wb-text disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-wb-muted pointer-coarse:py-3"
      >
        <span>Memory</span>
        {memoryCount > 0 ? (
          <span className="rounded-full bg-wb-text px-2 text-[11px] font-semibold leading-5 text-wb-surface">
            {memoryCount}
            <span className="sr-only"> waiting for review</span>
          </span>
        ) : null}
      </button>
    </aside>
  )
}
```

If Biome rejects the two-line biome-ignore form, use whichever single suppression it asks for; do not add a `role` to the aside.

- [ ] **Step 4: Run the test — expect PASS.** (If the "New plan" regex fails only because of attribute order, adjust the regex to the real markup, keeping both `disabled=""` and `bg-wb-text` asserted.)

- [ ] **Step 5: Commit** `SideNav.tsx`, `SideNav.test.tsx`: `feat(navlog-web): SideNav with New plan, threads and a memory count`.

---

### Task 3: `Drawer`

**Files:**
- Create: `examples/navlog/web/app/components/Drawer.tsx`

(Its behaviour is tested through `WorkbenchLayout.test.tsx` in Task 6.)

- [ ] **Step 1: Create `Drawer.tsx`**

```tsx
"use client"
import { type ReactNode, useEffect, useRef } from "react"

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface DrawerProps {
  readonly id: string
  /** Must be stable (`useCallback`): the focus effect re-runs when it changes. */
  readonly onClose: () => void
  readonly children: ReactNode
}

/**
 * The phone's navigation drawer: a modal dialog from the left over a scrim.
 * Focus moves into it on open and stays there (Tab and Shift+Tab wrap);
 * Escape and a tap on the scrim close it. Returning focus to the menu button
 * is the caller's `onClose`. Rendered only while open.
 */
export function Drawer({ id, onClose, children }: DrawerProps) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = panel.current
    element?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose()
        return
      }
      if (event.key !== "Tab" || element === null) return
      const items = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = items[0]
      const last = items.at(-1)
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 print:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        tabIndex={-1}
        className="wb-scrim absolute inset-0"
        onClick={onClose}
      />
      <div
        ref={panel}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="wb-drawer absolute inset-y-0 left-0 flex w-[80%] max-w-80 p-2 pt-[max(8px,env(safe-area-inset-top))] pb-[max(8px,env(safe-area-inset-bottom))]"
      >
        {children}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck** (`pnpm --filter @b4-example/navlog-web typecheck`) and commit `Drawer.tsx`: `feat(navlog-web): modal navigation drawer for phones`.

---

### Task 4: Slim `ChatDock`

**Files:**
- Modify: `examples/navlog/web/app/components/ChatDock.tsx`
- Test: `examples/navlog/web/app/components/ChatDock.test.tsx`

- [ ] **Step 1: Update the test first.** In `ChatDock.test.tsx`:
  - In `render(...)`, delete the `rail={null}` and `onNewConversation={() => {}}` props.
  - Replace the test "the brand is the page's one h1, kept for screen readers on a phone" with:

```tsx
  test("the dock holds no brand and no navigation: those are the sidenav's", () => {
    const html = render("Plan")
    expect(html).not.toContain("<h1")
    expect(html).not.toContain("wb-wordmark")
    expect(html).not.toContain("Threads")
    expect(html).not.toContain("New conversation")
  })
```

- [ ] **Step 2: Run it — expect FAIL** (h1 and buttons still present; TypeScript may also complain about missing props, which is fine at this step).

- [ ] **Step 3: Rewrite `ChatDock.tsx`.** Keep `statusPresentation`, `TONE_CLASS` and `StatusBadge` exactly as they are. Replace everything else:
  - Imports become `import type { ReactNode } from "react"` (drop `useEffect`, `useId`, `useState`, `useHydrated`, `Wordmark`).
  - `ChatDockProps`: remove `rail` and `onNewConversation` and their doc comments.
  - Delete the `HEADER_BUTTON` constant and its comment.
  - Replace the component's doc comment and body with:

```tsx
/**
 * The chat column: the thread's title and run status, the memory panel, the
 * failure banner, drop notices and the conversation.
 *
 * The brand, "New plan" and the thread list are the sidenav's (`SideNav`).
 * The memory panel stays here, inline above the conversation, rather than
 * behind a link: it renders nothing until a candidate is waiting, so it costs
 * no space until there is something to approve, and then it is in view (the
 * teach journey and a person both need to see it without hunting for it).
 * The sidenav's "Memory" item counts the candidates and scrolls here.
 */
export function ChatDock({ header, status, memory, banner, notices, children }: ChatDockProps) {
  return (
    // `min-w-0`: as a flex item the dock would otherwise grow to its widest
    // content (a long tool-call argument line) and spill into the map.
    <section
      className="wb-panel wb-dock relative flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Chat"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-wb-border px-3 py-2.5">
        {/* `title` carries the full text when it truncates. */}
        <h2
          title={header}
          className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-5 tracking-tight"
        >
          {header}
        </h2>
        <StatusBadge status={status} />
      </header>
      <div className="max-h-[30%] shrink-0 overflow-auto border-b border-wb-border empty:hidden max-md:max-h-[25%]">
        {memory}
      </div>
      {banner ? <div className="shrink-0 px-3 pt-2">{banner}</div> : null}
      {notices}
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </section>
  )
}
```

- [ ] **Step 4: Run `ChatDock.test.tsx` — expect PASS.** (`WorkbenchLayout.tsx` will not typecheck until Task 6; that is expected. Do not commit a typecheck fix here.)

- [ ] **Step 5: Commit** `ChatDock.tsx`, `ChatDock.test.tsx`: `feat(navlog-web): the chat dock keeps the conversation; navigation moves to the sidenav`.

---

### Task 5: `RouteMap` fills its panel

**Files:**
- Modify: `examples/navlog/web/app/components/RouteMap.tsx`

- [ ] **Step 1: Root element.** Change the returned element's className from `"wb-map fixed inset-0 z-0"` to `"wb-map absolute inset-0 z-0"`.

- [ ] **Step 2: Re-measure on resize.** Add this effect after the SETUP effect (the one that creates the map):

```tsx
  // RESIZE: the map fills a panel now, not the viewport. The panel changes
  // size when the navlog sheet opens or closes, and goes from zero to full
  // size when a phone's Map tab is shown; Leaflet must re-measure each time
  // or it draws tiles for the old box.
  useEffect(() => {
    if (leaflet === null || container.current === null) return
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => leaflet.map.invalidateSize())
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [leaflet])
```

- [ ] **Step 3: Comments.** In the `padding` prop's doc comment, replace "Extra padding for the floating surfaces: the dock (left), the strip (top), the sheet (bottom), in pixels." with "Room to leave around the route when fitting it: the weather chips along the top, in pixels." In the SETUP effect's comment about controls, replace the text from "The weather strip owns the top" through "is never covered." with "The weather chips own the top of the panel, so the bottom-right corner is free and the OpenStreetMap attribution the tile policy requires is never covered."

- [ ] **Step 4: Typecheck the file compiles** (the layout may still fail; check only RouteMap errors) and commit `RouteMap.tsx`: `feat(navlog-web): the route map fills its panel and re-measures on resize`.

---

### Task 6: Rewrite `WorkbenchLayout`

**Files:**
- Modify (replace): `examples/navlog/web/app/components/WorkbenchLayout.tsx`
- Modify (replace): `examples/navlog/web/app/components/WorkbenchLayout.test.tsx`

- [ ] **Step 1: Replace the test file**

```tsx
// @vitest-environment jsdom
import { act, useContext } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { SheetControlContext } from "./sheet-control"
import { WorkbenchLayout, type WorkbenchLayoutProps } from "./WorkbenchLayout"

const viewport = vi.hoisted(() => ({ desktop: true }))
/** What the layout last handed the map. */
const map = vi.hoisted(
  () =>
    ({}) as {
      categories?: Readonly<Record<string, string>>
      padding?: { readonly left: number; readonly top: number; readonly bottom: number }
    },
)

// Leaflet needs a DOM; the map is a stand-in here (recording its props) and
// `RouteMap` itself is exercised in the browser.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    (mapProps: {
      categories: Readonly<Record<string, string>>
      padding: { readonly left: number; readonly top: number; readonly bottom: number }
    }) => {
      map.categories = mapProps.categories
      map.padding = mapProps.padding
      return <div data-testid="map" />
    },
}))
vi.mock("../lib/use-media-query", () => ({ useMediaQuery: () => viewport.desktop }))

const props = (overrides: Partial<WorkbenchLayoutProps> = {}): WorkbenchLayoutProps => ({
  navlog: SAMPLE_NAVLOG,
  brief: null,
  assistantBrief: "ok",
  chat: <p>transcript</p>,
  rail: (
    <ul>
      <li>
        <button type="button">rail row</button>
      </li>
    </ul>
  ),
  memory: <p>memory</p>,
  memoryCount: 0,
  header: "Thread one",
  onNewConversation: () => {},
  ...overrides,
})

const count = (html: string, needle: string): number => html.split(needle).length - 1

describe("WorkbenchLayout on desktop", () => {
  beforeEach(() => {
    viewport.desktop = true
  })
  test("sidenav, chat, map and navlog are docked panels; no top bar, no tabs", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toContain('aria-label="Navigation"')
    expect(html).toContain('aria-label="Chat"')
    expect(html).toContain('data-testid="map"')
    expect(html).toContain('aria-label="Navlog"')
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain("<header class=\"wb-topbar")
  })
  test("exactly one main and one h1, the wordmark in the sidenav", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(count(html, "<main")).toBe(1)
    expect(count(html, "<h1")).toBe(1)
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf('aria-label="Chat"'))
  })
  test("the thread list is always in view; there is no Threads disclosure", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toContain("rail row")
    expect(html).not.toContain(">Threads<")
    expect(html.indexOf("New plan")).toBeLessThan(html.indexOf("<main"))
  })
  test("the memory panel stays above the conversation; the sidenav counts it", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ memoryCount: 2 })} />)
    expect(html.indexOf("<p>memory</p>")).toBeLessThan(html.indexOf("<main"))
    expect(html).toContain(">2<")
  })
  test("map markers take each airport's worst category, as the chips do", () => {
    const brief = {
      airports: [
        { id: "KSTP", now: "VFR" as const, atEta: "VFR" as const, line: "", metar: "", taf: "" },
        // Improving: MVFR now, VFR at ETA is MVFR on the chip and the marker.
        { id: "KRST", now: "MVFR" as const, atEta: "VFR" as const, line: "", metar: "", taf: "" },
      ],
      winds: [],
      advisories: [],
      note: "",
    }
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ brief })} />)
    expect(map.categories).toEqual({ KSTP: "VFR", KRST: "MVFR" })
    expect(html).toContain("KRST MVFR now, VFR at ETA")
  })
  test("the map only leaves a margin: nothing floats over it but the chips", () => {
    renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(map.padding?.left).toBeLessThan(100)
    expect(map.padding?.bottom).toBeLessThan(100)
  })
  test("without a navlog there is no navlog panel", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ navlog: null })} />)
    expect(html).not.toContain('aria-label="Navlog"')
  })
})

describe("WorkbenchLayout on a phone", () => {
  beforeEach(() => {
    viewport.desktop = false
  })
  test("a top row with the menu, the wordmark h1 and New plan", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toMatch(/<button[^>]*aria-label="Open navigation"/)
    expect(count(html, "<h1")).toBe(1)
    expect(html).toMatch(/<button[^>]*aria-label="New plan"/)
  })
  test("a bottom tab bar: Chat, Map, Navlog; one main", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).toContain('role="tablist"')
    expect(html).toContain(">Chat<")
    expect(html).toContain(">Map<")
    expect(html).toContain(">Navlog<")
    expect(count(html, "<main")).toBe(1)
  })
  test("Map and Navlog are disabled until there is a navlog", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props({ navlog: null })} />)
    expect(html).toMatch(/<button[^>]*id="wb-tab-map"[^>]*disabled=""/)
    expect(html).toMatch(/<button[^>]*id="wb-tab-navlog"[^>]*disabled=""/)
  })
  test("the drawer is closed, so the thread list is not rendered", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout {...props()} />)
    expect(html).not.toContain("rail row")
  })
})

/** A step view's "See the navlog sheet", as a chat would hold it. */
function OpenSheet() {
  const { openSheet } = useContext(SheetControlContext)
  return (
    <button type="button" data-open-sheet="" onClick={openSheet}>
      See the navlog sheet
    </button>
  )
}

function mount(overrides: Partial<WorkbenchLayoutProps> = {}) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const render = (next: Partial<WorkbenchLayoutProps> = {}) =>
    act(() =>
      root.render(
        <WorkbenchLayout {...props({ chat: <OpenSheet />, ...overrides, ...next })} />,
      ),
    )
  render()
  const click = (selector: string) =>
    act(() => (container.querySelector(selector) as HTMLElement).click())
  const key = (key: string) =>
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
    })
  return { container, click, key, render, unmount: () => act(() => root.unmount()) }
}

describe("WorkbenchLayout sheet control", () => {
  test("on a desktop, a step's openSheet opens the collapsed sheet", () => {
    viewport.desktop = true
    const view = mount()
    const toggle = () =>
      view.container.querySelector('section[aria-label="Navlog"] button[aria-expanded]')
    view.click('section[aria-label="Navlog"] button[aria-expanded]')
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false")
    view.click("[data-open-sheet]")
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true")
    view.unmount()
  })
  test("on a phone, a step's openSheet selects the Navlog tab", () => {
    viewport.desktop = false
    const view = mount()
    const navlogTab = () => view.container.querySelector("#wb-tab-navlog")
    expect(navlogTab()?.getAttribute("aria-selected")).toBe("false")
    view.click("[data-open-sheet]")
    expect(navlogTab()?.getAttribute("aria-selected")).toBe("true")
    view.unmount()
  })
})

describe("WorkbenchLayout phone tabs and drawer", () => {
  beforeEach(() => {
    viewport.desktop = false
  })
  test("a new navlog while on Chat dots Map and Navlog; visiting a tab clears its dot", () => {
    const view = mount({ navlog: null })
    expect(view.container.querySelectorAll(".wb-tab-dot")).toHaveLength(0)
    view.render({ navlog: SAMPLE_NAVLOG })
    expect(view.container.querySelectorAll(".wb-tab-dot")).toHaveLength(2)
    view.click("#wb-tab-map")
    expect(view.container.querySelector("#wb-tab-map .wb-tab-dot")).toBeNull()
    expect(view.container.querySelector("#wb-tab-navlog .wb-tab-dot")).not.toBeNull()
    view.unmount()
  })
  test("an approval switches back to Chat", () => {
    const view = mount()
    view.click("#wb-tab-navlog")
    expect(view.container.querySelector("#wb-tab-navlog")?.getAttribute("aria-selected")).toBe(
      "true",
    )
    view.render({ status: "awaiting approval" })
    expect(view.container.querySelector("#wb-tab-chat")?.getAttribute("aria-selected")).toBe(
      "true",
    )
    view.unmount()
  })
  test("the menu opens a modal drawer with the threads; Escape closes it", () => {
    const view = mount()
    view.click('button[aria-label="Open navigation"]')
    const dialog = view.container.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute("aria-modal")).toBe("true")
    expect(dialog?.textContent).toContain("rail row")
    expect(dialog?.contains(document.activeElement)).toBe(true)
    view.key("Escape")
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    view.unmount()
  })
  test("choosing a thread in the drawer closes it", () => {
    const view = mount()
    view.click('button[aria-label="Open navigation"]')
    view.click('[role="dialog"] li button')
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    view.unmount()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (the old layout).

- [ ] **Step 3: Replace `WorkbenchLayout.tsx`**

```tsx
"use client"
import dynamic from "next/dynamic"
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import type { Navlog } from "../lib/navlog-types"
import { pairIndexOf, routeGeometry } from "../lib/route-geometry"
import { useHydrated } from "../lib/use-hydrated"
import { useMediaQuery } from "../lib/use-media-query"
import { resolveVerdict } from "../lib/verdict"
import { type FlightCategory, type WeatherBrief, worstCategory } from "../lib/weather-selectors"
import { ChatDock } from "./ChatDock"
import { Drawer } from "./Drawer"
import { revealMemoryPanel } from "./memory-anchor"
import { NavlogSheet } from "./NavlogSheet"
import { type SheetControl, SheetControlContext } from "./sheet-control"
import { SideNav } from "./SideNav"
import { WeatherStrip } from "./WeatherStrip"
import { Wordmark } from "./Wordmark"

const RouteMap = dynamic(() => import("./RouteMap").then((m) => m.RouteMap), { ssr: false })

export interface WorkbenchLayoutProps {
  readonly navlog: Navlog | null
  readonly brief: WeatherBrief | null
  /** The planning answer of the turn that produced the navlog, shown in the sheet. */
  readonly assistantBrief: string
  readonly header: string
  readonly status?: string | undefined
  /** The thread list (`ThreadRail`), for the sidenav. */
  readonly rail: ReactNode
  readonly memory: ReactNode
  /** Memory candidates waiting, for the sidenav's count. */
  readonly memoryCount: number
  /** The chat's failure banner (`RunError`), or nothing. */
  readonly banner?: ReactNode
  /** The chat's content-parts-dropped notices, or nothing. */
  readonly notices?: ReactNode
  /** The conversation (`NavlogChat`): messages and input. */
  readonly chat: ReactNode
  readonly onNewConversation: () => void
}

/** The margin the route fit keeps inside the map panel, in pixels. */
const MAP_MARGIN = 24
/** Tailwind's `md` breakpoint. */
const DESKTOP_QUERY = "(min-width: 768px)"

type PhoneTab = "chat" | "map" | "navlog"

const PHONE_TABS: readonly { readonly id: PhoneTab; readonly label: string; readonly icon: string }[] =
  [
    { id: "chat", label: "Chat", icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
    { id: "map", label: "Map", icon: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" },
    { id: "navlog", label: "Navlog", icon: "M4 6h16M4 12h16M4 18h10" },
  ]

/**
 * An element's height, tracked: the weather chips' height tells the route fit
 * how much room to leave at the top of the map. Re-attached after every
 * render because which element the ref points at changes with the layout; an
 * unchanged height is a no-op.
 */
function useMeasuredHeight(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element === null || typeof ResizeObserver === "undefined") {
      setHeight(0)
      return
    }
    const measure = (): void => setHeight(Math.ceil(element.getBoundingClientRect().height))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  })
  return [ref, height]
}

function Icon({ path }: { readonly path: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
    >
      <path d={path} />
    </svg>
  )
}

/**
 * Desktop (`md` and up): a grey canvas with three docked columns and no top
 * bar: the sidenav, the chat, and the map stacked over the navlog sheet.
 * Phone: a top row (menu, wordmark, New plan), one full-screen panel, and a
 * bottom tab bar (Chat, Map, Navlog); the sidenav opens as a drawer.
 *
 * Only the layout that applies is rendered, not both hidden by CSS: the dock
 * holds the chat, and two copies would mean two `<main>` elements, two
 * `CopilotChat`s connecting the same thread and two inputs.
 *
 * Provides `SheetControlContext`, so a step view inside the chat ("See the
 * navlog sheet") can bring the sheet into view: on a desktop it opens the
 * sheet, on a phone it selects the Navlog tab.
 *
 * `wb-root`, `wb-sheet-wrap` and `wb-print-hide` are what the print rules in
 * `theme.css` use so the sheet prints alone, in the page flow.
 */
export function WorkbenchLayout({
  navlog,
  brief,
  assistantBrief,
  header,
  status,
  rail,
  memory,
  memoryCount,
  banner,
  notices,
  chat: conversation,
  onNewConversation,
}: WorkbenchLayoutProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const hydrated = useHydrated()
  const drawerId = useId()
  const [sheetOpen, setSheetOpen] = useState(true)
  const [tab, setTab] = useState<PhoneTab>("chat")
  const [unseen, setUnseen] = useState<{ readonly map: boolean; readonly navlog: boolean }>({
    map: false,
    navlog: false,
  })
  const [drawerOpen, setDrawerOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const [hoveredLeg, setHoveredLeg] = useState<number | null>(null)
  const [stripRef, stripHeight] = useMeasuredHeight()
  // No navlog, nothing on the Map and Navlog tabs: a thread switch must not
  // leave an empty tab selected.
  const activeTab: PhoneTab = navlog ? tab : "chat"
  const awaitingApproval = status === "awaiting approval"

  // An approval card lives in the chat; never leave it behind another tab.
  useEffect(() => {
    if (awaitingApproval) setTab("chat")
  }, [awaitingApproval])

  // A new navlog while the pilot is in the chat: dot the two tabs that show it.
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab
  const previousNavlog = useRef(navlog)
  useEffect(() => {
    if (navlog !== null && navlog !== previousNavlog.current && activeTabRef.current === "chat") {
      setUnseen({ map: true, navlog: true })
    }
    previousNavlog.current = navlog
  }, [navlog])

  const selectTab = useCallback((next: PhoneTab): void => {
    setTab(next)
    if (next !== "chat") setUnseen((current) => ({ ...current, [next]: false }))
  }, [])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    menuButton.current?.focus()
  }, [])

  const showMemory = useCallback(() => {
    setDrawerOpen(false)
    setTab("chat")
    requestAnimationFrame(revealMemoryPanel)
  }, [])

  const geometry = useMemo(() => (navlog ? routeGeometry(navlog) : null), [navlog])
  const categories = useMemo(() => {
    const out: Record<string, FlightCategory> = {}
    for (const airport of brief?.airports ?? []) out[airport.id] = worstCategory(airport)
    return out
  }, [brief])
  const padding = useMemo(
    () => ({ left: MAP_MARGIN, top: stripHeight + MAP_MARGIN, bottom: MAP_MARGIN }),
    [stripHeight],
  )
  const highlightedLeg = navlog && hoveredLeg !== null ? pairIndexOf(navlog, hoveredLeg) : null
  const cruise = navlog ? { cruiseFt: navlog.altitudeFt } : {}
  // The same inputs the sheet resolves its verdict from, so the strip's pill
  // and the sheet's card always show the same level.
  const verdict = useMemo(
    () => resolveVerdict({ weather: brief, answer: assistantBrief, navlog }),
    [brief, assistantBrief, navlog],
  )

  const sheetControl = useMemo<SheetControl>(
    () => ({
      openSheet: () => {
        if (isDesktop) setSheetOpen(true)
        else selectTab("navlog")
      },
    }),
    [isDesktop, selectTab],
  )

  const chat = (
    <ChatDock header={header} status={status} memory={memory} banner={banner} notices={notices}>
      {conversation}
    </ChatDock>
  )
  const map = (
    <RouteMap
      geometry={geometry}
      categories={categories}
      highlightedLeg={highlightedLeg}
      padding={padding}
    />
  )

  if (isDesktop) {
    return (
      <SheetControlContext.Provider value={sheetControl}>
        <div className="wb-root grid h-dvh grid-cols-[var(--wb-nav-width)_minmax(360px,34%)_minmax(0,1fr)] gap-[var(--wb-gutter)] p-[var(--wb-gutter)]">
          <SideNav
            brand="heading"
            rail={rail}
            memoryCount={memoryCount}
            onNewConversation={onNewConversation}
            onShowMemory={showMemory}
            className="wb-print-hide"
          />
          <div className="wb-print-hide flex min-h-0 min-w-0">{chat}</div>
          <div className="flex min-h-0 min-w-0 flex-col gap-[var(--wb-gutter)]">
            <div className="wb-panel wb-print-hide relative min-h-0 flex-1 overflow-hidden">
              {map}
              <div
                ref={stripRef}
                className="pointer-events-none absolute inset-x-3 top-3 z-10 flex justify-end *:pointer-events-auto"
              >
                <WeatherStrip brief={brief} verdict={verdict} {...cruise} />
              </div>
            </div>
            {navlog ? (
              <div className="wb-sheet-wrap min-h-0 shrink-0">
                <NavlogSheet
                  navlog={navlog}
                  brief={assistantBrief}
                  weather={brief}
                  open={sheetOpen}
                  onToggle={() => setSheetOpen((value) => !value)}
                  onHoverLeg={setHoveredLeg}
                />
              </div>
            ) : null}
          </div>
        </div>
      </SheetControlContext.Provider>
    )
  }

  return (
    <SheetControlContext.Provider value={sheetControl}>
      <div className="wb-root flex h-dvh flex-col">
        <header className="wb-print-hide flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-[max(8px,env(safe-area-inset-top))]">
          <button
            ref={menuButton}
            type="button"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls={drawerId}
            disabled={!hydrated}
            onClick={() => setDrawerOpen(true)}
            className="wb-focus wb-icon-button"
          >
            <Icon path="M4 7h16M4 12h16M4 17h16" />
          </button>
          <h1 className="min-w-0 truncate text-[15px]">
            <Wordmark />
          </h1>
          <button
            type="button"
            aria-label="New plan"
            disabled={!hydrated}
            onClick={onNewConversation}
            className="wb-focus wb-icon-button wb-icon-button-primary"
          >
            <Icon path="M12 5v14M5 12h14" />
          </button>
        </header>
        {/*
          All three panels stay mounted and the inactive ones are hidden with
          a class, not unmounted: a switch keeps the chat's scroll position,
          the input's draft and any parked approval card, the map keeps its
          view, and the navlog panel still prints (`print:block`) from any tab.
        */}
        <div className="relative min-h-0 flex-1 px-2 pb-2">
          <div
            role="tabpanel"
            id="wb-panel-chat"
            aria-labelledby="wb-tab-chat"
            className={`h-full min-h-0 flex-col print:hidden ${activeTab === "chat" ? "flex" : "hidden"}`}
          >
            {chat}
          </div>
          <div
            role="tabpanel"
            id="wb-panel-map"
            aria-labelledby="wb-tab-map"
            className={`wb-panel relative h-full overflow-hidden print:hidden ${activeTab === "map" ? "" : "hidden"}`}
          >
            {map}
            <div
              ref={stripRef}
              className="pointer-events-none absolute inset-x-2 top-2 z-10 *:pointer-events-auto"
            >
              <WeatherStrip brief={brief} layout="row" verdict={verdict} {...cruise} />
            </div>
          </div>
          {navlog ? (
            <div
              role="tabpanel"
              id="wb-panel-navlog"
              aria-labelledby="wb-tab-navlog"
              className={`wb-sheet-wrap h-full overflow-auto ${activeTab === "navlog" ? "" : "hidden print:block"}`}
            >
              <NavlogSheet
                navlog={navlog}
                brief={assistantBrief}
                weather={brief}
                open={true}
                onToggle={() => {}}
                variant="cards"
                collapsible={false}
              />
            </div>
          ) : null}
        </div>
        <div
          role="tablist"
          aria-label="Views"
          className="wb-print-hide flex shrink-0 border-t border-wb-border bg-wb-surface pb-[env(safe-area-inset-bottom)]"
        >
          {PHONE_TABS.map((item) => {
            const dotted = item.id !== "chat" && unseen[item.id]
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`wb-tab-${item.id}`}
                aria-selected={activeTab === item.id}
                aria-controls={`wb-panel-${item.id}`}
                disabled={item.id !== "chat" && navlog === null}
                className="wb-focus wb-tab"
                onClick={() => selectTab(item.id)}
              >
                <span className="relative">
                  <Icon path={item.icon} />
                  {dotted ? (
                    <span className="wb-tab-dot">
                      <span className="sr-only">, new result</span>
                    </span>
                  ) : null}
                </span>
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
        {drawerOpen ? (
          <Drawer id={drawerId} onClose={closeDrawer}>
            <SideNav
              brand="label"
              rail={rail}
              memoryCount={memoryCount}
              onNewConversation={onNewConversation}
              onShowMemory={showMemory}
              onNavigate={closeDrawer}
              className="flex-1"
            />
          </Drawer>
        ) : null}
      </div>
    </SheetControlContext.Provider>
  )
}
```

Notes for the implementer:
- `showMemory` sets the tab and closes the drawer itself; `onNavigate={closeDrawer}` also fires for that click, which is harmless (focus returns to the menu button first, then `revealMemoryPanel` moves it to the panel on the next frame).
- The tab label text sits in its own `<span>` so the test's `>Chat<` matcher finds it.
- `requestAnimationFrame` exists in jsdom; no test clicks Memory through the layout.

- [ ] **Step 4: Run `WorkbenchLayout.test.tsx` — expect PASS.** If the "dots" test fails because the first render's effect already dotted (it should not: `previousNavlog` starts as `null` and `navlog` is `null`), debug the effect order rather than weakening the test.

- [ ] **Step 5: Commit** `WorkbenchLayout.tsx`, `WorkbenchLayout.test.tsx`: `feat(navlog-web): docked desktop columns and a phone tab bar with a drawer`. (Typecheck still fails in `AppShell.tsx` until Task 7.)

---

### Task 7: `AppShell` wiring

**Files:**
- Modify: `examples/navlog/web/app/components/AppShell.tsx`

- [ ] **Step 1:** In the component that renders `<B4Activity …><ThreadWorkbench …/></B4Activity>`, add a count state near the other `useState` calls (above the `serverStatus === "down"` early return, with the other hooks):

```tsx
  const [memoryCount, setMemoryCount] = useState(0)
```

- [ ] **Step 2:** Change `memory={<MemoryPanel />}` to `memory={<MemoryPanel onCountChange={setMemoryCount} />}` and add `memoryCount={memoryCount}` to the `<ThreadWorkbench …>` props.

- [ ] **Step 3:** In `ThreadWorkbenchProps` add `readonly memoryCount: number`, destructure it in `ThreadWorkbench`, and pass `memoryCount={memoryCount}` to `<WorkbenchLayout …>`.

- [ ] **Step 4:** Update the comment at the `serverStatus === "down"` return: "The rail and header disappear with the chat" → "The sidenav disappears with the chat".

- [ ] **Step 5:** Run `pnpm --filter @b4-example/navlog-web typecheck` and `test`. Expect both to pass. If `AppShell.test.tsx` mocks `MemoryPanel` with a zero-argument component, it still type-checks (extra props are ignored at runtime); if TypeScript complains about the mock's signature, give the mock a `(_props: { onCountChange?: (n: number) => void })` parameter.

- [ ] **Step 6: Commit** `AppShell.tsx` (and `AppShell.test.tsx` if touched): `feat(navlog-web): the sidenav counts waiting memories`.

---

### Task 8: `theme.css` layout rules

**Files:**
- Modify: `examples/navlog/web/app/theme.css`

- [ ] **Step 1: Layout tokens.** In the layout-tokens `:root` block, replace

```css
  --wb-dock-width: min(380px, 34vw);
  --wb-sheet-max: 46vh;
  --wb-gutter: 16px;
```

with

```css
  --wb-nav-width: 200px;
  --wb-sheet-max: 55dvh;
  --wb-gutter: 12px;
```

and change that block's comment to: `Layout tokens: the canvas's gutter, the sidenav's width, and how tall the open navlog sheet may grow inside the right column.`

- [ ] **Step 2: Canvas.** Nothing to add: `body` already has `bg-wb-bg`.

- [ ] **Step 3: Map corner.** Replace the `.wb-map .leaflet-bottom.leaflet-right` rule and its comment with:

```css
/*
 * The zoom and attribution controls share Leaflet's bottom-right corner (see
 * `RouteMap`). The weather chips own the top of the map panel, so nothing
 * covers the corner; the OpenStreetMap tile policy requires the attribution to
 * stay visible.
 */
.wb-map .leaflet-bottom.leaflet-right {
  bottom: 4px;
  right: 2px;
}
```

and in the `prefers-reduced-motion` list remove `.wb-map .leaflet-bottom.leaflet-right,`.

- [ ] **Step 4: Tabs.** Replace the `.wb-tab` rules (the comment "The phone's tabs…", `.wb-tab`, `.wb-tab[aria-selected="true"]`, `.wb-tab:disabled`) with:

```css
/* The phone's bottom tab bar: icon over label, 52px targets, ink when selected. */
.wb-tab {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 52px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--wb-muted);
}

.wb-tab[aria-selected="true"] {
  font-weight: 650;
  color: var(--wb-text);
}

.wb-tab:disabled {
  opacity: 0.45;
}

/* A new result on a tab the pilot is not looking at. */
.wb-tab-dot {
  position: absolute;
  top: -2px;
  right: -4px;
  width: 8px;
  height: 8px;
  border: 2px solid var(--wb-surface);
  border-radius: 999px;
  background: var(--wb-accent);
}

/* The phone's top-row buttons: 44px round targets. */
.wb-icon-button {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: var(--wb-surface);
  color: var(--wb-text);
}

.wb-icon-button:disabled {
  opacity: 0.6;
}

.wb-icon-button-primary {
  border-color: var(--wb-text);
  background: var(--wb-text);
  color: var(--wb-surface);
}

/* The phone's navigation drawer and the scrim behind it. */
.wb-scrim {
  background: rgb(13 13 13 / 0.3);
}

.wb-drawer {
  animation: wb-drawer-in 200ms ease-out;
}

@keyframes wb-drawer-in {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(0);
  }
}
```

The `.wb-tab-dot` uses the accent: a new result is a "selection" cue, and the spec allows cobalt for selection. (If you consider that a fourth accent use, use `var(--wb-text)` instead and say so in the commit.)

- [ ] **Step 5: Motion.** In the `@media (prefers-reduced-motion: reduce)` block add `.wb-drawer` to the selector list and add, inside the same media block, `.wb-drawer { animation: none; }` (as its own rule, since the list sets `transition`).

- [ ] **Step 6: Print.** In `@media print`:
  - Change the `.wb-root, .wb-sheet-wrap` rule to also set `display: block !important;` and `padding: 0 !important;` (each with the same biome-ignore comment line the others use).
  - Add:

```css
  .wb-print-hide {
    /* biome-ignore lint/complexity/noImportantStyles: print must override the layout's screen styles */
    display: none !important;
  }
```

  - In the `.wb-sheet-actions, .wb-sheet-grip, .wb-sheet-tabs, .wb-sheet .wb-button` rule, remove `.wb-sheet-grip,` and `.wb-sheet-tabs,` (those elements no longer exist).
  - Update the block comment's "The sheet's ancestors are a full-viewport, overflow-hidden root and an absolutely positioned wrapper" to "The sheet's ancestors are a full-viewport grid (desktop) or flex column (phone)".

- [ ] **Step 7: Remove dead rules.** Delete `.wb-dock textarea::placeholder`'s comment reference "(the textarea is ~20 characters wide at 380px)" → "(the textarea can be narrow)". Leave the rule.

- [ ] **Step 8: Verify** `grep -n "wb-dock-width\|wb-sheet-grip\|wb-sheet-tabs\|wb-map-inset-bottom" examples/navlog/web/app -r` returns nothing; run lint and the full web test suite (design rules included). Commit `theme.css`: `feat(navlog-web): layout tokens, tab bar, drawer and print rules for the docked shell`.

---

### Task 9: Mirror into the template

- [ ] **Step 1:** Run `pnpm --filter @b4run/devkit exec vitest --run test/templates.test.ts` — expect FAIL (drift).

- [ ] **Step 2:** Copy:

```bash
E=examples/navlog/web/app; T=packages/devkit/templates/app-navlog/web/app
cp $E/theme.css $T/theme.css
for f in memory-anchor.ts MemoryPanel.tsx SideNav.tsx Drawer.tsx ChatDock.tsx RouteMap.tsx WorkbenchLayout.tsx AppShell.tsx; do cp $E/components/$f $T/components/$f; done
for f in MemoryPanel SideNav ChatDock WorkbenchLayout; do cp $E/components/$f.test.tsx $T/components/$f.test.tsx.template; done
# and AppShell.test.tsx if Task 7 changed it:
git diff --quiet HEAD~8 -- $E/components/AppShell.test.tsx || cp $E/components/AppShell.test.tsx $T/components/AppShell.test.tsx.template
```

(Simpler and safer: run `diff -rq $E $T` afterwards and copy anything it reports as differing, remembering the `.template` suffix for tests.)

- [ ] **Step 3:** In `packages/devkit/test/templates.test.ts` change the `.test.tsx.template` count `toHaveLength(15)` to `toHaveLength(16)` (SideNav.test.tsx is new).

- [ ] **Step 4:** `pnpm --filter @b4run/devkit test` — expect PASS. Commit the template files and `templates.test.ts`: `chore(devkit): mirror the navlog docked shell into the scaffold template`.

---

### Task 10: Harness journeys

**Files:**
- Modify: `test/harness/workbench-suggestions.ts`
- Modify: `test/harness/workbench-suggestions.test.ts`

The harness drives the scaffolded app at desktop size. The create button's accessible name is now its visible text, "New plan"; there is no "Threads" button.

- [ ] **Step 1: `workbench-suggestions.ts`, `startSuggestion`.** Change `.getByRole("button", { name: "+ New conversation", exact: true })` to `.getByRole("button", { name: "New plan", exact: true })`. Replace the "THE `+` IS LOAD-BEARING…" paragraph of its doc comment with:

```ts
 * The sidenav's create button is named by its visible text, `New plan`
 * (`SideNav.tsx`; the `+` beside it is decorative). It cannot collide with an
 * untitled thread row, which reads `New conversation`
 * (`UNTITLED_THREAD_LABEL`). Exact match, so a renamed button fails loudly
 * instead of clicking a row.
```

- [ ] **Step 2: The approval journey's focus entry.** Change

```ts
  // Keyboard only: from the dock's header into the conversation, Tab to the
  // card's primary action and press Enter. The message box is disabled while
  // the approval is open, so the dock's Threads button is the entry point.
  const allowOnce = card.getByRole("button", { name: "Allow once", exact: true })
  await page
    .getByRole("button", { name: "Threads", exact: true })
    .focus({ timeout: LOCATOR_TIMEOUT_MS })
```

to

```ts
  // Keyboard only: from the sidenav into the conversation, Tab to the card's
  // primary action and press Enter. The message box is disabled while the
  // approval is open, so the sidenav's New plan button is the entry point;
  // the thread rows and Memory sit between it and the chat.
  const allowOnce = card.getByRole("button", { name: "Allow once", exact: true })
  await page
    .getByRole("button", { name: "New plan", exact: true })
    .focus({ timeout: LOCATOR_TIMEOUT_MS })
```

- [ ] **Step 3: `workbench-suggestions.test.ts`.** Replace every `'click page > button="+ New conversation"'` with `'click page > button="New plan"'`, `'focus page > button="Threads"'` with `'focus page > button="New plan"'`, and in the "starts each of the three journeys" test the filter `call.includes('button="+ New conversation"')` with `call.includes('button="New plan"')`. Rewrite the "fails with Playwright's own message when the create button is missing" test's comment to "The sidenav's create button is `New plan`; a rename must not stay green." and its two `'button="+ New conversation"'` strings to `'button="New plan"'`.

- [ ] **Step 4:** `pnpm verify:harness:self-test` — expect PASS. Commit both files: `test(harness): workbench journeys use the sidenav's New plan`.

---

### Task 11: Docs

**Files:**
- Modify: `examples/navlog/web/README.md` (the "## Layout" bullets)
- Modify: `packages/devkit/templates/app-navlog/web/README.md` (its bullet list near the top)
- Modify: `apps/web/content/docs/recipes/flight-planner-web-ui.mdx`
- Regenerate: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: Example README.** In "## Layout", replace the **Route map**, **Chat dock**, **Weather strip** and **Navlog sheet** bullets' placement words and the **Phones** bullet:
  - Add a first bullet: `- **Sidenav** (left, \`app/components/SideNav.tsx\`) — the wordmark, **New plan**, the recent threads (\`app/components/ThreadRail.tsx\`, each titled from its first user message) and **Memory**, which counts the candidates waiting for review and scrolls to them.`
  - Route map: "(full viewport, …)" → "(right column, …)"; "then fits the route between the floating panels" → "then fits the route inside its panel".
  - Chat dock → **Chat** "(middle column, `app/components/ChatDock.tsx`) — the thread title and run status, the memory panel (…unchanged text…), and the chat (…)". Remove "the brand", "+ New conversation" and the "Threads" disclosure from it.
  - Weather strip: "(floating top right, …)" → "(along the top of the map, …)".
  - Navlog sheet: "(floating bottom, …)" → "(under the map, …)".
  - Phones: replace with `- **Phones** (under 768 px) — a top row (menu, wordmark, New plan), one full-screen panel, and a bottom tab bar: **Chat**, **Map** and **Navlog** (one card per leg). Map and Navlog get a dot when a new navlog arrives while you are in the chat, and an approval always brings you back to Chat. The menu opens the sidenav as a drawer. Only the layout that applies is rendered (\`app/lib/use-media-query.ts\`), so there is always exactly one chat.`
  - In "## Restyling it", "`--wb-dock-width`, `--wb-sheet-max` and `--wb-gutter` for the layout" → "`--wb-nav-width`, `--wb-sheet-max` and `--wb-gutter` for the layout".

- [ ] **Step 2: Template README.** Apply the same facts to its shorter bullets (Route map "A full-viewport" → "A"; Chat dock → Chat in the middle column without "+ New conversation"/"Threads"; add a Sidenav bullet; phone sentence if present), and the same token rename in its "Restyling it". Keep `{{appName}}`.

- [ ] **Step 3: Recipe page** (`apps/web/content/docs/recipes/flight-planner-web-ui.mdx`):
  - Line 3: "CopilotKit's stock `<CopilotChat>` sits in a floating dock over a route map, inside" → "CopilotKit's stock `<CopilotChat>` sits in the middle column, between a sidenav of threads and the route map, inside".
  - The "**Thread rail:**" bullet → `- **Sidenav:** "New plan", the list of threads (each titled from its first user message), and Memory with a count of the candidates waiting for review.`
  - Line ~114 "selecting a row in the rail would change nothing" → "selecting a thread in the sidenav would change nothing".
  - Line ~133 "So the rail keeps its own list" → "So the sidenav keeps its own list"; "The rail holds ids, titles and recency only." → "The list holds ids, titles and recency only."
  - Line ~177 "shows each event as a muted line in the dock above the chat" → "shows each event as a muted line in the chat column above the conversation".
  - Line ~257 "renders the candidates in the thread rail with Approve and Delete on each" → "renders the candidates above the conversation with Approve and Delete on each, and the sidenav's Memory item shows how many are waiting".
  - Search the page for any other "dock", "rail" or "floating" describing the layout and fix it the same way.

- [ ] **Step 4:** `node scripts/check-docs.mjs` — expect exit 0. Commit the three docs files: `docs(navlog-web): the docked shell in the READMEs and the recipe page`.

- [ ] **Step 5: SEO manifest** (must follow the content commit): `pnpm --dir apps/web seo:lastmod`, then `pnpm --dir apps/web seo:lastmod:routes`. Expect only the recipe route's entry to change. Commit `apps/web/app/seo/lastmod.generated.json`: `chore(web): lastmod for the flight-planner recipe`.

---

### Task 12: Verify and open the stacked PR

- [ ] **Step 1: Gates.** `pnpm build`, then `pnpm --filter @b4-example/navlog-web lint && pnpm --filter @b4-example/navlog-web typecheck && pnpm --filter @b4-example/navlog-web test`, `pnpm --filter @b4run/devkit test`, `pnpm --filter @b4-example/navlog-web test:e2e`, `pnpm verify:harness:self-test`, `pnpm --filter @b4run/web test` (the lastmod gate), `node scripts/check-docs.mjs`.
- [ ] **Step 2: Harness.** `pnpm verify:harness:framework` (about 7 minutes; run nothing else heavy meanwhile).
- [ ] **Step 3: Live check** in the browser pane (servers via `.claude/launch.json`: `navlog-server`, `navlog-web`) at 1280×800 and at the `mobile` preset: three columns with no top bar; New plan; switch threads from the sidenav; Memory count after "Teach it the aircraft" and the scroll-to; plan KSTP → KRST and open/close the navlog sheet (the map re-fits); file through the approval; Print shows the navlog alone; on the phone the tab bar, dots, drawer (Escape, scrim, choose a thread), and approval returning to Chat; connect screen with the server stopped.
- [ ] **Step 4: PR.** `git push -u origin blove/navlog-lla-layout`, then `gh pr create --base blove/navlog-lla-look` titled `navlog-web: docked shell with a sidenav and a phone tab bar`, body summarising the spec sections 2–3, the Memory decision, the harness rename, and verification, ending with the Claude Code attribution line. Bind it with the ccd_pr tools. When #1006 merges, retarget this PR to `main` (`gh pr edit --base main`) and rebase if GitHub asks.
