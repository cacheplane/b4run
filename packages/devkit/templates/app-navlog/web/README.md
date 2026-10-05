# {{appName}} — web

The B4.run Workbench: the browser client for the `server/` package's `/navlog`
agent. It is a [CopilotKit](https://docs.copilotkit.ai) v2 app
(`@copilotkit/react-core/v2` + `@copilotkit/runtime`) on Next.js and React that
talks to B4.run over [AG-UI](https://github.com/ag-ui-protocol/ag-ui).

It is a workbench rather than a chat widget, and it is map-first:

- **Route map.** A full-viewport [Leaflet](https://leafletjs.com) map on
  OpenStreetMap tiles, credited in the map's attribution control. It draws the
  planned route, one marker per waypoint colored by flight category with the
  category as text beside it, and the cruise magnetic heading on each leg.
- **Chat dock.** A floating panel on the left with "+ New conversation", the
  thread list behind a "Threads" disclosure, memory review, and the
  conversation itself: the plan card, the `weather` and `performance` subagent
  cards, tool cards and the `fileFlightPlan` approval, inline and in order.
- **Weather strip.** Flight-category chips per airport from the `weather`
  subagent's brief (the worse of now and at ETA), plus the winds-aloft line. A
  chip opens the raw METAR and TAF.
- **Navlog sheet.** A bottom sheet with the totals when collapsed; open, the
  legs table, the ICAO flight plan items 7 to 19 and the brief. **Print** prints
  the sheet alone on one landscape page and **Copy FPL** copies the `(FPL-…)`
  message. Hovering a leg highlights it on the map.
- **Phones.** Under 768 px the dock and the sheet become one bottom sheet with
  Chat and Navlog tabs, the navlog as one card per leg.

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
| Layout | `app/components/WorkbenchLayout.tsx` | the map with the dock, strip and sheet over it; the phone tabs |
| Route map | `app/components/RouteMap.tsx` | Leaflet, browser-only, draws what `routeGeometry` returns |
| Chat dock | `app/components/ChatDock.tsx` | header, new conversation, threads, memory, transcript, composer |
| Weather strip | `app/components/WeatherStrip.tsx` | flight-category chips and the raw reports |
| Navlog sheet | `app/components/NavlogSheet.tsx`, `NavlogTable.tsx`, `FlightPlanBlock.tsx` | totals, legs, ICAO flight plan, print and copy |
| Navlog card | `app/components/NavlogCard.tsx` | the compact `computeNavlog` card in the transcript |
| Selectors | `app/lib/navlog-selectors.ts`, `weather-selectors.ts`, `route-geometry.ts` | turn the thread into navlog, weather and map data |
| Thread list | `app/components/ThreadRail.tsx` | the thread list behind the dock's "Threads" disclosure |
| Memory review | `app/components/MemoryPanel.tsx` | approve or delete the candidates `remember()` proposed |
| Transcript | `app/components/Transcript.tsx` | messages, activity cards, tool cards, approvals, errors |
| Composer | `app/components/Composer.tsx` | send, and stop while a run is in flight |
| Plan card | `app/components/PlanCard.tsx` | the packaged plan card, restyled |
| Subagent card | `app/components/SubagentCard.tsx` | the packaged subagent card, restyled |
| Renderer registry | `app/components/activity-renderers.tsx` | hands both cards to CopilotKit |
| CopilotKit runtime | `app/api/copilotkit/[...path]/route.ts` | registers a `B4HttpAgent` on B4.run's AG-UI endpoint |
| Server proxy | `app/api/b4/[...path]/route.ts` | forwards allowlisted reads to B4.run |
| Proxy allowlist | `app/lib/proxy-allowlist.ts` | the pure policy the proxy enforces |
| Thread history | `app/lib/thread-source.ts`, `app/lib/hydrate.ts` | the rail's list, and restoring a saved thread |
| Theme | `app/theme.css` | the whole palette, as CSS variables |

## Restyling it

`app/theme.css` is the one file to edit. The palette is defined there as CSS
variables and re-exported as Tailwind tokens through `@theme inline`, which is
why the app's utilities read `bg-wb-surface`, `border-wb-border`,
`text-wb-muted`, `rounded-wb`. Change a `--wb-*` value and the light palette,
the dark palette, the activity-card tokens, and every utility move together.
The same file holds the focus ring (`wb-focus`), the two roles the gradient is
allowed to play (`.wb-brand-mark`, `.wb-primary-action`), and the `.wb-prose`
rules for rendered markdown.

It also holds the map workbench's tokens: `--wb-dock-width`, `--wb-sheet-max`
and `--wb-gutter` for the layout, `--wb-route` for the route line, the
`--wb-cat-*` flight-category colors shared by the chips and the markers, the
filter that mutes the map tiles (inverted in dark mode), and the print rules.

The palette follows the OS light/dark setting. To pin one, set
`data-wb-theme="light"` or `data-wb-theme="dark"` on `<html>`; `theme.css`
defines both branches.

The plan and subagent cards are **not forks**. They are the packaged
`@b4run/ag-ui/react` components (`PlanActivityCard`, `SubagentActivityCard`),
customized through that package's `classNames` ladder. To change how they look,
edit `app/components/PlanCard.tsx` and `app/components/SubagentCard.tsx` —
validation, bounds, and layout stay in the package, where they are tested. One
constraint is worth knowing before you add a class: a `classNames` entry can
only set a property the package stylesheet leaves unset on that element,
because the package's CSS is unlayered and Tailwind's utilities are not.
`app/components/activity-renderers.tsx` states the rule and what it puts out of
reach.

The [AG-UI and Web Clients](https://b4.run/docs/ag-ui) guide covers the
protocol side, and the
[Research Assistant Web UI](https://b4.run/docs/recipes/research-web-ui)
recipe walks through building a client like this one.

## The proxy is not open

B4.run's dev server sets no CORS headers, so the browser reaches it through the
same-origin catch-all at `app/api/b4/[...path]/route.ts`. That route forwards
five requests and nothing else:

| Method | Path |
| --- | --- |
| GET | `/memory/candidates` |
| POST | `/memory/candidates/:id/approve` |
| POST | `/memory/candidates/:id/reject` |
| GET | `/threads/:id/state` |
| GET | `/threads/:id/pending_interrupts` |

Anything else — an unlisted path, or a listed path with the wrong method — is
rejected with **403** and never forwarded. Running, resuming, and cancelling a
thread are deliberately absent: those go through CopilotKit's own runtime route.

The allowlist bounds **which** routes are reachable, not **who** may reach them.
That is the job of the server's
[`threadAccess` policy](https://b4.run/docs/thread-access), which this scaffold
ships active in `server/src/thread-access.ts`, with the caller resolved in
`server/src/auth.ts`. Locally it is inert: with no `B4_INTERNAL_TOKEN` one local
principal owns every thread. Set `B4_INTERNAL_TOKEN` on both packages and the
proxy guards in `app/lib/proxy-guard.ts` turn on: the proxy forwards the token
and a per-browser visitor id, and the server refuses calls without the token
and makes each thread owned by the visitor that created it. Before you expose
this beyond your own machine, replace the visitor id in `server/src/auth.ts`
with however you authenticate a caller.

## Known limits

- **Threads are local to the browser.** B4.run's server cannot enumerate threads,
  so the rail keeps its own list in `localStorage` (`app/lib/thread-source.ts`).
  The list is not shared across browsers, devices, or profiles, and clearing
  site data clears it — the server still holds the conversations, but this
  client no longer knows their ids. Two tabs open at once can also clobber each
  other's list, because the store does read-modify-write with no merge.
- **Restores are lossy.** Switching back to a thread replays only what the
  checkpoint stores: messages, tool calls and results, and the plan. Subagent
  activity cards from earlier runs are not saved and do not come back, and the
  app says so above the restored messages. A brand-new thread has no checkpoint
  yet; that 404 is treated as "nothing to restore", not an error.
- **Memory review is candidates only.** The panel lists what the agent proposed
  with `remember()` and offers Approve and Delete on each — Delete is a hard
  delete on the server with no undo. It shows at most three candidates at a time
  and counts the rest, so it cannot push the thread list off the rail. It cannot
  browse, search, or edit stored memories; that is `npm run memory:list` and the
  rest of the `b4 memory` CLI, or `npx b4 inspect --cwd server` for a browser UI.
- **The map needs the network.** Tiles come from `tile.openstreetmap.org` under
  the OpenStreetMap tile usage policy, which suits development and light use,
  not heavy production traffic; point the `L.tileLayer` URL in `RouteMap.tsx` at
  your own tile provider before you ship. Without network access the map is
  blank, and the route, markers and labels still draw on it.
- **A connection loss costs your draft.** When a probe finds the server down,
  the connect screen replaces the whole shell, which unmounts the composer.

## Tests

`npm test --workspace web` runs 27 test files with Vitest: the proxy route and
its allowlist, the thread source, the checkpoint hydrator, the transcript
mapping, the renderer registry, the thread rail, the composer, the connect
screen, the memory panel, the tool-call card, media parts, all three permission
surfaces, the shell's thread-switch and server-probe behaviour, and the map
workbench (selectors, route geometry, formatting, the navlog table, sheet,
flight plan and card, the weather strip, and the desktop and phone layouts).
`RouteMap` needs a real DOM and is not unit-tested. `typecheck` and `build`
prove the CopilotKit and AG-UI wiring compiles. The activity cards themselves
are tested in `@b4run/ag-ui`.

There are no browser or live-model tests here. A full planning run — streaming,
activity cards, the approval gate live and across a reload, memory candidates
appearing — needs a real `OPENAI_API_KEY` and is covered by unit tests only.
