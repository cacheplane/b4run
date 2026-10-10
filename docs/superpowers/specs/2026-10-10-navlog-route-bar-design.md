# Navlog: a route bar on the map, and weather by role

Date: 2026-10-10
Scope: `examples/navlog` (server and web) and its byte-parity twin in
`packages/devkit/templates/app-navlog`
Builds on: #1009, #1010, #1014, #1016

## Goal

Pilots who already know their route can type it in quickly on the map, see
it drawn as they go, and replan once. Weather moves off the map into a
Weather tab, by role: origin, en route and destination.

Out of scope: automated waypoint suggestions, alternates (the Weather tab
leaves room for them), named fixes, and dragging waypoints on the map.

## Decisions

| Question | Decision |
|---|---|
| How editing relates to the agent | The map is a draft editor; one Replan sends the route to the agent, which plans as today. |
| Waypoint kinds | Airports and navaids (VOR, VOR-DME, VORTAC, NDB, NDB-DME). |
| Data source | A bundled US snapshot built from OurAirports (public domain), dated, "not for navigation". |
| Placement | A route bar across the top of the map, holding the route as pills. |
| Altitude and departure | Two short fields in the bar, filled in from the last plan. |
| How Replan reaches the agent | An ordinary, visible chat message. |
| Weather on the map | The strip goes. Clicking an airport marker opens its METAR and TAF. |
| En-route weather | Up to 6 reporting stations within 25 nm of the course, found on Replan. |

## 1. The route bar (web)

A pill-shaped bar across the top of the map panel (and the phone Map tab)
replaces `WeatherStrip`:

`[KPAO] → [SNS] → [KSBA] [add waypoint…] · 5500 ft · 1400Z · 231 nm [Replan]`

- **Pills.** Airports show in ink and navaids in cobalt, in mono type. Each
  pill has a remove button (×). Backspace in an empty input removes the last
  pill.
- **Autocomplete.** The input is a combobox (`role="combobox"`, listbox
  options, `aria-activedescendant`). Typing searches identifiers and names: a
  case-insensitive prefix on the identifier or its local code first, then a
  substring of the name. At most 8 results. Each option shows the identifier,
  name and kind (VORTAC 117.30 for navaids). Arrows move through options;
  Enter, Tab or space adds the highlighted one; Escape closes the list.
  Typing a route such as `KPAO SNS KSBA` and pressing space after each token
  adds the best match each time.
- **Altitude and departure.** `5500 ft`: a number from 1000 to 17500.
  `1400Z`: what the pilot types is passed through as given (`resolveDeparture`
  accepts `1400Z`, `tomorrow 1400Z` or an ISO instant). After a plan, the
  field shows the planned departure as `HHMMZ` and, while it is untouched,
  Replan sends the plan's ISO instant.
- **Draft drawing.** Each added waypoint draws on the map at once, from the
  snapshot coordinates. A dashed line marks a draft that differs from the
  planned route; the solid planned route keeps its markers and heading
  labels. The bar shows the draft's total great-circle distance.
- **Replan.** It is enabled when the route has at least 2 waypoints, the
  altitude is valid and no run is in progress. It sends a user message
  through the same CopilotKit agent the chat uses, for example:
  `Plan KPAO → SNS (VORTAC) → KSBA at 5500 ft, departing 1400Z.` Navaids carry
  their type in parentheses; airports carry no suffix.
- **Sync with the plan.** When a new navlog arrives, the bar resets to the
  planned waypoints, altitude and departure. The plan wins over an unsent
  draft. Before any plan, the bar is empty and the placeholder reads
  `Type a route: KPAO SNS KSBA`.
- **Snapshot note.** A small "Waypoints: OurAirports <date>, not for
  navigation" line sits under the open list.

### Search endpoint

`GET /api/waypoints?q=<text>` is a Next route handler in the web app. It
reads the bundled snapshot server-side (never shipped to the browser) and
returns `{ results: Waypoint[], snapshot: "<YYYY-MM-DD>" }`, where
`Waypoint = { id, kind: "airport" | "navaid", type, name, lat, lon, freqKhz? }`.
The handler applies the same origin and rate guards as the other web
proxies, caps `q` at 32 characters, and answers an empty `q` with no results.

## 2. Snapshot data

- `examples/navlog/scripts/build-waypoints.mjs <airports.csv> <navaids.csv>`
  reads OurAirports CSVs that the operator downloads (the README gives the
  URLs) and writes:
  - `web/app/data/waypoints.json`: US small, medium and large airports
    (identifier = ICAO code, else GPS code, else ident; plus the local code as
    an alias) and US navaids of the types above. Compact rows plus a
    `snapshot` date. About 1 MB.
  - `server/src/data/navaids.json`: the same navaids with magnetic variation,
    for `lookupNavaid`.
- Both files are committed and mirrored into the template.

## 3. Server

- **`lookupNavaid({ id })`** reads `navaids.json` and returns
  `{ id, name, type, lat, lon, freqKhz, magneticVariationDeg }`, or an error
  naming the identifier. It exists because aviationweather.gov's navaid
  endpoint returns nothing.
- **`findRouteStations({ waypoints, corridorNm?, max? })`**, with defaults of
  25 nm and 6 stations. It queries aviationweather.gov `metar?bbox=` once per
  leg box, keeps stations within the corridor of the course, drops the route's
  own airports, orders them by along-track distance, and thins them evenly to
  `max`. It returns `{ stations: [{ id, name, lat, lon, alongNm, offsetNm }] }`.
- **Prompt (navlog route).** A waypoint written with a navaid type in
  parentheses, or one `lookupAirport` cannot find, is resolved with
  `lookupNavaid` and enters `computeNavlog` with `kind: "navaid"`. After the
  lookups, the agent calls `findRouteStations` and passes the stations to the
  weather subagent.
- **Prompt (weather subagent).** It fetches METAR and TAF for the en-route
  stations too, and lists the airports in route order: origin, then
  intermediate airports and stations by distance along the route, then the
  destination. A station with no TAF says so.

## 4. Map

- `WeatherStrip` is removed from the map overlay (desktop and phone), along
  with its file and tests. Verdict, hazards and winds already appear in the
  sheet.
- **Station markers.** Stations from the latest `findRouteStations` result
  draw as small grey markers with their identifier and category.
- **Marker panel.** Airport and station markers are buttons (Leaflet keyboard
  focus). Clicking one opens a small panel in the map's corner with the id,
  name when known, category now and at ETA, the raw METAR and the raw TAF from
  the weather brief, and a close button. Escape closes it. Navaid markers stay
  labels only.
- The map's top padding follows the route bar's measured height, as it
  followed the strip's.

## 5. The Weather tab (sheet)

The sheet's tabs become Legs · Weather · Totals & plan · Brief. The Weather
tab shows, in order:

1. **Origin**, **En route** and **Destination** groups. Each airport card has
   the id, category now → at ETA, the raw METAR and the raw TAF (mono,
   wrapped), or "No report in the brief". En route lists intermediate route
   airports and stations by along-track distance, each with its distance
   ("98 nm along"). An empty En route says "No reporting stations within 25 nm
   of the course."
2. **Winds aloft**: one line per leg.
3. **Advisories**: the hazard chips and the outside-window chip, moved from
   the strip.
4. **Forecast horizon**: the note, when the brief has one.

Print includes the Weather tab's content after the legs.

## 6. Testing and delivery

- Unit tests:
  - the search ranking;
  - the route-bar combobox (keyboard, pills, Replan text, sync with the plan);
  - the draft geometry;
  - the role grouping in the Weather tab;
  - the marker panel;
  - `lookupNavaid`;
  - `findRouteStations` against a stubbed fetch (corridor filter, ordering,
    thinning, dropping route airports);
  - the snapshot builder against a small CSV fixture.
- Harness and demo capture: `assertWeatherVerdict` and anything that reads the
  removed strip move to the sheet. `pnpm verify:harness:framework` and
  `pnpm test:brand-demo` stay green.
- Docs: the flight-planner recipes and the navlog READMEs describe the route
  bar and the Weather tab; then regenerate lastmod.
- Mirror every parity file into the template. One PR off `main`, merged on
  green, then verified in production (navlog-web.vercel.app with the Railway
  server): type a route with a VOR, replan, and see the Weather tab and
  marker panels.
