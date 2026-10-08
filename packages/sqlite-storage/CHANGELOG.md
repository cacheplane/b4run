# @dawn-ai/sqlite-storage

## 0.13.2

### Patch Changes

- 1180d4c: **Breaking:** every tool call now returns a `ToolMessage` whose `additional_kwargs.b4_step` is complete (`status`, `startedAt`, `settledAt`, the gate `decision`, and the display's icon, label and sources), display or not; the `task` tool returns a `ToolMessage` (not a string) carrying `b4_step` and `b4_subagent` with the child's checkpoint namespace; a thrown tool's error message is built by the converter with a `failed` step, and a branded denial persists as a `denied` step (with `decision: "deny"`) on a `success` ToolMessage — not a failure, so a denied `returnDirect` call still ends the run with the denial as its result. Raw `GET /threads/:id/state` readers see the new keys. Permission gates report `once | always | deny` into the tool context (`onGateDecision`). The runtime stamps `b4:turn` (`done | failed | stopped`, `error`, `endedAt`) on the head checkpoint's metadata when a run ends (never on a parked head, only on a head the turn wrote), and both checkpointers gain `listNamespaces(threadId)`.

  `@b4run/ag-ui/view` gains `turnsFromState(input)`: rebuild a thread's `TurnsView` from its checkpoint history and parked interrupts by synthesising the AG-UI events the live stream would have carried and folding them through the unchanged `reduceTurns`; output carries `warnings` for ignored stamps. `GET /threads/:id/turns` serves it in the next release. Threads written before these stamps do not restore.

- 2c33a3f: `GET /agui/:routeId` now reports a `multimodal` section for an `agent()` route: `input.image`, `input.pdf`, `input.audio` and `input.video` come from the route model's LangChain profile with the provider's converter limits — the same judgment that keeps or drops each part at run time — and `image`/`pdf` describe the inline `data` source (URL support varies by provider and is reported by the dropped-parts warning). `input.file` and `output` are always `false`. The section is omitted for a raw runnable, a chain/graph/workflow route, or a provider package that is missing or cannot be read; the rest of the document is unaffected. `@b4run/langchain` exports `readModelProfile`, which reads a model's profile off its provider class without constructing it.

  Client-provided tool results may carry content parts. A `role: "tool"` answer's parts are stored as sent and replayed to the model under the tool-result rules; the UI gets every part on `TOOL_CALL_RESULT`. A call closed by the abandon path replays the stored result as its text and logs a warning. The 64 KiB result cap is measured on text/JSON with inline media bytes excluded.

  - `ClientToolCallRecord.result` and `ClientToolCallStore.answer`'s `result` widen from `string` to `B4MessageContent` (`@b4run/sdk`); `ClientToolResumeValue.clientToolResult` widens the same way (`@b4run/core`). A custom store must keep and return parts.
  - `@b4run/sdk` exports `encodeClientToolResult`/`decodeClientToolResult`: a part list is kept in the existing text column as a self-describing JSON envelope. Text results, including rows written before this release, are stored and read back unchanged; no migration. A rollback to an earlier release reads a stored part-list result as its JSON envelope text; resume or abandon such calls before downgrading. The SQLite and Postgres stores use the codec and gained a direct `@b4run/sdk` dependency.
  - The dropped-parts warning again ends by pointing at `GET /agui/<route>` for what the route accepts.

- 61e5922: Approval grant records are now pruned. Every `InterruptGrantStore` gains `prune({ before })`, which deletes records whose `voidedAt` is before `before` and nothing else. `voidOutstanding` now also voids consumed grants whose prompt the thread moved past (every unvoided row of the thread not in the keep list), so a consumed grant is voided once its resumed turn completes and ages out from there; a consumed grant whose resume never completed, and an outstanding grant however old, are never deleted: in both cases the prompt is still parked, and a parked prompt with no grant row resumes without a grant under `approvals.grants: "optional"`. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement both; a custom store must match.

  `approvals.grantStore` is now shape-checked at boot while grants are on: a store missing any method, `prune` included, fails the boot naming the missing methods. A custom store written before this release must add `prune`.

  The runtime sweeps the store wherever it voids superseded grants, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `approvals.grantRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot). `b4 approvals prune [--retention <ms>]` runs the same pass by hand.

- b61e133: Client tool call records are now pruned. Every `ClientToolCallStore` gains `prune({ before })`, which deletes answered or voided records settled before `before` and outstanding records whose `expiresAt` is before `before`, and keeps every outstanding record that is unexpired or has no expiry. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement it; a store set in `server.agui.clientToolStore` must implement it too, or the boot fails naming the missing method.

  The runtime sweeps the store when an AG-UI turn settles, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `server.agui.clientToolRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot), never shorter than `clientToolTtlMs`. `b4 client-tools prune [--retention <ms>]` runs the same pass by hand.

- fd0c456: A consumed approval grant records who answered it. `InterruptGrantRecord` gains `consumedBy`, the `id` of the principal `src/auth.ts` resolved for the resuming request, or `null` for an anonymous answer. It's for audit only: grants stay caller-unbound, and no check reads it. `consume()` takes an optional `by`. The SQLite and Postgres grant stores add the `consumed_by` column in a new version-2 migration, and rows written before it read as `null`. A custom `InterruptGrantStore` must store and return the new field.
- 91726d5: The tool-call record behind client-provided tools now covers every tool call on an AG-UI run where the store is resolved (a route listed in `server.agui.clientTools`, `server.agui.clientToolStore` set, or the default `.b4/client-tool-calls.sqlite` still present from an earlier opt-in), on every route. A server tool call is recorded as identity only — thread, route, run, tool name, issued and settled times; no result text — and is never answerable. A `role: "tool"` message is consumed only when it names an open client call this server issued; one naming a server call, a closed call, or nothing is history. `RUN_FINISHED`'s `pendingToolCallIds` is now read from the record, scoped to the calls this run left parked.

  - `ClientToolCallRecord` gains `kind` (`"client" | "server"`) and `settledAt`; `ClientToolCallStore` gains `settle`; `ClientToolRecorder` gains `issue` and `settle`. An operator-supplied `clientToolStore` must implement `settle` or the boot fails naming it. The SQLite and Postgres stores append migration 2 (`kind`, `settled_at`); existing rows read as `client`.
  - The client-tool-call prune now also deletes server rows settled before the window (`server.agui.clientToolRetentionMs`); open rows of either kind are never deleted.
  - `B4ToolDefinition` gains an optional `clientTool: true` marker, set only by the client-tool stub. `@b4run/ag-ui`'s `pendingToolCallIds` option may return a Promise; a rejection ends the run as `RUN_ERROR`.

  Behavior changes on an app with a store:

  - Every server tool call on every AG-UI route is written to the store before it runs and settled after; a write failure fails that tool call. With the store unavailable, server tool calls on AG-UI runs fail until it is back. Apps with no store are unchanged.
  - Rolling upgrades on a shared Postgres store: a replica on the previous version has no `kind` filter and reads new server rows as open client rows (it may void them). Nothing becomes answerable, but finish the rollout before mixing traffic.

- bbd4a0c: Tool-call record rows now say where they were issued from. `routeId` is the route that issued the call — for a subagent's tool calls, the child route's key rather than the parent's — and a new required `parentToolCallId` (`null` at the root) names the `task` call that launched the subagent. The SQLite and Postgres stores append migration 3 (`parent_tool_call_id`, nullable); rows that predate it read `null`. `ClientToolRecorder.issue` takes an optional `origin` (`ToolCallOrigin`) the writer supplies; the runtime resolves a missing origin to the run's route with no parent.

  Breaking for custom stores and recorder fakes: `ClientToolCallRecord.parentToolCallId` is required, and a store must persist it. Breaking for custom `SubagentResolver`s in `@b4run/langchain`: `ResolvedSubagentGraph.routeKey` (`<routeId>#<mode>`) is required, and a subagent stack entry without `routeKey` is ignored. Client rows are unchanged: they are only ever issued by the root route.

- Updated dependencies [e6cfa3d]
- Updated dependencies [29acd56]
- Updated dependencies [1180d4c]
- Updated dependencies [52b19ec]
- Updated dependencies [2c33a3f]
- Updated dependencies [ed43d4f]
- Updated dependencies [5caad96]
- Updated dependencies [61e5922]
- Updated dependencies [b25fc3b]
- Updated dependencies [b61e133]
- Updated dependencies [fd0c456]
- Updated dependencies [00b85cf]
- Updated dependencies [03fb4e6]
- Updated dependencies [bcfc8b8]
- Updated dependencies [936b7bf]
- Updated dependencies [936b7bf]
- Updated dependencies [91726d5]
- Updated dependencies [bbd4a0c]
- Updated dependencies [9547137]
- Updated dependencies [18bc4fd]
- Updated dependencies [bbc7871]
- Updated dependencies [d45b2dc]
  - @b4run/sdk@0.13.2
  - @b4run/workspace@0.13.2

## 0.13.1

### Patch Changes

- 17f16ea: Add **approval grants**: a single-use capability bound to one parked tool call, minted when B4.run parks a human-in-the-loop approval and required when that approval is answered.

  Until now a parked approval was addressed by `interruptId` and `resumeKey`, and neither is a credential — `interruptId` is a timestamp plus ~31 bits of `Math.random`, disclosed in the persisted envelope, and `resumeKey` is LangGraph's deterministic position hash. `ThreadAccessPolicy` gates _who_ may touch a thread, but disclosure control is not consumption control: inside a session that legitimately holds the thread, nothing stopped the same approval being answered twice (applying a financial allocation twice) or an approval minted against an earlier proposal being applied to the current one. Replay protection was emergent from LangGraph advancing the checkpoint, not enforced or tested.

  A grant is 32 CSPRNG bytes, stored only as a SHA-256 hash in a B4-owned table added by an additive versioned migration under the existing `runMigrations` advisory lock. It is minted at the park site in `@b4run/core`, reaches the client on the channels that already carry the prompt (the AG-UI interrupt, `GET /threads/:id/pending_interrupts`, the attach `state` frame), and comes back as an opaque `grant` on the resume entry. Consumption is a conditional `UPDATE … WHERE consumed_at IS NULL` — atomic, durable, replica-safe. A reused grant gives `409 grant_consumed` echoing the recorded decision rather than re-executing; a wrong grant gives `403 grant_invalid`, indistinguishable from "no such row" so the endpoint is not an oracle; a grant whose parked call the thread has moved past is voided and gives `409 stale_interrupt`. `deny` and `cancelled` consume the grant too — a denial is a decision, and a re-answerable denial is a replay surface of its own.

  Off by default. `approvals.grants` in `b4.config.ts` takes `"off"` (unchanged behavior), `"optional"` (an interrupt that **has** a grant requires it; one parked without a grant resumes as before — the softness is per-interrupt-age, never per-request, or `"optional"` would be a bypass), or `"required"`. The minter is injected through LangGraph's `config.configurable`, the same channel this repo already uses for live per-call identity, so nothing in core's call graph grows a storage handle. That injection is optional by construction, and the absence **fails closed**: under `"required"`, a park with no minter aborts the turn loudly rather than parking a prompt that cannot be answered safely.

  Two limits, stated rather than implied. At-most-once _delivery_ is not exactly-once _effect_ — an application's own idempotency key does not become redundant. And the plaintext grant is at rest in the checkpointer's `writes`, because the park site carries it in the interrupt envelope; the hash-only grant store protects the consumption ledger, not the checkpoint.

- 3b1be6e: Client-provided tools over AG-UI (cacheplane/b4run#743). On a route named in `server.agui.clientTools`, the model can now call the tools an AG-UI client defines (CopilotKit's `useFrontendTool`, for example). Before, the opt-in only made the `tools` field accepted.

  Each client tool becomes a tool the model sees as `client_<name>`. When the model calls one, the server records the call and parks the turn. The client sees the tool-call frames under its own name and an ordinary `RUN_FINISHED`, runs the tool, and sends `{ role: "tool", toolCallId, content }` on its next run. The server matches that result against its record of calls it issued, on this thread and route, still outstanding and unexpired, and resumes the turn. Resent history is ignored, and each result is used once. A new user message, or a call older than `server.agui.clientToolTtlMs` (default 10 minutes), abandons the unanswered call: it is closed with "The client did not return a result for this tool call." and the new message runs.

  - Definitions are bounded (32 tools, 1,024-character descriptions, 8,192-character and 8-level `parameters`, 32,768 characters in total across names, descriptions and serialized `parameters`) and refused with a `422` otherwise. Each result is capped at 64 KiB of UTF-8 (`413 client_tool_result_too_large` when a run answers with a larger one; a larger one resent in history is dropped and the call is abandoned). The bounds cap context budget; they do not prevent prompt injection.
  - A new reserved `clientTool` permission key gates client tool calls: exact match, allowed by default, `deny` refuses, never inherits a `tool:<name>` entry, and never offers `always`.
  - New `ClientToolCallStore` with an in-memory store (`@b4run/sdk`), a SQLite store (`@b4run/sqlite-storage`, the node default at `.b4/client-tool-calls.sqlite`) and a Postgres store (`createPostgresClientToolCallStore` in `@b4run/postgres-storage`). Set `server.agui.clientToolStore` on edge or serverless targets and on multi-instance deployments; with no store, client tool runs are refused with `503 client_tool_store_unavailable`.

  Behavior changes:

  - Tool names starting with `client_` are now reserved. A route with an authored or capability tool named `client_*` fails preparation, and `b4 check` reports an authored one.
  - `POST /agui/:routeId` request bodies are capped at 8 MiB (`413 payload_too_large`) on every route. Long histories with many inline images can reach it.
  - On AG-UI, a request whose last message is a `role: "tool"` message now counts as `resuming: true` for thread-access policies, on every route.
  - `POST /threads/:thread_id/resume`, `POST /threads/:thread_id/runs/stream` and `POST /threads/:thread_id/runs/wait` refuse with `409 client_tool_pending` while a client tool call is parked on the thread; the call is answered or abandoned through the AG-UI endpoint. A new Agent Protocol run there would drop the park and leave the model's tool call with no result.
  - On AG-UI, a request whose last message is a `role: "tool"` message now takes the thread's resume claim on every route, so a concurrent request on the same thread may get `409 resume_in_progress`.
  - On an opted-in route, a trailing `role: "tool"` message that answers nothing is now a no-op (an empty `RUN_STARTED` / `RUN_FINISHED`) instead of re-running the newest user message.
  - AG-UI turns now void superseded approval grants when they settle, as the Agent Protocol run handlers already did.

- Updated dependencies [b0605d7]
  - @b4run/workspace@0.13.1

## 0.13.0

### Patch Changes

- 3b489a5: A `sandbox.thread` resolver may return `permissions`: that thread's permission gates then use its own allow-list in place of the app's, keep the app's mode and every denial (the app's and the thread's), and save an "Always" decision to the thread's record in the workspace installation, never to `.b4/permissions.json` or a configured `permissions.store`. A subagent runs under its parent thread's permissions. `createThreadPermissionsStore` builds such a store over any `PermissionsStore` and passes the store conformance suite. Empty and whitespace-only permission patterns are refused in a thread's lists. An "Always" whose pattern the thread's record cannot hold (longer than `MAX_THREAD_GRANT_LENGTH`, empty or containing NUL) allows that call once with a warning instead of failing the run.
- 0dd8fff: `sandbox.thread` decides each thread's whole sandbox (workspace, image and policy) once, at the thread's first admission. The image goes through the new optional `ManagedWorkspaceProvider.resolveImageEnvironment`, and its identity is recorded in the thread's creation intent; the image reference and the policy overrides are recorded beside the association in the same transaction, and every reconnect runs the thread's recorded policy over the app's. `dockerSandbox({ images })` bounds which images a thread may name and refuses anything else before any Docker call; `image` is optional when `images` is given. A thread may not open a network the app denies, and `security` stays per app. `b4 check`, `b4 build` and startup refuse unknown `sandbox` keys and `thread` beside `workspace`; a thread-sandbox app builds to a `{ version: 2, kind: "thread" }` artifact. The installation now stores a workspace's source only after its environment resolves, so a refused image leaves no source behind.

  **Behaviour change:** `b4 check`, `b4 build` and startup now refuse any key in the `sandbox` block other than `workspace`, `thread`, `provider`, `network`, `env`, `resources`, `security` and `idleTimeoutMs`. A misspelt key used to be ignored silently, which left every thread in a per-app sandbox; rename or remove any other key.

- 79c5f63: Hand a thread its workspace at creation. `sandbox.stagedWorkspaces` serves `PUT /workspace/sources/:digest` (a content-addressed `SourceBundle` upload, verified against its digest, one at a time per process with `429 upload_in_flight` to a second, within `uploadTimeoutMs`, default 120 s, `408` past it, and within `maxStagedBytes`, default 1 GiB, `507` past it) and accepts `workspace: { sourceDigest, environmentLinks?, baseline? }` on `POST /threads`, which may name only an uploaded source (never one an admission stored for another thread) and is checked against the upload's recorded file paths without re-reading its bytes; the app's resolver (`sandbox.thread`, or a function `sandbox.workspace`) receives it as `thread.staged` at the thread's first admission, and sources nothing references are reclaimed after `retentionMs` (default 24 hours), at boot and before each upload. The option needs a resolver and a thread-access policy; `b4 check`, `b4 build` and boot refuse it otherwise.

  Behaviour changes:

  - **`ThreadAccessRequest.requestedWorkspace` is a new required field** (`ThreadAccessRequestedWorkspace | undefined`, exported from `@b4run/sdk`): `{ sourceDigest }` on the new `workspace.source.put` operation (a `create` with no thread) and the whole reference plus `uploadedBy` on a `thread.create` that names a workspace, `undefined` everywhere else. A stamp a policy returns on `workspace.source.put` is kept as the upload's uploader and handed back in `uploadedBy`, so a policy can require a caller to choose only what it uploaded. Code that builds a `ThreadAccessRequest` by hand needs `requestedWorkspace: undefined`; `@b4run/testing`'s `createThreadAccessHarness` accepts it on a check. `ThreadOperation` gains `"workspace.source.put"`, so an exhaustive `switch` over it needs a case. Enabling `stagedWorkspaces` means auditing the policy's `create` handler.
  - **`POST /threads` refuses a `workspace` field it will not serve** (`400 workspace_not_accepted`, after the policy's decision) instead of ignoring it, in every app. In an app with `stagedWorkspaces` it also refuses a body over 1 MiB (`413 payload_too_large`, after a policy that refuses the caller has answered), and runs at most four creates naming a workspace at once (`429 workspace_create_in_flight`); every other app reads its create body as before.
  - **`DELETE /threads/:thread_id`** forgets the thread's staged workspace before its row, and boot forgets the staged workspace of any thread whose row is gone.

- Updated dependencies [f2ee6cf]
- Updated dependencies [3b489a5]
- Updated dependencies [0dd8fff]
- Updated dependencies [1da86ae]
- Updated dependencies [79c5f63]
- Updated dependencies [fcf6d83]
  - @b4run/workspace@0.13.0

## 0.12.0

### Patch Changes

- @b4run/workspace@0.12.0

## 0.11.2

### Patch Changes

- @b4run/workspace@0.11.2

## 0.11.1

### Patch Changes

- @b4run/workspace@0.11.1

## 0.11.0

### Patch Changes

- a30db23: LangChain dependencies move to their current releases: `@langchain/core` 1.2.12, `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/openai` 1.5.13, `@langchain/anthropic` 1.5.11, `@langchain/google-genai` 2.3.2, `@langchain/xai` 1.4.13 and `@langchain/openrouter` 0.4.13, with the peer ranges raised to match. The lockfile is deduplicated so that every workspace package resolves the same single copy of `@langchain/langgraph` and `@langchain/core`.
  - @b4run/workspace@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [71bccb3]
  - @b4run/workspace@0.10.0

## 0.9.0

### Minor Changes

- 516c038: Read a managed workspace from a trusted host process. `ManagedWorkspaceProvider` gains an optional `openWorkspaceReader` addressed by the published `ReadyWorkspace` (implemented for Docker as a read-only bind of the managed volume in a separate networkless container that never touches a session), `@b4run/sqlite-storage` gains `openWorkspaceInstallationReader` (a lock-free read-only view of an installation another process owns), and `@b4run/cli/workspace` gains `openManagedWorkspaceReader` / `withManagedWorkspaceReader`, which resolve a thread to its published workspace through that store. `scopedWorkspaceReader` is exported from `@b4run/workspace` as the shared always-close lifetime.

### Patch Changes

- Updated dependencies [516c038]
- Updated dependencies [7410154]
  - @b4run/workspace@0.9.0

## 0.8.36

### Patch Changes

- @b4run/workspace@0.8.36

## 0.8.35

### Patch Changes

- Updated dependencies [89a5958]
  - @b4run/workspace@0.8.35

## 0.8.34

### Patch Changes

- @b4run/workspace@0.8.34

## 0.8.33

### Patch Changes

- @b4run/workspace@0.8.33

## 0.8.32

### Patch Changes

- 0003db2: Add provider-owned managed workspaces with immutable source capture, durable installation ownership and associations, resumable creation/deletion, and incarnation-scoped compute sessions. Node builds retain verified source artifacts; tools receive permission-bound initial bytes and workspace provenance. Docker implements managed preparation and recovery. Add file metadata and binary reads, disposable workspace execution, and isolated test-harness cleanup. Migrate the code-fixer example to ordinary author tools with independently verified, approval-bound candidate export.
- 0003db2: Add internal durable workspace installation ownership with recoverable initialization, exclusive local runtime admission, and guarded source-bundle persistence. Runtime integration follows separately.
- 0003db2: Add Node utilities for capturing and verifying immutable workspace source bundles,
  preserving exact bytes and checking declared file inventories and size limits.
  Add an internal transactional SQLite source-bundle component with strict integrity
  verification. Managed workspace lifecycle and runtime integration remain pending.
- Updated dependencies [0003db2]
- Updated dependencies [0003db2]
  - @b4run/workspace@0.8.32

## 0.8.31

## 0.8.30

## 0.8.29

## 0.8.28

## 0.8.27

## 0.8.26

## 0.8.25

## 0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.

## 0.8.22

### Patch Changes

- bedad77: Documentation only: every public export of this package now has an API reference
  page on dawnai.org, and the package README leads with a concise entrypoint. No
  runtime behavior changed.

## 0.8.21

## 0.8.20

## 0.8.19

## 0.8.18

## 0.8.17

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

## 0.8.8

## 0.8.7

## 0.8.6

## 0.8.5

## 0.8.4

## 0.8.3

## 0.8.2

## 0.8.1

### Patch Changes

- 407303f: Friendlier import errors. When a route, tool, or config module fails to load with the opaque ESM error "does not provide an export named X", Dawn now identifies the offending package and explains the likely cause and fix — an older hoisted `@langchain/core` (with the installed-vs-required versions and an `npm ls` pointer) or a CommonJS dependency imported with named bindings under Dawn's ESM resolver. `CliError` now preserves the original error via `cause`. Also aligns `@dawn-ai/sqlite-storage`'s `@langchain/core` peer floor to `^1.1.47` to match the rest of the suite.

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.2.0

### Minor Changes

- cfc3e8c: Add Agent Protocol HTTP endpoints backed by a Dawn-native SQLite checkpointer (phase-3 sub-project 7).

  - New `@dawn-ai/sqlite-storage` package: `sqliteCheckpointer` (a `BaseCheckpointSaver` over Node's built-in `node:sqlite`, no native deps) and `createThreadsStore`. Requires Node 22.13+ (where `node:sqlite` is available without the `--experimental-sqlite` flag).
  - `dawn.config.ts` gains `checkpointer` and `threadsStore` fields — both pluggable, with SQLite-backed defaults at `.dawn/checkpoints.sqlite` and `.dawn/threads.sqlite`.
  - The dev server's HTTP layer is reshaped to the Agent Protocol: `POST /threads`, `GET`/`DELETE /threads/{id}`, `POST /threads/{id}/runs/stream`, `POST /threads/{id}/runs/wait`, `GET /threads/{id}/state`, `POST /threads/{id}/resume`. The legacy `POST /runs/stream` is removed.
  - Conversation state and permission interrupts now survive a server restart. `MemorySaver` is removed from `@dawn-ai/langchain`; the checkpointer is supplied by the caller. Permission resume is state-based (reads the parked interrupt from the checkpoint) and resolves the route durably from thread metadata.
