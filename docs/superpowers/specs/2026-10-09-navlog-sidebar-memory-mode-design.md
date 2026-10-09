# Navlog web: collapsible sidebar, Memory mode, alignment polish

Date: 2026-10-09
Scope: `examples/navlog/web` (and its byte-parity twin in
`packages/devkit/templates/app-navlog/web`)
Builds on: `2026-10-08-navlog-lla-shell-design.md` (PRs #1006, #1008, merged)

## Goal

Three changes to the docked shell, delivered as one PR:

1. The desktop sidebar collapses to an icon rail.
2. Memory review becomes a mode, toggled from the sidebar, that takes the place
   of the map column. The inline memory panel leaves the chat.
3. An alignment and detail pass: one spacing scale, one header-row height, one
   radius rule, one icon set.

## Decisions

| Question | Decision |
|---|---|
| Collapsed sidebar | A 64px icon rail (not fully hidden). |
| Memory mode placement | Replaces the whole right column (map and navlog). |
| New-candidate signal | The sidebar Memory badge only (rail included); the chat's own activity step already shows the proposal. |
| Delivery | One PR on `main`. |

## 1. Collapsible sidebar (desktop, 1024px and up)

**Expanded (200px):** the top row holds the wordmark (left) and a collapse
button (right, a sidebar-panel icon, `aria-label="Collapse sidebar"`). Below:
New plan, "Recent" and the thread list, and Memory pinned at the bottom.

**Collapsed (64px):** a column of identical 44px icon buttons, centred:

- the top row holds only the expand button (`aria-label="Expand sidebar"`), in
  the same position as the collapse button so the toggle never moves;
- New plan as an ink `+` button, accessible name "New plan";
- the thread list is hidden;
- Memory at the bottom, with its count badge on the icon's top-right corner.

Every icon button has an `aria-label` and a tooltip shown on hover and on
keyboard focus. The wordmark stays the page's `h1` but is visually hidden
(`sr-only`) while collapsed.

**Behaviour:**

- The grid's first column transitions between 200px and 64px over the shared
  motion token (200ms ease-out); no transition under `prefers-reduced-motion`.
- The state persists in `localStorage` under `b4.workbench.sidebar`
  (`"expanded" | "collapsed"`), read after hydration (default expanded, so the
  server render and first client render match). Reads and writes are wrapped
  in try/catch.
- The toggle carries `aria-expanded` and `aria-controls` (the sidebar's id).
- Phones: the drawer always shows the expanded sidebar; there is no collapse
  control there.

## 2. Memory mode

**Entry and exit.** The sidebar Memory item becomes a toggle (`aria-pressed`).
Pressed, it uses the selected style (cobalt text on the `--wb-rail` fill, as the
current thread does). It is disabled only when the count is zero *and* the mode
is off, so the mode can always be left. The mode is left by: pressing Memory
again, the panel's close button (`aria-label="Close memory"`), Escape while
focus is inside the panel, starting a new plan, or switching threads.

**Desktop.** The right column shows one Memory panel at full height in place of
the map and navlog. The map column stays mounted beneath it with `invisible`
and `inert`, so the map keeps its view and the sheet its open state.

- Header row (56px, see §3): "Memory" and the count in mono, and the close
  button.
- Body: every candidate (no `MAX_VISIBLE` cap). Each row: the candidate text;
  its namespace and tags as muted mono metadata; Approve (ink pill) and Delete
  (outline pill). Accessible names unchanged (`Approve: …`, `Delete: …`).
- The existing outcome and failure messages (`role="status"`) sit at the top of
  the body.
- Empty: "Nothing waiting for review." and one muted line: "When the planner
  proposes something to remember, it appears here for you to approve or
  delete."
- The region keeps `aria-label="Memory candidates"`.
- Focus: entering moves focus to the panel's heading (`tabIndex={-1}`); leaving
  returns it to the sidebar Memory item.

**Chat.** The inline memory panel above the conversation is removed;
`ChatDock` no longer takes a `memory` prop.

**Phone (under 1024px).** Memory in the drawer closes the drawer and shows the
Memory panel full-screen in place of the active panel. The tab bar stays, with
no tab selected (`aria-selected="false"` on all three); tapping any tab leaves
the mode.

**State and data.** `MemoryPanel` keeps the loading and decision logic and
`onCountChange`; `MemoryPanelView` stays pure and gains the header, the
uncapped list, the empty state and an `onClose` prop. `MemoryPanel` moves from
the chat column into the layout's right column (desktop) and the phone panel
stack, and stays mounted while hidden so the count keeps updating.
`memory-anchor.ts` and `revealMemoryPanel` are deleted.

**Tests and journeys that change with it:**

- `test/harness/workbench-suggestions.ts` teach journey: click the sidebar's
  Memory button before waiting for the "Memory candidates" region; update its
  unit test's golden call list.
- `docs/brand/demo/capture.mjs` memory beat and the fake pages in
  `docs/brand/demo/demo.test.mjs`: the same.
- The demo video's `APP_FOCUS` presets remain out of scope (next re-record).

## 3. Alignment and details

Rules (ui-ux-pro-max: `spacing-scale`, `effects-match-style`,
`icon-style-consistent`, `motion-consistency`; the icon-rail pattern itself had
no database match and follows general practice):

**Spacing scale (4/8).** Every panel's content inset is 16px: sidebar, chat
header and transcript, Memory rows, map chips (16px from the panel's top and
right), navlog sheet. Gaps: 8px between controls in a row, 12px between groups,
12px canvas gutters (unchanged).

**Header row (56px).** The sidebar's top row, the chat header and the Memory
panel header are each exactly 56px tall, start at the canvas gutter, and centre
their content vertically. The map's chips sit on the same 16px top line.
Measured before: sidebar wordmark row 29px at y=21; chat header 43px at y=13.

**Radius.** Panels 14px. Every button, chip, input and badge a pill. List rows
(thread rows, Memory rows) 10px. Measured before: rows and controls mixed
7/14/999px.

**Type.** 13px for controls and rows; 12px for labels and metadata ("Recent"
sentence case, muted, on the 16px inset); 14px semibold for panel titles;
JetBrains Mono with tabular figures for numbers. Nothing under 12px except the
map attribution.

**Icons.** One inline set (24×24 viewBox, 2px stroke, round caps and joins) in a
single `icons.tsx`, used by the rail, the phone top row, the tab bar and panel
headers. It replaces the scattered inline paths and the `▸` / `+` text glyphs.

**Details.**

- Memory item and badge align with the thread rows' text.
- Truncated titles carry the full text in `title`.
- Map zoom control and attribution share the bottom-right corner on the 16px
  inset with an 8px gap.
- The composer's left edge aligns with the transcript's 16px inset.
- One motion token (`--wb-motion: 200ms ease-out`) for every transition; none
  under reduced motion.

## 4. Testing and delivery

- Unit: `SideNav` (expanded/collapsed render, toggle `aria-expanded`, persisted
  state, tooltips present, Memory `aria-pressed` and disabled rule);
  `WorkbenchLayout` (Memory mode swaps the right column, the map column is
  `invisible` + `inert` not unmounted, exits on close/Escape/new plan/thread
  switch, phone tabs deselected in the mode); `MemoryPanelView` (uncapped list,
  empty state, close button); `ChatDock` (no memory slot).
- A layout test asserting the 56px header class on the three header rows.
- `app/design-rules.test.ts` unchanged and green.
- `pnpm verify:harness:framework` (the teach journey changes); `pnpm
  test:brand-demo`.
- Live check at 1440×900 and 375px, re-measuring the §3 numbers.
- READMEs (example and template) and `apps/web/content/docs/recipes/flight-planner-web-ui.mdx`
  updated where they describe the memory panel's placement, then `pnpm --dir
  apps/web seo:lastmod`.
- Mirror every `app/` change into the template; update the template test-file
  count if a test file is added or removed.
