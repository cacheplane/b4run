# {{appName}} — web

The B4.run Workbench: the browser client for the `server/` package's `/navlog`
agent. It is a [CopilotKit](https://docs.copilotkit.ai) v2 app
(`@copilotkit/react-core/v2` + `@copilotkit/runtime`) on Next.js and React that
talks to B4.run over [AG-UI](https://github.com/ag-ui-protocol/ag-ui).

It is a workbench rather than a chat widget, and it is map-first:

- **Sidenav.** On the left: the wordmark, "New plan", the recent threads and
  Memory, which counts the candidates waiting for review and scrolls to them.
- **Route map.** A [Leaflet](https://leafletjs.com) map on
  OpenStreetMap tiles, credited in the map's attribution control. It draws the
  planned route, one marker per waypoint colored by flight category with the
  category as text beside it, and the cruise magnetic heading on each leg.
- **Chat.** The middle column: the thread title and status, memory review, and
  the conversation itself: the plan card, the `weather` and `performance` subagent
  cards, tool cards and the `fileFlightPlan` approval, inline and in order.
- **Weather strip.** Flight-category chips per airport from the `weather`
  subagent's brief (the worse of now and at ETA), plus the winds-aloft line. A
  chip opens the raw METAR and TAF.
- **Navlog sheet.** Under the map, with the totals when collapsed; open, the
  legs table, the ICAO flight plan items 7 to 19 and the brief. **Print** prints
  the sheet alone on one landscape page and **Copy FPL** copies the `(FPL-…)`
  message. Hovering a leg highlights it on the map.
- **Phones.** Under 1024 px: a top row, one full-screen panel and a bottom tab
  bar (Chat, Map, Navlog, the navlog as one card per leg). The menu opens the
  sidenav as a drawer.

Every surface reads the thread the client already has through pure, unit-tested
selectors: `latestNavlog` (the last `computeNavlog` result), `latestWeatherBrief`
(the last completed `weather` subagent run) and `routeGeometry` (what the map
draws). Nothing extra is stored.

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
| Layout | `app/components/WorkbenchLayout.tsx` | the docked columns (sidenav, chat, map with the strip and sheet); the phone tabs |
| Route map | `app/components/RouteMap.tsx` | Leaflet, browser-only, draws what `routeGeometry` returns |
| Sidenav | `app/components/SideNav.tsx` | wordmark, new plan, threads, memory count |
| Chat | `app/components/ChatDock.tsx` | title, status, memory, the chat |
| Weather strip | `app/components/WeatherStrip.tsx` | flight-category chips and the raw reports |
| Navlog sheet | `app/components/NavlogSheet.tsx`, `NavlogTable.tsx`, `FlightPlanBlock.tsx` | totals, legs, ICAO flight plan, print and copy |
| Step views | `app/components/StepViews.tsx` | the opened `computeNavlog` and `renderChart` steps, through `B4Activity`'s `renderStep` |
| Selectors | `app/lib/navlog-selectors.ts`, `weather-selectors.ts`, `route-geometry.ts` | turn the thread into navlog, weather and map data |
| Thread list | `app/components/ThreadRail.tsx` | the thread list inside the sidenav |
| Memory review | `app/components/MemoryPanel.tsx` | approve or delete the candidates `remember()` proposed |
| Chat | `app/components/NavlogChat.tsx` | `<CopilotChat>` with B4.run's slots: turns, approvals, attachments |
| Notices | `app/components/DropNotices.tsx`, `RunError.tsx` | parts the model never saw, and run errors |
| CopilotKit runtime | `app/api/copilotkit/[...path]/route.ts` | registers a `B4HttpAgent` on B4.run's AG-UI endpoint, and a `createB4AgentRunner(InMemoryAgentRunner, ...)` runner that restores threads |
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
thread and the hovered map leg, pill buttons and solid fills. Flight-category, verdict and status
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
- **Memory review is candidates only.** The panel lists what the agent proposed
  with `remember()` and offers Approve and Delete on each — Delete is a hard
  delete on the server with no undo. It shows at most three candidates at a time
  and counts the rest, because it sits above the conversation and takes the
  conversation's space; with none waiting it takes none. It cannot
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

`npm test --workspace web` runs the Vitest suites: the proxy and CopilotKit
runtime routes and the allowlist, the thread source, the thread rail, the chat
(attachments, echo stripping, approval gating), the step views, drop notices,
the connect screen, the memory panel, media parts, the shell's thread-switch
and server-probe behaviour, and the map workbench (selectors, route geometry,
formatting, the navlog table, sheet, flight plan, the weather strip, and the
desktop and phone layouts). `RouteMap` needs a real DOM and is not unit-tested.
`typecheck` and `build` prove the CopilotKit and AG-UI wiring compiles. The
activity components themselves are tested in `@b4run/ag-ui`.

There are no browser or live-model tests here. A full planning run — streaming,
activity steps, the approval gate live and across a reload, memory candidates
appearing — needs a real `OPENAI_API_KEY` and is covered by unit tests only.
