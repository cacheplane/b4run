# B4.run examples

Canonical, runnable examples of B4.run applications. Each example is a folder containing one or more workspace packages.

| Example | What it shows |
|---|---|
| [chat](./chat) | Foundational agent-harness primitives (filesystem + bash) end-to-end, with a disposable smoke-test web client |
| [memory](./memory) | Long-term memory with a backend-switchable store — zero-setup SQLite by default, Postgres + pgvector via `DATABASE_URL`, hybrid keyword + vector recall via `OPENAI_API_KEY` |
| [research](./research) | The flagship deep-research assistant example — routes, tools, subagents, memory, planning, offloading, HITL permissions, and an optional Docker sandbox |
| [software-factory](./software-factory) | Rung 0 of the software factory: an application-owned work-order controller that drives the code-fixer worker over the Agent Protocol with exact-candidate approval, cancel, and restart reconciliation |

These examples are pnpm workspace members. They consume B4.run via `workspace:*` and are typechecked in CI.
