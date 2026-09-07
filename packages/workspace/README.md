# @b4run/workspace

Filesystem and shell backend contracts for B4.run agent workspaces.

**Use this when:** You are supplying filesystem or shell backends, middleware, or workspace tools to a B4.run application.

## Install

```bash
pnpm add @b4run/workspace
```

## Example

```ts
import { compose, type FilesystemBackend, withFilesystemLogging } from "@b4run/workspace"
import { localFilesystem } from "@b4run/workspace/node"

const base: FilesystemBackend = localFilesystem({ maxFileBytes: 512 * 1024 })
const filesystem = compose(withFilesystemLogging())(base)
```

## Runtime and stability

- `@b4run/workspace` is an edge-safe, supported application surface.
- `@b4run/workspace/node` is a node-only, supported application surface.

Workspace backends define where operations run; they are not an isolation boundary by themselves. Use a sandbox provider when untrusted execution must leave the host process.

## Related

- [Workspace API reference](https://b4.run/docs/api/workspace) — exact backend, middleware, and tool contracts.
- [Workspace Filesystem](https://b4.run/docs/workspace) — application configuration and backend behavior.
- [`@b4run/sandbox`](https://www.npmjs.com/package/@b4run/sandbox) — isolated execution providers for workspace operations.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/workspace` changelog](https://github.com/cacheplane/b4-run/blob/main/packages/workspace/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4-run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4-run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4-run/blob/main/LICENSE).
