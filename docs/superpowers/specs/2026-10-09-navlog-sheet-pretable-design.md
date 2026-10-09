# Navlog sheet: the legs table first, on pretable

Date: 2026-10-09
Scope: `examples/navlog/web` (and its byte-parity twin in
`packages/devkit/templates/app-navlog/web`)
Builds on: #1006, #1008, #1009 (merged)

## Goal

Make the navlog's legs table the primary element of the sheet under the map,
rendered with pretable (`@pretable/react`, our own grid), scrolling inside its
own region while the window stays fixed. The big-number totals, the ICAO flight
plan and the planning brief move behind tabs.

Out of scope: redesigning the planning brief and structured blocks ("Watch
for", numbers, assumptions), hashbrown rendering in the chat, and manual
waypoint entry on the map. Those are later sub-projects; this one gives the
brief its own tab to land in.

## Decisions

| Question | Decision |
|---|---|
| Verdict placement | A slim strip above the table (not the large card). |
| Totals, flight plan, brief | Tabs inside the sheet: Legs (default), Totals & plan, Brief. |
| Phones | Keep the per-leg cards on the Legs tab; pretable on desktop only. |
| Map highlight | Follows the selected row (pretable has no hover callback). |
| Print | A print-only plain table, so every leg prints (the grid virtualizes). |

## 1. Sheet structure (desktop)

The sheet stays a disclosure under the map. Collapsed: the existing one-line
summary (route, distance, ETE, fuel). Open, it grows to `--wb-sheet-max` and
holds, top to bottom:

1. **Header row** (56px, `wb-header-row`): route title, Print, Copy FPL.
2. **Verdict strip:** one row with the go/no-go pill and its reason on one line
   (truncated, full text in `title`). Clicking it selects the Brief tab. It
   replaces the large verdict card in the open sheet.
3. **Tabs:** Legs · Totals & plan · Brief (`role="tablist"`, arrow-key
   switching, roving `tabIndex`). Legs is the default.
4. **Tab body** filling the remaining height, one scroll region per tab:
   - **Legs:** the pretable grid (`NavlogGrid`), then a fixed totals strip
     (distance, ETE, fuel burned, fuel at landing, reserve) in mono tabular
     figures; reserve in the danger colour under 45 minutes. The strip does
     not scroll with the grid.
   - **Totals & plan:** the existing totals tiles, then `FlightPlanBlock`.
   - **Brief:** `PlanningBrief` as today.

`SheetControl.openSheet` opens the sheet and selects Legs.

## 2. The grid (`NavlogGrid`)

A new `app/components/NavlogGrid.tsx` wrapping `Pretable`:

- **Columns:** Leg (pinned left, `flex` width) and TC, Var, MC, Wind, WCA, MH,
  TAS, GS, Dist, Rem, ETE, ETA, Fuel, Fuel rem — the same formatters and header
  tooltips as `NavlogTable` (shared, not copied). Figures right-aligned, mono,
  tabular; MH and GS bold.
- **Behaviour:** sorting and filtering off (route order is the meaning);
  resize and reorder allowed; copy-with-headers on.
- **Map link:** `onSelectedRowIdChange` reports the selected leg; the layout
  maps it to the highlighted leg (replacing the hover highlight on desktop).
  Escape clears the selection.
- **Styling:** `@pretable/ui`'s grid skin imported once; its tokens mapped onto
  `--wb-*`, Hanken Grotesk and JetBrains Mono in `theme.css`, with no shadows
  or uppercase (the design-rules test scans `theme.css`).

## 3. Print

`NavlogTable` (the current plain table) renders inside the sheet as
`hidden print:table`, so Print keeps its current output: every leg, the totals,
the flight plan and the brief, regardless of the selected tab. The grid is
`print:hidden`.

## 4. Phones (under 1024px)

The Navlog tab shows the same verdict strip and tabs. Legs keeps today's
per-leg cards (`NavlogTable` `variant="cards"`) with the totals strip pinned
below them; the other tabs match desktop.

## 5. Dependency

- Add `@pretable/react` and `@pretable/ui` (`^0.20.2`) to
  `examples/navlog/web/package.json` and to
  `packages/devkit/templates/app-navlog/web/package.json.template`; update
  `pnpm-lock.yaml`.
- Check the template dependency guards in `packages/devkit/test/` (e.g.
  `template-copilotkit-dependencies.test.ts`) and the harness's generated-app
  install still pass.
- Gaps found in pretable are fixed upstream in `cacheplane/pretable`, not worked
  around here. This design needs none.

## 6. Testing and delivery

- `NavlogSheet` tests: verdict strip, three tabs with roles and arrow keys, Legs
  default, `openSheet` → Legs, totals strip on Legs with the reserve warning,
  the print-only table present with every leg.
- `NavlogGrid` tests: column order with Leg pinned, sort/filter off, selection
  reports the leg index, Escape clears. pretable is stubbed at its public API
  in unit tests; the real grid is checked in the browser.
- Step views: "See the navlog sheet" lands on Legs.
- `app/design-rules.test.ts` green.
- Harness and demo capture: audit their "Navlog" region and distance
  assertions against the new markup; update if needed;
  `pnpm verify:harness:framework` and `pnpm test:brand-demo`.
- Live check at 1440×900 (grid fills the sheet and scrolls on its own; the
  window does not; totals strip fixed; row selection highlights the leg;
  Print outputs every leg) and 375px (cards and tabs).
- READMEs and `apps/web/content/docs/recipes/flight-planner-web-ui.mdx` where
  they describe the sheet, then `pnpm --dir apps/web seo:lastmod`.
- Mirror every `app/` change into the template. One PR off `main`; re-fetch
  `main` before merging (lockfile).
