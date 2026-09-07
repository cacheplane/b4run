<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4-run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180">
</p>

# create-b4-app

Scaffold a B4.run TypeScript application with a supported starter template and the canonical project layout.

**Use this when:** You are starting a new B4.run application from a supported template.

<p align="center">
  <a href="https://b4.run/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/b4-run/main/docs/brand/product-loop.gif" alt="B4.run product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>

## Install

Requires Node.js 24 or later. Run `npm create b4-app@latest my-agent`; a global installation is not required.

## Example

Create the default research starter and run its fixture-backed test suite:

```bash
npm create b4-app@latest my-agent
cd my-agent
npm install
npm test
```

The `research` template is the default. Version 0.8.21 generated the earlier single-package research starter; version 0.8.22 introduced the `server` and `web` workspace. Run `npm view create-b4-app@latest version` to see which release the current dist-tag selects. For a smaller greeter application, select the optional `basic` template with `npm create b4-app@latest my-agent -- --template basic`.

## Runtime and stability

`create-b4-app` is a Node-only executable. It creates files in the target directory but does not install dependencies or start the generated application for you. The generated app owns its provider credentials; fixture-backed tests do not silently fall through to a live provider.

## Related

Related packages are [`@b4run/cli`](https://www.npmjs.com/package/@b4run/cli), which develops and builds the generated app, and [`@b4run/sdk`](https://www.npmjs.com/package/@b4run/sdk), which supplies its author-facing declarations. See the [API catalog](https://b4.run/docs/api#create-b4-app), [Getting Started](https://b4.run/docs/getting-started), [testing guide](https://b4.run/docs/testing-agents), [CLI guide](https://b4.run/docs/cli), and [`create-b4-app` changelog](https://github.com/cacheplane/b4-run/blob/main/packages/create-b4-app/CHANGELOG.md).

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [changelog](https://github.com/cacheplane/b4-run/blob/main/packages/create-b4-app/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4-run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4-run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4-run/blob/main/LICENSE).
