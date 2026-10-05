# Navlog demo — server

The flagship [B4.run](https://github.com/cacheplane/b4run) example: a VFR flight
planner for a Cessna 172N. It briefs the weather from live aviationweather.gov
data (no key), looks up performance in the 1978 172N POH tables, computes the
navlog in code, and files an ICAO flight plan only when the pilot asks and a
person approves. Live planning uses a real model and API key; the unit tests
and evals run offline.

## Run it

```bash
pnpm install                 # from the repo root
pnpm build                   # build B4.run packages before commands that use dist
pnpm --filter @b4-example/navlog-server exec b4 typegen  # write generated types
pnpm --filter @b4-example/navlog-server check   # validate routes, tools, and config
pnpm --filter @b4-example/navlog-server test    # keyless unit tests of the math, tables and parsers
pnpm --filter @b4-example/navlog-server eval     # quality evals, offline (scripted fixtures)
pnpm --filter @b4-example/navlog-server memory:list
```

To run against a real model, set `OPENAI_API_KEY` and add `--live`
(e.g. `pnpm --filter @b4-example/navlog-server eval -- --live`). The offline
path replays scripted model turns, so evals are deterministic and need no API
key; the tools still run, so the weather tools reach aviationweather.gov.

The weather tools call the aviationweather.gov Data API, which needs no key and
is cached in-process for five minutes. Set `B4_AWC_BASE_URL` to point them at a
local stub instead.

## Run the live web client

The current Next.js/CopilotKit client streams the plan, renders tool calls,
handles the flight-plan approval, offers suggestion prompts, and reviews memory
candidates. After the root install and build above, run from `examples/navlog`:

```bash
cp server/.env.example server/.env   # add a real OPENAI_API_KEY
pnpm dev                             # B4.run server on :3002, web client on :3010
```

Open `http://localhost:3010`. The key stays on the B4.run server; see
[`../web/README.md`](../web/README.md) for the architecture and smoke checklist.

## The tour — where each capability lives

| Capability | File | What it shows |
|---|---|---|
| Agent route | `src/app/navlog/index.ts` | the flight-planning coordinator |
| Tools + typegen | `src/tools/` | `lookupAirport`, `getMetar`, `getTaf`, `getWindsAloft`, `getAdvisories`, `computeNavlog`, `fileFlightPlan`, `readDoc`, `renderChart`; `b4 typegen` writes their generated types |
| Pure logic | `src/lib/` | great-circle and wind math, POH tables, the navlog core, the ICAO flight plan, the winds-aloft parser |
| Subagents | `src/app/navlog/subagents/` | `weather` and `performance`, each scoped to its own tools, dispatched via `task({ subagent, input })` |
| Planning | `src/app/navlog/plan.md` | seeded checklist becomes the thread's todos |
| Memory | `workspace/AGENTS.md`, `memory.md`, `memory.ts` | prompt memory plus typed `recall`/`remember` for the aircraft profile |
| Skills | `src/app/navlog/skills/` | `brief-weather`, `poh-lookup` |
| HITL approval | `src/app/navlog/index.ts` (`tools.approve`) | `fileFlightPlan` asks a person before each call |
| Workspace | `workspace/` | POH and regulation excerpts, saved navlogs, recorded flight plans |
| Persistence | (default) | threads survive a restart (SQLite) |
| Tests | `test/` | keyless unit tests of `computeNavlog`, the tables, the parsers and the tools |
| Evals | `src/app/navlog/evals/` | `defineEval` + scorers + a gate |

## Memory review

This app uses candidate memory writes. When the agent calls `remember`, the
memory is saved for review instead of becoming active immediately.

```bash
pnpm --filter @b4-example/navlog-server memory:list
pnpm --filter @b4-example/navlog-server memory:approve -- <memory-id>
```
