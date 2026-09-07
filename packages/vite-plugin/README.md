# @b4run/vite-plugin

Internal Vite integration for B4.run's route discovery and TypeScript type-generation pipeline.

**Use this when:** You are working on B4.run's type-generation pipeline. B4.run application authors should use the [`b4` CLI](https://www.npmjs.com/package/@b4run/cli), which wires this integration for them.

## Install

```bash
pnpm add -D @b4run/vite-plugin vite
```

## Example

```ts
import { b4ToolSchemaPlugin as b4 } from "@b4run/vite-plugin"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [b4()],
})
```

## Runtime and stability

`@b4run/vite-plugin` is a Node-only, internal tooling surface. It reads B4.run routes, analyzes TypeScript tool sources, and writes generated declarations during development and builds. It is not an application-runtime plugin or an author-facing compatibility contract.

## Related

- [`@b4run/cli`](https://www.npmjs.com/package/@b4run/cli) — the supported application entry point for type generation and builds.
- [`@b4run/core`](https://www.npmjs.com/package/@b4run/core) — discovery, compiler, and type-rendering primitives used by this plugin.
- [API catalog entry](https://b4.run/docs/api#b4runvite-plugin) — audience and compatibility summary.
- [Routes guide](https://b4.run/docs/routes) — the route and tool files consumed by the pipeline.

## Maturity and support

This package is pre-1.0 and releases in B4.run's fixed package group. Review the [changelog](https://github.com/cacheplane/b4-run/blob/main/packages/vite-plugin/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/b4-run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4-run/blob/main/LICENSE).
