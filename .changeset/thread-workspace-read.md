---
"@b4run/workspace": patch
"@b4run/sandbox": patch
"@b4run/cli": patch
---

Add a read-only way for a trusted host process to read one thread's sandbox workspace.

`SandboxProvider` gains an optional `openWorkspaceReader`, and `@b4run/workspace`
exports `withWorkspaceReader` plus the `SandboxWorkspaceReader`,
`ReadOnlyFilesystemBackend`, `WorkspaceReadSource` and `OpenWorkspaceReaderInput`
contracts. `inspectWorkspace` now accepts any `WorkspaceReadSource`, so a reader
works wherever a `SandboxHandle` did.

`dockerSandbox` implements the capability by attaching the thread's existing
workspace into a separate, ephemeral, networkless container as a read-only bind
of the volume's backing directory: the thread's keeper container is never
inspected, started, stopped or replaced, and writes fail at the kernel rather
than at a policy check. It also reads a thread whose compute was already
released. A named-volume mount is deliberately avoided because it would create a
missing volume, so a reader racing a thread delete would resurrect that thread's
workspace as an empty volume. A `close()` that cannot remove its container
reports the failure instead of swallowing it, and reads after close are refused
with a clear error.

`kubernetesSandbox` omits the capability because a `ReadWriteOnce` claim cannot
be mounted by a second Pod unless it lands on the same node. `fakeSandbox`
implements it in memory and gained the `lstat`, `readBinaryFile` and `statFile`
members the Docker backend already had. `runProviderConformance` takes a
`workspaceReads` declaration and verifies it, so the contract is covered without
skipping a test for providers that omit the capability.

This is a host-side API for an already-trusted caller. It is not an authorization
boundary, not a model tool, and not an HTTP endpoint.

`@b4run/cli` also gains a `./workspace` subpath exporting `withWorkspace`,
`WithWorkspaceOptions` and `cleanupWorkspaces`, so a host process can own managed
workspace lifecycle without importing the package root, which is the command
program.
