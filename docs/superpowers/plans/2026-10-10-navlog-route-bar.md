# Navlog route bar and weather by role: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pilot types a route on the map (airports and navaids, with
autocomplete), sees it drawn, and replans once. Weather moves off the map,
into marker panels and a Weather tab grouped by role.

**Architecture:**
- **Data.** A bundled OurAirports snapshot. The web reads it through a Next
  route handler for search; the server reads its navaids for `lookupNavaid`.
- **Draft state.** It lives in the browser, in a pure reducer.
- **Replan.** It sends an ordinary chat message through the same CopilotKit
  agent.
- **En-route stations.** A new parent tool, `findRouteStations`, finds them,
  and the weather subagent briefs them.

**Spec:** `docs/superpowers/specs/2026-10-10-navlog-route-bar-design.md`

**Tech stack:** Next 16, React 19, Tailwind 4, Leaflet, CopilotKit v2,
Vitest (jsdom), B4.run tools (`src/tools/*.ts`, default-exported functions).

## Global rules for every task

- **Template parity.** Every file under `examples/navlog/server/{src,test,data,…}`
  and `examples/navlog/web/{app,data,…}` has a byte-identical twin under
  `packages/devkit/templates/app-navlog/`. Test files take a `.template`
  suffix; check the existing twins for the rule. Mirror in the same commit.
  `packages/devkit/test/templates.test.ts` pins the parity roots and the test
  counts, so update them when you add a root or a test file.
- **Imports.** `src/` imports use `.js`. Tests follow the package's existing
  style.
- **Models.** gpt-5-family models only. Never print or commit secrets.
  `examples/navlog/server/.env` is gitignored.
- **Biome.** Run it scoped, from the package directory:
  `npx biome check --config-path ../../../packages/config-biome/biome.json --write <files>`.
  Never run a bare root `biome check --write`.
- **Shared worktree.** Never use `git checkout`, `git switch` or `git stash`.
  Stage only your own files, by path.
- **Node.** Node 24: `source ~/.nvm/nvm.sh && nvm use 24`.

## File map

| File | Responsibility |
|---|---|
| `examples/navlog/server/scripts/build-waypoints.mjs` | CLI: OurAirports CSVs → `web/data/waypoints.json` + `server/data/navaids.json`. Exports pure `buildSnapshot({ airportsCsv, navaidsCsv, snapshot })`. |
| `examples/navlog/server/test/build-waypoints.test.ts` | Builder against tiny CSV strings. |
| `examples/navlog/server/data/navaids.json` | `{ snapshot, navaids: [[id, name, type, lat, lon, freqKhz, magVarDeg], …] }` |
| `examples/navlog/web/data/waypoints.json` | `{ snapshot, airports: [[id, alias, name, lat, lon], …], navaids: [[id, name, type, lat, lon, freqKhz], …] }` |
| `examples/navlog/server/src/lib/navaids.ts` | Lazy-load and index `navaids.json` (`readFileSync(new URL("../../data/navaids.json", import.meta.url))`). |
| `examples/navlog/server/src/tools/lookupNavaid.ts` | Tool: `{ id }` → `Navaid`. |
| `examples/navlog/server/src/tools/findRouteStations.ts` | Tool: corridor stations via AWC `metar?bbox=`. |
| `examples/navlog/server/src/lib/route-corridor.ts` | Pure: per-leg bbox, cross-track and along-track distances, thinning. Uses `lib/geo.ts`. |
| `examples/navlog/server/test/route-tools.test.ts` | `lookupNavaid` + `findRouteStations` (stubbed fetch through `B4_AWC_BASE_URL` or an `AwcClient` seam, as `weather-tools.test.ts` does). |
| `examples/navlog/server/src/app/navlog/index.ts` (+ `subagents/*/index.ts`) | Prompt and tool allow/deny updates. |
| `examples/navlog/web/app/lib/waypoint-search.ts` | Pure ranking over the snapshot. |
| `examples/navlog/web/app/api/waypoints/route.ts` | `GET ?q=`: guard, cap, search. |
| `examples/navlog/web/app/lib/route-draft.ts` | Pure reducer: draft state, sync from navlog, Replan text, draft geometry. |
| `examples/navlog/web/app/components/RouteBar.tsx` | The combobox bar. |
| `examples/navlog/web/app/components/MarkerPanel.tsx` | METAR/TAF panel for a clicked marker. |
| `examples/navlog/web/app/lib/weather-roles.ts` | Pure: group brief airports into origin / en route / destination. |
| `examples/navlog/web/app/components/WeatherTab.tsx` | The sheet's Weather tab. |
| `examples/navlog/web/app/components/RouteMap.tsx` | Draft dashed line, station markers, clickable markers. |
| `examples/navlog/web/app/components/WorkbenchLayout.tsx`, `AppShell.tsx`, `NavlogSheet.tsx` | Wiring; `WeatherStrip` removed. |

## Task 1: Snapshot builder and data

**Files:** `server/scripts/build-waypoints.mjs`,
`server/test/build-waypoints.test.ts`, `server/data/navaids.json`,
`web/data/waypoints.json`, the template twins, and `templates.test.ts`
(add `"data"` and `"scripts"` to `SERVER_PARITY_ROOTS` and `"data"` to
`WEB_PARITY_ROOTS`).

- [ ] **Test first.** `buildSnapshot` with a 6-row airports CSV and a 5-row
  navaids CSV (quoted fields with commas included). Expected:
  - airports keep only `iso_country === "US"` and type
    `small_airport | medium_airport | large_airport`;
  - the id is `icao_code || gps_code || ident`, with `local_code` as the alias
    when it differs from the id;
  - coordinates are rounded to 4 decimals;
  - navaids keep US types `VOR | VOR-DME | VORTAC | NDB | NDB-DME`, with
    `magnetic_variation_deg` rounded to 1 decimal (null when blank) and
    `frequency_khz` as a number;
  - both outputs carry `snapshot`.
- [ ] **Implement** with a small RFC 4180 CSV parser (no dependency). The CLI
  takes `node scripts/build-waypoints.mjs <airports.csv> <navaids.csv> [--date YYYY-MM-DD]`
  and writes both files, one row per line (`JSON.stringify` per row, joined
  with `,\n`), so diffs stay readable.
- [ ] **Generate** from the CSVs in the scratchpad (`…/scratchpad/ourairports/`)
  with `--date 2026-10-10`, then copy both data files into the template.
- [ ] **Run** the server tests and the devkit tests. Commit:
  `feat(navlog): bundled OurAirports waypoint snapshot`.

## Task 2: Server tools and prompts

- [ ] **`lib/navaids.ts`:**
  - `findNavaid(id: string): Navaid | undefined`, where
    `Navaid = { id, name, type, lat, lon, freqKhz: number | null, magneticVariationDeg: number }`.
  - Variation: signed, east positive, matching `Airport.magneticVariationDeg`;
    OurAirports' sign already follows that.
  - The index is built lazily, once.
- [ ] **`tools/lookupNavaid.ts`:**
  - Upper-cases and trims the id.
  - Throws `no navaid record for X` when the id is unknown.
  - Exports `display` like the other tools (look at `lookupAirport.ts`'s
    `display` export).
- [ ] **`lib/route-corridor.ts`:**
  - `legBoxes(waypoints, corridorNm)`: one `[minLat, minLon, maxLat, maxLon]`
    per leg, expanded by `corridorNm`.
  - `placeOnRoute(point, waypoints)`: `{ alongNm, offsetNm }`, measured
    against the nearest leg, with `alongNm` cumulative from the origin.
  - `thin(stations, max)`: an evenly spaced pick by `alongNm`.
  - Reuse `lib/geo.ts`'s haversine and bearing helpers where they exist.
- [ ] **`tools/findRouteStations.ts`:**
  - Input: `{ waypoints: { id, lat, lon }[], corridorNm?: number, max?: number }`.
  - Calls `awc.getJson("metar", { bbox: "<minLat>,<minLon>,<maxLat>,<maxLon>", format: "json" })`
    once per leg box.
  - Merges the results by `icaoId`, keeps `offsetNm <= corridorNm`, drops ids
    that equal a waypoint id, sorts by `alongNm` and thins to `max`.
  - Returns `{ stations: [{ id, name, lat, lon, alongNm, offsetNm }] }`, with
    distances rounded to whole nm.
  - Fewer than 2 waypoints gives `{ stations: [] }`.
- [ ] **Tests** (`test/route-tools.test.ts`):
  - navaid found, and unknown;
  - corridor filter, ordering, thinning, route airports dropped, and the
    leg-box query count;
  - follow `weather-tools.test.ts` for stubbing AWC.
- [ ] **Prompts.**
  - Navlog step 4 becomes: "Call `lookupAirport` for each airport, and
    `lookupNavaid` for each navaid: a waypoint written with a navaid type in
    parentheses, such as `SNS (VORTAC)`, or one `lookupAirport` has no record
    for. A navaid enters computeNavlog with kind navaid and its own magnetic
    variation."
  - Insert a new step after it: "Call `findRouteStations` with the waypoints
    in route order, and pass its stations to the weather subagent with their
    coordinates and alongNm."
  - Weather subagent: fetch METAR and TAF for every station passed in too;
    list the Airports lines in route order (origin, then en-route airports and
    stations by alongNm, then destination); and for a station with no TAF,
    write "TAF none".
  - Add `lookupNavaid` and `findRouteStations` to both subagents' `deny`
    lists.
- [ ] **Run** the server tests, typecheck and lint. Mirror to the template.
  Commit.

## Task 3: Search endpoint

- [ ] **`lib/waypoint-search.ts`:**
  - `searchWaypoints(data, q, limit = 8): Waypoint[]`, where
    `Waypoint = { id, kind: "airport" | "navaid", type, name, lat, lon, freqKhz? }`
    and an airport's `type` is `"airport"`.
  - Ranking:
    1. exact id or alias;
    2. id or alias prefix (shorter ids first);
    3. name word-prefix;
    4. name substring.
  - Within a rank, airports with a K-prefixed 4-letter id come first, then
    alphabetical.
  - Case-insensitive; trimmed; an empty query gives `[]`.
- [ ] **`api/waypoints/route.ts`:**
  - `GET` only. It imports `../../../data/waypoints.json` statically.
  - It applies the same visitor and origin guard the `api/b4` proxy uses (see
    `lib/guarded-request.ts` and `lib/proxy-guard.ts`). A guard failure
    returns the guard's response.
  - It caps `q` at 32 characters and returns
    `Response.json({ results, snapshot })` with `cache-control: no-store`.
- [ ] **Tests:**
  - the ranking cases: SNS (navaid) vs KSNS, "salinas", "KSB" prefix, and
    empty;
  - the route handler: guard enforced, cap enforced, JSON shape. Mirror the
    `api/b4` route tests' setup.
- [ ] Mirror. Commit.

## Task 4: Draft model (pure)

**`lib/route-draft.ts`:**

```ts
export interface DraftWaypoint { readonly id: string; readonly kind: "airport" | "navaid"; readonly type: string; readonly lat: number; readonly lon: number }
export interface RouteDraft { readonly waypoints: readonly DraftWaypoint[]; readonly altitudeFt: string; readonly departure: string; readonly departureFromPlan: string | null }
export function draftFromNavlog(navlog: Navlog): RouteDraft   // departure = "HHMMZ" of navlog.departureTimeUtc; departureFromPlan = that ISO instant
export const EMPTY_DRAFT: RouteDraft
export type DraftAction = { type: "add"; waypoint: DraftWaypoint } | { type: "remove"; index: number } | { type: "removeLast" } | { type: "altitude"; value: string } | { type: "departure"; value: string } | { type: "reset"; draft: RouteDraft }
export function draftReducer(state: RouteDraft, action: DraftAction): RouteDraft // editing departure clears departureFromPlan
export function replanMessage(draft: RouteDraft): string | null // null unless ≥2 waypoints and 1000 ≤ altitude ≤ 17500
// "Plan KPAO → SNS (VORTAC) → KSBA at 5500 ft, departing 1400Z." — departing <departureFromPlan ISO> when untouched
export function draftDistanceNm(draft: RouteDraft): number // great-circle sum, rounded
export function sameRoute(draft: RouteDraft, navlog: Navlog | null): boolean // ids in order
```

- [ ] Tests for every function, including the Replan text with an untouched
  plan departure and with an edited one. Check `navlog-types.ts` for the
  waypoint and departure field names. Mirror. Commit.

## Task 5: RouteBar component

`components/RouteBar.tsx` takes these props:

```ts
{ navlog: Navlog | null; running: boolean; onReplan: (text: string) => void; onDraftChange: (draft: RouteDraft) => void; search?: (q: string, signal: AbortSignal) => Promise<{ results: Waypoint[]; snapshot: string }> }
```

The default `search` fetches `/api/waypoints?q=`.

- [ ] **State.** `useReducer(draftReducer)`. It is reset by an effect keyed on
  the navlog object (`reset` with `draftFromNavlog`), and every change is
  reported through `onDraftChange`.
- [ ] **Markup.** `<form role="search" aria-label="Route">`, an ordered list of
  pills (each `<li>` with the id in mono, and a cobalt class for navaids),
  then:
  - a × button per pill, labelled `Remove <id>`;
  - a combobox input: `role="combobox"`, `aria-expanded`, `aria-controls`,
    `aria-activedescendant`, `aria-autocomplete="list"`, placeholder
    `Type a route: KPAO SNS KSBA` when empty and `add waypoint…` otherwise;
  - a listbox of options showing id, name and kind ("VORTAC 117.30" for a
    navaid, with the frequency formatted from kHz to MHz);
  - the snapshot note;
  - the altitude input (`aria-label="Cruise altitude, feet"`, `inputMode="numeric"`);
  - the departure input (`aria-label="Departure time"`);
  - the total `N nm`;
  - a Replan button, `type="submit"`, disabled when `replanMessage` is null
    or `running`.
- [ ] **Keys.**
  - Typing debounces the search by 120 ms and aborts the previous request.
  - ArrowUp/ArrowDown move through options; Enter or Tab adds the active
    option; space adds the top option when the list has results.
  - Escape closes the list. Backspace in an empty input removes the last pill.
  - Submitting the form calls `onReplan(replanMessage(draft))`.
- [ ] **Styling.** The LLA look in `theme.css` (`wb-routebar`, pills, no
  shadows or uppercase). The `design-rules.test.ts` scan must stay green.
- [ ] **Tests** with a fake `search`: typing and Enter adds a pill; space adds
  the top match; Backspace removes; the × removes; Replan text; the button is
  disabled while running; a new navlog resets the bar; options use
  listbox/option roles. Mirror. Commit.

## Task 6: Map, marker panel and layout wiring

- [ ] **`RouteMap`** gets new props:
  - `draft: readonly DraftWaypoint[] | null`: drawn as a dashed `wb-route-draft`
    polyline with small draft markers, only when `!sameRoute`;
  - `stations: readonly { id, lat, lon }[]`: grey station markers labelled
    with id and category;
  - `onSelectMarker: (id: string) => void`.

  Airport and station markers become interactive (`interactive: true`,
  `keyboard: true`, with `title`/`alt` set to the id). Clicking one, or Enter
  on it, calls `onSelectMarker`. Navaid markers stay non-interactive (waypoint
  `kind` comes from the navlog).
- [ ] **`MarkerPanel.tsx`.** `{ airport: AirportWeather | null; id: string; station?: { name } ; onClose }`.
  A `role="dialog"` with `aria-label="<id> weather"`, positioned in the map
  panel's lower-left corner. It shows category now → ETA, the raw METAR and
  TAF in `<pre>`, or "No report in the brief". It has a close button, and
  Escape closes it. Focus moves into it on open and back to the map on close.
- [ ] **`WorkbenchLayout`.**
  - Remove `WeatherStrip`. Render `RouteBar` in the strip's slot, on desktop
    and phone, measured with the same `useMeasuredHeight`.
  - Hold the `draft` and `selectedMarker` state here.
  - The phone Map tab is enabled even with no navlog: `activeTab` falls back
    to chat only for the navlog tab.
- [ ] **`AppShell`.**
  - Read the stations from `latestToolResult(turns, "findRouteStations", ok)`.
  - `onReplan(text)` does
    `agent.addMessage({ id: crypto.randomUUID(), role: "user", content: text })`,
    then `void copilotkit.runAgent({ agent })`, through the same failure seam
    the chat uses (read the comments near `copilotkit.runAgent` in
    `AppShell.tsx`).
  - Pass `running` (the existing `status === "running"`).
- [ ] **Delete** `WeatherStrip.tsx` and its test. Move anything only it used
  into `WeatherTab` (Task 7), or delete it.
- [ ] **Tests.**
  - `WorkbenchLayout`: the route bar renders in both layouts; no weather
    strip; the Map tab is enabled before a navlog.
  - `RouteMap`: Leaflet is mocked as in the existing tests; a draft line
    appears only when it differs; marker click.
  - `MarkerPanel`.
  - Mirror. Commit.

## Task 7: Weather tab

- [ ] **`lib/weather-roles.ts`.**
  `groupByRole(brief: WeatherBrief, navlog: Navlog, stations: Station[]): { origin, enRoute: { airport, id, alongNm }[], destination }`.
  - Origin is the first navlog waypoint and destination the last.
  - En route holds the intermediate airport waypoints (`alongNm` = cumulative
    leg distance) plus the stations, sorted by `alongNm` and deduplicated by
    id.
  - Each entry's weather is the brief airport with the same id, or null.
- [ ] **`WeatherTab.tsx`.**
  - Sections: Origin, En route, Destination. Each holds cards with id,
    "98 nm along" for en route, category now → ETA, and the METAR and TAF in
    `<pre>`.
  - Then Winds aloft (lines), Advisories (`HazardChip`, `OutsideWindowChip`
    from `VerdictCard`), and Forecast horizon (`HorizonNote`).
  - Empty states as in the spec.
- [ ] **`NavlogSheet`.**
  - Tabs: Legs · Weather · Totals & plan · Brief.
  - The tab body for Weather is `<WeatherTab>`, and the print copy includes it.
  - It needs `stations` passed down.
- [ ] **Tests:** the role grouping; the tab's rendering and empty states; the
  sheet's tab order and arrow keys. Mirror. Commit.

## Task 8: Harness, demo, docs, delivery

- [ ] **Demo capture.** `docs/brand/demo/capture.mjs`:
  - `assertWeatherVerdict` drops the `region "Weather"` assertion and keeps
    the verdict summary.
  - Optionally assert the Weather tab.
  - Update `demo.test.mjs` fakes, `storyboard.mjs` and `transcript.md`
    references to the strip.
  - If `capture.mjs` is content-pinned
    (`scripts/release/test/fixtures/release-script-hashes.json`), regenerate
    the pin and its digest snapshot.
- [ ] **Harness.** `test/harness/workbench-suggestions.ts` and the W7/W8
  journeys: check every accessible name that was removed.
- [ ] **Docs.** `apps/web/content/docs/recipes/flight-planner-web-ui.mdx`,
  `flight-planner.mdx`, `examples/navlog/README.md`, `web/README.md`,
  `server/README.md` and the template READMEs: describe the route bar,
  `lookupNavaid`, `findRouteStations`, the Weather tab and the snapshot
  (OurAirports, public domain, not for navigation, how to refresh).
- [ ] **Changeset.** A patch for the package that ships the template (check
  whether previous navlog PRs added one).
- [ ] **Gates.** Run, in order:
  - lint, typecheck, and the navlog server and web tests;
  - the devkit tests and `check-docs`;
  - `pnpm verify:harness:framework` and `pnpm test:brand-demo`;
  - lastmod regeneration after committing content.
- [ ] **Live check locally.** Restart the servers, type `KPAO SNS KSBA`,
  replan, and confirm the plan, the marker panel and the Weather tab.
- [ ] **Delivery.** Open the PR and set auto-merge. After the merge, verify in
  production at navlog-web.vercel.app.
