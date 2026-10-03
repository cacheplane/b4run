# Reading a managed workspace from a trusted host process

**Date:** 2026-09-19
**Status:** approved for implementation
**Amends:** `2026-09-18-thread-workspace-read-design.md` ("Out of scope", last bullet)
**Consumer:** `examples/software-factory` controller (`server/src/worker/workspace-reader.ts`)

## Problem

`SandboxProvider.openWorkspaceReader` (#731) reads `b4-sbx-vol-<resourceScope(scope)(threadId)>`.
That volume exists only for threads whose sandbox went through `SandboxProvider.acquire`.

An app that declares `sandbox.workspace` never calls `acquire`: `resolveSandboxManager` builds a
`ManagedWorkspaceManager` and `SandboxManager.getForThread` routes every thread to it
(`packages/cli/src/lib/runtime/sandbox-manager.ts:42`). The bytes live in
`b4-ws-volume-<sha256([binding, installationId, operationId])>`
(`packages/sandbox/src/docker/managed-workspace.ts`, `names()`), which no function of the thread id
can name. Measured in `examples/software-factory`: after a real builder turn the only volume present
is a `b4-ws-volume-*`, and the thread-id reader fails with "no workspace storage for thread".

The read design excluded a managed-aware variant because thread-id addressing "is what the first
consumer has". The first consumer is the software-factory controller, whose builder is a managed
workspace. The premise was false; this spec supplies the missing half.

`ManagedWorkspaceProvider` has no read capability. `reconnect` starts a session container, so it
is not a workaround: the whole point of the read surface is to never disturb the thread.

## Design calls

### M1 — The reader is addressed by a `ReadyWorkspace`, not a thread id

```ts
// @b4run/workspace
export interface OpenManagedWorkspaceReaderInput {
  readonly workspace: ReadyWorkspace
  readonly signal: AbortSignal
  readonly runAsNonRoot?: SandboxSecurityPolicy["runAsNonRoot"]
}
export interface ManagedWorkspaceProvider {
  // ...existing members
  openWorkspaceReader?(input: OpenManagedWorkspaceReaderInput): Promise<SandboxWorkspaceReader>
}
```

The provider's own addressing unit is the `ReadyWorkspace` (`reconnect`, `release` and `destroy`
already take the reference). A thread id cannot carry the installation id and operation id that
name the storage, and inventing a thread label on the volume would make the provider's storage
addressable by a fact it does not own. The returned `SandboxWorkspaceReader` is the same type the
provider-storage reader returns, with `threadId = workspace.reference.threadId`, so
`inspectWorkspace` and every existing consumer of a reader work unchanged.

It is optional for the same reason `SandboxProvider.openWorkspaceReader` is (D5 of the read
design): a remote provider whose storage cannot be attached twice omits it, and the absence is the
capability probe. The same contract applies verbatim: never create, start, stop, replace or
otherwise disturb the thread's session; writes impossible, not merely undocumented; a missing
workspace is a coded error, never an empty view; not an authorization boundary.

### M2 — Docker: verify the record, then bind the managed volume read-only

The Docker implementation reuses the existing `stored(reference)` verification path: the record
container exists and carries this provider's labels, the persisted intent verifies, the daemon and
scope binding match this provider, the published ready record matches the reference byte for byte,
and the volume exists and is owned. Then, as `reconnect` does, the supplied `ReadyWorkspace` must
verify against the stored intent and equal the stored record (a caller cannot read workspace A by
presenting workspace B's provenance under A's reference). A mismatch is a `conflict`; a missing
record or volume is `lost`.

After verification the read delegates to `openDockerWorkspaceReader` with the managed volume's
name. That function inspects the volume's mountpoint and attaches it as
`--mount type=bind,source=<mountpoint>,target=/workspace,readonly` in a networkless, capability-less,
read-only-root reader container. The "never creates a missing volume" property (D1a) carries over
unchanged: the managed volume is created by `docker volume create` with the default local driver,
so it has a host mountpoint, and a bind of that path refuses a missing source instead of creating
anything. The existing guard that rejects a non-path mountpoint still applies. The reader container
is named `b4-ws-reader-<key>-<random>` and carries the same `b4.sandbox.reader=<key>` label as
provider-storage readers, where `<key>` is the managed intent hash.

Non-disturbance, proven the same two ways as the read design:

- Unit, injected Docker: no command issued by the managed reader names a session container
  (`b4-ws-session-*`), none is a `ps`, and the reader's `run` args carry the bind-readonly mount
  form, `--network none` and the hardening flags. Reverting the mount form reds the test.
- Real Docker (`B4_TEST_DOCKER=1`): create, reconnect, write through the session, read through a
  reader while the session is live, assert the session still reads/writes/execs and the reader
  container is gone after `close()`; then release and read again with only the volume left; then
  destroy and assert the read rejects.

### M3 — A co-located process resolves the reference through a read-only installation opener

The worker's `openWorkspaceInstallation(appRoot)` holds the sqlite store that maps
`threadId → { intent, ready }`. It is a single-owner surface: it opens `admission.sqlite` with
`BEGIN IMMEDIATE` and holds that transaction until `close()`, so a second owner in another process
fails at open. That is correct for lifecycle, and the controller must not become a second owner.

New in `@b4run/sqlite-storage`:

```ts
export interface WorkspaceInstallationReader {
  readonly installationId: string
  readonly associations: Pick<WorkspaceAssociationStore, "get" | "list">
  close(): void
}
export function openWorkspaceInstallationReader(appRoot: string): WorkspaceInstallationReader
```

It opens both databases with `readOnly: true`, takes no transaction, and validates exactly what the
owner validates (admission schema, phase `ready`, state schema, identity match). It never creates
the `.b4/workspaces` directory or either database: a missing installation is an error, because "the
worker has never run here" and "the worker is running here with no such thread" are different
facts. A short `busy_timeout` absorbs the owner's brief write transactions. Rows are verified by the
same association-store code the owner uses, so a corrupt or non-canonical record is rejected, not
read.

### M4 — `@b4run/cli/workspace` ties the two together

```ts
export interface ManagedWorkspaceReadOptions {
  readonly appRoot: string
  readonly provider: SandboxProvider
  readonly threadId: string
  readonly signal: AbortSignal
  readonly runAsNonRoot?: SandboxSecurityPolicy["runAsNonRoot"]
}
export function openManagedWorkspaceReader(options): Promise<SandboxWorkspaceReader>
export function withManagedWorkspaceReader<T>(options, operation): Promise<T>
```

`openManagedWorkspaceReader` opens the installation reader for `appRoot`, looks up the thread's
association, closes the reader, and dispatches to `provider.workspaces.openWorkspaceReader`. Each
refusal names its fact: no `workspaces` capability on the provider; no `openWorkspaceReader` on it;
no association for the thread; association `creating` (the workspace is not published yet);
`deleting` or `deleted` (`lost`); retention `expiresAt` in the past (`expired`). The record's
`ready` is re-verified against its intent before it is handed to the provider.

`withManagedWorkspaceReader` has the scoped-lifetime semantics of `withWorkspaceReader`: the reader
is always closed, and a close failure is aggregated with a body failure rather than replacing it.
That logic is lifted out of `withWorkspaceReader` into one shared helper in `@b4run/workspace`
(`scopedWorkspaceReader(open, operation)`) so the two cannot drift.

There is deliberately no fallback from the managed path to the thread-id path. A helper that tried
provider storage when the installation has no such thread would turn "this app is managed and the
thread does not exist" into a read of some other storage, which is the fail-open shape the
read design refused.

### M5 — The example reads the builder's real workspace

`createThreadWorkspaceReader` takes the builder's `appRoot` alongside its provider and uses
`withManagedWorkspaceReader`. The end-to-end test runs a real builder turn through the agent harness
(the worker's own tools write the repair into the managed workspace, the fixture's test command runs
over it in the container), then the controller reads that workspace, assembles, verifies, freezes,
approves and exports. The `materializeThreadWorkspace` placeholder and the test that pins the
refusal are deleted.

## Out of scope

- Any wire path, as before.
- The captured baseline half (D10 of the read design).
- A Kubernetes managed provider.
- Reading a workspace whose association is still `creating`. A published record is the unit of
  addressing; a half-built volume is not a workspace.
- Changing the single-owner semantics of `openWorkspaceInstallation`.

## Acceptance

- `openWorkspaceInstallationReader` reads associations written by a live owner in the same and in
  another connection, refuses a missing or initializing installation, and cannot write.
- Managed Docker reader: unit non-disturbance and mount-form tests; integration lifecycle test
  under `B4_TEST_DOCKER=1`.
- `openManagedWorkspaceReader` resolves and refuses as listed in M4, against the sqlite store and
  the managed provider fixture.
- `examples/software-factory` end-to-end test reads the builder's own workspace; the refusal test
  is gone; README and handoff note no longer describe the gap as open.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green from the repo root.
