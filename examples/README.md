# B4.run examples

Canonical, runnable examples of B4.run applications. Each example is a folder containing one or more workspace packages.

| Example | What it shows |
|---|---|
| [chat](./chat) | Foundational agent-harness primitives (filesystem + bash) end-to-end, with a disposable smoke-test web client |
| [memory](./memory) | Long-term memory with a backend-switchable store — zero-setup SQLite by default, Postgres + pgvector via `DATABASE_URL`, hybrid keyword + vector recall via `OPENAI_API_KEY` |
| [navlog](./navlog) | The flagship example, a VFR flight planner for a Cessna 172N: live weather tools, POH-grounded navlog computation, weather and performance subagents, memory, planning, offloading, approval-gated filing, and the map Workbench |
| [software-factory](./software-factory) | Rung 1 of the software factory: an application-owned work-order controller with a bounded builder route, controller-owned verification in its own container, and approval bound to a frozen review bundle rather than a bare digest |

These examples are pnpm workspace members. They consume B4.run via `workspace:*` and are typechecked in CI.
