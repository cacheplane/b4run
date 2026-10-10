# B4.run App — Coding Agent Instructions

This project uses **B4.run**, the TypeScript meta-framework for LangGraph. Agents
and workflows are file-system routes under `src/app/`.

## Key rules

- A route is a directory with an `index.ts` that exports exactly ONE of:
  `agent` (LLM-driven; default export), `workflow` (deterministic async
  function), `graph` (LangGraph graph), or `chain` (LangChain LCEL Runnable).
- Tools are one default-exported async function per file, either in a route's
  `tools/` directory or, as in this app, in the app-level `src/tools/`, where
  every route can use them. Their argument types are inferred at build time.
- Optional route state goes in `state.ts` next to the route.
- Never edit `.b4/b4.generated.d.ts` — it is generated. Run `b4 typegen`
  if `b4:routes` types do not resolve.

## This app: the navlog flight planner

This file is for whoever edits the code. The agent's own runtime guidance is
`workspace/AGENTS.md`, which B4.run injects into its prompt as read-only.

- **Route:** `src/app/navlog/index.ts` is the planning agent. `runBash` is
  denied, and `fileFlightPlan` asks a person before every call.
- **Subagents:** `src/app/navlog/subagents/weather` (METAR, TAF, winds aloft,
  advisories) and `subagents/performance` (POH lookups), each allowed only its
  own tools and dispatched with `task({ subagent, input })`.
- **Tools** (`src/tools/`): `resolveDeparture`, `lookupAirport`,
  `lookupNavaid`, `findRouteStations`, `getMetar`, `getTaf`, `getWindsAloft`,
  `getAdvisories`, `computeNavlog`, `fileFlightPlan`, `readDoc`,
  `renderChart`. The arithmetic lives in pure modules under `src/lib/`, with
  keyless tests in `test/`; the model never does navigation math.
- **Corpus:** `workspace/AGENTS.md`, `aircraft/`, `poh/` and `regs/` are
  read-only (`backends.filesystem` in `b4.config.ts`); `reports/` and
  `flight-plans/` stay writable.
- **Structured answer:** the web client sends the brief kit's JSON Schema as
  `forwardedProps.responseSchema`, which `server.agui.clientForwardedProps`
  in `b4.config.ts` allows for `/navlog` only. Remove that entry and every
  run from the client is refused with a 422. The answer format in the route's
  system prompt must keep matching the kit's components in `web/app/brief/`.

## Full reference (read this before writing routes)

The complete, version-matched B4.run documentation is bundled with the installed
CLI. Run `b4 docs` to list topics or `b4 docs <topic>` to read one (for
example, `b4 docs tools`). The same files are at
`node_modules/@b4run/cli/docs/` — start with `docs/README.md`.
