# Navlog — a VFR flight planner on B4.run

The flagship B4.run example: a flight-planning agent for a Cessna 172N and the
web workbench that drives it. Type a route such as `KPAO SNS KSBA`, and the agent
briefs the live weather from aviationweather.gov (no key), looks up performance in
the 1978 172N POH tables, computes the navlog in code rather than in the model,
answers with a structured go/no-go brief, and files an ICAO flight plan only when
you ask and a person approves.

**Live demo:** <https://navlog-web.vercel.app> (the web client on Vercel, the
B4.run server on Railway).

It is also a template: `npm create b4-app -- --template navlog` scaffolds the same
two packages as a standalone npm workspace.

## Prerequisites

- Node.js 24 or later.
- pnpm, from the B4.run monorepo root (the version is pinned in the root
  `package.json`). A scaffolded copy uses npm instead; its root README has the
  npm commands.
- An `OPENAI_API_KEY` for live planning. There is no keyless demo mode; the unit
  tests and evals run keyless on fixtures.

## Run it

```bash
pnpm install                         # from the repo root
pnpm build                           # the example uses the B4.run packages' dist
cd examples/navlog
cp server/.env.example server/.env   # set OPENAI_API_KEY here
pnpm dev                             # server on :3002, web on :3010
```

Open <http://localhost:3010> and plan a route from the route bar above the map,
or pick a starter suggestion in the chat. `pnpm dev:server` and `pnpm dev:web`
start one process each, and `pnpm test` runs both packages' Vitest suites.

## Where things live

**`server/`** — the B4.run app ([`server/README.md`](./server/README.md)):

| Path | What is there |
|---|---|
| `src/app/navlog/` | the `/navlog` agent route, its `plan.md`, memory, skills and evals |
| `src/app/navlog/subagents/` | `weather` (METAR, TAF, winds aloft, advisories) and `performance` (POH lookups) |
| `src/tools/` | the app's tools, one per file: `computeNavlog`, the weather tools, `fileFlightPlan` and the rest |
| `src/lib/` | pure logic: wind and great-circle math, the POH tables, the navlog core, the ICAO flight plan |
| `src/auth.ts`, `src/thread-access.ts` | who the caller is, and which threads they may reach |
| `data/`, `scripts/` | the navaid snapshot and the script that rebuilds it from OurAirports |
| `workspace/` | the agent's read-only corpus (POH and regulation excerpts, the aircraft baseline, `AGENTS.md`) plus its writable reports and flight plans |
| `test/` | keyless unit tests |

**`web/`** — the Next.js + CopilotKit workbench ([`web/README.md`](./web/README.md)):

| Path | What is there |
|---|---|
| `app/components/` | the shell (`AppShell`, `WorkbenchLayout`, `SideNav`), the chat (`ChatDock`, `NavlogChat`), the map (`RouteMap`, `RouteBar`, `MarkerPanel`) and the sheet (`NavlogSheet`, `WeatherTab`, `FlightPlanBlock`) |
| `app/brief/` | the brief kit: the structured answer's schema, components and renderer |
| `app/lib/` | pure selectors and helpers that turn the thread into navlog, weather and map data |
| `app/api/` | the CopilotKit runtime route, the memory proxy and the waypoint search |

## How a request flows

```
browser
  → /api/copilotkit/*                 (web: CopilotKit runtime route, no API key)
    → B4HttpAgent → POST /agui/%2Fnavlog%23agent   (B4.run server, holds OPENAI_API_KEY)
      → the /navlog agent and its subagents
        → AG-UI event stream back to the browser
```

The browser never talks to the B4.run server directly: chat runs go through the
CopilotKit route, and memory review goes through an allowlisted proxy at
`/api/b4/*`.

## Read more

- [Navlog overview](https://b4.run/docs/recipes/navlog) — the demo, running,
  deploying and the architecture.
- [Flight Planner](https://b4.run/docs/recipes/flight-planner) — building the agent.
- [Flight Planner Web UI](https://b4.run/docs/recipes/flight-planner-web-ui) —
  building the workbench.
- [`server/README.md`](./server/README.md) — the capability tour, the waypoint
  snapshot, memory review and the Railway deploy.
- [`web/README.md`](./web/README.md) — the layout, data flow, restyling, tests and
  the Vercel deploy.
