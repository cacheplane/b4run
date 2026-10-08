<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180">
</p>

# @b4run/cli

Command-line development tools and runtime embedding entry points for B4.run applications.

**Use this when:** You are developing, checking, testing, building, serving, or embedding a B4.run runtime.

<p align="center">
  <a href="https://9rq8ezyghevy0wop.public.blob.vercel-storage.com/b4/demo/product-loop.mp4">
    <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/apps/web/public/demo/product-loop-poster.webp" alt="The B4.run navlog demo: a VFR flight plan with its navlog sheet in the Workbench. Opens the demo video." width="720">
  </a>
  <br><a href="https://9rq8ezyghevy0wop.public.blob.vercel-storage.com/b4/demo/product-loop.mp4">▶ Watch the 50-second navlog demo</a>
</p>

## Install

Requires Node.js 24 or later. `create-b4-app` adds the CLI to a new app for you. To add it to an existing app, install it as a regular dependency, not a dev dependency, because the server that `b4 build` emits imports `@b4run/cli` at runtime:

```bash
npm install @b4run/cli
```

## Example

Run the local `b4` binary through `npx` or a `package.json` script:

```bash
npx b4 dev
npx b4 check
npx b4 test
npx b4 build
```

| Command | What it does |
| --- | --- |
| `b4 dev` | Starts the local development runtime with hot reload on `127.0.0.1`. |
| `b4 check` | Validates the app's structure and configuration. |
| `b4 verify` | Checks the app, routes, generated types, dependencies, provider keys and Node version before you run or deploy. |
| `b4 typegen` | Regenerates the route and tool types under `.b4/`. |
| `b4 test` | Runs the app's colocated `run.test.ts` route scenarios. The starters' `npm test` runs vitest instead. |
| `b4 build` | Generates deployment artifacts: a Node server, Dockerfile and LangSmith config by default. |
| `b4 start` | Serves the app in production, on `0.0.0.0:8000` by default. |
| `b4 docs` | Prints the B4.run docs bundled with the installed CLI. |

The [CLI guide](https://b4.run/docs/cli) lists every command and flag.

`b4 start` serves the app without any code of your own. To let application code own the production Node listener instead, import `serveRuntime` from the package root:

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
- `@b4run/cli/workspace` is Node-only and low-level: managed-workspace lifecycle for a host process, without the command program.
- `@b4run/cli/testing` is a deprecated, back-compat-only node-only alias of `@b4run/sdk/testing`; it remains supported only for existing imports, and new scenario code should use the SDK subpath.

`serveRuntime()` starts once and does not watch files or run type generation at boot. Use `b4 dev` for the development watcher and generated types.

## Related

- [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk) supplies the route and runtime contracts consumed by the CLI.
- [`@b4run/core`](https://www.npmjs.com/package/@b4run/core) provides the route discovery, configuration, and type-generation primitives used by the CLI.
- [CLI guide](https://b4.run/docs/cli)
- [CLI API reference](https://b4.run/docs/api/cli)
- [Embed the runtime](https://b4.run/docs/embedding)
- [Deployment options](https://b4.run/docs/deployment)
- [`@b4run/cli` changelog](https://github.com/cacheplane/b4run/blob/main/packages/cli/CHANGELOG.md)

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/cli` changelog](https://github.com/cacheplane/b4run/blob/main/packages/cli/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
