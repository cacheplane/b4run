<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4-run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180">
</p>

# @b4run/sdk

Author-facing TypeScript declarations for B4.run agents, tools, middleware, memory, routes, and typed runtime contracts.

**Use this when:** You are authoring routes, tools, middleware, memory declarations, or typed runtime contracts.

<p align="center">
  <a href="https://b4.run/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/b4-run/main/docs/brand/product-loop.gif" alt="B4.run product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>

## Install

Requires Node.js 24 or later.

```bash
pnpm add @b4run/sdk
```

Add `zod` when declaring typed long-term memory:

```bash
pnpm add zod
```

## Example

Define a minimal agent route:

```ts
// src/app/support/index.ts
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Answer support questions clearly and concisely.",
})
```

The same package provides adjacent memory and middleware declarations:

```ts
// src/app/support/memory.ts
import { defineMemory } from "@b4run/sdk"
import { z } from "zod"

export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route"],
  schema: z.object({
    subject: z.string(),
    predicate: z.string(),
    value: z.string(),
  }),
})
```

```ts
// src/middleware.ts
import { defineMiddleware } from "@b4run/sdk"

export default defineMiddleware(() => ({ action: "continue" }))
```

## Runtime and stability

- `@b4run/sdk` is the supported, edge-safe application surface.
- `@b4run/sdk/pure` is a supported, dependency-free edge-safe integration surface.
- `@b4run/sdk/testing` is a supported Node-only scenario-authoring surface. It is separate from `@b4run/testing`.

## Related

- [`@b4run/cli`](https://www.npmjs.com/package/@b4run/cli) develops, tests, builds, and serves routes declared with the SDK.
- [`@b4run/testing`](https://www.npmjs.com/package/@b4run/testing) provides programmatic harnesses for B4.run applications.
- [SDK API reference](https://b4.run/docs/api/sdk)
- [Agents](https://b4.run/docs/agents)
- [Tools](https://b4.run/docs/tools)
- [Middleware](https://b4.run/docs/middleware)
- [Memory](https://b4.run/docs/memory)
- [Scenario testing](https://b4.run/docs/testing)

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/sdk` changelog](https://github.com/cacheplane/b4-run/blob/main/packages/sdk/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4-run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4-run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4-run/blob/main/LICENSE).
