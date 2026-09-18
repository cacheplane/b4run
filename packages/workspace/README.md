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

### Inspecting a text workspace

`inspectWorkspace` accepts the permission-bound `ctx.fs` author handle, a
`SandboxHandle`, or any `WorkspaceReadSource` — including the `SandboxWorkspaceReader`
a provider hands back from `openWorkspaceReader`. All use the same bounded traversal
and require leaf metadata (`stat` / `lstat`) and raw binary reads; missing support
fails closed.

```ts
import { inspectWorkspace } from "@b4run/workspace"

const inventory = await inspectWorkspace(ctx.fs, {
  signal: ctx.signal,
  excludeRootDirectories: [".git"],
  expectedRootSymlinks: { node_modules: "/opt/project/node_modules" },
})
// inventory.files: relative path → exact UTF-8 text (including a leading BOM)
// inventory.symlinks: validated root name → exact readlink target
```

Defaults are 10,000 entries, 2 MiB per file, and 16 MiB total file bytes;
`maxEntries`, `maxFileBytes`, and `maxTotalBytes` accept nonnegative safe integers.
Directories and omitted root entries count toward the entry limit; the workspace
root itself does not. Limits check both reported sizes and actual returned bytes.
The result also includes `entries` and `totalBytes`. File and link records have
null prototypes, so filenames such as `__proto__` remain ordinary keys.

Excluded root names may be absent, but must be directories when present. Expected
root links are required and must match their exact, unnormalized targets. Their
targets are never traversed. Nested entries receive no root exclusions. All other
symlinks, non-file/non-directory entries, executable files, invalid UTF-8 and
NUL-containing binary data are rejected. Leaf names cannot traverse directories.

### Reading another thread's workspace

`withWorkspaceReader(provider, { threadId, signal }, operation)` opens a provider's
optional read-only view of one thread's workspace storage, hands it to `operation`,
and closes it on both the success and failure paths. The reader carries no write
method and no command backend, and reading does not disturb that thread's live
sandbox. `openWorkspaceReader` is optional on `SandboxProvider`; a provider that
omits it makes `withWorkspaceReader` raise rather than silently return nothing.

This is a host-side API for an already-trusted caller. It is not an authorization
boundary, not a tool an agent can call, and not an HTTP surface.
UTF-8 text without NUL is accepted; this is not a file-format classifier.

Pass a signal to check cancellation around every filesystem call; sandbox backends
also receive it in their `BackendContext`. Author handles retain their existing
permission policy and cancellation behavior. The helper cannot interrupt an
author operation already in flight. It uses no shell and no host filesystem APIs.

Inspection is not an atomic snapshot or a new isolation boundary. Metadata,
listing, and reads use separate backend calls and can race with concurrent writers;
quiesce writers or revalidate before acting. Exact links validate link identity,
not the contents of their external targets. Backend reads must honor the supplied
byte cap to bound allocation before returning data.

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
