# @b4run/core

Low-level B4.run APIs for configuration, capabilities, route discovery, state resolution, and type generation.

**Use this when:** You are building B4.run integrations or tooling below the author-facing SDK. Direct route authors should use [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk) instead.

## Install

```bash
pnpm add @b4run/core
```

## Example

The root export includes the typed configuration helper and pure type renderers:

```ts
import { config, renderB4Types } from "@b4run/core"

export const appConfig = config({
  build: { targets: ["node"] },
})

export const declarations = renderB4Types({ appRoot: "/app", routes: [] }, [])
```

## Runtime and stability

- `@b4run/core` is an edge-safe, low-level integration surface.
- `@b4run/core/node` is a Node-only, low-level surface for filesystem discovery and compiler-backed extraction.
- `@b4run/core/internal/compiler` is Node-only and internal. Application and integration code must not depend on it.

Importing `/node` registers the disk-backed `b4.config.ts` loader. The root stays free of that filesystem-loader edge so static runtimes can seed configuration instead.

## Related

- [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk) — author-facing agents, tools, middleware, and route contracts.
- [`@b4run/cli`](https://www.npmjs.com/package/@b4run/cli) — route discovery, type generation, development, and builds.
- [Core API reference](https://b4.run/docs/api/core) — complete exports and surface boundaries.
- [Routes guide](https://b4.run/docs/routes) — B4.run's application and filesystem route model.

## Maturity and support

This package is pre-1.0 and releases in B4.run's fixed package group. Review the [changelog](https://github.com/cacheplane/b4run/blob/main/packages/core/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
