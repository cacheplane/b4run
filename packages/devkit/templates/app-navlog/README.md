# {{appName}}

A VFR flight planner for a Cessna 172N, built with [B4.run](https://github.com/cacheplane/b4run),
shipped as an npm workspace with two packages:

- **`server/`** — the B4.run app: the planning route, live aviationweather.gov
  tools (no key), a POH-grounded `computeNavlog`, `weather` and `performance`
  subagents, memory, planning, `fileFlightPlan` behind approval, keyless unit
  tests, and evals.
  [`server/README.md`](./server/README.md) is the full tour.
- **`web/`** — the B4.run Workbench: an [AG-UI](https://github.com/ag-ui-protocol/ag-ui)
  client built on CopilotKit. A full-viewport route map (Leaflet on
  OpenStreetMap tiles) sits behind a floating chat dock (threads, streaming chat,
  plan and subagent activity cards, tool cards, the flight-plan approval, memory
  review), a weather strip with flight-category chips that match the airport
  markers, and a bottom navlog sheet with the legs table, the ICAO flight plan,
  the brief, print and copy. Phones get one tabbed bottom sheet.
  [`web/README.md`](./web/README.md) covers restyling it and its known limits.

The B4.run repository's `examples/navlog` runs this same app as a public demo,
with the server on Railway and the Workbench on Vercel; its READMEs' "Deploy"
sections cover the production entry, the proxy guards and the configuration.

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
