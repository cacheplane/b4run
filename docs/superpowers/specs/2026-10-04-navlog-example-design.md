# Navlog: the flagship example becomes a VFR flight planner, deployed live

**Status:** approved design, 2026-10-04. Supersedes the research-assistant
theme of `examples/research` and the `research` scaffold template.

## 1. Summary

The flagship `examples/research` example (and the `create-b4-app` template it
is mirrored into) becomes **navlog**: a VFR flight-planning assistant for a
Cessna 172N. A pilot asks for a route; the agent recalls the pilot's aircraft
profile from long-term memory, plans the legs, dispatches a weather briefer and
a performance planner, computes the navlog in code from live aviation weather
and transcribed POH tables, renders it as a form over a route map, and
summarizes in plain language. Filing a flight plan happens only when asked and
only after a human approves it.

The example is deployed as a public live demo: the web client on Vercel, the
server on Railway with Postgres stores, behind the three guardrails threadplane
already runs (origin allowlist, per-visitor rate limit, internal token).

Why this and not the old theme:

- The old corpus was five short notes about agent frameworks. Every B4.run
  feature demonstrated something meta. In a flight planner each feature has a
  real job: memory holds the aircraft profile, planning holds the legs,
  subagents brief weather and performance, offloading absorbs a TAF bundle,
  approval gates filing, and tools do arithmetic the model must never do.
- `runBash` was the example's only human-approval moment and ran a stub
  script. A live demo cannot expose shell to anonymous visitors, and Railway
  offers no Docker daemon for a sandbox. `fileFlightPlan` behind
  `tools.approve` keeps the moment and removes the shell.

## 2. Scope

In scope:

- Rename `research` to `navlog` everywhere (example, template, template id,
  package names, docs slugs), keeping `research` as a deprecated template-id
  alias for one release.
- Server retheme: POH corpus, live-weather tools, `computeNavlog`,
  `fileFlightPlan`, two subagents, memory schema, evals, unit tests.
- Web retheme: map-dominant layout, navlog card, weather chips, approval flow,
  phone layout.
- Deployment: Railway service, Vercel project, Postgres stores, token guard,
  proxy guards, spend controls.
- One framework change: `@b4run/cli` exports the runtime request listener so
  an application entry point can wrap it.
- Docs: two recipe pages rewritten and moved; touched pages updated.

Out of scope for this series: IFR planning, weight and balance, non-standard
temperature corrections beyond what the POH tables give, a Docker sandbox for
the demo, re-recording the three demo video clips, a CI lane that deploys the
demo, and real flight-plan transmission.

## 3. Naming

| Today | After |
|---|---|
| `examples/research/{server,web}` | `examples/navlog/{server,web}` |
| `@b4-example/research-server`, `-web` | `@b4-example/navlog-server`, `-web` |
| route `src/app/research/` (`/research`) | `src/app/navlog/` (`/navlog`) |
| devkit template `app-research` | `app-navlog` |
| `create-b4-app --template research` | `--template navlog`; `research` accepted with a one-line deprecation notice for one release |
| `/docs/recipes/research-assistant` | `/docs/recipes/flight-planner` (old slug redirects) |
| `/docs/recipes/research-web-ui` | `/docs/recipes/flight-planner-web-ui` (old slug redirects) |

The devkit parity test requires the template to match the example byte for
byte, so every example change lands in the template in the same PR.

## 4. Server (`examples/navlog/server`)

### 4.1 Route `src/app/navlog/`

A coordinator agent on `gpt-5-mini`, `recursionLimit: 100`. The system prompt,
in order:

1. `recall` the pilot's aircraft profile and preferences.
2. Parse the request into departure, destination, optional waypoints, cruise
   altitude and departure time. Ask once if altitude or time is missing.
3. Write the legs as todos (`writeTodos`).
4. `task` the `weather` and `performance` subagents.
5. `computeNavlog` with the resolved waypoints, altitude, departure time,
   aircraft profile and the winds the weather subagent returned.
6. Optionally `renderChart` for fuel remaining by checkpoint.
7. Summarize in plain language: flight category at each airport, winds at
   altitude, fuel burned and reserve, anything that should give the pilot pause.
8. `remember` any durable preference or aircraft fact the pilot states.
9. `fileFlightPlan` only when the pilot asks to file.

The route keeps accepting an attached image (a sectional snippet or kneeboard
notes) and is told to read the route from it. Route state stays a single
accumulated `context` string.

Route config: `tools: { deny: ["runBash"], approve: ["fileFlightPlan"] }`.

### 4.2 Shared tools `src/tools/`

Every tool exports `display` so the activity summary reads like a briefing
("Briefing weather at KRST", "Computed navlog for 3 legs").

| Tool | Source | Returns |
|---|---|---|
| `lookupAirport({ id })` | aviationweather.gov `/api/data/airport` | coordinates, elevation, magnetic variation, runways, frequencies |
| `getMetar({ ids })` | `/api/data/metar`, JSON | parsed fields plus raw text |
| `getTaf({ ids })` | `/api/data/taf`, JSON | parsed fields plus raw text |
| `getWindsAloft({ lat, lon, altitude, hoursAhead })` | `/api/data/windtemp` FB text product for the covering region | direction, speed, temperature at the requested altitude, interpolated between the bracketing levels of the nearest FB station; station id and forecast validity |
| `getAdvisories({ lat, lon })` | `/api/data/gairmet`, `/api/data/sigmet` | advisories touching the route corridor |
| `computeNavlog({ waypoints, altitude, departureTimeUtc, aircraft, winds })` | pure code | the structured navlog (section 4.3) |
| `fileFlightPlan({ flightPlan })` | pure code, approval-gated | writes `flight-plans/<date>-<dep>-<dest>.txt` in ICAO FPL layout to the workspace; returns a confirmation that says recorded, not transmitted |
| `renderChart` | unchanged | inline SVG bar chart as a content part |
| `readDoc({ path })` | unchanged | a corpus document |

`searchCorpus` is removed. The aviationweather.gov API needs no key and allows
100 requests a minute across all callers, so the weather tools share an
in-process cache keyed by product and station with a five-minute TTL.

### 4.3 `computeNavlog`

One pure module with no model in the loop, unit-tested table-driven:

- Great-circle distance and initial true course per leg from waypoint
  coordinates.
- Magnetic variation from the airport records (east subtracted, west added),
  applied to true course and true heading.
- Wind triangle per leg: wind correction angle, true heading, groundspeed.
- Climb from POH Figure 5-6 (time, fuel, distance to climb) for the first leg,
  with the leg split into climb and cruise segments when the climb distance is
  shorter than the leg.
- Cruise TAS and GPH from Figure 5-7 for the pressure altitude and RPM in the
  aircraft profile, interpolated between table rows.
- Per-leg ETE, ETA from departure time, fuel burned, fuel remaining.
- Totals and reserve: usable fuel minus burn, expressed in minutes at the
  cruise burn rate, flagged when under 45 minutes.
- ICAO flight plan fields 7 through 19 assembled from the aircraft profile and
  the computed totals.

Output schema (abbreviated):

```ts
{
  aircraft: { tailNumber, type: "C172", cruiseRpm, tasKt, gph, usableFuelGal },
  altitudeFt, departureTimeUtc,
  waypoints: [{ id, lat, lon, elevationFt?, kind: "airport" | "navaid" | "fix" }],
  legs: [{ from, to, trueCourse, variation, magneticCourse, wind: { dir, kt },
           wca, trueHeading, magneticHeading, tasKt, groundspeedKt,
           distanceNm, remainingNm, eteMin, etaUtc, fuelGal, fuelRemainingGal,
           segment: "climb" | "cruise" }],
  totals: { distanceNm, eteMin, fuelGal, fuelRemainingGal, reserveMin },
  flightPlan: { item7, item8, item9, item10, item13, item15, item16, item18, item19 },
  sources: [{ figure, path }]
}
```

### 4.4 Subagents

- `weather`: tools `getMetar`, `getTaf`, `getWindsAloft`, `getAdvisories`,
  skill `brief-weather`. Returns a structured brief: flight category per
  airport with the raw METAR and TAF, winds and temperature at the planned
  altitude per leg, advisories, and a plain-language go/no-go style summary.
- `performance`: tools `readDoc`, `lookupAirport`, skill `poh-lookup`. Returns
  takeoff and landing distances for the actual field elevations and
  temperatures, the cruise row to use, and the figure citations.

Both are scoped with `tools: { allow: [...] }` so neither sees the other's
tools.

### 4.5 Corpus `workspace/`

- `poh/`: our own Markdown transcriptions of the 1978 Cessna 172N POH figures
  2-1 (airspeed limitations), 5-4 (takeoff distance), 5-5 (rate of climb), 5-6
  (time, fuel, distance to climb), 5-7 (cruise performance), 5-8 and 5-9
  (range and endurance, 40 and 50 gallon), 5-10 (landing distance), plus the
  Section 1 weights and fuel figures. Each file is headed with its figure
  citation. The POH PDF is not vendored; performance figures are facts and are
  transcribed, the handbook's prose and layout are not copied.
- `regs/`: short excerpts on VFR fuel reserves and VFR cruising altitudes.
- `scripts/fetch-source.mjs` and the old corpus are removed.

### 4.6 Memory and config

`memory.ts` keeps the `{ subject, predicate, value }` schema. The prompt seeds
the aircraft profile as subject `aircraft` with predicates such as
`tail_number`, `cruise_rpm`, `usable_fuel_gal`, `reserve_minutes`. Writes stay
`candidate` so the memory panel keeps its review beat.

`b4.config.ts`: the permissions block shrinks to the file tools; the tool-output
offload threshold stays low so a TAF bundle trips it; the Docker sandbox seam
and `test:sandbox:docker` are removed from this example.

## 5. Web client (`examples/navlog/web`)

The map is the page. Everything else floats over it. The mockup the design
was validated against lives at
`.superpowers/brainstorm/70001-1791084588/content/layout-v2.html` (gitignored).

- **Map.** Leaflet over OpenStreetMap tiles with attribution, loaded through a
  dynamic import with server rendering off. Light tiles are desaturated by a
  CSS filter; dark mode inverts and hue-rotates the tile pane. Before a navlog
  exists the map centers on the pilot's home field from memory, else the
  continental US, with the starter prompts floating in the center. The tile
  host is added to the Next connect and image allowlists.
- **Chat dock, left.** A floating panel, at most one third of the width,
  collapsible to a pill, holding the transcript, the per-turn activity summary
  and the composer. Thread rail and memory panel move into the dock header's
  menu. Approval prompts for `fileFlightPlan` render in the dock.
- **Weather strip, top right, and marker colors.** Flight-category chips for
  departure, destination and any alternate the weather subagent returned (VFR
  green, MVFR blue, IFR red, LIFR magenta, each also labelled in text), plus
  winds at the planned altitude. Airport markers on the map are colored by the
  same category. A chip or a marker opens a popover with the raw METAR and TAF
  and the category stated in words. Color never carries meaning alone.
- **Navlog sheet, bottom.** Collapsed, one line of totals (route truncated to
  departure and destination on phones) with print, copy-FPL and file actions.
  Expanded, the full form: one row per leg with TC, Var, MC, wind, WCA, MH,
  TAS, GS, distance, remaining, ETE, ETA, fuel, remaining; a totals row with
  reserve; the ICAO flight plan block laid out as items 7 through 19; the
  brief. Hovering or focusing a leg row highlights its segment on the map;
  selecting a marker scrolls its row into view. The sheet is a native
  disclosure with keyboard support. A print stylesheet fits the form on one
  landscape page.
- **Data flow.** The `NavlogCard` is registered with
  `useRenderTool({ name: "computeNavlog" })` and reads the tool result; the map
  draws from the result's waypoints and legs; the weather strip reads the
  weather subagent's structured result from the subagent run events. Numbers
  on screen are the tool's, never retyped by the model.
- **Phone.** Map full screen; the strip collapses to one scrolling chip row;
  chat and navlog share one bottom sheet with Navlog, Chat and Flight plan
  tabs; leg rows become stacked cards; actions move to the sheet header.
  Safe-area insets, 44 px targets, no horizontal scroll.
- **Motion.** 200 to 300 ms panel transitions, one short route reveal, all
  off under `prefers-reduced-motion`.
- **Suggestions.** Plan a route (full flow), teach it the aircraft (drives
  `remember`), file a prior plan (drives the approval).
- **Unchanged.** The same-origin proxy and its allowlist, media parts and
  image attachment, the plan card, the subagent panel, the connect screen.

Design language stays the workbench's existing tokens (`--wb-*`), Minimalism
and Swiss style, map-neutral surfaces with color reserved for flight category
and the route.

## 6. Deployment and guardrails

### 6.1 Topology

- Web: a new Vercel project in the existing team, root `examples/navlog/web`,
  pnpm monorepo install, deploys from `main`.
- Server: a new Railway service in the threadplane project, Dockerfile builder,
  `/healthz` healthcheck, on-failure restarts (`railway.json` as threadplane's
  services use), deploys from `main`. Railway Postgres beside it. A Railway
  volume at `/app/workspace` for flight plans and reports.
- Rate limits: the existing Upstash Redis with a `navlog` key prefix.
- Model: a dedicated OpenAI key with a monthly hard cap.

### 6.2 Server entry and stores

`examples/navlog/server/main.ts` composes `@b4run/postgres-storage` stores
(checkpointer, threads, permissions, one `pg` pool with an `'error'` listener)
and `@b4run/memory-pgvector` over the same database (keyword recall unless an
embedding key is set), then starts the runtime with a guard in front: every
request except `/healthz` must carry `X-Internal-Token` equal to the service's
secret, else 401 before the runtime sees it. The Dockerfile command runs the
compiled entry. Locally, without `DATABASE_URL`, the example keeps its SQLite
defaults through `b4 dev`.

This needs one framework change (PR 1): `@b4run/cli` exports the runtime
request listener (today internal to `serve()`), so an entry point can wrap it.
`serve()` itself is unchanged. The embedding docs page gains one paragraph.

`src/auth.ts` and `src/thread-access.ts` are activated from their `.example`
files: the principal is the visitor id the proxy forwards, so one visitor
cannot list, read or resume another's threads.

### 6.3 Web proxy guards

Both Next proxy routes (`api/b4/[...path]` and `api/copilotkit/[...path]`)
gain, in order:

1. Origin check against the demo host and localhost.
2. A visitor id minted into an HTTP-only cookie on first contact.
3. An Upstash token bucket per visitor id and per IP, plus a daily run quota
   per visitor; fails open when Upstash is unconfigured, as threadplane does.
4. Injection of `X-Internal-Token` and the visitor id header on the upstream
   call.

The memory candidate approve and reject routes are scoped to the visitor's own
candidates through the same principal. `B4_SERVER_URL`, the token and the
Upstash credentials are Vercel project secrets.

### 6.4 Verification

`b4 check`, `b4 build`, `b4 verify` as today, plus a one-time manual smoke of
the live demo with the transcript and a screenshot attached to the deployment
PR. No CI deploy lane in this series.

## 7. Tests and evals

- **Unit tests, keyless.** Table-driven cases for `computeNavlog` (wind
  triangle head, tail and crosswind; great-circle distance and course between
  known airports; variation; POH interpolation for climb and cruise; reserve;
  FPL fields), the winds-aloft parser against a saved FB text sample, the
  weather cache, and the web components (navlog card, chips, map data mapping,
  proxy guard logic). These are the `pnpm test` gate.
- **Recorded evals.** Cases recorded with `b4 eval --record`; tools run live
  against aviationweather.gov in replay, so scorers judge shape, never a
  weather-dependent number or exact wording:
  - `computeNavlog` called once; result validates against the schema.
  - every leg has MH, GS, ETE and fuel; totals add up; reserve is at least 45
    minutes.
  - `weather` and `performance` each ran once.
  - POH citations in the brief resolve to corpus paths.
  - `fileFlightPlan` not called unless the case asks; when called, preceded by
    an approval.
  - an LLM judge with written criteria scores the brief for naming the flight
    category at each airport and the fuel and reserve, thresholded; runs only
    when a key is present.
- The scripted `research.test.ts` scenario is removed. The recipe copy that
  promises `npm test` passes without a provider key stays true and is reworded
  to describe the math tests.

## 8. Docs and scaffold

- Recipe pages rewritten and moved (section 3). Moving a page touches the nav
  and its test, the SEO registry, `llms.txt`, the lastmod manifest, the CLI
  docs-bundle count test, the prompts index and the templates `AGENTS.md`.
- Pages with research references updated: ag-ui, evals, testing-agents,
  getting-started, recipes index. The mental-model page's generic `/research`
  route example stays.
- `examples/README.md`, the repo `AGENTS.md` workspace map, the example READMEs.
- Demo-media captions naming the research route get corrected text; the clips
  are re-recorded in a later PR.
- `create-b4-app`: `navlog` template id, `research` alias with notice, tests
  for both. Changesets: patch, fixed group, for `@b4run/cli`, `@b4run/devkit`,
  `create-b4-app`.

## 9. PR series

Each PR is green on its own.

1. **CLI listener export.** The seam from 6.2, its test, one embedding doc
   paragraph, changeset.
2. **Mechanical rename.** `research` to `navlog` across example, template,
   package names, template id and alias, docs slugs and the eight pinned
   places. No content change beyond names.
3. **Server retheme.** Sections 4 and 7 server parts, template mirror.
4. **Web retheme.** Section 5 and its tests, template mirror.
5. **Deployment.** Section 6: `main.ts`, proxy guards, `railway.json`, Vercel
   settings, environment docs, manual smoke evidence.
6. **Docs rewrite.** Section 8 content, lastmod regen.

PRs 3 and 4 can be built in parallel in separate worktrees once 2 lands.

## 10. Sources

- 1978 Cessna 172N Pilot's Operating Handbook, scanned with an OCR layer,
  Section 5 figures legible:
  https://wingsflightschool.com/document/Cessna-172N-POH-1978.pdf
- Lake Elmo Aero C172M/N Standardization Manual (clean text; 172M cruise,
  takeoff, landing, V-speeds, weights; cross-check only, the M is 150 hp):
  https://www.lakeelmoaero.com/wp-content/uploads/2021/11/LEA-C172-Stan-Manual-KTS.pdf
- Aviation Weather Center Data API (no key, 100 requests a minute, airport
  records carry coordinates, elevation, `magdec`, runways, frequencies; winds
  aloft is the FB text product keyed by region):
  https://aviationweather.gov/data/api/
- Threadplane's proxy guards, the pattern this reuses:
  `~/repos/angular-agent-framework/scripts/ag-ui-proxy.ts` and
  `deployments/ag-ui-mastra/railway.json`.
