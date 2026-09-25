# @dawn-ai/sandbox

## 0.12.1

### Patch Changes

- f2ee6cf: `inspectWorkspace` no longer makes one backend call per entry when the backend can batch. Filesystem backends gain two optional methods. `walkTree` returns every entry below a directory with `lstat` metadata in one call, and `readBinaryFiles` reads many files with `readBinaryFile`'s per-file `maxBytes` bound. When a backend has both, inspection walks once, reads in a few calls, and applies exactly the same name, kind, size, and budget checks as before. A file that grew between the walk and the read is refused.

  The Docker backend and the Docker workspace reader implement both methods. Inspecting a container workspace now costs a few `docker exec` calls instead of one per `listDir`, `lstat`, and read. Over 1,214 entries that took inspection from 143 s to about 1 s. The walk is bounded inside the container, names travel as exact bytes, and a walk over the entry limit fails rather than being truncated. `withFilesystemLogging` passes both methods through. Other backends are unchanged and keep the per-entry path.

- 0781125: The Kubernetes sandbox backend now implements `walkTree` and `readBinaryFiles`, so `inspectWorkspace` over a pod's workspace costs a few execs instead of one per `listDir`, `lstat`, and read. Over 1,212 entries on a kind cluster, batched inspection took under a second, where each per-entry exec cost about 80 ms. The batch read's script goes to `sh -s` on stdin rather than in argv, because a Kubernetes exec carries its command in the request URL, where an API server or proxy may cap the length. Batch read scripts also redirect each read's stdin from `/dev/null`, so no command in a script fed on stdin can consume the rest of it.
- 0dd8fff: `sandbox.thread` decides each thread's whole sandbox (workspace, image and policy) once, at the thread's first admission. The image goes through the new optional `ManagedWorkspaceProvider.resolveImageEnvironment`, and its identity is recorded in the thread's creation intent; the image reference and the policy overrides are recorded beside the association in the same transaction, and every reconnect runs the thread's recorded policy over the app's. `dockerSandbox({ images })` bounds which images a thread may name and refuses anything else before any Docker call; `image` is optional when `images` is given. A thread may not open a network the app denies, and `security` stays per app. `b4 check`, `b4 build` and startup refuse unknown `sandbox` keys and `thread` beside `workspace`; a thread-sandbox app builds to a `{ version: 2, kind: "thread" }` artifact. The installation now stores a workspace's source only after its environment resolves, so a refused image leaves no source behind.

  **Behaviour change:** `b4 check`, `b4 build` and startup now refuse any key in the `sandbox` block other than `workspace`, `thread`, `provider`, `network`, `env`, `resources`, `security` and `idleTimeoutMs`. A misspelt key used to be ignored silently, which left every thread in a per-app sandbox; rename or remove any other key.

- 1da86ae: A sandbox with no `network` setting now defaults to `{ mode: "allow" }`. The previous default was `{ mode: "allow", denylist: ["169.254.169.254"] }`, but neither the Docker nor the Kubernetes provider enforces an allow-mode `denylist`. The entry claimed a block on the cloud metadata endpoint that never took effect, and runtime behavior is unchanged: allow-mode egress was open before and is open now. On a cloud VM, set `network: { mode: "deny" }` when the sandbox does not need the network. Otherwise block the endpoint outside B4.run, with a host firewall or egress proxy for Docker, or with the `b4-sandbox-infra` chart's default-deny egress backstop or your own NetworkPolicy for Kubernetes. The `SandboxPolicy.network` JSDoc and the sandbox and configuration docs now say which lists each reference provider ignores.
- 03795da: A Docker command that exits before reading its stdin no longer crashes the process with an uncaught `EPIPE`. The Docker client and the devkit test process helper now ignore `EPIPE` on the child's stdin, where the exit status already reports the failure, and still surface any other stdin error. Batched workspace reads send their scripts over stdin, which made this reachable.
- fcf6d83: Read a thread's workspace over HTTP. `sandbox.workspaceRead: "http"` serves `POST /threads/:thread_id/workspace/inspect`, a bounded read-only inventory of a thread's managed workspace, authorized by the app's thread-access policy as the new `thread.workspace` operation; `b4 check`, `b4 build` and boot refuse it without a policy. `sandbox.workspaceReadTimeoutMs` bounds one read (default 120 s). `readThreadWorkspace` in `@b4run/cli/workspace` is the client. `inspectWorkspace` gains `root` and throws `WorkspaceInspectionError` with a code (`invalid_options`, `root_missing`, `refused`, `changed`); B4.run's bounded reads throw `WorkspaceReadLimitError` with their existing messages, and the Docker and Kubernetes batched walk's entry-limit refusal is a `WorkspaceInspectionError`. `ThreadOperation` gains a member, so an exhaustive `switch` over it needs a case. On Node, a request body a handler stops reading part-way is now discarded rather than resetting the connection, so a refusal such as a 413 reaches the client.
- Updated dependencies [f2ee6cf]
- Updated dependencies [3b489a5]
- Updated dependencies [0dd8fff]
- Updated dependencies [1da86ae]
- Updated dependencies [79c5f63]
- Updated dependencies [fcf6d83]
  - @b4run/workspace@0.12.1
  - @b4run/sdk@0.12.1

## 0.12.0

### Patch Changes

- @b4run/sdk@0.12.0
- @b4run/workspace@0.12.0

## 0.11.2

### Patch Changes

- @b4run/sdk@0.11.2
- @b4run/workspace@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [c282336]
  - @b4run/sdk@0.11.1
  - @b4run/workspace@0.11.1

## 0.11.0

### Patch Changes

- @b4run/sdk@0.11.0
- @b4run/workspace@0.11.0

## 0.10.0

### Patch Changes

- 185ae3c: The Docker sandbox now starts its session container with `--init`, so orphaned descendants of a command are reaped instead of lingering as zombies that hold PID slots and make process-tree termination look like it failed.
- Updated dependencies [71bccb3]
  - @b4run/workspace@0.10.0
  - @b4run/sdk@0.10.0

## 0.9.0

### Minor Changes

- 516c038: Read a managed workspace from a trusted host process. `ManagedWorkspaceProvider` gains an optional `openWorkspaceReader` addressed by the published `ReadyWorkspace` (implemented for Docker as a read-only bind of the managed volume in a separate networkless container that never touches a session), `@b4run/sqlite-storage` gains `openWorkspaceInstallationReader` (a lock-free read-only view of an installation another process owns), and `@b4run/cli/workspace` gains `openManagedWorkspaceReader` / `withManagedWorkspaceReader`, which resolve a thread to its published workspace through that store. `scopedWorkspaceReader` is exported from `@b4run/workspace` as the shared always-close lifetime.

### Patch Changes

- 7410154: Add a read-only way for a trusted host process to read one thread's sandbox workspace.

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

- Updated dependencies [7c9627f]
- Updated dependencies [516c038]
- Updated dependencies [6a59e00]
- Updated dependencies [7410154]
  - @b4run/sdk@0.9.0
  - @b4run/workspace@0.9.0

## 0.8.36

### Patch Changes

- @b4run/sdk@0.8.36
- @b4run/workspace@0.8.36

## 0.8.35

### Patch Changes

- 89a5958: Add bounded text workspace inspection for author filesystem handles and sandbox handles, with strict UTF-8, executable and symlink checks, exact expected dependency links, and cancellation support.

  Bound built-in filesystem reads before collecting content so a growing file cannot bypass an explicit byte limit.

- Updated dependencies [89a5958]
- Updated dependencies [814f4f9]
- Updated dependencies [c9a4d87]
- Updated dependencies [80aa142]
  - @b4run/workspace@0.8.35
  - @b4run/sdk@0.8.35

## 0.8.34

### Patch Changes

- @b4run/sdk@0.8.34
- @b4run/workspace@0.8.34

## 0.8.33

### Patch Changes

- @b4run/sdk@0.8.33
- @b4run/workspace@0.8.33

## 0.8.32

### Patch Changes

- 0003db2: Add provider-owned managed workspaces with immutable source capture, durable installation ownership and associations, resumable creation/deletion, and incarnation-scoped compute sessions. Node builds retain verified source artifacts; tools receive permission-bound initial bytes and workspace provenance. Docker implements managed preparation and recovery. Add file metadata and binary reads, disposable workspace execution, and isolated test-harness cleanup. Migrate the code-fixer example to ordinary author tools with independently verified, approval-bound candidate export.
- 0003db2: Breaking change: Docker and Kubernetes sandbox providers now require a stable
  application/environment `scope`. All resource names hash scope and thread ID,
  preventing collisions caused by the previous thread-name normalization. Research
  scaffolds now supply scope explicitly.

  Existing resources use different names and are not automatically reattached,
  migrated, or deleted. Export required data before upgrading and manage old
  resources explicitly. Scope is not authorization or cross-process coordination.

- Updated dependencies [0003db2]
- Updated dependencies [9e3c42e]
- Updated dependencies [0003db2]
- Updated dependencies [0003db2]
  - @b4run/workspace@0.8.32
  - @b4run/sdk@0.8.32

## 0.8.31

### Patch Changes

- @b4run/sdk@0.8.31
- @b4run/workspace@0.8.31

## 0.8.30

### Patch Changes

- Updated dependencies [80a98ad]
  - @b4run/sdk@0.8.30
  - @b4run/workspace@0.8.30

## 0.8.29

### Patch Changes

- Updated dependencies [481489e]
  - @b4run/sdk@0.8.29
  - @b4run/workspace@0.8.29

## 0.8.28

### Patch Changes

- Updated dependencies [39ceb2e]
  - @b4run/sdk@0.8.28
  - @b4run/workspace@0.8.28

## 0.8.27

### Patch Changes

- Updated dependencies [b05b96d]
  - @b4run/sdk@0.8.27
  - @b4run/workspace@0.8.27

## 0.8.26

### Patch Changes

- @dawn-ai/sdk@0.8.26
- @dawn-ai/workspace@0.8.26

## 0.8.25

### Patch Changes

- @dawn-ai/sdk@0.8.25
- @dawn-ai/workspace@0.8.25

## 0.8.24

### Patch Changes

- @dawn-ai/sdk@0.8.24
- @dawn-ai/workspace@0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- 47bf96b: Validate the complete Kubernetes runtime permission contract during preflight,
  replace existing owned NetworkPolicies with their live resource version, and
  export the structured `KubePermission` type and
  `KubeAuthorizationReviewError`. Custom `KubeClient` implementations must
  replace positional `canI(namespace, verb, resource)` with
  `canI(namespace, permission)`; no compatibility overload is provided, and the
  exported error preserves API-versus-transport preflight diagnostics.

  Serialize filesystem changes observed during the initial `dawn dev` child boot
  so startup and restart children cannot race for the same listening port, and
  drain fixing edits queued while a watched restart is failing.

- Updated dependencies [7e62bb1]
  - @dawn-ai/sdk@0.8.23
  - @dawn-ai/workspace@0.8.23

## 0.8.22

### Patch Changes

- bedad77: Documentation only: every public export of this package now has an API reference
  page on dawnai.org, and the package README leads with a concise entrypoint. No
  runtime behavior changed.
- 5cc8d4d: Recover Docker-backed filesystem operations when PID exhaustion prevents the keeper container from forking, while preserving the thread workspace volume.
- Updated dependencies [bedad77]
- Updated dependencies [a530e70]
- Updated dependencies [3c68800]
- Updated dependencies [f317dd7]
- Updated dependencies [3c68800]
- Updated dependencies [d42774e]
- Updated dependencies [984c3ad]
- Updated dependencies [496b54c]
- Updated dependencies [67030fa]
- Updated dependencies [730b136]
  - @dawn-ai/workspace@0.8.22
  - @dawn-ai/sdk@0.8.22

## 0.8.21

### Patch Changes

- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
  - @dawn-ai/sdk@0.8.21
  - @dawn-ai/workspace@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/sdk@0.8.20
- @dawn-ai/workspace@0.8.20

## 0.8.19

### Patch Changes

- b8d0da7: Docker sandboxes now prove an OCI exec never started before recovering, drain admitted container operations before a per-thread keeper recycle, preserve the named workspace volume, and retry once. Fair shared/exclusive lifecycle coordination prevents replacement from killing peer commands, while persisted keeper identities prevent cleanup failures or provider restarts from adopting stale container policy.
  - @dawn-ai/sdk@0.8.19
  - @dawn-ai/workspace@0.8.19

## 0.8.18

### Patch Changes

- Updated dependencies [c6b08a9]
  - @dawn-ai/sdk@0.8.18
  - @dawn-ai/workspace@0.8.18

## 0.8.17

### Patch Changes

- Updated dependencies [713797f]
  - @dawn-ai/sdk@0.8.17
  - @dawn-ai/workspace@0.8.17

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).
- Updated dependencies [2da55fa]
  - @dawn-ai/sdk@0.8.16
  - @dawn-ai/workspace@0.8.16

## 0.8.15

### Patch Changes

- @dawn-ai/sdk@0.8.15
- @dawn-ai/workspace@0.8.15

## 0.8.14

### Patch Changes

- @dawn-ai/sdk@0.8.14
- @dawn-ai/workspace@0.8.14

## 0.8.13

### Patch Changes

- 18df470: Add a central `DAWN_Exxxx` error-code registry in `@dawn-ai/sdk` and surface
  codes on the failure channels. `CliError` now carries an optional `code` and the
  CLI prints `[CODE] See <docs>`; HTTP/SSE error bodies gain optional `code`/`docsUrl`;
  permission denials returned as tool results are prefixed with `[DAWN_E3001]`.
  The high-value families are wired (`dawn check` config errors, sandbox
  unavailable, permission denied, missing model provider / unknown model id, and
  tool-file shape errors), and a generated `/docs/errors` reference page is guarded
  against drift. Additive and backward-compatible.
- Updated dependencies [5bbd6e3]
- Updated dependencies [628d1c3]
- Updated dependencies [18df470]
  - @dawn-ai/sdk@0.8.13
  - @dawn-ai/workspace@0.8.13

## 0.8.12

### Patch Changes

- @dawn-ai/workspace@0.8.12

## 0.8.11

### Patch Changes

- @dawn-ai/workspace@0.8.11

## 0.8.10

### Patch Changes

- @dawn-ai/workspace@0.8.10

## 0.8.9

### Patch Changes

- 628f0c1: Add a `kubernetesSandbox` provider: run each thread's sandbox as a Kubernetes Pod
  with a per-thread PersistentVolumeClaim for the durable workspace, implementing the
  same `SandboxProvider` contract as `dockerSandbox`. Tier-1 hardening maps onto Pod
  SecurityContext (non-root via `fsGroup`, read-only rootfs, dropped capabilities,
  no-new-privileges, RuntimeDefault seccomp); sandbox pods mount no ServiceAccount
  token. Per-thread NetworkPolicy provides best-effort egress control (requires a
  policy-capable CNI; `dawn check` warns when unconfirmed). New `resources.diskGb`
  sets the PVC size.
- Updated dependencies [628f0c1]
  - @dawn-ai/workspace@0.8.9

## 0.8.8

### Patch Changes

- 57e8cd9: Harden the Docker sandbox by default: drop all Linux capabilities, no-new-privileges,
  a PID limit (512), a read-only root filesystem (workspace + /tmp stay writable), and
  run-as-non-root (uid/gid 1000:1000 via a create-time root chown-init) — expressed as a
  provider-agnostic `SandboxPolicy.security` intent. `resources.timeoutMs` is now enforced
  per command (in-container `timeout`, exit 124). All hardening is on by default with
  per-flag opt-outs (`readOnlyRootFilesystem`, `runAsNonRoot`, etc.). Behavior changes only
  for apps already using `sandbox`; runtime system-directory writes / global installs now
  fail under the defaults — bake system deps into your image or opt out.
- Updated dependencies [57e8cd9]
  - @dawn-ai/workspace@0.8.8

## 0.8.7

### Patch Changes

- @dawn-ai/workspace@0.8.7

## 0.8.6

### Patch Changes

- 4ede7b8: Add an opt-in execution sandbox: a provider-agnostic `SandboxProvider` contract
  with a Docker reference (`dockerSandbox`), giving each conversation thread a
  hard-isolated workspace (filesystem + shell + network). Enable via
  `dawn.config.ts` `sandbox: { provider: dockerSandbox({ image }) }`; without it,
  behavior is unchanged. Adds a typed `config()` helper. When sandboxed, the
  materialized agent cache is bypassed so tools bind per-thread. Honest scope:
  Docker's boundary (not a microVM); `allow`-mode network denylist is best-effort
  in the Docker reference. New package `@dawn-ai/sandbox` (+ `@dawn-ai/sandbox/testing`
  `fakeSandbox` and a provider conformance kit).
- Updated dependencies [4ede7b8]
  - @dawn-ai/workspace@0.8.6
