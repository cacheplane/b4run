# Navlog demo — server

The flagship [B4.run](https://github.com/cacheplane/b4run) example: a VFR flight
planner for a Cessna 172N. It briefs the weather from live aviationweather.gov
data (no key), looks up performance in the 1978 172N POH tables, computes the
navlog in code, and files an ICAO flight plan only when the pilot asks and a
person approves. Live planning uses a real model and API key; the unit tests
and evals are keyless.

## Run it

```bash
pnpm install                 # from the repo root
pnpm build                   # build B4.run packages before commands that use dist
pnpm --filter @b4-example/navlog-server exec b4 typegen  # write generated types
pnpm --filter @b4-example/navlog-server check   # validate routes, tools, and config
pnpm --filter @b4-example/navlog-server test    # keyless unit tests of the math, tables and parsers
pnpm --filter @b4-example/navlog-server eval     # quality evals, keyless (scripted fixtures)
pnpm --filter @b4-example/navlog-server memory:list
```

To run against a real model, set `OPENAI_API_KEY` and add `--live`
(e.g. `pnpm --filter @b4-example/navlog-server eval -- --live`). The keyless
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
| HITL approval | `src/app/navlog/index.ts` (`tools.approve`) | `fileFlightPlan` asks a person before every call (`allowAlways: false`: no "Always allow") |
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

## Deploy (Railway)

The live demo runs this server on Railway behind the web client on Vercel
(see [`../web/README.md`](../web/README.md#deploy-vercel)). Two files are
deployment-only and are not part of the scaffold:

- `main.mjs`, the production entry. It loads the `b4 build` output exactly as
  the generated `.b4/build/server.mjs` does, then adds two things. With
  `DATABASE_URL` set, the checkpointer, threads and permissions stores move to
  Postgres (`@b4run/postgres-storage`). With `B4_INTERNAL_TOKEN` set, every
  request except `GET /healthz` must carry that token in `X-Internal-Token`,
  which only the web proxy has, and anything else gets 401. With neither set it
  behaves like `b4 start`.
- `Dockerfile.railway`, a multi-stage build from the repository root: it
  installs the server and its workspace packages, builds them from source, and
  runs `b4 build`.

**Railway service.** The service is not connected to GitHub (Railway has
deprecated `railway.json` config-as-code, and its GitHub App is not installed
on this repository). Its settings live on the service itself: Dockerfile path
`examples/navlog/server/Dockerfile.railway` with the repository root as the
build context, health check `/healthz` with a 120 s timeout, restart on
failure up to three times. The Postgres template in the same project injects
`DATABASE_URL`.

**Deploys** come from `.github/workflows/deploy-navlog.yml`, the same shape as
threadplane's Railway workflows: on a push to `main` that touches the server,
a workspace package, or the docs the CLI bundles, it uploads the checkout with
the Railway CLI under a project token (`RAILWAY_NAVLOG_TOKEN`, scoped to the
demo's project and environment), follows the deployment it created until
Railway reports success, and probes `/healthz`. A build or boot failure fails
the workflow instead of hiding behind the last good image. `workflow_dispatch`
redeploys `main` by hand.

**Variables.**

| Variable | Purpose |
|---|---|
| `B4_INTERNAL_TOKEN` | The secret shared with the web project. At least 32 characters (`openssl rand -base64 32`); `main.mjs` refuses to boot with a shorter one. |
| `DATABASE_URL` | Injected by the Postgres plugin. Durable threads, checkpoints, permissions and memory (Postgres + pgvector). |
| `OPENAI_API_KEY` | A dedicated key with a monthly spend cap. With `DATABASE_URL` also set it turns on vector recall. |
| `B4_PG_SCHEMA`, `B4_PG_TABLE_PREFIX` | Optional; default `public` and `b4`. |
| `B4_ALLOW_UNGUARDED` | Leave unset. See below. |

**Fail closed.** When `DATABASE_URL` or any of `RAILWAY_ENVIRONMENT`,
`RAILWAY_ENVIRONMENT_NAME` and `RAILWAY_ENVIRONMENT_ID` is set and
`B4_INTERNAL_TOKEN` is not, `main.mjs` refuses to boot rather than serve every
runtime route to anyone who finds the URL. `src/auth.ts` checks the token too,
so route runs and thread routes refuse an untokened call even without
`main.mjs` in front; `main.mjs` is what also covers `/memory/*`. Set `B4_ALLOW_UNGUARDED=1` only if an
unguarded server is really what you mean.

**Visitors.** Behind the proxy each browser is its own principal: the proxy
mints a visitor id into a cookie and forwards it as `X-B4-Visitor`, and
`src/auth.ts`, `src/middleware.ts` and `src/thread-access.ts` make every thread
owned by the visitor that created it. Without `B4_INTERNAL_TOKEN` (`b4 dev`, the
tests, the evals) one local principal owns everything, so none of this changes
local development. Because the thread-access policy cannot ship to LangSmith,
`b4.config.ts` builds the `node` target only.

**Memory is shared.** Long-term memory is one store for the whole demo. Any
visitor's agent may propose a memory, and the proposed candidates are visible
to every visitor in the memory panel; only the demo owner can approve or reject
one (see the web README). Approved memories are the demo's curated aircraft
profile.

**What does not survive a redeploy.** Reports and recorded flight plans the
agent writes under `workspace/`, and "Always allow" approval grants (they stay
in SQLite on the container disk). Filing never has one: the route approves
`fileFlightPlan` with `allowAlways: false`, so one visitor cannot approve
filing for everyone; every call asks. The navlog itself lives in the Postgres
checkpoint, which the Workbench reads back from the thread.

**Run the production entry locally.**

```bash
pnpm --filter @b4-example/navlog-server build   # b4 build: writes .b4/build
cd examples/navlog/server
B4_INTERNAL_TOKEN="$(openssl rand -base64 32)" DATABASE_URL=postgres://… node main.mjs
```

`pnpm --filter @b4-example/navlog-server test:deploy` builds and then boots
`main.mjs` to check the guard, the visitor isolation and the fail-closed boot.
It is a manual, local lane: it is not part of `test` and CI does not run it.

The image builds and runs locally too:

```bash
docker build -f examples/navlog/server/Dockerfile.railway -t navlog-server .   # from the repo root
docker run --rm -e B4_INTERNAL_TOKEN="$(openssl rand -base64 32)" -p 8000:8000 navlog-server
```
