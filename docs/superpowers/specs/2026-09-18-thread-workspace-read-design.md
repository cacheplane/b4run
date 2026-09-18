# Thread workspace read — design

- Date: 2026-09-18
- Status: accepted (design calls made unilaterally; repo owner unavailable for an interactive gate)
- Blocking dependency for: software factory rung 1 (`examples/software-factory/server`) controller-owned verification

## Problem

A trusted, co-located host process — not the agent, not an HTTP client — must read
the bytes a worker thread produced inside its sandbox workspace **after the
worker's turn ends**, so it can validate them against a baseline that process
captured itself. There is no supported way to do that today.

The first consumer is the software factory controller. It is a separate process
from the worker runtime. It knows the worker's sandbox `scope` and the thread id.
It wants an `inspectWorkspace`-compatible reader and nothing more.

### Why the two obvious workarounds are rejected

1. **Call `SandboxProvider.acquire` from the second process.** `acquire` is
   documented idempotent per `threadId`, but the Docker provider "reuses only a
   keeper owned by this provider lifecycle with a matching persisted identity;
   otherwise it replaces the keeper while preserving the volume"
   (`packages/sandbox/src/docker/docker-sandbox.ts`). A second provider instance
   has no lifecycle state for the thread, so `reuseExisting` is `false` and the
   worker's container is destroyed and recreated underneath it. The volume
   survives; the worker does not. Unacceptable.
2. **Derive the volume name and reach in.** The name is
   `b4-sbx-vol-<resourceScope(scope)(threadId)>`, and `resourceScope`
   (`packages/sandbox/src/resource-scope.ts`) is not exported. Reaching into a
   private addressing function makes a second process depend on an internal
   naming scheme whose own comment says it is addressing, "not an authorization
   or ownership check". Unacceptable as a supported path.

## Shape of the solution

A **provider-optional capability** on `SandboxProvider`:

```ts
openWorkspaceReader?(input: OpenWorkspaceReaderInput): Promise<SandboxWorkspaceReader>
```

It returns a read-only view over the thread's *workspace storage* — not over the
thread's live sandbox. The live sandbox is never inspected, started, stopped,
replaced or exec'd into.

## Design calls

Each call below was made without a human gate. Rationale is recorded so it can be
reversed knowingly.

### D1 — Mechanism: a separate read-only container over the same storage

The Docker implementation starts a **fresh, ephemeral container** with the
thread's existing workspace volume bind-mounted read-only
(`-v <vol>:/workspace:ro`) and reads through `docker exec` **into that reader
container**. It touches the keeper container's name in exactly zero Docker
commands.

Rejected: `docker exec` into the keeper. It would require a live keeper, so it
would fail for precisely the case the consumer cares about — the worker released
between turns, container reaped, volume retained — and it offers no
mechanism-level read-only guarantee.

Rejected: one ephemeral container per filesystem call (`docker run --rm ... sh -c
<op>`). No lifecycle to leak, but `inspectWorkspace` issues two or more execs per
file, and a container start per operation turns a modest workspace into minutes.

### D2 — Read-only is enforced by the kernel, not by a doc comment

Three independent layers, in order of authority:

1. The workspace mount is `:ro`. A write fails with `EROFS` from the kernel. This
   is the guarantee.
2. The returned type exposes no write methods and **no `exec`**. There is no API
   through which a caller can even express a mutation.
3. The reader container itself is hardened beyond the keeper's defaults:
   `--network none` (unconditionally — a reader has no reason to reach the
   network, whatever the thread's policy was), `--cap-drop ALL`,
   `--security-opt no-new-privileges`, `--read-only` rootfs with tmpfs `/tmp` and
   `/run`, and a `--pids-limit`.

### D3 — The return type is not a `SandboxHandle`; `inspectWorkspace` widens instead

A read-only view with a mandatory `exec` backend would be a lie. So
`SandboxWorkspaceReader` has `threadId`, `workspaceRoot`, a read-only
`filesystem`, and `close()` — no `exec`.

To keep `inspectWorkspace` compatibility (the stated acceptance test),
`inspectWorkspace`'s parameter widens from `WorkspaceFs | SandboxHandle` to
`WorkspaceFs | WorkspaceReadSource`, where:

```ts
interface WorkspaceReadSource {
  readonly filesystem: Pick<FilesystemBackend, "lstat" | "readBinaryFile" | "listDir">
  readonly workspaceRoot: string
}
```

`SandboxHandle` structurally satisfies that, so this is a pure widening: no
existing call site changes, nothing that compiled stops compiling. The
discriminant `"filesystem" in source` is unchanged.

The reader's `filesystem` type makes `lstat`, `readBinaryFile` and `statFile`
**required** rather than optional, so `inspectWorkspace` can never fail against a
reader for a missing capability — the failure mode the optional members exist to
describe does not apply to a surface built for inspection.

### D4 — A method on `SandboxProvider`, not a nested capability object

`workspaces?: ManagedWorkspaceProvider` already establishes the
provider-optional-capability precedent, but managed workspaces are a cluster of
operations. This is one operation, so it is one optional method. Presence is the
capability probe: `typeof provider.openWorkspaceReader === "function"`.

### D5 — Kubernetes deliberately does not implement it

`kubernetesSandbox` has no managed-workspace support yet, and its per-thread
storage is a `ReadWriteOnce` PVC, which a second pod cannot mount unless it lands
on the same node. An implementation that works only by accident of scheduling is
worse than an honest absence, so the capability stays absent there and the docs
say so. The conformance kit skips the block when the capability is absent, so
Kubernetes conformance keeps passing unchanged.

### D6 — Reader identity defaults to the hardened workspace owner (1000:1000)

Files the worker produced under the default policy are owned by `1000:1000`
(Architecture B's create-time chown). The reader runs as the same uid/gid so it
can read them, including mode-0600 files.

Running the reader as root would not be *more* capable: `--cap-drop ALL` removes
`CAP_DAC_OVERRIDE` and `CAP_DAC_READ_SEARCH`, so uid 0 gets no permission bypass,
and it would then *lose* access to 0600 files owned by 1000.

A thread that opted into `security.runAsNonRoot: false` produced root-owned
files. For that case the input accepts
`runAsNonRoot?: SandboxSecurityPolicy["runAsNonRoot"]` — the same vocabulary the
thread's own policy uses — so the caller can mirror whatever it dispatched. It
defaults to the same secure default the provider applies.

### D7 — Explicit `close()`, plus a scoped helper so callers cannot leak

The reader container is real state. `close()` removes it, is idempotent, and
never throws for an already-gone container. The container is created with `--rm`
and labelled `b4.sandbox.reader=<resourceId>` so a stray is findable.

`withWorkspaceReader(provider, input, fn)` ships in `@b4run/workspace` and closes
in a `finally`, aggregating a body failure with a close failure rather than
losing either. That is the form the docs lead with.

### D8 — A missing workspace is a coded error, not an empty reader

`open` probes the volume and throws `B4_E2001` ("sandbox unavailable") when the
thread has no workspace storage. "The thread produced nothing" and "the thread
does not exist" are different facts to a verifier, and silently returning an
empty inventory would let a controller pass a validation it never actually ran.

### D9 — Reader operations carry no PID-exhaustion recovery

The keeper's exec path can recover from PID exhaustion by *replacing the
container*. That is exactly the behaviour this surface exists to avoid, so the
reader's filesystem is built without a recovery hook and without an exec lease.
A PID-exhausted reader surfaces as an error; it never recreates anything.

### D10 — The captured baseline half stays out of scope

`<appRoot>/.b4/workspaces/state.sqlite` holds the full base64 `SourceBundle` in
`workspace_sources`. It stays private. Three reasons:

- The first consumer **authors** the baseline. The controller dispatched the
  `WorkspaceDefinition`; it can capture and retain its own bundle. Reading B4's
  private store back would make controller verification depend on B4's storage
  schema instead of on the controller's own captured authority — the inversion
  the code-fixer example already avoids by treating `readInitialFile` (captured
  source) as authority rather than the live volume.
- It would hand a second process a durable-format dependency on a table we want
  to stay free to change.
- The blocking dependency for rung 1 is the *produced* bytes. The baseline is
  already obtainable.

Listed as an open question in the PR rather than settled forever.

### D11 — Not an authorization boundary

Stated explicitly in the docs. The caller must already be trusted: it holds the
provider, which holds the Docker socket. Anything reachable through this surface
was already reachable. It is not a model tool and not an HTTP endpoint, and no
route, permission or thread-access check is consulted. Naming a thread id is not
a claim of ownership — `resourceScope` addresses, it does not authorize.

### D12 — `@b4run/cli/workspace` subpath, folded in

`withWorkspace` is public but only from the `@b4run/cli` root barrel, and that
root is the CLI itself — shebang, commander, every command module. A host process
that wants to own workspace lifecycle should not import a command program. The
new `@b4run/cli/workspace` subpath re-exports `withWorkspace`,
`WithWorkspaceOptions` and `cleanupWorkspaces` from a dedicated entry, following
the existing `./fetch` and `./runtime` pattern. The root barrel keeps its exports
so nothing breaks.

## Non-disturbance requirement

Proven, not asserted, at two levels:

- **Unit (no daemon).** With an injected Docker spawner, assert that
  `openWorkspaceReader` issues no command naming the keeper container
  `b4-sbx-<resourceId>` — no `ps`, no `inspect`, no `start`, no `rm` — and that
  the reader's own `run` args carry `:ro`, `--network none`, the hardening flags
  and the reader label.
- **Real Docker (`B4_TEST_DOCKER=1`).** Acquire a thread, write a file, record
  the keeper's container id. Read the workspace through a reader while the keeper
  is running. Then assert: the keeper's container id is unchanged, the keeper is
  still running, `exec.runCommand` still returns exit 0, the original handle can
  still read and write, the reader container is gone after `close()`, and a write
  into the same volume through a `:ro` mount fails. Plus the case `docker exec`
  into the keeper could never serve: read the workspace after `release()`, when
  the keeper is gone and only the volume remains.

## Surface

```ts
// @b4run/workspace
export type ReadOnlyFilesystemBackend = Readonly<
  Pick<Required<FilesystemBackend>, "lstat" | "readFile" | "readBinaryFile" | "listDir" | "statFile">
>

export interface WorkspaceReadSource {
  readonly filesystem: Pick<FilesystemBackend, "lstat" | "readBinaryFile" | "listDir">
  readonly workspaceRoot: string
}

export interface OpenWorkspaceReaderInput {
  readonly threadId: string
  readonly signal: AbortSignal
  readonly runAsNonRoot?: SandboxSecurityPolicy["runAsNonRoot"]
}

export interface SandboxWorkspaceReader extends WorkspaceReadSource {
  readonly threadId: string
  readonly filesystem: ReadOnlyFilesystemBackend
  readonly workspaceRoot: string
  close(): Promise<void>
}

export interface SandboxProvider {
  // ...existing members
  openWorkspaceReader?(input: OpenWorkspaceReaderInput): Promise<SandboxWorkspaceReader>
}

export function withWorkspaceReader<T>(
  provider: SandboxProvider,
  input: OpenWorkspaceReaderInput,
  operation: (reader: SandboxWorkspaceReader) => Promise<T>,
): Promise<T>
```

`inspectWorkspace(source: WorkspaceFs | WorkspaceReadSource, options?)`.

## Consumer sketch

```ts
import { dockerSandbox } from "@b4run/sandbox"
import { inspectWorkspace, withWorkspaceReader } from "@b4run/workspace"

const provider = dockerSandbox({ scope: "software-factory", image })

const produced = await withWorkspaceReader(provider, { threadId, signal }, (reader) =>
  inspectWorkspace(reader, { excludeRootDirectories: [".git"], maxTotalBytes: 2 * 1024 * 1024 }),
)
```

## Out of scope

- Any wire path. No Agent Protocol route, no HTTP endpoint, no provenance or
  digest endpoint. This is a host-side API only.
- The captured baseline / `SourceBundle` reader (D10).
- A Kubernetes implementation (D5).
- Writes, patches or exports of any kind.
- A managed-workspace-aware variant. `ManagedWorkspaceProvider` sessions have
  their own lifecycle; the capability here is addressed by `threadId` against
  provider storage, which is what the first consumer has.

## Acceptance

- `inspectWorkspace(reader)` returns the worker's produced files.
- `runProviderConformance` passes for `fakeSandbox` and real Docker, with a new
  capability-conditional block covering the reader.
- The real-Docker non-disturbance proof above passes.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green from the repo root.
