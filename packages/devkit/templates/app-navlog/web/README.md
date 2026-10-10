# {{appName}} — web

The B4.run Workbench: the browser client for the `server/` package's `/navlog`
agent. It is a [CopilotKit](https://docs.copilotkit.ai) v2 app
(`@copilotkit/react-core/v2` + `@copilotkit/runtime`) on Next.js and React that
talks to B4.run over [AG-UI](https://github.com/ag-ui-protocol/ag-ui).

It is a workbench rather than a chat widget, and it is map-first:

- **Sidenav.** On the left: the wordmark, "New plan", the recent threads and
  Memory, a toggle that opens Memory mode and carries a badge counting the
  candidates waiting for review. On desktop the sidebar collapses to a 64px icon
  rail, and the choice is remembered per browser.
- **Route map.** A [Leaflet](https://leafletjs.com) map on
  OpenStreetMap tiles, credited in the map's attribution control. It draws the
  planned route, one marker per waypoint colored by flight category with the
  category as text beside it, and the cruise magnetic heading on each leg. The
  en-route reporting stations draw as small grey markers. Clicking an airport or
  station marker opens a panel with its category now and at ETA and the raw
  METAR and TAF.
- **Chat.** The middle column: the thread title and status, and
  the conversation itself: the plan card, the `weather` and `performance` subagent
  cards, tool cards and the `fileFlightPlan` approval, inline and in order.
- **Route bar.** Across the top of the map: the route as pills, an
  autocomplete input over the bundled waypoint snapshot (`GET /api/waypoints?q=`),
  the cruise altitude, the departure, the draft's distance and **Plan**
  (**Replan** once a navlog exists). Type `KPAO SNS KSBA` with a space after
  each identifier to build a route; each waypoint draws on the map at once,
  dashed until it is planned. Plan sends one ordinary chat message, such as
  `Plan KPAO → SNS (VORTAC) → KSBA at 5500 ft, departing 1400Z.`, and the next
  navlog resets the bar to the planned route. The snapshot comes from
  OurAirports (public domain) and is not for navigation; the server README
  covers refreshing it.
- **Navlog sheet.** Under the map, with the totals when collapsed. Open, a
  verdict strip sits above four tabs: **Legs** leads with the legs grid
  (pretable, `NavlogGrid.tsx`; Leg pinned left, selecting a row lights that leg
  on the map) over a fixed totals strip, **Weather** groups the brief by
  origin, en route and destination (each airport's category and raw METAR and
  TAF; en-route stations by distance along the route), then the winds aloft,
  advisories and forecast horizon, **Totals & plan** holds the tiles and
  the ICAO flight plan items 7 to 19, and **Brief** the verdict card and the
  brief, rendered from the agent's structured answer. **Print** prints the sheet alone on one landscape page, every leg
  included (from a print-only table), and **Copy FPL** copies the `(FPL-…)`
  message.
- **Phones.** Under 1024 px: a top row, one full-screen panel and a bottom tab
  bar (Chat, Map with the route bar, Navlog, the navlog as one card per leg). The menu opens the
  sidenav as a drawer.

Every surface reads the thread the client already has through pure, unit-tested
selectors:

- `latestNavlogResult` and `parseNavlog` (`app/lib/navlog-selectors.ts`) — the
  last `computeNavlog` result, parsed into a navlog.
- `latestWeatherBriefText` and `parseWeatherBrief` (`app/lib/weather-selectors.ts`)
  — the last completed `weather` subagent run, parsed into a weather brief.
- `latestRouteStations` and `groupByRole` (`app/lib/weather-roles.ts`) — the
  last `findRouteStations` result, and the Weather tab's groups.
- `routeGeometry` (`app/lib/route-geometry.ts`) — what the map draws.

Only the route bar's unsent draft is local state.

Map labels never sit on each other: each marker's label goes right of its dot,
else left of it, else it hides until the marker is hovered or focused
(`app/lib/map-labels.ts`). The route's own waypoints always keep their labels;
the reporting stations and draft points around them give way.

## Structured answer

The agent answers a plan with a structured brief rather than markdown. The
CopilotKit runtime route (`app/api/copilotkit/[...path]/route.ts`) builds its
`B4HttpAgent({ responseSchema })` with the brief kit's JSON Schema
(`app/brief/kit.ts`), so every run sends it as `forwardedProps.responseSchema`.
B4.run binds it on the route's model as structured output, and `BriefRenderer`
(`app/brief/`) renders the streamed `{ ui: [...] }` as the BottomLine,
RouteSummary, WatchFor, KeyNumbers, Assumptions, Citations and Prose components,
in the chat and in the sheet's Brief tab. An older thread's markdown answer
falls back to the markdown renderer.

The server must allow that key, and `server/b4.config.ts` does, for this route
only:

```ts
server: {
  agui: { clientForwardedProps: { "/navlog": ["responseSchema"] } },
},
```

Without it the server refuses every run with a 422
`forwarded_props_not_allowed`.

No model credentials live in this package. The B4.run server holds them, and this
app reaches it through a same-origin proxy.

Requires Node.js 24 or later and npm 11.

## Run it

Everything runs from the app root — the directory above this one, where
`npm install` links both workspace packages.

```bash
npm install
cp server/.env.example server/.env    # add a real OPENAI_API_KEY here
npm run dev:server                    # B4.run server on http://127.0.0.1:3002
npm run dev:web                       # this app on http://localhost:3010
```

Start the server first. Until it answers, this app shows a connect screen with
the commands that start it; the screen re-probes every five seconds and clears
itself the moment the server comes up, with no reload.

`web/.env.example` sets `B4_SERVER_URL` (default `http://127.0.0.1:3002`).
Copy it to `web/.env` if your server listens elsewhere. Its other variables
turn on the proxy guards for a deployment and stay unset locally.

Offline checks, also from the app root:

```bash
npm run typecheck --workspace web
npm test --workspace web
npm run build --workspace web
```

## Where things live

| Part | File | What it does |
|---|---|---|
| Connect screen | `app/components/ConnectScreen.tsx` | replaces the shell while the server is unreachable |
| Layout | `app/components/WorkbenchLayout.tsx` | the docked columns (sidenav, chat, map with the route bar and sheet); the phone tabs |
| Route map | `app/components/RouteMap.tsx`, `MarkerPanel.tsx`, `app/lib/map-labels.ts` | Leaflet, browser-only, draws what `routeGeometry` returns; the marker panel; label placement |
| Sidenav | `app/components/SideNav.tsx` | wordmark, new plan, threads, memory count |
| Chat column | `app/components/ChatDock.tsx` | the thread title and run status above the chat |
| Route bar | `app/components/RouteBar.tsx`, `app/lib/route-draft.ts` | the typed route, its draft on the map, and the Plan message |
| Waypoint search | `app/api/waypoints/route.ts`, `app/lib/waypoint-search.ts`, `data/waypoints.json` | searches the bundled OurAirports snapshot server-side |
| Navlog sheet | `app/components/NavlogSheet.tsx`, `NavlogGrid.tsx`, `NavlogTable.tsx`, `FlightPlanBlock.tsx`, `WeatherTab.tsx` | verdict strip, legs grid and tabs, weather by role, totals, ICAO flight plan, print and copy |
| Step views | `app/components/StepViews.tsx` | the opened `computeNavlog` and `renderChart` steps, through `B4Activity`'s `renderStep` |
| Selectors | `app/lib/navlog-selectors.ts`, `weather-selectors.ts`, `weather-roles.ts`, `route-geometry.ts` | turn the thread into navlog, weather and map data |
| Thread list | `app/components/ThreadRail.tsx` | the thread list inside the sidenav |
| Memory review | `app/components/MemoryPanel.tsx` | approve or delete the candidates `remember()` proposed |
| Brief kit | `app/brief/` | the structured answer: hashbrown schemas, the BottomLine / RouteSummary / WatchFor / KeyNumbers / Assumptions / Citations / Prose components, and `BriefRenderer` (markdown fallback for older threads) |
| Chat | `app/components/NavlogChat.tsx` | `<CopilotChat>` with B4.run's slots: turns, approvals, attachments |
| Notices | `app/components/DropNotices.tsx`, `RunError.tsx` | parts the model never saw, and run errors |
| CopilotKit runtime | `app/api/copilotkit/[...path]/route.ts` | registers a `B4HttpAgent` on B4.run's AG-UI endpoint with `responseSchema` set to the brief kit's JSON Schema, and a `createB4AgentRunner(InMemoryAgentRunner, ...)` runner that restores threads |
| Server proxy | `app/api/b4/[...path]/route.ts` | forwards the three memory routes to B4.run |
| Proxy allowlist | `app/lib/proxy-allowlist.ts` | the pure policy the proxy enforces |
| Thread list | `app/lib/thread-source.ts` | the sidenav's ids, titles and recency (restoring a thread is the runner's replay) |
| Theme | `app/theme.css` | the whole palette, as CSS variables |

## Restyling it

`app/theme.css` is the one file to edit. The palette is defined there as CSS
variables and re-exported as Tailwind tokens through `@theme inline`, which is
why the app's utilities read `bg-wb-surface`, `border-wb-border`,
`text-wb-muted`, `rounded-wb`, `font-sans`. Change a `--wb-*` value and the
activity-card tokens, CopilotChat's tokens and every utility move together.
The same file holds the focus ring (`wb-focus`), the wordmark
(`.wb-wordmark`), and the `.wb-prose` rules for rendered markdown.

The look is light only: Hanken Grotesk and JetBrains Mono (loaded in
`app/layout.tsx`), ink plus one cobalt accent for links, the focus ring, the selected
thread, the selected map leg and the selected navlog row, pill buttons and solid fills. Flight-category, verdict and status
colors are data, shown as labelled chips and dots. `app/design-rules.test.ts`
fails the test suite on uppercase, positive letter-spacing, gradients, shadows,
glass, a dark scheme, or any Google font other than those two.

It also holds the map workbench's tokens: `--wb-nav-width`, `--wb-sheet-max`
and `--wb-gutter` for the layout, `--wb-route` for the route line, the
`--wb-cat-*` flight-category colors shared by the chips and the markers, the
filter that turns the map tiles grey, and the print rules.

The plan and subagent steps are **not forks**. They are the packaged
`@b4run/ag-ui/react` components `B4Activity` renders (`TurnActivity` and its
steps), themed through the `--b4-activity-*` tokens in `app/theme.css` and
extended per tool in `app/components/StepViews.tsx`. Validation, bounds, and
layout stay in the package, where they are tested. The package's CSS is
unlayered and Tailwind's utilities are not, so a utility cannot override a
property the package stylesheet sets; use the tokens for those.

The [AG-UI and Web Clients](https://b4.run/docs/ag-ui) guide covers the
protocol side, and the
[Flight Planner Web UI](https://b4.run/docs/recipes/flight-planner-web-ui)
recipe walks through building a client like this one.

## The proxy is not open

B4.run's dev server sets no CORS headers, so the browser reaches it through the
same-origin catch-all at `app/api/b4/[...path]/route.ts`. That route forwards
three requests and nothing else:

| Method | Path |
| --- | --- |
| GET | `/memory/candidates` |
| POST | `/memory/candidates/:id/approve` |
| POST | `/memory/candidates/:id/reject` |

Anything else — an unlisted path, or a listed path with the wrong method — is
rejected with **403** and never forwarded. Running, resuming, and cancelling a
thread are deliberately absent: those go through CopilotKit's own runtime route.
Thread history is absent too: the runtime route's runner (`createB4AgentRunner`) replays
`GET /threads/:id/events` from B4.run's storage server to server when the chat
connects.

The allowlist bounds **which** routes are reachable, not **who** may reach them.
That is the job of the server's
[`threadAccess` policy](https://b4.run/docs/thread-access), which this scaffold
ships active in `server/src/thread-access.ts`, with the caller resolved in
`server/src/auth.ts`. Locally it is inert: with no `B4_INTERNAL_TOKEN` one local
principal owns every thread. Set `B4_INTERNAL_TOKEN` on both packages and the
proxy guards in `app/lib/proxy-guard.ts` turn on: the proxy forwards the token
and a per-browser visitor id, route runs and thread routes are refused without
the token, and each thread is owned by the visitor that created it. The policy
gates only those: `/healthz` and the `/memory/*` review routes still answer
without the token. The B4.run repository's `examples/navlog` adds a production
entry (`main.mjs`) that requires the token on the whole process. Before you
expose this beyond your own machine, guard the whole server the same way, and
replace the visitor id in `server/src/auth.ts` with however you authenticate a
caller.

## Known limits

- **Threads are local to the browser.** B4.run's server cannot enumerate threads,
  so the sidenav keeps its own list in `localStorage` (`app/lib/thread-source.ts`).
  The list is not shared across browsers, devices, or profiles, and clearing
  site data clears it — the server still holds the conversations, but this
  client no longer knows their ids. Two tabs open at once can also clobber each
  other's list, because the store does read-modify-write with no merge.
- **Restores replay stored events.** Switching back to a thread replays what
  the checkpoint stores as the AG-UI events a live run would have sent:
  messages, the turns (plan, subagents, tool steps), attachments and tool media,
  and a parked approval. Notices for parts the model never saw come from
  stream-only events and do not come back. A brand-new thread has nothing to
  replay and restores as an empty chat.
- **Memory review is candidates only.** The sidebar's Memory toggle opens Memory
  mode, which replaces the map column (on a phone, the current panel) with every
  candidate the agent proposed with `remember()`, each with Approve and Delete —
  Delete is a hard delete on the server with no undo. The Memory badge counts
  what is waiting. It cannot
  browse, search, or edit stored memories; that is `npm run memory:list` and the
  rest of the `b4 memory` CLI, or `npx b4 inspect --cwd server` for a browser UI.
- **The map needs the network.** Tiles come from `tile.openstreetmap.org` under
  the OpenStreetMap tile usage policy, which suits development and light use,
  not heavy production traffic; point the `L.tileLayer` URL in `RouteMap.tsx` at
  your own tile provider before you ship. Without network access the map is
  blank, and the route, markers and labels still draw on it.
- **A connection loss costs your draft.** When a probe finds the server down,
  the connect screen replaces the whole shell, which unmounts the chat input.

## Tests

`npm test --workspace web` runs the Vitest suites:

- **Routes and proxy:** the CopilotKit runtime, memory proxy, waypoint search
  and admin routes, the allowlist and the proxy guards.
- **Shell and chat:** the thread source and thread rail, the sidenav and its
  remembered state, the chat (attachments, echo stripping, approval gating),
  the step views, drop notices, the connect screen, the memory panel, media
  parts, the shell's thread-switch and server-probe behaviour, and the desktop
  and phone layouts.
- **Brief kit** (`app/brief/*.test.*`): the schema, the components, the
  parser and `BriefRenderer`, plus the brief contract and the verdict
  (`app/lib/verdict.test.ts`).
- **Map and sheet:** the selectors, route geometry, label collision placement
  (`app/lib/map-labels.test.ts`), `RouteMap` over a fake Leaflet, the marker
  panel, the route bar and its draft, the waypoint search, formatting, the
  navlog grid, table and sheet, the Weather tab and its role grouping, the
  verdict card and the flight plan block.
- **Design rules** (`app/design-rules.test.ts`): the look's constraints, see
  Restyling it.

`typecheck` and `build` prove the CopilotKit and AG-UI wiring compiles. The
activity components themselves are tested in `@b4run/ag-ui`.

None of these tests calls a model. To smoke-test a live run, start both
processes with a real `OPENAI_API_KEY` in `server/.env`, type `KPAO SNS KSBA`
in the route bar and press **Plan**: the plan and subagent steps stream into
the chat, the route and its weather draw on the map, the navlog sheet fills in,
and the brief renders. Then ask it to file the plan to see the approval card.
