# @b4run/inspector

Browser application for inspecting a running B4.run app.

**Use this when:** You want a browser inspector for reviewing memory and runtime state in a B4.run application.

## Install

Install the inspector application separately; the B4.run CLI launches it rather than importing it as an API:

```bash
pnpm add -D @b4run/inspector
```

## Example

Launch it from a B4.run application:

```bash
pnpm exec b4 inspect
```

## Runtime and stability

`b4Inspector.server` identifies the supported node-only application shipped as a standalone server. The package is launched through the CLI, not imported as a TypeScript API.

## Related

- [Inspector guide](https://b4.run/docs/inspector) — launch options and browser workflow.
- [API catalog entry](https://b4.run/docs/api#b4runinspector) — the package's runtime classification.
- [`@b4run/cli`](https://www.npmjs.com/package/@b4run/cli) — the command that launches the inspector.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/inspector` changelog](https://github.com/cacheplane/b4-run/blob/main/packages/inspector/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4-run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4-run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4-run/blob/main/LICENSE).
