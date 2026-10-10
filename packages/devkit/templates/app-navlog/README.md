# {{appName}}

A VFR flight planner for a Cessna 172N, built with [B4.run](https://github.com/cacheplane/b4run),
shipped as an npm workspace with two packages:

- **`server/`** — the B4.run app: the planning route, live aviationweather.gov
  tools (no key), a POH-grounded `computeNavlog`, `weather` and `performance`
  subagents, memory, planning, `fileFlightPlan` behind approval, keyless unit
  tests, and evals.
  [`server/README.md`](./server/README.md) is the full tour.
- **`web/`** — the B4.run Workbench: an [AG-UI](https://github.com/ag-ui-protocol/ag-ui)
  client built on CopilotKit. On desktop it is three docked columns:
  - a collapsible sidenav with **New plan**, the recent threads and **Memory**
    mode for reviewing the memories the agent proposed;
  - the chat, with each turn's plan, tool and subagent steps and the
    flight-plan approval inline, and the agent's answer rendered as a
    structured brief;
  - the route map (Leaflet on OpenStreetMap tiles) over the navlog sheet. A
    route bar across the top of the map takes a typed route with waypoint
    autocomplete, airport markers open their METAR and TAF, and the sheet holds
    the legs, a **Weather** tab grouped by origin, en route and destination,
    the totals and ICAO flight plan, the brief, print and copy.

  Phones get one full-screen panel at a time and a tab bar: Chat, Map, Navlog.
  [`web/README.md`](./web/README.md) covers the layout, restyling it and its
  known limits.

The B4.run repository's `examples/navlog` runs this same app as a public demo at
<https://navlog-web.vercel.app>, with the server on Railway and the Workbench on
Vercel; its READMEs' "Deploy" sections cover the production entry, the proxy
guards and the configuration.

Requires Node.js 24 or later and npm 11.

## Run it

Install once, from the app root — that wires up both packages:

```bash
npm install
cp server/.env.example server/.env
```

Live planning needs a real `OPENAI_API_KEY` in `server/.env`. There is no
keyless demo mode; the bundled tests and evals run keyless on fixtures instead.

Then start the two processes, one per terminal:

| Process | Command | URL |
|---|---|---|
| Agent server | `npm run dev:server` | <http://127.0.0.1:3002> |
| Web client | `npm run dev:web` | <http://localhost:3010> |

Start the server first. The web client proxies to it and shows a "can't reach
the B4.run server" screen until it answers.

The rest of the toolchain lives at the root too — `npm run verify`,
`npm run check`, `npm run typecheck`, `npm test`, `npm run eval`,
`npm run build`, and `npm start`. Each one delegates to `server/`, except
`typecheck`, `test`, and `build`, which run in every package that defines them.
