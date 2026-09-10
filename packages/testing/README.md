<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180" />
</p>

# @b4run/testing

Supported harnesses, fixtures, matchers, deterministic embedders, and runtime helpers for testing B4.run applications.

**Use this when:** You want to test B4.run agent behavior without making live model calls.

## Install

```bash
pnpm add -D @b4run/testing vitest
```

## Example

```ts
import { createAgentHarness, expectFinalMessage, script } from "@b4run/testing"

await using harness = await createAgentHarness({
  appRoot: process.cwd(),
  route: "/support#agent",
})
const result = await harness.run({
  input: "Say hello",
  fixtures: script().user("Say hello").replies("Hello!"),
})

expectFinalMessage(result).toContain("Hello")
```

## Runtime and stability

`@b4run/testing` is a supported node-only testing surface. `createAgentHarness()` temporarily changes process-wide model environment variables and runtime caches; await `close()` and do not run concurrent harnesses in one process. Fixture replay is deterministic and CI-safe; live recording requires model credentials.

## Related

- [Testing API reference](https://b4.run/docs/api/testing) — exact harness and lifecycle contracts.
- [Agent Test Harness](https://b4.run/docs/testing-agents) — end-to-end agent testing.
- [Fixtures and Recording](https://b4.run/docs/testing-agents/fixtures) — deterministic replay and optional live recording.
- [`@b4run/evals`](https://www.npmjs.com/package/@b4run/evals) — repeatable datasets, scorers, and release gates.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/testing` changelog](https://github.com/cacheplane/b4run/blob/main/packages/testing/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
