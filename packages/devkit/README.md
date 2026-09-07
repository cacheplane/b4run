# @b4run/devkit

Internal scaffold templates and generated-application test utilities shared by B4.run tooling.

**Use this when:** You are working on B4.run scaffold templates or generator tests. Application authors should run [`create-b4-app`](https://www.npmjs.com/package/create-b4-app) instead of importing this package.

## Install

```bash
pnpm add -D @b4run/devkit
```

## Example

```ts
import { resolveTemplateDir } from "@b4run/devkit"

const templateDir = await resolveTemplateDir("research")
```

`resolveTemplateDir` accepts B4.run's supported `basic` and `research` template names and verifies that the bundled template directory exists.

## Runtime and stability

`@b4run/devkit` is a Node-only, internal tooling surface. It reads packaged templates and supports B4.run's own scaffold generation and generated-app tests; it is not an application runtime or author-facing SDK.

## Related

- [`create-b4-app`](https://www.npmjs.com/package/create-b4-app) — the supported scaffold command for application authors.
- [`@b4run/cli`](https://www.npmjs.com/package/@b4run/cli) — development, verification, and build tooling for generated applications.
- [API catalog entry](https://b4.run/docs/api#b4rundevkit) — audience and compatibility summary.
- [Getting Started](https://b4.run/docs/getting-started) — scaffold and run a B4.run application.

## Maturity and support

This package is pre-1.0 and releases in B4.run's fixed package group. Review the [changelog](https://github.com/cacheplane/b4-run/blob/main/packages/devkit/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/b4-run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4-run/blob/main/LICENSE).
