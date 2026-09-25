# @dawn-ai/workspace

## 0.12.1

### Patch Changes

- f2ee6cf: `inspectWorkspace` no longer makes one backend call per entry when the backend can batch. Filesystem backends gain two optional methods. `walkTree` returns every entry below a directory with `lstat` metadata in one call, and `readBinaryFiles` reads many files with `readBinaryFile`'s per-file `maxBytes` bound. When a backend has both, inspection walks once, reads in a few calls, and applies exactly the same name, kind, size, and budget checks as before. A file that grew between the walk and the read is refused.

  The Docker backend and the Docker workspace reader implement both methods. Inspecting a container workspace now costs a few `docker exec` calls instead of one per `listDir`, `lstat`, and read. Over 1,214 entries that took inspection from 143 s to about 1 s. The walk is bounded inside the container, names travel as exact bytes, and a walk over the entry limit fails rather than being truncated. `withFilesystemLogging` passes both methods through. Other backends are unchanged and keep the per-entry path.

- 3b489a5: A `sandbox.thread` resolver may return `permissions`: that thread's permission gates then use its own allow-list in place of the app's, keep the app's mode and every denial (the app's and the thread's), and save an "Always" decision to the thread's record in the workspace installation, never to `.b4/permissions.json` or a configured `permissions.store`. A subagent runs under its parent thread's permissions. `createThreadPermissionsStore` builds such a store over any `PermissionsStore` and passes the store conformance suite. Empty and whitespace-only permission patterns are refused in a thread's lists. An "Always" whose pattern the thread's record cannot hold (longer than `MAX_THREAD_GRANT_LENGTH`, empty or containing NUL) allows that call once with a warning instead of failing the run.
- 0dd8fff: `sandbox.thread` decides each thread's whole sandbox (workspace, image and policy) once, at the thread's first admission. The image goes through the new optional `ManagedWorkspaceProvider.resolveImageEnvironment`, and its identity is recorded in the thread's creation intent; the image reference and the policy overrides are recorded beside the association in the same transaction, and every reconnect runs the thread's recorded policy over the app's. `dockerSandbox({ images })` bounds which images a thread may name and refuses anything else before any Docker call; `image` is optional when `images` is given. A thread may not open a network the app denies, and `security` stays per app. `b4 check`, `b4 build` and startup refuse unknown `sandbox` keys and `thread` beside `workspace`; a thread-sandbox app builds to a `{ version: 2, kind: "thread" }` artifact. The installation now stores a workspace's source only after its environment resolves, so a refused image leaves no source behind.

  **Behaviour change:** `b4 check`, `b4 build` and startup now refuse any key in the `sandbox` block other than `workspace`, `thread`, `provider`, `network`, `env`, `resources`, `security` and `idleTimeoutMs`. A misspelt key used to be ignored silently, which left every thread in a per-app sandbox; rename or remove any other key.

- 1da86ae: A sandbox with no `network` setting now defaults to `{ mode: "allow" }`. The previous default was `{ mode: "allow", denylist: ["169.254.169.254"] }`, but neither the Docker nor the Kubernetes provider enforces an allow-mode `denylist`. The entry claimed a block on the cloud metadata endpoint that never took effect, and runtime behavior is unchanged: allow-mode egress was open before and is open now. On a cloud VM, set `network: { mode: "deny" }` when the sandbox does not need the network. Otherwise block the endpoint outside B4.run, with a host firewall or egress proxy for Docker, or with the `b4-sandbox-infra` chart's default-deny egress backstop or your own NetworkPolicy for Kubernetes. The `SandboxPolicy.network` JSDoc and the sandbox and configuration docs now say which lists each reference provider ignores.
- 79c5f63: Hand a thread its workspace at creation. `sandbox.stagedWorkspaces` serves `PUT /workspace/sources/:digest` (a content-addressed `SourceBundle` upload, verified against its digest, one at a time per process with `429 upload_in_flight` to a second, within `uploadTimeoutMs`, default 120 s, `408` past it, and within `maxStagedBytes`, default 1 GiB, `507` past it) and accepts `workspace: { sourceDigest, environmentLinks?, baseline? }` on `POST /threads`, which may name only an uploaded source (never one an admission stored for another thread) and is checked against the upload's recorded file paths without re-reading its bytes; the app's resolver (`sandbox.thread`, or a function `sandbox.workspace`) receives it as `thread.staged` at the thread's first admission, and sources nothing references are reclaimed after `retentionMs` (default 24 hours), at boot and before each upload. The option needs a resolver and a thread-access policy; `b4 check`, `b4 build` and boot refuse it otherwise.

  Behaviour changes:

  - **`ThreadAccessRequest.requestedWorkspace` is a new required field** (`ThreadAccessRequestedWorkspace | undefined`, exported from `@b4run/sdk`): `{ sourceDigest }` on the new `workspace.source.put` operation (a `create` with no thread) and the whole reference plus `uploadedBy` on a `thread.create` that names a workspace, `undefined` everywhere else. A stamp a policy returns on `workspace.source.put` is kept as the upload's uploader and handed back in `uploadedBy`, so a policy can require a caller to choose only what it uploaded. Code that builds a `ThreadAccessRequest` by hand needs `requestedWorkspace: undefined`; `@b4run/testing`'s `createThreadAccessHarness` accepts it on a check. `ThreadOperation` gains `"workspace.source.put"`, so an exhaustive `switch` over it needs a case. Enabling `stagedWorkspaces` means auditing the policy's `create` handler.
  - **`POST /threads` refuses a `workspace` field it will not serve** (`400 workspace_not_accepted`, after the policy's decision) instead of ignoring it, in every app. In an app with `stagedWorkspaces` it also refuses a body over 1 MiB (`413 payload_too_large`, after a policy that refuses the caller has answered), and runs at most four creates naming a workspace at once (`429 workspace_create_in_flight`); every other app reads its create body as before.
  - **`DELETE /threads/:thread_id`** forgets the thread's staged workspace before its row, and boot forgets the staged workspace of any thread whose row is gone.

- fcf6d83: Read a thread's workspace over HTTP. `sandbox.workspaceRead: "http"` serves `POST /threads/:thread_id/workspace/inspect`, a bounded read-only inventory of a thread's managed workspace, authorized by the app's thread-access policy as the new `thread.workspace` operation; `b4 check`, `b4 build` and boot refuse it without a policy. `sandbox.workspaceReadTimeoutMs` bounds one read (default 120 s). `readThreadWorkspace` in `@b4run/cli/workspace` is the client. `inspectWorkspace` gains `root` and throws `WorkspaceInspectionError` with a code (`invalid_options`, `root_missing`, `refused`, `changed`); B4.run's bounded reads throw `WorkspaceReadLimitError` with their existing messages, and the Docker and Kubernetes batched walk's entry-limit refusal is a `WorkspaceInspectionError`. `ThreadOperation` gains a member, so an exhaustive `switch` over it needs a case. On Node, a request body a handler stops reading part-way is now discarded rather than resetting the connection, so a refusal such as a 413 reaches the client.
- Updated dependencies [79c5f63]
- Updated dependencies [fcf6d83]
  - @b4run/sdk@0.12.1

## 0.12.0

### Patch Changes

- @b4run/sdk@0.12.0

## 0.11.2

### Patch Changes

- @b4run/sdk@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [c282336]
  - @b4run/sdk@0.11.1

## 0.11.0

### Patch Changes

- @b4run/sdk@0.11.0

## 0.10.0

### Minor Changes

- 71bccb3: `sandbox.workspace` may now be a `WorkspaceResolver`: host code called once per thread, at first admission, with the thread id and its stored client metadata, returning that thread's initial workspace definition. The result is captured and recorded by digest exactly as a static definition is; `b4 build` records a resolver marker in place of captured source and startup refuses an artifact whose form disagrees with the config; `b4 check` reports the per-thread form.

### Patch Changes

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
- Updated dependencies [6a59e00]
  - @b4run/sdk@0.9.0

## 0.8.36

### Patch Changes

- @b4run/sdk@0.8.36

## 0.8.35

### Patch Changes

- 89a5958: Add bounded text workspace inspection for author filesystem handles and sandbox handles, with strict UTF-8, executable and symlink checks, exact expected dependency links, and cancellation support.

  Bound built-in filesystem reads before collecting content so a growing file cannot bypass an explicit byte limit.

- Updated dependencies [814f4f9]
- Updated dependencies [c9a4d87]
- Updated dependencies [80aa142]
  - @b4run/sdk@0.8.35

## 0.8.34

### Patch Changes

- @b4run/sdk@0.8.34

## 0.8.33

### Patch Changes

- @b4run/sdk@0.8.33

## 0.8.32

### Patch Changes

- 0003db2: Add provider-owned managed workspaces with immutable source capture, durable installation ownership and associations, resumable creation/deletion, and incarnation-scoped compute sessions. Node builds retain verified source artifacts; tools receive permission-bound initial bytes and workspace provenance. Docker implements managed preparation and recovery. Add file metadata and binary reads, disposable workspace execution, and isolated test-harness cleanup. Migrate the code-fixer example to ordinary author tools with independently verified, approval-bound candidate export.
- 0003db2: Add Node utilities for capturing and verifying immutable workspace source bundles,
  preserving exact bytes and checking declared file inventories and size limits.
  Add an internal transactional SQLite source-bundle component with strict integrity
  verification. Managed workspace lifecycle and runtime integration remain pending.
- Updated dependencies [0003db2]
- Updated dependencies [9e3c42e]
- Updated dependencies [0003db2]
  - @b4run/sdk@0.8.32

## 0.8.31

### Patch Changes

- @b4run/sdk@0.8.31

## 0.8.30

### Patch Changes

- Updated dependencies [80a98ad]
  - @b4run/sdk@0.8.30

## 0.8.29

### Patch Changes

- Updated dependencies [481489e]
  - @b4run/sdk@0.8.29

## 0.8.28

### Patch Changes

- Updated dependencies [39ceb2e]
  - @b4run/sdk@0.8.28

## 0.8.27

### Patch Changes

- Updated dependencies [b05b96d]
  - @b4run/sdk@0.8.27

## 0.8.26

### Patch Changes

- @dawn-ai/sdk@0.8.26

## 0.8.25

### Patch Changes

- @dawn-ai/sdk@0.8.25

## 0.8.24

### Patch Changes

- @dawn-ai/sdk@0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- Updated dependencies [7e62bb1]
  - @dawn-ai/sdk@0.8.23

## 0.8.22

### Patch Changes

- bedad77: Documentation only: every public export of this package now has an API reference
  page on dawnai.org, and the package README leads with a concise entrypoint. No
  runtime behavior changed.
- Updated dependencies [a530e70]
- Updated dependencies [3c68800]
- Updated dependencies [f317dd7]
- Updated dependencies [3c68800]
- Updated dependencies [d42774e]
- Updated dependencies [984c3ad]
- Updated dependencies [496b54c]
- Updated dependencies [67030fa]
- Updated dependencies [730b136]
  - @dawn-ai/sdk@0.8.22

## 0.8.21

### Patch Changes

- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
  - @dawn-ai/sdk@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/sdk@0.8.20

## 0.8.19

### Patch Changes

- @dawn-ai/sdk@0.8.19

## 0.8.18

### Patch Changes

- Updated dependencies [c6b08a9]
  - @dawn-ai/sdk@0.8.18

## 0.8.17

### Patch Changes

- 713797f: Purge `node:` imports from the edge module graph (deploy-anywhere B3, PR 2a).

  A bundle built from `@dawn-ai/cli/fetch` now links **zero** `node:` specifiers —
  previously it linked 33 of them (including `node:fs` and `node:child_process`)
  via Dawn's own supporting packages. Because static imports resolve when a module
  graph is instantiated, those edges made the bundle require a `node:` shim layer
  (Cloudflare Workers with `nodejs_compat`) even though the injected request path
  never called them. The artifact is now runtime-agnostic, verified by an esbuild
  purity test that bundles on the `neutral` and `browser` platforms with no `node:`
  externals and asserts an empty graph, plus a negative control proving the check
  still fails against the CLI entry.

  **Node-only exports moved to `/node` subpaths.** They are unchanged in behavior;
  only the import specifier differs:

  - `@dawn-ai/core` → `@dawn-ai/core/node`: `discoverRoutes`, `findDawnApp`,
    `assertDawnRoutesDir`, `extractToolSchemasForRoute`, `extractToolTypesForRoute`,
    `registerTsxLoader`
  - `@dawn-ai/permissions` → `@dawn-ai/permissions/node`: `createPermissionsStore`
  - `@dawn-ai/workspace` → `@dawn-ai/workspace/node`: `localFilesystem`, `localExec`

  **New:** `@dawn-ai/sdk/pure` (pure path/hash helpers, parity-tested against
  `node:path`/`node:crypto`); `@dawn-ai/core` gains `registerConfigLoader` and the
  `DawnConfigLoader` type; `@dawn-ai/core/node` gains `registerNodeConfigLoader`,
  `loadDawnConfigUncached`, and `nodeLoadRouteDescription`. `CapabilityMarkerContext`
  gains optional `backendFactories` and `loadRouteDescription` — capability markers
  no longer reach for node implementations by static import, and throw a named error
  when a runtime supplies neither an instance nor a factory.

  **Behavior change:** `createWorkspaceFs` now requires an absolute, POSIX-normalized
  `workspaceRoot` and throws a named error otherwise. Previously a relative root
  silently resolved against `process.cwd()`. Every in-repo caller already passes an
  absolute path; the host lane canonicalizes before calling core. This is
  fail-closed — it cannot widen the workspace path jail, only reject earlier and
  more loudly.

- Updated dependencies [713797f]
  - @dawn-ai/sdk@0.8.17

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

## 0.8.15

## 0.8.14

## 0.8.13

## 0.8.12

## 0.8.11

## 0.8.10

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

## 0.8.7

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

## 0.8.5

## 0.8.4

## 0.8.3

## 0.8.2

## 0.8.1

### Patch Changes

- 89b2a73: Harden the workspace path jail against symlink escapes. `FilesystemBackend` gains a required `realPath(path, ctx)` method; `localFilesystem` implements it (resolving symlinks via the deepest existing ancestor so not-yet-created write targets work), and `createWorkspaceFs` canonicalizes both the candidate path and the workspace root before the permission gate. A symlink inside `workspace/` that points outside is now correctly gated instead of being silently classified as inside.

  **Action for custom `FilesystemBackend` implementations:** add a `realPath` method — return the path unchanged (`async (p) => p`) if your backend has no symlink semantics. (Shipped as a patch since `localFilesystem`, the only built-in backend, already implements it; custom backends are not expected at this 0.x stage.)

  **Behavior note:** allow rules for paths outside the workspace are now matched against the canonical (symlink-resolved) path. If your workspace or an allowed target lives under a symlink, express allow-rule paths in canonical form; rules written against a non-canonical alias will fail closed. (No effect when your paths contain no symlinks.)

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.3.0

### Minor Changes

- 917a99f: Add a binary read path to the workspace filesystem backend. `FilesystemBackend` gains an optional `readBinaryFile(path, ctx, opts?): Promise<Uint8Array>`, implemented by `localFilesystem` (same size-cap semantics as `readFile`), so binary I/O (e.g. reading an image) stays inside the sandboxed backend instead of dropping to `node:fs`. `withFilesystemLogging` now forwards `readBinaryFile` (logging the path only, never the bytes) and also preserves the optional `statFile`/`removeFile`/`touchFile`/`mkdir` methods it previously dropped when wrapping a backend.

### Patch Changes

- fa8bdd4: `localFilesystem` `writeFile` now creates missing parent directories before
  writing. Previously, an agent writing to a nested workspace path (e.g.
  `reports/result.md`) failed with `ENOENT` unless the directory already existed.

## 0.2.0

### Minor Changes

- 027b1cc: Add tool-output offloading. When a tool returns output larger than `toolOutput.offloadThresholdChars` (default 40,000), the full payload is written to `workspace/tool-outputs/` and the in-context ToolMessage is replaced with a preview+pointer stub; the agent retrieves the full content with the existing `readFile` tool (which bypasses the size cap for `tool-outputs/` paths). Active automatically when a workspace exists. The directory is bounded by a size + TTL cap (defaults 256MB / 3h) with throttled evict-on-write and LRU-by-access eviction (readFile bumps mtime for tool-outputs/ files). Large content never enters message state, so there is no tool-call/result pairing hazard. Configurable via `dawn.config.ts` `toolOutput`. The `FilesystemBackend` interface gains optional `statFile`/`removeFile`/`touchFile`/`mkdir` methods and an optional per-call `maxBytes` override on `readFile`.
