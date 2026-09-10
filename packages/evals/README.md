<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180" />
</p>

# @b4run/evals

Supported evaluation definitions, datasets, scorers, reports, and release gates for B4.run application behavior.

**Use this when:** You are defining repeatable evaluations, scorers, or release gates for a B4.run application.

## Install

```bash
pnpm add -D @b4run/evals @b4run/testing
```

## Example

```ts
import { contains, defineEval, gate, runEval } from "@b4run/evals"
import { createAgentHarness, script } from "@b4run/testing"

const evaluation = defineEval({
  name: "support replies",
  route: "/support#agent",
  dataset: [
    {
      input: "Where is my order?",
      fixtures: script()
        .user("Where is my order?")
        .replies("Your order is in transit."),
    },
  ],
  scorers: [contains("order", { threshold: 1 })],
  gate: gate.perScorer(),
})

await using harness = await createAgentHarness({
  appRoot: process.cwd(),
  route: "/support#agent",
})
const report = await runEval(evaluation, {
  runCase: async (testCase) => {
    if (typeof testCase.input !== "string") throw new TypeError("Expected string input")
    return harness.run({
      input: testCase.input,
      ...(testCase.fixtures !== undefined ? { fixtures: testCase.fixtures } : {}),
    })
  },
})
```

## Runtime and stability

`@b4run/evals` is a supported node-only testing surface because it resolves JSON and JSONL datasets from disk. Deterministic agent runs come from `@b4run/testing`; scorer code still executes in replay, record, and live modes. `llmJudge()` needs a fixture, model credentials, or an injected fetch implementation.

## Related

- [Evals API reference](https://b4.run/docs/api/evals) — exact scorer, runner, and gate semantics.
- [Evals](https://b4.run/docs/evals) — the application evaluation workflow.
- [`@b4run/testing`](https://www.npmjs.com/package/@b4run/testing) and [Fixtures and Recording](https://b4.run/docs/testing-agents/fixtures) — deterministic model calls.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/evals` changelog](https://github.com/cacheplane/b4run/blob/main/packages/evals/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
