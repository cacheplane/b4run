<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180">
</p>

# create-b4-app

Scaffold a B4.run TypeScript application with a supported starter template and the canonical project layout.

**Use this when:** You are starting a new B4.run application from a supported template.

<p align="center">
  <a href="https://9rq8ezyghevy0wop.public.blob.vercel-storage.com/b4/demo/product-loop.mp4">
    <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/apps/web/public/demo/product-loop-poster.webp" alt="The B4.run navlog demo: a VFR flight plan with its navlog sheet in the Workbench. Opens the demo video." width="720">
  </a>
  <br><a href="https://9rq8ezyghevy0wop.public.blob.vercel-storage.com/b4/demo/product-loop.mp4">▶ Watch the 50-second navlog demo</a>
</p>

## Install

Requires Node.js 24 or later and npm 11. Run `npm create b4-app@latest <directory>`; a global installation is not required, and the directory must be new or empty. Options: `--template basic|navlog` (default `basic`) and `--dist-tag <tag>`, the npm dist-tag the generated app's B4.run dependencies resolve (default `latest`).

## Example

Create the default basic starter, a single `/hello` agent with one typed tool, and run its offline test suite:

```bash
npm create b4-app@latest my-agent
cd my-agent
npm install
npm test
```

For the flight planner, a `server` and `web` npm workspace with subagents, memory, planning and a map Workbench, run `npm create b4-app@latest my-navlog -- --template navlog`. Its live runs need `OPENAI_API_KEY` in `server/.env`; `npm run dev:server` serves the agent on port 3002 and `npm run dev:web` the Workbench on port 3010.

## Runtime and stability

`create-b4-app` is a Node-only executable. It creates files in the target directory but does not install dependencies or start the generated application for you. The generated app owns its provider credentials; fixture-backed tests do not silently fall through to a live provider.

## Related

Related packages are [`@b4run/cli`](https://www.npmjs.com/package/@b4run/cli), which develops and builds the generated app, and [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk), which the app's routes and tools import. See the [API catalog](https://b4.run/docs/api#create-b4-app), [Getting Started](https://b4.run/docs/getting-started), [testing guide](https://b4.run/docs/testing-agents), [CLI guide](https://b4.run/docs/cli), and [`create-b4-app` changelog](https://github.com/cacheplane/b4run/blob/main/packages/create-b4-app/CHANGELOG.md).

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [changelog](https://github.com/cacheplane/b4run/blob/main/packages/create-b4-app/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
