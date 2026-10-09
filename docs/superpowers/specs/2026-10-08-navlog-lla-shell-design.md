# Navlog web: LLA shell redesign

Date: 2026-10-08
Scope: `examples/navlog/web` (the navlog example's Next.js client)

## Goal

Restyle the navlog web client so its shell follows CopilotKit's layout (rounded
panels on a soft grey canvas) drawn to LiveLoveApp's design rules (Hanken
Grotesk and JetBrains Mono, ink plus one cobalt accent, pill buttons, no
gradients, glass, shadows, uppercase or letter-spacing). Behaviour and data flow
do not change; this is a look and layout change.

## Decisions

| Question | Decision |
|---|---|
| Style direction | CopilotKit layout, LLA rules. Solid fills, no blur. |
| Brand in the shell | "B4.run / navlog" as a plain ink wordmark. No LLA credit, no gradient mark. |
| Desktop layout | Docked panels on a grey canvas. Nothing floats over the map. |
| Top bar | None. The wordmark moves to the top of the sidenav. |
| Threads and memory | A slim labelled left sidenav, about 200px, always open. |
| Dark mode | Removed. Light only. |
| Mobile | Top row, one full-screen panel, bottom tab bar (Chat, Map, Navlog); the sidenav becomes a drawer. |
| Status colours | Kept as a data-only exception to LLA's one-accent rule. |
| Delivery | Two PRs: look first, then layout. |

The "File plan" button seen in early mockups is not a real control and is not
added. Filing stays in the chat, through the agent's `fileFlightPlan` approval
card.

## 1. Visual foundation

### Fonts

Load Hanken Grotesk (text) and JetBrains Mono (numbers, identifiers, navlog
figures) with `next/font/google` in `app/layout.tsx`, exposed as CSS variables
that `theme.css` uses. They replace the system font stack and the
`ui-monospace, SFMono-Regular, Menlo, monospace` fallback in `theme.css`.

### Palette

`app/theme.css` keeps its role ("restyling the app is editing this file") and its
`--wb-*` variables re-exported through `@theme inline`. The values change:

| Token | Value | Role |
|---|---|---|
| `--wb-bg` | `#f4f4f5` | Grey canvas behind the panels |
| `--wb-surface` | `#ffffff` | Panels |
| `--wb-border` | `#e4e4e7` | 1px panel and control borders |
| `--wb-text` | `#0d0d0d` | LLA ink; also the primary button fill |
| `--wb-muted` | `#52525b` | Secondary text |
| `--wb-accent` | `#002fa7` | LLA cobalt: links, the focus ring, the selected thread only |
| `--wb-radius` | `14px` | Panels; buttons and chips are pills (`999px`) |

Primary buttons the app owns ("New plan", the connect screen's retry) are ink
pills with white text. Secondary buttons (`wb-button`: Print, Memory's Approve
and Delete) are white pills with a `--wb-border` outline. The activity kit's
approval card buttons follow whatever the `--b4-activity-*` mapping allows; the
kit itself is not changed. `wb-focus` draws its ring
in `--wb-accent`.

### Removed

- `--wb-accent-from` / `--wb-accent-to` (the orange-to-pink gradient) and both of
  its roles: the brand mark and the primary action.
- Every `@media (prefers-color-scheme: dark)` block and the `data-wb-theme`
  overrides. `color-scheme` becomes `light`.
- The Leaflet tile inversion filter.
- All `uppercase`, positive letter-spacing, `shadow`/`box-shadow`, `gradient` and
  `backdrop-blur` uses in `theme.css`, `ThreadRail.tsx` and `MemoryPanel.tsx`.

### Status colours (the data-only exception)

These keep distinct colours, retuned for a white surface:

- Flight categories: VFR green, MVFR blue, IFR red, LIFR magenta (FAA convention).
- The go/no-go verdict.
- Approval amber ("Awaiting approval").
- Denied red (the activity kit's `denied` step).
- The activity kit's running colour.

They appear only as small chips or dots beside a text label, never as panel
fills, large areas or decoration. The text label always carries the meaning.

### Activity kit and CopilotChat

The `--b4-activity-*` mapping in `theme.css` stays and points at the new tokens,
so `<B4Activity>`, the step cards and CopilotChat follow without further changes.

### Map

The same OpenStreetMap tiles, attribution and tile policy. A CSS desaturation
filter on the tile pane turns the base map grey. The route line is ink with its
existing casing; category markers keep their status colours.

### Enforcement

Add `app/design-rules.test.ts`, modelled on LLA's `src/lib/design-rules.test.ts`.
It scans every `.ts`, `.tsx` and `.css` file under `app/` (test files excluded)
and fails on:

- `uppercase`
- positive letter-spacing (`tracking-wide`, `tracking-wider`, `tracking-widest`,
  positive `tracking-[…]`, `letter-spacing` with a positive value)
- `gradient`, `shadow-`, `box-shadow`, `drop-shadow`, `backdrop-blur`
- `prefers-color-scheme: dark`
- any `next/font/google` import other than `Hanken_Grotesk` and `JetBrains_Mono`

`tracking-tight` (negative) is allowed.

## 2. Desktop layout (768px and wider)

The window is the grey canvas with a 12px gutter around and between three
columns, each the full window height. There is no top bar.

```
┌────────────┬──────────────────┬────────────────────────────┐
│ SideNav    │ Chat             │ Map (weather chips on top) │
│ ~200px     │ ~34%, min 360px  │                            │
│            │                  ├────────────────────────────┤
│            │                  │ Navlog (disclosure)        │
└────────────┴──────────────────┴────────────────────────────┘
```

### SideNav (new `app/components/SideNav.tsx`)

Replaces `ThreadRail` and the dock header's toggles. Top to bottom:

1. The "B4.run / navlog" wordmark: the page's one `h1`.
2. An ink "New plan" pill (calls `onNewConversation`).
3. "Recent": the thread list from `ThreadSource`, titled as today
   (`titleFor`, `UNTITLED_THREAD_LABEL`). The current thread has cobalt text on a
   `--wb-bg` fill and `aria-current="page"`.
4. "Memory", pinned to the bottom.

"Memory" opens `MemoryPanel` in the chat column in place of the conversation,
with a back control that returns to the conversation. This mirrors how the dock
swaps its body today.

### Chat (`ChatDock`, simplified)

The header row holds only the thread title (`h2`) and the status from
`statusPresentation` (Ready, Running, Awaiting approval). The brand, "+ New" and
"Threads" move to the sidenav. `RunError`, `DropNotices`, `NavlogChat` and
`DemoSuggestions` keep their places.

### Map and navlog

The right column stacks two panels:

- **Map** (`RouteMap`): always present. `WeatherStrip` chips sit inside its top
  edge.
- **Navlog** (`NavlogSheet`, `variant="table"`): present only once a navlog
  exists. It keeps the disclosure: collapsed shows the route and totals on one
  line; open grows to about 55% of the column and the map shrinks. Print still
  prints the full navlog in either state.

With nothing floating over the map, `WorkbenchLayout` drops `DOCK_PAD`,
`STRIP_PAD`, `SHEET_COLLAPSED_PAD`, `SHEET_OPEN_SHARE` and the measured strip
height used for the route fit. The map fits the route inside its own panel with
a small fixed padding, and refits when its panel resizes (for example when the
navlog opens).

### Connect screen

`ConnectScreen` still replaces the whole shell when the B4.run server is down,
restyled as one centred white panel on the grey canvas with the ink wordmark.

### Unchanged

All of `AppShell`'s behaviour: thread switching, the three error surfaces,
approvals, the hover-leg map highlight, `SheetControlContext`, drop notices and
memory refresh.

## 3. Mobile layout (narrower than 768px)

Top to bottom:

1. A slim top row on the grey canvas: a menu button (left), the wordmark `h1`
   (centre), an ink "+" pill for New plan (right). Each is a 44px touch target.
2. One full-screen panel: Chat, Map or Navlog, with an 8px gutter.
3. A bottom tab bar (Chat, Map, Navlog), padded for
   `env(safe-area-inset-bottom)`. The active tab is ink, the others muted.

### Tab rules

Carried over from today's phone sheet logic:

- Map and Navlog are disabled until a navlog exists. A thread switch that leaves
  no navlog returns to Chat.
- When a new navlog arrives while Chat is showing, Map and Navlog show a small
  dot, cleared when that tab is visited.
- An awaiting approval always switches to Chat.
- `SheetControl.openSheet` switches to the Navlog tab.

### Tabs

- **Chat** (default): `ChatDock` with its title and status row.
- **Map**: `RouteMap` with the weather chips on its top edge. The map stays
  mounted when hidden (hidden with `visibility`, not unmounted) and calls
  Leaflet's `invalidateSize()` when the tab is shown.
- **Navlog**: `NavlogSheet` with `variant="cards"` and `collapsible={false}`,
  verdict at the top.

### Drawer

The menu button opens `SideNav` as a left drawer, 80% of the width, over a scrim.
It is a modal dialog: focus is trapped, Escape and a scrim tap close it, and it
closes after choosing a thread or "Memory". "Memory" opens in the Chat tab's
panel. The drawer slides in once; under `prefers-reduced-motion` it appears
without motion.

### Removed

The bottom sheet's grip, peek and raised states, `PHONE_SHEET_SHARE`,
`PHONE_STRIP_PAD`, `PHONE_PEEK_PAD`, `PHONE_TOP_PAD`, and the weather row above
the sheet.

## 4. Testing, docs and delivery

### Tests

- Update the existing component tests where they assert structure:
  - `WorkbenchLayout.test.tsx`: the docked columns; the phone tab rules
    (disabled tabs, new-result dot, approval forcing Chat, `openSheet`).
  - `ChatDock.test.tsx`: the header holds the title and status only.
  - `ThreadRail.test.tsx` becomes `SideNav.test.tsx`: the wordmark `h1`, New
    plan, `aria-current` on the current thread, Memory; the drawer's focus trap,
    Escape and close-on-select.
  - `AppShell.test.tsx`: connect screen and error surfaces unchanged.
- Add `app/design-rules.test.ts`.
- `e2e/copilotkit-v2.spec.ts` covers the transport, not the layout; it must pass
  unchanged.
- Live check in a browser before merging each PR, at desktop width and at 375px:
  a KPAO → KMRY plan through an approval, a thread switch, Memory, Print, and the
  connect screen with the server stopped.

### Docs

- `examples/navlog/web/README.md`: replace the floating dock, sheet, dark map and
  phone bottom sheet descriptions.
- `apps/web/content/docs/recipes/flight-planner-web-ui.mdx`: replace "a floating
  dock over a route map", the "Thread rail" bullet and "renders the candidates in
  the thread rail". Run `pnpm --dir apps/web seo:lastmod` after committing the
  change and commit the manifest in the same PR.
- Out of scope, follow-up: re-record the navlog demo video in the root README,
  which shows the old UI.

`@b4-example/navlog-web` is private, so no changeset.

### Constraints found while planning

- **Scaffold template parity.** Every file under `examples/navlog/web/app` has a
  byte-for-byte twin under `packages/devkit/templates/app-navlog/web/app` (test
  files with a `.template` suffix), enforced by
  `packages/devkit/test/templates.test.ts`, which also counts the template's
  test files. Both PRs mirror every change there. The template's own
  `web/README.md` is written separately and is updated by hand.
- **The workbench harness.** `test/harness/workbench-*.ts` drives the scaffolded
  app in Chromium (part of `harness-verify` in `validate`) by accessible name:
  "+ New conversation", "Threads", "Send", the "Memory candidates" region,
  `section[aria-label="Chat"]`, `main`, and axe colour-contrast. PR 1 keeps all
  of them. PR 2 removes the "Threads" disclosure, so it updates
  `workbench-suggestions.ts` to pick the thread from the sidenav, and keeps
  "+ New conversation" as the New plan button's accessible name.
- **Memory placement (open for PR 2).** `ChatDock` deliberately shows
  `MemoryPanel` inline above the conversation, and only when a candidate is
  waiting, so a proposed memory is seen without hunting (the teach journey in
  the harness relies on it). Section 2's "Memory opens in place of the
  conversation" would hide new candidates behind a click. PR 2's plan settles
  this before implementation.

### Delivery

Two PRs, merged in order:

1. **Look.** Fonts, palette, light only, restyled components in the current
   floating layout, retuned status colours, the desaturated map, and
   `design-rules.test.ts`. No behaviour change.
2. **Layout.** `SideNav` and its drawer, the docked desktop columns, the phone
   tab bar, removal of the floating-layout clearances, and the README and docs
   page updates.

Each PR passes the full `validate` lane. The web app deploys to Vercel from its
own `vercel.json` project config; `deploy-navlog.yml` ships only the server and
is not touched.
