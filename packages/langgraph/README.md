# @b4run/langgraph

LangGraph.js adapters and route-module contracts for B4.run graphs and workflows.

**Use this when:** You are integrating raw graphs or workflows with B4.run route contracts. Agent and tool authors who do not need raw route modules should start with [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk).

## Install

```bash
pnpm add @b4run/langgraph
```

## Example

```ts
import { defineEntry, graphAdapter } from "@b4run/langgraph"

const route = defineEntry({
  graph: async (input: { name: string }) => ({ greeting: `Hello, ${input.name}` }),
})

const result = await graphAdapter.execute(route.graph, { name: "B4.run" }, {
  signal: new AbortController().signal,
})
```

## Runtime and stability

- `@b4run/langgraph` is an edge-safe, supported integration surface for adapters and route contracts.
- `@b4run/langgraph/define-entry` is an edge-safe, supported entry-validation subpath.
- `@b4run/langgraph/route-module` is an edge-safe, supported normalization and route-type subpath.

These surfaces contain no third-party runtime dependencies or Node globals. That boundary does not classify graphs, workflows, or tools supplied by an application.

## Related

- [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk) — higher-level route, agent, and tool contracts.
- [`@b4run/langchain`](https://www.npmjs.com/package/@b4run/langchain) — LangChain agent and chain materialization.
- [LangGraph API reference](https://b4.run/docs/api/langgraph) — route-module exports and adapter behavior.
- [Routes guide](https://b4.run/docs/routes) — B4.run's filesystem route model.

## Maturity and support

This package is pre-1.0 and releases in B4.run's fixed package group. Review the [changelog](https://github.com/cacheplane/b4run/blob/main/packages/langgraph/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
