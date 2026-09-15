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

### Capturing initial source

The Node entry point provides `captureWorkspaceSource`, `createSourceBundle`,
`verifySourceBundle`, and `readSourceFile` for immutable source bundles.

```ts
import { captureWorkspaceSource, readSourceFile } from "@b4run/workspace/node"

const source = await captureWorkspaceSource(appRoot, {
  directory: "fixtures/demo",
  include: ["index.ts", "package.json"],
  files: [{ path: "TASK.md", text: "Repair the failing example.\n" }],
})
const original = readSourceFile(source, "index.ts")
```

Paths resolve relative to `appRoot`. `include` is the exact file inventory;
unexpected files cause capture to fail. `excludeDirectories` can explicitly omit
existing directory subtrees, such as installed dependencies. Additional entries
can declare `file` paths relative to `appRoot` instead of inline `text`.

Capture preserves binary bytes and executable flags, rejects symlinks and
ambiguous paths, and returns a verified digest with immutable content. Limits are
10,000 distinct inspected filesystem paths (including the app root and ancestor
directories), 16 MiB per file, and 64 MiB total file content. Source paths
use a portable ASCII subset with consistent directory casing.

Capture reads a trusted application tree and rejects detected changes during
reading; it is not an atomic filesystem snapshot. It does not create a sandbox,
register runtime configuration, or provide workspace lifecycle recovery.

### Supported surfaces

- `@b4run/workspace` is an edge-safe, supported application surface.
- `@b4run/workspace/node` is a node-only, supported application surface.

Workspace backends define where operations run; they are not an isolation boundary by themselves. Use a sandbox provider when untrusted execution must leave the host process.

## Related

- [Workspace API reference](https://b4.run/docs/api/workspace) — exact backend, middleware, and tool contracts.
- [Workspace Filesystem](https://b4.run/docs/workspace) — application configuration and backend behavior.
- [`@b4run/sandbox`](https://www.npmjs.com/package/@b4run/sandbox) — isolated execution providers for workspace operations.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/workspace` changelog](https://github.com/cacheplane/b4run/blob/main/packages/workspace/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
