<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4-run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180">
</p>

# @b4run/cli

Command-line development tools and runtime embedding entry points for B4.run applications.

**Use this when:** You are developing, checking, testing, building, serving, or embedding a B4.run runtime.

<p align="center">
  <a href="https://b4.run/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/b4-run/main/docs/brand/product-loop.gif" alt="B4.run product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>

## Install

Requires Node.js 24 or later. Install the CLI as a development dependency for normal application workflows:

```bash
pnpm add -D @b4run/cli
```

Install it as a production dependency only when application code imports its runtime entry points.

## Example

Use the local binary to develop, validate, test, and build an application:

```bash
pnpm exec b4 dev
pnpm exec b4 check
pnpm exec b4 test
pnpm exec b4 build
```

The corresponding commands are `b4 dev`, `b4 check`, `b4 test`, and `b4 build` when the local binary is already on `PATH`.

To let application code own a production Node listener, import `serveRuntime` from the package root:

```ts
import { serveRuntime } from "@b4run/cli"

const runtime = await serveRuntime({
  appRoot: process.cwd(),
  host: "0.0.0.0",
  port: 8000,
})

console.log(runtime.url)
// Call await runtime.close() during your host's ordered shutdown.
```

## Runtime and stability

- `@b4run/cli` and its `b4` command are supported node-only application and tooling surfaces.
- `@b4run/cli/fetch` is a supported edge-safe integration surface for generated fetch deployments.
- `@b4run/cli/runtime` is Node-only and low-level.
- `@b4run/cli/testing` is a deprecated, back-compat-only node-only alias of `@b4run/sdk/testing`; it remains supported only for existing imports, and new scenario code should use the SDK subpath.

`serveRuntime()` starts once and does not watch files or run type generation at boot. Use `b4 dev` for the development watcher and generated types.

## Related

- [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk) supplies the route and runtime contracts consumed by the CLI.
- [`@b4run/core`](https://www.npmjs.com/package/@b4run/core) provides the route discovery, configuration, and type-generation primitives used by the CLI.
- [CLI guide](https://b4.run/docs/cli)
- [CLI API reference](https://b4.run/docs/api/cli)
- [Embed the runtime](https://b4.run/docs/embedding)
- [Deployment options](https://b4.run/docs/deployment)
- [`@b4run/cli` changelog](https://github.com/cacheplane/b4-run/blob/main/packages/cli/CHANGELOG.md)

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/cli` changelog](https://github.com/cacheplane/b4-run/blob/main/packages/cli/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4-run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4-run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4-run/blob/main/LICENSE).
