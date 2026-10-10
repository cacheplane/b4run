# Navlog demo

The flagship B4.run example — a VFR flight planner for a Cessna 172N. See
[`server/README.md`](./server/README.md) for the full tour and how to run it.

- `server/` — the B4.run app: routes, live aviationweather.gov tools (no key),
  a POH-grounded `computeNavlog`, `weather` and `performance` subagents,
  memory, planning, `fileFlightPlan` behind approval, keyless unit tests, evals.
- `web/` — the live CopilotKit/AG-UI client: a thread rail, streaming chat,
  suggestion prompts, tool cards, and approval handling, beside a route map
  with a route bar for typing a route and a navlog sheet with a Weather tab. The agent answers with a
  structured brief (hashbrown UI-kit JSON) that the client renders as components. Live runs require a real
  `OPENAI_API_KEY` on the server; the client does not offer a keyless demo mode.
