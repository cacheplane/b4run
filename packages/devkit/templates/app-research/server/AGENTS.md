# B4.run App — Coding Agent Instructions

This project uses **B4.run**, the TypeScript meta-framework for LangGraph. Agents
and workflows are file-system routes under `src/app/`.

## Key rules

- A route is a directory with an `index.ts` that exports exactly ONE of:
  `agent` (LLM-driven; default export), `workflow` (deterministic async
  function), `graph` (LangGraph graph), or `chain` (LangChain LCEL Runnable).
- Tools are co-located in a route's `tools/` directory — one default-exported
  async function per file. Their argument types are inferred at build time.
- Optional route state goes in `state.ts` next to the route.
- Never edit `.b4/b4.generated.d.ts` — it is generated. Run `b4 typegen`
  if `b4:routes` types do not resolve.

## Full reference (read this before writing routes)

The complete, version-matched B4.run documentation is bundled with the installed
CLI. Run `b4 docs` to list topics or `b4 docs <topic>` to read one (for
example, `b4 docs tools`). The same files are at
`node_modules/@b4run/cli/docs/` — start with `docs/README.md`.
