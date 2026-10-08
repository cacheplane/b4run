# {{appName}} — server

A VFR flight planner for a Cessna 172N, built with [B4.run](https://github.com/cacheplane/b4run).
Ask for a flight; it briefs the weather from live aviationweather.gov data (no
key), looks up performance in the 1978 172N POH tables, computes the navlog in
code, and files an ICAO flight plan only when you ask and a person approves.
Live planning uses a real OpenAI model and API key; the unit tests and evals
are keyless.

Requires Node.js 24 or later and npm 11.

## Run it live

Everything below runs from the app root — the directory above this one, where
`npm install` links both workspace packages. The root scripts delegate here.

```bash
npm install
cp server/.env.example server/.env
# Add a real OPENAI_API_KEY to server/.env
npm run verify
npm run dev:server     # B4.run dev server on http://127.0.0.1:3002
```

Ask the planner for a flight — it plans, dispatches the `weather` and
`performance` subagents, computes the navlog, and streams back a brief:

```bash
curl -N "http://127.0.0.1:3002/agui/%2Fnavlog%23agent" \
  -H 'accept: text/event-stream' \
  -H 'content-type: application/json' \
  -d '{"threadId":"t1","runId":"r1","state":{},"tools":[],"context":[],"forwardedProps":{},
       "messages":[{"id":"1","role":"user","content":"Plan a VFR flight from KSTP to KRST at 4500 feet, departing 1400Z, in N738ZU (172N, 2400 RPM, 50 gal usable)."}]}'
```

That's the [AG-UI](https://github.com/ag-ui-protocol/ag-ui) endpoint (`/agui/<route>`).
Alongside text, tools, and interrupts, it emits standard replacement `b4.plan`
activity snapshots for valid planning, and AG-UI 1.0 `SUBAGENT_STARTED/FINISHED/ERROR`
events, with the child's own events tagged `subagentRunId`, for each `task`
dispatch. The plan activity is the whole presentation of the root `writeTodos`
call behind it: a call whose activity was emitted produces no root tool events,
while every other tool is unchanged.

The **web UI** over this endpoint is the sibling [`web/`](../web) package — the
B4.run Workbench: the streamed plan and brief, each turn's activity, suggestion
prompts, the flight-plan approval, and memory-candidate review. Start it with
`npm run dev:web` from the app root. If you write your own client instead, do
not hand-build the activity view — `@b4run/ag-ui/react/copilotkit` ships it: a React
client wraps CopilotKit's `<CopilotChat>` in `B4Activity` and spreads
`useB4ChatSlots()` onto it, so each turn renders its plan, tool steps and
subagents, and a parked approval renders as a card.
That is what `web/` does, and the
[Flight planner web UI](https://b4.run/docs/recipes/flight-planner-web-ui)
recipe walks through building one.

Separately, `npx b4 inspect --cwd server` opens the
[B4.run Inspector](https://b4.run/docs/inspector) — a browser UI over this
app's live memory store, already installed here as a devDependency.

## Check it without a key

```bash
npm run typegen    # write server/.b4/b4.generated.d.ts
npm run check      # validate routes, tools, and configuration without writing files
npm run typecheck  # validate TypeScript
npm test           # keyless unit tests of the math, tables and parsers
npm run eval       # quality evals (scripted fixtures)
npm run memory:list
```

These commands provide keyless confidence in the starter; the fixtures are
test assets, not a keyless product demo. The eval replays scripted model turns,
but the tools still run, so the weather tools reach aviationweather.gov. To run
evals against a real model, add `--live` (for example, `npm run eval -- --live`).

The weather tools call the aviationweather.gov Data API, which needs no key and
is cached in-process for five minutes. Set `B4_AWC_BASE_URL` in `server/.env`
to point them at a local stub instead.

## Build and start the artifact

```bash
npm run build
npm start
```

Run these in order: `build` writes the configured deployment artifacts, then
`start` loads `server/.env` when present and serves
`server/.b4/build/server.mjs`. `start` does not build the app for you.

## The tour — where each capability lives

| Capability | File | What it shows |
|---|---|---|
| Agent route | `src/app/navlog/index.ts` | the flight-planning coordinator |
| Tools + typegen | `src/tools/` | `resolveDeparture`, `lookupAirport`, `getMetar`, `getTaf`, `getWindsAloft`, `getAdvisories`, `computeNavlog`, `fileFlightPlan`, `readDoc`, `renderChart`; `b4 typegen` writes their generated types |
| Pure logic | `src/lib/` | great-circle and wind math, POH tables, the navlog core, the ICAO flight plan, the winds-aloft parser |
| Subagents | `src/app/navlog/subagents/` | `weather` and `performance`, each scoped to its own tools, dispatched via `task({ subagent, input })` |
| Planning | `src/app/navlog/plan.md` | seeded checklist becomes the thread's todos |
| Memory | `workspace/AGENTS.md`, `memory.md`, `memory.ts` | prompt memory plus typed `recall`/`remember` for the aircraft profile |
| Skills | `src/app/navlog/skills/` | `brief-weather`, `poh-lookup` |
| HITL approval | `src/app/navlog/index.ts` (`tools.approve`) | `fileFlightPlan` asks a person before every call (`allowAlways: false`: no "Always allow") |
| Workspace | `workspace/` | POH and regulation excerpts, saved navlogs, recorded flight plans, behind a path-jail |
| Persistence | (default) | threads survive a restart (SQLite) |
| Tests | `test/` | keyless unit tests of `computeNavlog`, the tables, the parsers and the tools |
| Evals | `src/app/navlog/evals/` | `defineEval` + scripted cases + scorers + a gate |

## Memory review

This scaffold uses candidate memory writes. When the agent calls `remember`,
the memory is saved for review instead of becoming active immediately.

```bash
npm run memory:list
npm run memory:approve -- <memory-id>
```

`npm run memory:approve` wraps `b4 memory approve`; use either form when
you want to promote a candidate into active recall.

## Make it yours

This is a starter — extend the parts you want and delete the rest:

- **Swap the aircraft:** replace `workspace/poh/*.md` and `src/lib/poh-tables.ts`
  together; `test/corpus-sync.test.ts` keeps the two equal.
- **Add tools:** drop a file in `src/tools/` for shared tools or
  `<route>/tools/` for route-local tools, then run `npm run typegen` followed by
  `npm run check`.
- **File for real:** `fileFlightPlan` records the FPL message in the workspace;
  replace its body with a call to your filing service, and keep its
  `tools.approve` entry (`allowAlways: false`, so every filing asks a person).
- **Enable summarization:** uncomment the `summarization` block in
  `b4.config.ts` once your threads get long.
- **Throw it away:** delete `src/app/navlog/` and start from a single
  `index.ts` — the toolchain (`typegen`/`check`/`build`/`test`/`eval`) still works.
