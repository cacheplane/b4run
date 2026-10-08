# @dawn-ai/sdk

## 0.14.0

### Patch Changes

- e6cfa3d: Restore a CopilotKit chat from B4's storage. `GET /threads/:thread_id/events` replays a thread as the AG-UI events its live runs carried (`eventsFromState` in `@b4run/ag-ui/view`), behind the same gate as `/turns` (new `thread.events` operation). `@b4run/ag-ui/copilotkit-runtime` adds `createB4AgentRunner(InMemoryAgentRunner, { url, fetch })`, which builds a CopilotKit runtime runner whose `connect` replays it, so a reload, a restart or another instance restores the chat, its activity and a parked approval.
- 29acd56: **Breaking:** `GET /threads/:thread_id/state` reports `created_at` as the checkpoint's time instead of the request time. New `GET /threads/:thread_id/turns` rebuilds a thread's activity turns (`@b4run/ag-ui/view`'s `TurnsView`) from its checkpoints, parked interrupts embedded, gated like `/pending_interrupts`; a denied call restores as a `denied` step, not a failed one. `ThreadOperation` gains `thread.turns`. Threads from releases before the `b4_step`/`b4:turn` stamps do not restore.
- 1180d4c: **Breaking:** every tool call now returns a `ToolMessage` whose `additional_kwargs.b4_step` is complete (`status`, `startedAt`, `settledAt`, the gate `decision`, and the display's icon, label and sources), display or not; the `task` tool returns a `ToolMessage` (not a string) carrying `b4_step` and `b4_subagent` with the child's checkpoint namespace; a thrown tool's error message is built by the converter with a `failed` step, and a branded denial persists as a `denied` step (with `decision: "deny"`) on a `success` ToolMessage — not a failure, so a denied `returnDirect` call still ends the run with the denial as its result. Raw `GET /threads/:id/state` readers see the new keys. Permission gates report `once | always | deny` into the tool context (`onGateDecision`). The runtime stamps `b4:turn` (`done | failed | stopped`, `error`, `endedAt`) on the head checkpoint's metadata when a run ends (never on a parked head, only on a head the turn wrote), and both checkpointers gain `listNamespaces(threadId)`.

  `@b4run/ag-ui/view` gains `turnsFromState(input)`: rebuild a thread's `TurnsView` from its checkpoint history and parked interrupts by synthesising the AG-UI events the live stream would have carried and folding them through the unchanged `reduceTurns`; output carries `warnings` for ignored stamps. `GET /threads/:id/turns` serves it in the next release. Threads written before these stamps do not restore.

- 52b19ec: A new `b4.config.ts` option, `agentsMd: { writable: false }`, presents `workspace/AGENTS.md` to agent routes as read-only project guidance instead of agent memory. The injected block is headed `# Project guidance`, says the file is maintained by the app's authors, and tells the model not to modify it, in place of the default `# Memory` header's `writeFile` instruction. The over-64 KiB notice uses the same header. The default (`writable: true`, or no `agentsMd`) is unchanged. The option changes only the prompt; enforce it with a `FilesystemMiddleware` over `backends.filesystem` that refuses writes to `AGENTS.md`, and deny or gate `runBash` for routes that can reach the workspace, since a shell command bypasses that middleware.

  `b4 check` and route preparation validate the option through one resolver and reject, with the new `B4_E1010` (Invalid agentsMd config), an `agentsMd` that isn't an object (`agentsMd: false` included), an unknown key in it such as `writeable`, and a non-boolean `writable`, so a misspelled or mistyped key inside `agentsMd` is an error rather than silently leaving the file writable. `CapabilityMarkerContext` gains `agentsMd?: { writable: boolean }`, which the agents-md marker reads.

- 2c33a3f: `GET /agui/:routeId` now reports a `multimodal` section for an `agent()` route: `input.image`, `input.pdf`, `input.audio` and `input.video` come from the route model's LangChain profile with the provider's converter limits — the same judgment that keeps or drops each part at run time — and `image`/`pdf` describe the inline `data` source (URL support varies by provider and is reported by the dropped-parts warning). `input.file` and `output` are always `false`. The section is omitted for a raw runnable, a chain/graph/workflow route, or a provider package that is missing or cannot be read; the rest of the document is unaffected. `@b4run/langchain` exports `readModelProfile`, which reads a model's profile off its provider class without constructing it.

  Client-provided tool results may carry content parts. A `role: "tool"` answer's parts are stored as sent and replayed to the model under the tool-result rules; the UI gets every part on `TOOL_CALL_RESULT`. A call closed by the abandon path replays the stored result as its text and logs a warning. The 64 KiB result cap is measured on text/JSON with inline media bytes excluded.

  - `ClientToolCallRecord.result` and `ClientToolCallStore.answer`'s `result` widen from `string` to `B4MessageContent` (`@b4run/sdk`); `ClientToolResumeValue.clientToolResult` widens the same way (`@b4run/core`). A custom store must keep and return parts.
  - `@b4run/sdk` exports `encodeClientToolResult`/`decodeClientToolResult`: a part list is kept in the existing text column as a self-describing JSON envelope. Text results, including rows written before this release, are stored and read back unchanged; no migration. A rollback to an earlier release reads a stored part-list result as its JSON envelope text; resume or abandon such calls before downgrading. The SQLite and Postgres stores use the codec and gained a direct `@b4run/sdk` dependency.
  - The dropped-parts warning again ends by pointing at `GET /agui/<route>` for what the route accepts.

- ed43d4f: Carry AG-UI 1.0 content parts to the model. A user message's `image`, `audio`, `video` and `document` parts — inline, by URL, or as a provider file handle — reach the route's model as LangChain content blocks; what the model cannot take (read from its LangChain profile) is dropped and announced, in the server log and on the stream as `CUSTOM` `b4.content_parts_dropped`, never refused: the `422` envelope rejection of media parts is gone. Tools may return `B4ContentPart[]` (new in `@b4run/sdk`), which travels as `TOOL_CALL_RESULT.content`. The Agent Protocol run endpoints now bound their bodies at the same 8 MiB as `/agui`. `B4Message.content` (`@b4run/ag-ui`), `UnwrappedToolResult.content` (`@b4run/langchain`) and `MiddlewareAfterMessage.content` (`@b4run/sdk`) widened from `string` to `string | readonly B4ContentPart[]`, and chain, graph and workflow routes now receive `messages[].content` as that part array whenever the client sent parts (previously flattened to text), so code that narrows on `string` must handle the array.
- 5caad96: **Breaking:** `agent()`'s `reasoning` is keyed by provider. `reasoning: { effort }` becomes `reasoning: { openai: { effort } }`; a flat `effort`, an unknown key, or a block for a provider the route does not resolve to now fails the route when its model is built (before, a misplaced setting was silently ignored — and the OpenAI effort itself never reached the request, because it was passed as the constructor field `reasoningEffort`, which `@langchain/openai` reads only per call). New controls make reasoning visible: `openai.summary: "auto" | "concise" | "detailed"` streams a reasoning summary (and moves the route to the Responses API); `anthropic.budgetTokens` enables extended thinking. The langchain adapter carries thinking and reasoning blocks as `reasoning` stream chunks; `@b4run/ag-ui` frames them as AG-UI 1.0 `REASONING_START` / `REASONING_MESSAGE_*` / `REASONING_END`, one span and one `role: "reasoning"` message per model invocation, every one closed before the run ends. `GET /agui/:routeId` advertises `reasoning: { supported: true, streaming: true, encrypted: false }` exactly when the route's config makes reasoning stream, `{ supported: false }` otherwise. `IdFactory` gains the `reasoning` and `reasoningSpan` kinds.

  `@b4run/testing`'s `finalMessage` now reads an assistant message whose `content` is a list of blocks (the OpenAI Responses API, Anthropic with tools bound), joining its `text` blocks; before, such a run reported an empty final message.

- 61e5922: Approval grant records are now pruned. Every `InterruptGrantStore` gains `prune({ before })`, which deletes records whose `voidedAt` is before `before` and nothing else. `voidOutstanding` now also voids consumed grants whose prompt the thread moved past (every unvoided row of the thread not in the keep list), so a consumed grant is voided once its resumed turn completes and ages out from there; a consumed grant whose resume never completed, and an outstanding grant however old, are never deleted: in both cases the prompt is still parked, and a parked prompt with no grant row resumes without a grant under `approvals.grants: "optional"`. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement both; a custom store must match.

  `approvals.grantStore` is now shape-checked at boot while grants are on: a store missing any method, `prune` included, fails the boot naming the missing methods. A custom store written before this release must add `prune`.

  The runtime sweeps the store wherever it voids superseded grants, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `approvals.grantRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot). `b4 approvals prune [--retention <ms>]` runs the same pass by hand.

- b25fc3b: A route can require approval on every call of a tool, with no standing approval possible: write the `tools.approve` entry as `{ tool: "fileFlightPlan", allowAlways: false }` instead of the bare name (bare names keep today's behavior, and the two forms mix in one list). For such a tool every call prompts in interactive mode even when the permission store holds an allow rule for it, the interrupt envelope carries `allowAlways: false`, and the AG-UI interrupt advertises `responseSchema.enum: ["once", "deny"]`, so the activity kit's approval card offers only Allow once and Deny. A client that answers `always` anyway gets `once`: the call runs, nothing is persisted, and the step records `once`. Bypass mode still allows and a deny rule still denies; non-interactive mode and contexts without interrupts fail closed, an allow rule notwithstanding, so a headless run of such a tool needs bypass. `@b4run/sdk` exports `ApproveEntry`, `NormalizedApproveEntry` and `normalizeApproveEntries`; `b4 check` validates the object form (unknown names, malformed entries, overlap with `constrain`), and the reserved `task` check covers it. The navlog example and scaffold approve `fileFlightPlan` this way, so on a shared permission store one visitor can no longer approve filing for everyone.
- b61e133: Client tool call records are now pruned. Every `ClientToolCallStore` gains `prune({ before })`, which deletes answered or voided records settled before `before` and outstanding records whose `expiresAt` is before `before`, and keeps every outstanding record that is unexpired or has no expiry. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement it; a store set in `server.agui.clientToolStore` must implement it too, or the boot fails naming the missing method.

  The runtime sweeps the store when an AG-UI turn settles, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `server.agui.clientToolRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot), never shorter than `clientToolTtlMs`. `b4 client-tools prune [--retention <ms>]` runs the same pass by hand.

- fd0c456: A consumed approval grant records who answered it. `InterruptGrantRecord` gains `consumedBy`, the `id` of the principal `src/auth.ts` resolved for the resuming request, or `null` for an anonymous answer. It's for audit only: grants stay caller-unbound, and no check reads it. `consume()` takes an optional `by`. The SQLite and Postgres grant stores add the `consumed_by` column in a new version-2 migration, and rows written before it read as `null`. A custom `InterruptGrantStore` must store and return the new field.
- 00b85cf: Long-term memory can now be scoped to the caller. `memory.resolveScope` runs per request and receives `principal`, the caller `src/auth.ts` resolved, so `resolveScope: ({ principal }) => (principal ? { user: principal.id } : {})` gives each caller its own memory.

  **Behavior change:** a dimension a route's `memory.ts` declares and `resolveScope` leaves without a value now makes memory unavailable for that request. `remember` and `recall` answer that memory is unavailable, the memory index is empty, and no episode is recorded. The request no longer falls back to the shared `workspace+route` namespace. An app that declared `user` or `tenant` without resolving it must resolve it, or drop the dimension.

  With a `src/auth.ts`, `GET /memory/candidates` lists only the caller's own namespaces (and shared ones), and approving or rejecting another caller's candidate answers `404`. `defineAuth` accepts `canReviewMemory(principal)` to let a reviewer see every namespace. Apps without an auth file are unchanged.

- 03fb4e6: `ownedThreads({ owner?, adminsRead? })` is the common thread-access policy as a value. Each caller reaches only the threads it created, stamped `{ ownerId }` from its principal, and `adminsRead` principals may also read the rest. It denies an anonymous caller, and denies a missing row ahead of any admin branch, so "not yours" and "never existed" stay the same answer. The `create-b4-app` templates now use it in place of a hand-written policy. `ownedThreadsOptions(policy)` reads its options back, for build targets that translate it.
- bcfc8b8: An app can now declare one place that resolves who is calling: `src/auth.ts` default-exports `defineAuth({ authenticate })`. B4.run calls `authenticate` once per request, before middleware and the thread-access policy, and passes the result to middleware and the thread-access policy as `req.principal` and to every tool as `ctx.principal`. A principal is any object with a string `id`. `undefined` makes the request anonymous, `reject(...)` answers it before any endpoint runs, and a throw or malformed result fails it with a 500.

  `b4 typegen` declares the type `authenticate` resolves to on `B4Register`, so `ctx.principal` is typed. The node and web build targets carry `src/auth.ts` in their build, and the `langsmith` target refuses an app that has one. An auth file that does not default-export `defineAuth` fails the boot with `B4_E3005`. The harness takes a `principal` option, and `createAgentProtocolInjector` takes `auth`.

  **Breaking:** `ThreadAccessRequest.headers` is removed. A thread-access policy that read identity from headers must move that read into `src/auth.ts` and use `req.principal`. The `basic` and `navlog` templates are migrated, and the `navlog` template no longer ships `src/middleware.ts`.

- 936b7bf: The package READMEs install with npm, list `create-b4-app`'s `--template basic|navlog` and `--dist-tag` options, install `@b4run/cli` as a runtime dependency, and show a tool that needs approval in the SDK example.
- 936b7bf: The package READMEs show the navlog demo's poster, linked to the full demo video, in place of the README animation.
- 91726d5: The tool-call record behind client-provided tools now covers every tool call on an AG-UI run where the store is resolved (a route listed in `server.agui.clientTools`, `server.agui.clientToolStore` set, or the default `.b4/client-tool-calls.sqlite` still present from an earlier opt-in), on every route. A server tool call is recorded as identity only — thread, route, run, tool name, issued and settled times; no result text — and is never answerable. A `role: "tool"` message is consumed only when it names an open client call this server issued; one naming a server call, a closed call, or nothing is history. `RUN_FINISHED`'s `pendingToolCallIds` is now read from the record, scoped to the calls this run left parked.

  - `ClientToolCallRecord` gains `kind` (`"client" | "server"`) and `settledAt`; `ClientToolCallStore` gains `settle`; `ClientToolRecorder` gains `issue` and `settle`. An operator-supplied `clientToolStore` must implement `settle` or the boot fails naming it. The SQLite and Postgres stores append migration 2 (`kind`, `settled_at`); existing rows read as `client`.
  - The client-tool-call prune now also deletes server rows settled before the window (`server.agui.clientToolRetentionMs`); open rows of either kind are never deleted.
  - `B4ToolDefinition` gains an optional `clientTool: true` marker, set only by the client-tool stub. `@b4run/ag-ui`'s `pendingToolCallIds` option may return a Promise; a rejection ends the run as `RUN_ERROR`.

  Behavior changes on an app with a store:

  - Every server tool call on every AG-UI route is written to the store before it runs and settled after; a write failure fails that tool call. With the store unavailable, server tool calls on AG-UI runs fail until it is back. Apps with no store are unchanged.
  - Rolling upgrades on a shared Postgres store: a replica on the previous version has no `kind` filter and reads new server rows as open client rows (it may void them). Nothing becomes answerable, but finish the rollout before mixing traffic.

- bbd4a0c: Tool-call record rows now say where they were issued from. `routeId` is the route that issued the call — for a subagent's tool calls, the child route's key rather than the parent's — and a new required `parentToolCallId` (`null` at the root) names the `task` call that launched the subagent. The SQLite and Postgres stores append migration 3 (`parent_tool_call_id`, nullable); rows that predate it read `null`. `ClientToolRecorder.issue` takes an optional `origin` (`ToolCallOrigin`) the writer supplies; the runtime resolves a missing origin to the run's route with no parent.

  Breaking for custom stores and recorder fakes: `ClientToolCallRecord.parentToolCallId` is required, and a store must persist it. Breaking for custom `SubagentResolver`s in `@b4run/langchain`: `ResolvedSubagentGraph.routeKey` (`<routeId>#<mode>`) is required, and a subagent stack entry without `routeKey` is ignored. Client rows are unchanged: they are only ever issued by the root route.

- 9547137: Server tool calls are recorded in the tool-call record only when a route is listed in `server.agui.clientTools` or `server.agui.clientToolStore` is set. A default `.b4/client-tool-calls.sqlite` left over after the opt-in was removed is still opened so calls parked back then can be closed, but it no longer records server calls, and boot logs one warning naming it. `ClientToolRecorder.issue` and `settle` are optional: absent on runs that do not record server calls.

  The `task` call that launches a subagent is now recorded as a server row like any other tool: issued before the subagent runs, open while it is parked, settled when it returns, fails or is refused. A `role: "tool"` message carrying a task id is dropped as a server row. The issue/settle discipline lives in one `@b4run/langchain` helper used by the tool converter and the subagent bridge.

- 18bc4fd: A tool call blocked by `tools.approve` or `tools.constrain` now returns its denial reason branded (`toolDenial(reason)` / `isToolDenial` / `TOOL_DENIAL` from `@b4run/sdk`) instead of a bare string. The model receives exactly the same text as before. The runtime can now tell a denial from a successful result, so a tool's `display.done` and `display.sources` are no longer asked to describe a denial as if it were output: the call's `b4.step` `completed` event carries the icon only, with no label or sources.
- bbc7871: Tools can export `display` (`ToolDisplay`): an icon and `running`/`done`/`sources` functions that say how a call reads to a person. The runtime evaluates it per call, streams it to AG-UI clients as `CUSTOM` `b4.step` events (`running` as the call starts, `completed` as it returns — both before the result; `failed` after an error result for every tool), and keeps it on the checkpointed tool message (`additional_kwargs.b4_step`). `b4 check` validates the export. The built-in workspace, memory, skill, plan and subagent tools ship labels. Built-in tools now carry labels, so the Agent Protocol stream gains `step`/`subagent.step` chunks.

## 0.13.1

### Patch Changes

- f9350c4: `agent({ retry })` now applies to each model call instead of the whole run. `maxAttempts` (default 3) becomes the chat model's `maxRetries` (`maxAttempts - 1`), so LangChain retries each model request, including later calls in a tool loop, up to that many times; `maxAttempts: 1` now fails fast. Before, LangChain's default of 6 retries applied whatever `retry` said, and B4.run restarted the whole run on top of it when nothing had streamed yet.

  B4.run also sends a model call again after a capacity rate limit that LangChain hands back without retrying (a `429` with no `Retry-After`), waiting `min(baseDelay * 2^n + jitter, 10s)`. A `429` whose `Retry-After` is over 60 seconds (LangChain waits out shorter ones itself) isn't retried: the error surfaces at once, keeping the wait in `retryAfterMs`. This is the only place `baseDelay` applies; it was previously never read on an agent route. A quota `429` isn't retried, an abort during the wait stops it, and a response that fails after part of it streamed isn't retried, so no token is sent twice. The run itself is never restarted, so tools never run twice, and a transient error outside the model call (for example a checkpointer connection reset before the first event) now fails the turn instead of being retried with the run.

  The route's summarization model gets the same `maxRetries` (`defaultSummarize` and a custom `summarize` receive it as `maxRetries`), and the `b4 memory consolidate` / `reflect` model takes its attempts from a new `memory.distill.retry: { maxAttempts }` in `b4.config.ts` (default 3 per call, instead of LangChain's 6). `memory.distill.retry` is validated by `b4 check` and by the `b4 memory consolidate` / `reflect` commands (not by `b4 dev` or the runtime, which never read `memory.distill`): a `baseDelay` (distillation has nothing for it to pace), an unknown key in `memory.distill` or its `retry` (including a near-miss case typo such as `Distill`, `distil`, or `Retry`), a non-object parent, `memory: null` or `memory.distill: null` (previously read as empty), a misplaced `retry`/`maxAttempts`, or a `maxAttempts` that isn't a whole number of at least 1 fails with the new error code `B4_E1009` (Invalid memory config) instead of falling back to the default. `modelMaxRetries(retry)` is exported for other code that builds a chat model from an agent's `retry`.

  An invalid `retry` (a `maxAttempts` below 1 or not a whole number, a negative `baseDelay`) now fails the route when it first runs, and so does an unknown key on the `retry` object (for example `maxAttemps`) or a non-object `retry` — the error names the bad key and the valid keys, `maxAttempts` and `baseDelay`. A route that exports its own LangChain runnable keeps its model's own `maxRetries`, and is no longer restarted on a failure either if it streams; one with only `invoke` (no `streamEvents`) is still re-run whole by the legacy fallback, up to 3 times on a message-matched transient error.

- a683816: Validate the AG-UI run envelope in the runtime, and close client-supplied `tools` and `forwardedProps` by default.

  `POST /agui/:routeId` used to accept whatever AG-UI's schema would parse and hand it on: `threadId: ""`, a whitespace-only `runId`, a megabyte-long id and `state: "nope"` all reached route code, so every app that cared re-checked B4.run's own wire format by hand — and had to re-check it again each time the protocol grew a field. Those four are now structurally validated before anything else runs, and a body that parses but is not one B4.run will act on is a `422` under the new `B4_E5401`, with a machine-readable `error.details.code` (`invalid_envelope`, `invalid_thread_id`, `invalid_run_id`, `invalid_state`).

  **Breaking for apps that pass client tools.** `tools` and `forwardedProps` are not an app's inputs — they are the caller's attempt to add to what the _route_ decided, and a client that sends `tools: [...]` on a route whose tool set the server chose is asking for authority it was not given. A non-empty `tools` or `forwardedProps` is now REJECTED (`422`, `client_tools_not_allowed` / `forwarded_props_not_allowed`) unless the route names itself in the new `server.agui` config, because silently ignoring a field is indistinguishable from honoring it and a client cannot tell which happened. An empty `tools: []` / `forwardedProps: {}` — what an AG-UI client sends when it has nothing to add — is unaffected, so an ordinary client sees no change. A route that genuinely wants them opts in:

  ```ts
  server: { agui: { clientTools: ["/chat"], clientForwardedProps: ["/chat"] } }
  ```

  This turns a silent narrowing into a loud one. `fromRunAgentInput` has never interpreted client `tools`, so a client that sent frontend tools — a CopilotKit frontend action, for instance — already got a run that ignored them; it now gets a `422` instead, which is the point.

  CopilotKit clients to check before upgrading: `useFrontendTool` (and any other hook that registers a tool definition) puts it in `tools` on every run, and CopilotKit's generated suggestions run with `tools: [copilotkitSuggest]` and `forwardedProps: { toolChoice }`. Static suggestion lists (`useConfigureSuggestions` with `{ title, message }` entries) and render-only hooks (`useRenderTool`) send neither, so B4.run's own examples and scaffolds are unaffected.

  The check runs before route middleware and before the thread-access policy: it needs no I/O, takes no resume claim and reads no thread row, so no app middleware is handed an envelope the runtime has already refused, and no policy is asked to authorize — or create a row for — a request that is about to be rejected. `resume` is deliberately not decided there, because whether a turn genuinely resumes depends on what is parked in the checkpointer, which is only readable once the policy has authorized this caller for that thread; `resolvePendingResume` still rejects a resume that matches no pending interrupt (`409`, `stale_interrupt`) at the point where the answer is known.

  Closes #735.

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

- c7282f4: `createMemoryInterruptGrantStore` now keys grants by thread and then by interrupt instead of a flat joined `threadId`/`interruptId` string, so two distinct pairs whose ids contain the separator can no longer read, consume, or void each other's grant. The SQLite and Postgres stores were not affected.

## 0.13.0

### Patch Changes

- 79c5f63: Hand a thread its workspace at creation. `sandbox.stagedWorkspaces` serves `PUT /workspace/sources/:digest` (a content-addressed `SourceBundle` upload, verified against its digest, one at a time per process with `429 upload_in_flight` to a second, within `uploadTimeoutMs`, default 120 s, `408` past it, and within `maxStagedBytes`, default 1 GiB, `507` past it) and accepts `workspace: { sourceDigest, environmentLinks?, baseline? }` on `POST /threads`, which may name only an uploaded source (never one an admission stored for another thread) and is checked against the upload's recorded file paths without re-reading its bytes; the app's resolver (`sandbox.thread`, or a function `sandbox.workspace`) receives it as `thread.staged` at the thread's first admission, and sources nothing references are reclaimed after `retentionMs` (default 24 hours), at boot and before each upload. The option needs a resolver and a thread-access policy; `b4 check`, `b4 build` and boot refuse it otherwise.

  Behaviour changes:

  - **`ThreadAccessRequest.requestedWorkspace` is a new required field** (`ThreadAccessRequestedWorkspace | undefined`, exported from `@b4run/sdk`): `{ sourceDigest }` on the new `workspace.source.put` operation (a `create` with no thread) and the whole reference plus `uploadedBy` on a `thread.create` that names a workspace, `undefined` everywhere else. A stamp a policy returns on `workspace.source.put` is kept as the upload's uploader and handed back in `uploadedBy`, so a policy can require a caller to choose only what it uploaded. Code that builds a `ThreadAccessRequest` by hand needs `requestedWorkspace: undefined`; `@b4run/testing`'s `createThreadAccessHarness` accepts it on a check. `ThreadOperation` gains `"workspace.source.put"`, so an exhaustive `switch` over it needs a case. Enabling `stagedWorkspaces` means auditing the policy's `create` handler.
  - **`POST /threads` refuses a `workspace` field it will not serve** (`400 workspace_not_accepted`, after the policy's decision) instead of ignoring it, in every app. In an app with `stagedWorkspaces` it also refuses a body over 1 MiB (`413 payload_too_large`, after a policy that refuses the caller has answered), and runs at most four creates naming a workspace at once (`429 workspace_create_in_flight`); every other app reads its create body as before.
  - **`DELETE /threads/:thread_id`** forgets the thread's staged workspace before its row, and boot forgets the staged workspace of any thread whose row is gone.

- fcf6d83: Read a thread's workspace over HTTP. `sandbox.workspaceRead: "http"` serves `POST /threads/:thread_id/workspace/inspect`, a bounded read-only inventory of a thread's managed workspace, authorized by the app's thread-access policy as the new `thread.workspace` operation; `b4 check`, `b4 build` and boot refuse it without a policy. `sandbox.workspaceReadTimeoutMs` bounds one read (default 120 s). `readThreadWorkspace` in `@b4run/cli/workspace` is the client. `inspectWorkspace` gains `root` and throws `WorkspaceInspectionError` with a code (`invalid_options`, `root_missing`, `refused`, `changed`); B4.run's bounded reads throw `WorkspaceReadLimitError` with their existing messages, and the Docker and Kubernetes batched walk's entry-limit refusal is a `WorkspaceInspectionError`. `ThreadOperation` gains a member, so an exhaustive `switch` over it needs a case. On Node, a request body a handler stops reading part-way is now discarded rather than resetting the connection, so a refusal such as a 413 reaches the client.

## 0.12.0

## 0.11.2

## 0.11.1

### Patch Changes

- c282336: `B4_E4001` and `B4_E4002` now link to the model providers section of the Agents docs (`/docs/agents#model-providers`) instead of the Configuration reference.

## 0.11.0

## 0.10.0

## 0.9.0

### Patch Changes

- 7c9627f: Apply a client-supplied `hashbrown.responseSchema` on the AG-UI run body to the route's root model, or reject the run. `POST /agui/:routeId` used to accept the field and read nothing from it, so a Hashbrown client that expected the final message to match its UI schema got an unconstrained model and found out only when a reply failed to parse. On an `agent` route the schema is now bound as the provider's native schema-constrained output alongside the route's tools — OpenAI `response_format` (`json_schema`, `strict: true`) and Anthropic `output_config.format` — so tool-calling turns are untouched and only the final message is constrained. A malformed schema, a non-agent route, or a provider with no such mode is refused with `422` and the new `B4_E5402` (`invalid_response_schema` / `response_schema_not_supported`) before any run side effect. Runs without the field are unchanged. `@b4run/langchain` gains `JsonSchemaResponseFormat`, `createChatModel({ responseFormat })`, `streamAgent({ responseFormat })` and the `JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS` list.
- 6a59e00: Add an `after` hook to the middleware lifecycle definition. `defineMiddleware({ handle, after })` runs `after` once per AG-UI run with the agent's final assistant message and the context `handle` allowed, before the client sees the message: return nothing to keep it, `{ finalMessage }` to replace it, or `reject(...)` to end the run with a `RUN_ERROR` (code `middleware_rejected`). With the hook defined the final assistant message is buffered and delivered whole before `RUN_FINISHED`; text before a tool call still streams live, and an app without the hook emits exactly the events it did before. `@b4run/ag-ui`'s `toAguiEvents` now forwards a string `code` from an upstream error onto `RUN_ERROR`.

## 0.8.36

## 0.8.35

### Patch Changes

- 814f4f9: `b4 check` no longer reports a clean `0 routes discovered` for an app whose `package.json` lacks `"type": "module"`. Route discovery now fails with `B4_E1006` naming the app root's `package.json`, and a route `index.ts` with no recognisable export fails with `B4_E1007` naming the file, the exports it found, and, when the module was loaded as CommonJS, the nested `package.json` that caused it — listing every unrecognised route entry in the app in one error rather than one per run. Closes #685.
- c9a4d87: Add optional `setup(ctx)` and `dispose()` lifecycle hooks to `defineMiddleware`. The object form `defineMiddleware({ setup, dispose, handle })` runs `setup` once, lazily, before the first gated request, shares one in-flight call across concurrent first requests, and retries it on the next request if it rejects, so a transient outage never poisons the process. `dispose` runs from the Node runtimes' shutdown path after in-flight requests drain. The function form is unchanged.
- 80aa142: Route discovery reports every route `index.ts` that exports more than one of `agent`, `workflow`, `graph`, or `chain` in a single run, as the new `B4_E1008`, naming each file and the kinds it exported. The message used to omit the file path and threw from inside the route walk, so an app with several of these surfaced them one per run.

## 0.8.34

## 0.8.33

## 0.8.32

### Patch Changes

- 0003db2: Add provider-owned managed workspaces with immutable source capture, durable installation ownership and associations, resumable creation/deletion, and incarnation-scoped compute sessions. Node builds retain verified source artifacts; tools receive permission-bound initial bytes and workspace provenance. Docker implements managed preparation and recovery. Add file metadata and binary reads, disposable workspace execution, and isolated test-harness cleanup. Migrate the code-fixer example to ordinary author tools with independently verified, approval-bound candidate export.
- 9e3c42e: Expose a detached parsed request body to execution middleware on AG-UI and
  Agent Protocol POST endpoints. Applications can validate client context and
  resume decisions through the existing middleware API without modifying runtime
  input or adding protocol-specific hooks.
- 0003db2: Expose the runtime's optional conversation thread identity as readonly `B4ToolContext.threadId` for authored tools. This documents and types existing agent tool context without changing permission behavior.

## 0.8.31

## 0.8.30

### Patch Changes

- 80a98ad: Add `GET /threads/{id}/runs/stream` — reattach to a running turn. A disconnected
  client rejoins by attaching to this read-only GET mirror of the POST stream: one
  `event: state` snapshot (channel values, the turn's coalesced frames so far, and
  parked interrupts) followed by the live tail, or an immediate durable snapshot +
  `done` when no live turn exists in this process. It requires thread-access `read` plus middleware approval for the selected
  producer and the recorded parked, last-run, and anchor routes. The selected
  turn stays fixed across asynchronous authorization. Backed by a bounded in-memory `LiveTurnHub`; the durable
  path works across restarts, replicas, and serverless. Being a GET with no body,
  it is the first Agent Protocol stream a stock `EventSource` can consume.

  `@b4run/sdk` gains one additive `ThreadOperation` member, `thread.attach`, for
  the new endpoint. A thread-access policy that switches exhaustively over
  `ThreadOperation` should add a `thread.attach` arm; a `fallback` handler already
  covers it.

  Canceling or aborting an attach releases its viewer slot and heartbeat without
  stopping the producer. Slow viewers remain bounded and are detached on overflow.
  The durable retry hint precedes `done`, so clients can stop reading at the terminal frame.

  Bind checkpoint ownership to the exact checkpoint ID at the saver write boundary,
  retaining verified ancestor routes and overwriting any upstream ownership claim.
  Attach authorizes that provenance instead of inferring checkpoint ownership from
  mutable thread metadata. Legacy or unknown checkpoint ancestry fails closed with
  `thread_route_unknown`; a fresh thread establishes verified provenance.

## 0.8.29

### Patch Changes

- 481489e: Publish the B4.run package family with the first-publication registry
  convergence fix in effect, so every package is published and verified in a
  single release rather than stalling on each newly created packument.

## 0.8.28

### Patch Changes

- 39ceb2e: Release controller fixes for the B4.run identity: read release history written
  under the previous identity, exclude releases made under it from candidate
  arbitration, allow the one-time package family rename across a candidate's first
  parent, and prove a never-published package absent during escrow.

## 0.8.27

### Patch Changes

- b05b96d: Rename the framework to B4.run and publish the package family under `@b4run`.
  Use `b4`, `b4.config.ts`, `.b4`, and `create-b4-app` for the CLI, configuration,
  local state, and scaffold. Branded public types and environment variables use
  the B4 prefix. Existing package names, config files, state locations and exported
  aliases are not supported by this release.

## 0.8.26

## 0.8.25

## 0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.

## 0.8.22

### Patch Changes

- a530e70: Documentation only: this package gains a canonical API reference on dawnai.org
  and a concise npm entrypoint. No runtime behavior changed. (`dawn docs` also
  now discovers every registered detailed API page.)
- 3c68800: Raise `DAWN_E1005` at request time for gated features a runtime cannot serve,
  instead of ignoring them silently. A runtime with no filesystem fallbacks — the
  shape an edge deployment has — now reports a configured `sandbox` block, a
  configured `toolOutput` block, and any route whose skills were recorded at build
  time, naming each feature and its config key. Previously the build gate was the
  only defense, so an entry composed by hand over `@dawn-ai/cli/fetch` never ran
  it and those settings did nothing at all.

  Node behavior is unchanged: the guard fires only when a runtime supplies no
  filesystem fallbacks, and every Node path supplies them, so an app that
  configures a sandbox, tool-output offloading or skills keeps working exactly as
  before.

  **Action may be required:** `dawn build` and `dawn check` now also reject
  `toolOutput` for the `hono` target, so a build that passed before can now fail.
  If your `dawn.config.ts` sets `toolOutput` and your `build.targets` includes
  `"hono"`, that build stops with `DAWN_E1005` naming the key; remove
  `toolOutput`, or drop `"hono"` from `build.targets` and deploy with the `node`
  target, which serves offloading normally. An empty `toolOutput: {}` configures
  nothing and is not rejected. Nothing is lost by removing it: offloading spills
  oversized tool results to a file under `workspace/`, and the edge has no
  filesystem, so it never ran there. It was the only gated feature whose config is
  plain JSON, which is why it slipped through — the other gated keys are live
  objects that get stripped at the build boundary, while these were inlined into
  the bundle intact and then ignored at runtime. Node deployments are unaffected.
  See the upgrade note at https://dawnai.org/docs/upgrading.

  `dawn check` now also detects a stale `.dawn/build/modules.edge.mjs` when `hono`
  is a configured target. An app building for `hono` alone emits no
  `modules.mjs`, so the staleness pass previously did nothing for it and a
  renamed or deleted route shipped in a stale bundle with no warning.

  `DAWN_E1005`'s registry title broadens from "Feature unsupported by the build
  target" to "Feature unsupported by the build target or runtime", since the code
  now has a request-time producer.

- f317dd7: Fail loudly when middleware is present but cannot be loaded, and load it
  correctly on Windows.

  The middleware probe wrapped every candidate import in a bare `catch {}`, so a
  `src/middleware.ts` that threw while being imported — a missing environment
  variable, an ESM/CJS interop break, a syntax error, an unresolved dependency —
  was indistinguishable from an app with no middleware at all. The server started,
  reported healthy, and served every gated Agent Protocol endpoint ungated, with
  no log line anywhere.

  **If your middleware file has been quietly broken, this release turns that into
  a startup failure.** Dawn now decides existence before importing, and a
  middleware file that exists but cannot be loaded exits with `DAWN_E3004`, naming
  the file and the underlying cause. In `dawn dev` the watcher restarts the child
  once you fix it; under `dawn start` or a built `server.mjs` the process exits
  non-zero, so a deploy fails its health check instead of shifting traffic onto an
  ungated server. Existence is probed with `lstat`, and only `ENOENT`/`ENOTDIR`
  count as absent, so an unreadable middleware file is no longer read as "this app
  has none". An app with no middleware file is unaffected.

  Two related fixes ride along. The probe no longer falls through to a later
  candidate when an earlier one fails, so a broken `src/middleware.ts` can no
  longer silently bind a `middleware.ts` at the app root instead. And the dynamic
  import now builds a `file://` URL rather than handing Node's ESM loader a raw
  path: on Windows that path is a drive letter, which the loader rejects as an
  unknown protocol, and the old `catch {}` swallowed it — middleware never ran on
  Windows. It does now, so a Windows app with a middleware file that was inert
  will start gating requests.

  A middleware file that exports no middleware function is still ignored rather
  than fatal, because the built manifest binds the same way, but it now warns on
  stderr and names the file.

- 3c68800: **`RouteConfig` is documented as reserved — Dawn reads none of its fields.**

  `runtime`, `streaming` and `tags` are accepted on a route's exported `config`,
  type-checked, normalized onto the route module and carried into the static build
  manifest, and then nothing branches on any of them. The API docs described
  effects none of them has: `runtime` did not pin a route to an execution
  environment (the node/edge split comes from `build.targets` and is never decided
  per route), `streaming` did not switch on token streaming (the endpoint the
  caller hits decides that), and `tags` were not displayed by the Dev Server UI or
  anywhere else.

  The fields are kept rather than removed — deleting a published field breaks
  every app that set one and buys nothing — but they now carry JSDoc saying they
  are reserved and have no effect, and the API reference says the same. If they
  gain behavior it will be additive.

- d42774e: **Breaking:** scenario files must default export `scenarios("<route>")` from
  `@dawn-ai/sdk/testing`. A plain default-exported array now throws
  `RunScenarioLoadError` at load; wrap the array in `scenarios("/route")` to
  migrate.

  Add route-scoped fluent `dawn test` scenarios with generated application-tool
  types, invocation-local in-process tool mocks, and declarative mock call
  assertions.

- 984c3ad: Thread endpoints can now be authorized with a `src/thread-access.ts` policy.

  `defineThreadAccess` answers a different question from route middleware — may
  this caller create, read, mutate or destroy this thread — and is keyed on the
  thread object rather than on route identity, because a thread has no owning
  route. Five endpoints that previously ran no middleware at all are gated by it:
  `POST /threads`, `GET /threads/:thread_id`, `GET /threads/:thread_id/state`,
  `POST /threads/:thread_id/cancel` and `DELETE /threads/:thread_id`. A read
  denial answers the same 404 a genuine miss answers, so a policy cannot be used
  to enumerate thread ids, and a `delete` is authorized even when the row is
  missing so a 403 cannot confirm that a thread exists.

  The policy loader is fail-closed, unlike the middleware probe: a
  `thread-access.ts` that exists but cannot be imported or binds no usable policy
  fails the boot with `DAWN_E3003` rather than degrading to "no gate". An app with
  no policy file behaves exactly as before, and every boot logs which layer the
  policy came from, or that there is none.

  `dawn build` now fails with `DAWN_E1005` for the `langsmith` target while a
  policy file exists, because that runtime cannot carry the hook. The `node`,
  `hono` and `vercel` targets are unaffected: `node`'s emitted server probes the
  policy at boot, and the bundled web targets carry it in their static manifest.

  One behavior change applies with or without a policy: `POST /threads` drops the
  reserved `dawn:access` key from client-supplied `metadata`. That key holds the
  server-issued access stamp, so a client can never write one — including in an
  app that adopts a policy later.

  `POST /threads/:thread_id/cancel` now binds its cancel to the run the caller
  observed, so a cancel can no longer land on a later run of the same thread; when
  the observed run has already finished it answers the existing
  `409 no_run_in_flight`.

  `@dawn-ai/testing` gains `createThreadAccessHarness` for unit-testing a policy
  without booting a server, and `createAgentProtocolInjector` accepts a
  `threadAccess` policy.

  The run endpoints — `/runs/stream`, `/runs/wait`, `/resume` and `/agui` — plus
  `GET /threads/:thread_id/pending_interrupts` are gated on this policy too.

- 496b54c: Add `resuming` to `ThreadAccessRequest`: a required boolean that is `true` when
  the request carries a resume credential and will continue a parked turn. A
  policy that ignores it behaves the same for resumed and ordinary turns.

  A policy that wants resumes treated differently from ordinary turns — step-up
  auth, a second approver, extra logging — should check `req.resuming` rather than
  `req.operation`. Two endpoints resume, and only one of them says so in its
  operation: `POST /threads/{thread_id}/resume` reports `run.resume`, but a
  `POST /agui/{routeId}` carrying a `resume` array reports `run.agui`, exactly as
  an ordinary AG-UI turn does. The request body is the only thing that separates
  them, and a policy never sees it, so keying the rule on `operation` leaves every
  AG-UI resume ungoverned.

  `resuming` is `false` everywhere else and never absent, so no policy needs
  `?? false`. An endpoint that gates more than once for one request — the gate
  before its side effects, the mid-flight recheck, the implicit create's recheck —
  reports the same value at every site.

  `createThreadAccessHarness().check()` accepts an optional `resuming`, defaulting
  to `false`.

- 67030fa: Thread access now authorizes the run endpoints and the pending-interrupts read.

  Two things to know about the shipped surface.

  **`ThreadOperation` includes `"thread.pending_interrupts"`**, under
  `action: "read"`. An exhaustive `switch` or mapped type over the union must
  handle every member.

  **Ten endpoints are gated on the thread-access axis**, including
  `POST /threads/:id/runs/stream`, `/runs/wait`, `/resume`,
  `POST /agui/:routeId` and `GET /threads/:id/pending_interrupts`. The hazard to
  watch is a policy whose `fallback` returns a bare `{ allow: false }`, or denies
  any operation it does not recognize: it denies these endpoints too, where route
  middleware alone used to decide. Read your `fallback` before
  upgrading. A `run.*` operation on a thread that exists arrives under
  `action: "update"`; on a thread id with no row yet, `run.stream`, `run.wait` and
  `run.agui` arrive under `action: "create"` — see the companion note on stamping
  the implicit create, which lands in the same release. A policy that permits
  `update` for the thread's owner therefore needs one more decision than it did
  before: what its `create` handler should answer for a thread id the client
  picked. `run.resume` never creates and is always an `update`.

  These gates compose with route middleware as AND rather than replacing it;
  middleware still answers "may this caller run this route" and keeps doing the
  per-caller work it does today. An app with no policy file is unaffected.

  `POST /threads/:id/resume` and `GET /threads/:id/pending_interrupts` gate
  **before** middleware rather than after it, so on those two a caller who would
  have received a middleware `401` now receives a thread-access deny — a `403` on
  `/resume`, a `404` on `/pending_interrupts`. That is forced: both resolve the
  route identity middleware would authorize against out of the thread's own
  metadata, so gating after middleware would mean reading a thread the caller is
  not yet authorized to read. On `/resume` it also stops a denied caller taking
  the thread's resume claim, which was a denial of service against a parked turn
  that needed no credential, and reading the `400`/`409` codes as an oracle on a
  guessed `interruptId`/`resumeKey`. A `/pending_interrupts` deny returns the
  handler's own `404 thread_not_found`, indistinguishable from a genuine miss.

  `dawn build --target hono` and `--target vercel` bundle the policy into the
  static module manifest and run it on those runtimes exactly as `dawn dev` does.
  A build that saw a policy file stamps that fact into its entry point, and boot
  fails when such an entry point is paired with a manifest carrying no
  thread-access entry — a stale manifest would otherwise come up with every thread
  endpoint open and nothing to say so. `--target langsmith` refuses with
  `DAWN_E1005`, permanently: it materializes per-route graphs with no Dawn HTTP
  layer to run a policy in.

  `create-dawn-app` templates now carry a deny-by-default `src/thread-access.ts`
  and the shared `src/auth.ts` it imports, both as `.example` files that a rename
  activates. They ship inert because a deny-by-default policy denies every request
  from a caller the app cannot yet authenticate.

  `@dawn-ai/testing`'s `runThreadsStoreConformance` gains two cases, both
  properties the access stamp depends on: a `createThread` on an id that already
  exists never applies the caller's metadata, and `updateMetadata` leaves a
  top-level key its patch does not name intact. Custom `ThreadsStore`
  implementations should re-run the kit.

- 730b136: Threads created implicitly by a run endpoint are now stamped with the caller who
  created them.

  `POST /threads/:id/runs/stream`, `/runs/wait` and `POST /agui/{routeId}` create
  the thread when the id they were given names no row. That create wrote no
  metadata, so the row carried no access stamp — and two things followed from
  that.

  **A policy's legacy branch means only "created before the policy existed"
  again.** `thread.access === undefined` is the branch an app writes when it
  adopts a policy on an existing store, usually admin-only or backfilled. Because
  an unstamped row could be manufactured on demand — by naming any thread id at a
  run endpoint — that branch had quietly widened to "predates the policy, **or**
  was created by anyone a moment ago", which turns a permissive legacy branch
  (the common shape mid-rollout) into an escalation path. The implicit create now
  carries the stamp your `create` handler returns, so the branch means what it
  says.

  **The caller who created a thread can take a second turn on it.** Previously the
  row it had just made read back with no owner, so a policy that authorizes
  against `thread.access` denied its own author from turn two onward. This is the
  flow `POST /agui/{routeId}` drives, since CopilotKit picks its `threadId` in the
  browser and never calls `POST /threads`.

  **`run.*` operations can now arrive under `action: "create"`.** When the row is
  absent, `run.stream`, `run.wait` and `run.agui` are asked under `create` — then
  again as the `update` recheck that follows every create, the same two-step
  `thread.create` already used. The `operation` is unchanged throughout; only the
  `action` differs. `run.resume` is untouched: it requires an already-parked
  thread and creates nothing.

  Read your `create` handler before upgrading. It now decides runs on thread ids
  the client picked, not just `POST /threads`, and the stamp it returns is what
  every later turn on those threads authorizes against. A policy that denied
  `create` outright — or that relied on `update` seeing `thread: undefined` for a
  first turn — changes behavior here. Ownership of a client-chosen id is first
  come, first served: whoever names an unused id is stamped as its owner and can
  hold it against the caller who meant to use it. Mint ids with `POST /threads`
  if that matters; those are server-generated and nobody can call them first.

  The `update` recheck is not optional and is not a stamp comparison. Two callers
  can both find the row absent, and a store that upserts on collision hands the
  loser the winner's row; Dawn re-authorizes the row that actually came back
  before the run proceeds. Comparing the minted stamp with the returned one would
  not catch it — a `permit()` with no stamp leaves both sides `undefined`.

  An app with no policy file is unaffected: the implicit create still passes the
  thread id and nothing else, with no extra gate call and no extra store read.

  The scaffolded `src/thread-access.ts` gains the AG-UI flow as a consequence: its
  `create` handler stamps an authenticated caller, so a browser-chosen `threadId`
  is served and stays served. Its commentary, and the thread-access docs, are
  updated to match.

## 0.8.21

### Patch Changes

- c2c19da: **New `hono` build target — a Dawn app that deploys to Cloudflare Workers.**

  `build: { targets: ["node", "hono"] }` makes `dawn build` emit an edge deploy
  alongside the usual ones: `.dawn/build/app.mjs` (a Hono app whose single
  catch-all hands every request to Dawn's web-standard fetch handler,
  `export default`ed — the shape Workers, Vercel and Bun all accept),
  `modules.edge.mjs` (the static module manifest, free of node builtins),
  `stores.mjs` (a per-request Postgres store factory), and a `wrangler.toml`
  scaffold at the app root. `wrangler deploy` is how you ship it; a gated CI lane
  boots those same artifacts under local workerd and shows them serving Agent
  Protocol and AG-UI with durable state in Postgres. No deploy to Cloudflare's
  platform has been exercised — see the caveats at the end of this note.

  The scaffold carries a bare `name` / `main` / `compatibility_date` and **no
  `nodejs_compat`**: the bundle links zero `node:` specifiers, so the flag would
  buy nothing, and setting it would mask a regression in the work that made the
  bundle node-free. A gated `edge-workerd` CI lane boots the emitted artifacts
  under real workerd — the same binary Cloudflare runs — with that `wrangler.toml`
  untouched, and drives four sequential AG-UI turns against Postgres over a
  `@neondatabase/serverless` WebSocket pool.

  The target is **opt-in and never a default**, because the edge serves a subset
  of Dawn rather than all of it.

  - **The stores are built per request, and that is not stylistic.** A pool held at
    module scope hands request N+1 an idle WebSocket bound to request N's dead I/O
    context; the request then hangs until workerd cancels it, in an alternating
    pattern that fails about half of all requests with nothing thrown. So
    `stores.mjs` builds the pool and all three stores inside the factory and ends
    the pool on dispose, with a module-scope flag recording that this isolate has
    already migrated so per-request instances do not re-run three migration
    transactions each time. That pool also gets an `'error'` listener:
    `@neondatabase/serverless` vendors `pg-pool` _and_ the `events` polyfill, so an
    idle client's failure re-emits on the pool and the shim throws when nothing is
    listening — the same uncaught-exception hazard node `pg` has, and one that
    `nodejs_compat` being off does nothing to remove. A per-request pool is still
    exposed: a client sits idle between every pair of store queries, and pg-pool's
    idle listener outlives `end()`.
  - **`requestStores`**, a new option on `createRuntimeFetchHandler`, is the seam
    that makes that possible: a `(request) => RequestStores` factory whose every
    field is optional and falls through to the boot-resolved store when omitted.
    `RequestStores` is exported from `@dawn-ai/cli/fetch`.
  - **The build fails, by name, on anything the edge cannot serve** — with the new
    `DAWN_E1005`, and reporting every offending feature at once rather than one
    build at a time: `sandbox`, `backends.filesystem`/`backends.exec`, a
    config-supplied `checkpointer` / `threadsStore` / `permissions.store` /
    `memory.store`, a `workspace/` directory, route skills, and route-level
    long-term memory. The store cases matter most: those handles cannot cross a
    build boundary, so before the gate the generated Postgres store quietly took
    their place. `dawn check` applies the identical gate whenever `hono` is a
    configured target.
  - **The provider import map is exhaustive or the build fails.** A bundler cannot
    follow a variable import specifier, so `app.mjs` emits a static `switch` over
    the model packages the app can reach; whatever is missing from it is missing
    from the bundle. A route that will not import, or an agent whose provider
    cannot be inferred, is therefore an error rather than a silently narrower map,
    and `summarization.model` is included.
  - **`dawn build` warns on stderr** when `@dawn-ai/cli`, `@dawn-ai/postgres-storage`,
    `@neondatabase/serverless` or `hono` is missing from the app's `package.json`.
    None of them is a dependency of `@dawn-ai/cli`, deliberately: the CLI does not
    import them, the app it generates does.
  - **Your config is inlined into `app.mjs` at build time**, minus every field that
    cannot survive a build boundary, rather than loaded from `dawn.config.ts` at
    runtime as the `node` target does. Keep secrets in bindings, not in config.

  Also new, both in service of the emitted entry: `seedModelImporter` and
  `providerPackages` from `@dawn-ai/langchain` (re-exported from
  `@dawn-ai/cli/fetch`), and `DAWN_E5301` on a runtime that reaches a store no
  layer supplied.

  Full walkthrough, the supported subset, and an explicit list of what the CI lane
  does **not** settle — no real Cloudflare deploy, Hyperdrive, production
  connection limits, per-query latency, cross-isolate cold starts, and the bundle
  size and startup CPU that `wrangler deploy` enforces and `wrangler dev --local`
  does not — are in the Deployment docs under Edge runtimes.

- c2c19da: Per-request stores are now disposed only after BOTH the response body has
  settled and the run that request started has released its slot. Route work
  outlives its response on three paths — an aborted AG-UI stream, an abandoned
  `/runs/wait`, a cancelled AP stream — and all three keep writing through the
  stores a response-triggered teardown would have closed. `close()` also waits
  for in-flight disposals, so a host awaiting shutdown knows the pools are shut.

  A runtime that reaches a store no layer supplied now answers with a 500 that
  names the missing store and carries the new `DAWN_E5301` code, instead of a
  generic failure with nothing to diagnose.

## 0.8.20

## 0.8.19

## 0.8.18

### Patch Changes

- c6b08a9: Add keyed, parent-owned subagent delegation policies with fail-closed
  constraints and approval. Subagents now run as native resumable LangGraph
  subgraphs, and interrupt resume uses one complete multi-entry request envelope.

  This intentionally removes array-form subagent registration, tool policy on
  the internal `task` mechanism, and scalar interrupt resume. Confirm the fixed
  0.x patch release intent with Brian before release.

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

### Patch Changes

- 5bbd6e3: Add a `recursionLimit` option to `agent()`. It maps to LangGraph's per-run
  super-step ceiling (default 25), so deep agents — a coordinator that dispatches
  subagents and makes many tool calls — can raise the limit instead of aborting
  with a recursion error.
- 628d1c3: Wire `DAWN_E` error codes into `dawn verify`'s runtime preflight. Add
  `DAWN_E5101` ("Node version below the supported floor") to the error-code
  registry, and surface it (or `DAWN_E2002` for an unreachable sandbox daemon)
  on a failed `dawn verify` runtime check — in both the CLI's `[CODE] See <docs>`
  line and the `--json` output's `runtime.node.code` / `runtime.docker.code`
  fields.
- 18df470: Add a central `DAWN_Exxxx` error-code registry in `@dawn-ai/sdk` and surface
  codes on the failure channels. `CliError` now carries an optional `code` and the
  CLI prints `[CODE] See <docs>`; HTTP/SSE error bodies gain optional `code`/`docsUrl`;
  permission denials returned as tool results are prefixed with `[DAWN_E3001]`.
  The high-value families are wired (`dawn check` config errors, sandbox
  unavailable, permission denied, missing model provider / unknown model id, and
  tool-file shape errors), and a generated `/docs/errors` reference page is guarded
  against drift. Additive and backward-compatible.

## 0.8.12

## 0.8.11

## 0.8.10

## 0.8.9

### Patch Changes

- d3d94af: Argument-level tool constraints: `agent({ tools: { constrain: { deployProd: (args, ctx) => … } } })` runs a per-tool predicate against the model's arguments at call time, returning allow / deny-with-reason / `{ approve: true }` (escalate to the HITL prompt). Predicates may be async and receive a read-only policy context; a throwing or off-contract predicate fails closed. The tool run context now also carries the live `threadId` + route params. `dawn check` validates `constrain` tool names and warns on `approve`/`constrain` overlap.

## 0.8.8

## 0.8.7

## 0.8.6

### Patch Changes

- 1d51b75: Per-tool approval gating: `agent({ tools: { approve: ["deployProd"] } })` makes any named tool require a HITL permission prompt per call (`kind: "tool"` interrupt). Decisions persist name-level under the reserved `tool` key in `.dawn/permissions.json` (exact-name matching); pre-approve via `permissions.allow.tool`. `dawn check` validates `approve` names and warns on overlap with the internally-gated workspace tools, `deny`, and the unsupported `task` case.

## 0.8.5

## 0.8.4

## 0.8.3

### Patch Changes

- 2744a5c: Add long-term memory. Routes gain a typed, cross-session memory collection via
  `defineMemory({ kind, scope, schema })` in `memory.ts` — the agent gets generated
  `remember`/`recall` tools backed by a namespaced `@dawn-ai/memory` store
  (node:sqlite, deterministic keyword+recency recall). Plus route-local `memory.md`
  profile injection and a `dawn memory` CLI (list/search/inspect/approve/reject/forget).
  Writes default to a `candidate` queue (config `memory.writes`). Ships the `semantic`
  kind; vector recall, episodic/procedural kinds, and the dev inspector UI are deferred.
  The research scaffold template now ships a `memory.ts`/`memory.md` example.
- 7339ded: Tool scoping: `agent({ tools: { allow, deny } })` restricts which tools a route's agent may call. `deny` revokes a tool; `allow` grants a withheld capability tool; deny wins.

  **Behavior change (pre-1.0):** subagents are now least-privilege by default — a subagent gets only its own route-local `tools/*.ts`; ambient capability tools (`writeFile`, `runBash`, `task`, `writeTodos`, `remember`/`recall`, …) are withheld unless named in `tools.allow`. A subagent that relied on inheriting these must add `tools: { allow: [...] }`. `dawn check` validates scope names. This scopes the tool surface, not execution (not a sandbox).

## 0.8.2

## 0.8.1

## 0.8.0

### Minor Changes

- Unknown model ids now get advisory warnings instead of late provider 404s. `dawn check`/`verify` warn (exit code unchanged) when an agent route's `model` isn't in the curated list for its resolved provider (`openai`, `google`, `anthropic`, `xai`), with did-you-mean suggestions; the runtime prints the same `[dawn:models]` advisory once per model at chat-model construction. Curated lists are values now (`CURATED_MODEL_IDS` etc.) with types derived, Anthropic and xAI ids included; `validateModelId` and `inferProvider` are exported from `@dawn-ai/sdk`. Note: the narrow `GoogleModelId` union dropped the vendor-retired `gemini-3-pro-preview` (replaced by `gemini-3.1-pro-preview`).

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.7.0

### Minor Changes

- a38ff61: Sandboxed `ctx.fs` for route tools and workflow/graph entries. Tools and route entries now receive a `WorkspaceFs` handle (`readFile`, `readBinaryFile`, `writeFile`, `listDir`) that resolves paths against the route's `workspace/` directory and runs the same permission gate as the agent-facing workspace tools — no more dropping to `node:fs`. The permission gate is extracted to a shared core module; in execution contexts where interactive prompts can't appear (workflow/graph entries), outside-workspace access fails closed with guidance to add an allow rule.

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.0

### Minor Changes

- 1005b3a: Add provider-aware agent materialization. Agent configs can now carry an optional `provider`, and the LangChain runtime infers providers for known model families or lazy-loads the explicit provider integration package for built-in provider IDs.
- e8462db: `agent({...})` now accepts an optional `reasoning: { effort }` field. Maps to OpenAI's `reasoningEffort` parameter (`none | minimal | low | medium | high | xhigh`). Non-reasoning models silently ignore it. Useful for tool-use-heavy agents that aren't following directives at the default reasoning depth.

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.

## 0.1.8

### Patch Changes

- 8c63c1a: Move testing helpers to `@dawn-ai/sdk/testing`.

  `expectError`, `expectMeta`, `expectOutput`, and the `RuntimeExecutionResult` type family now live at `@dawn-ai/sdk/testing` — the canonical home users have been intuitively reaching for. The old `@dawn-ai/cli/testing` subpath continues to work as a re-export for back-compat (and is now JSDoc-deprecated).

  ```ts
  // Preferred
  import { expectError, expectMeta, expectOutput } from "@dawn-ai/sdk/testing";

  // Still works (re-exports from sdk)
  import { expectError, expectMeta, expectOutput } from "@dawn-ai/cli/testing";
  ```

  No behavior change. The packed runtime contract test now exercises both subpaths.

## 0.1.7

### Patch Changes

- db635b1: Docs overhaul.

  - **Public package READMEs** (`@dawn-ai/sdk`, `@dawn-ai/cli`, `create-dawn-ai-app`) fleshed out with overview, install, key APIs, and links to the website.
  - All package READMEs include the Dawn brand image header.

  No code or runtime behavior changes — README content only.

- db635b1: Middleware context now flows through to tools.

  A tool's second argument is now `{ middleware?: Readonly<Record<string, unknown>>, signal: AbortSignal }`. Whatever the global middleware passes via `allow({ ... })` is available to every tool invocation as `ctx.middleware` — for both `/runs/wait` and `/runs/stream` paths.

  Example:

  ```ts
  // src/middleware.ts
  export default defineMiddleware(async (req) => {
    const userId = await verifyToken(req.headers.authorization);
    return allow({ userId });
  });

  // src/app/.../tools/lookup.ts
  export default async (input, { middleware }) => {
    const userId = middleware?.userId;
    return await db.lookup(userId, input);
  };
  ```

- db635b1: Production readiness: deployment config, LLM retry, request middleware.

  - **@dawn-ai/sdk:** `agent()` descriptor now accepts an optional `retry: { maxAttempts, baseDelay }`. Adds `defineMiddleware`, `reject(status, body?)`, `allow(context?)` for request middleware, plus `MiddlewareRequest`, `MiddlewareResult`, and `RetryConfig` types.
  - **@dawn-ai/cli:** `dawn build` produces a correctly-shaped `langgraph.json` for LangGraph Platform (`dependencies: ["."]`, `env` as file path). `dawn verify` adds an advisory `deps` check (4 checks total). Dev server loads `.env` files and runs middleware before route execution.
  - **@dawn-ai/langchain:** Per-agent retry config (`maxAttempts`, `baseDelayMs`) is wired through the agent adapter and applies to streaming and non-streaming paths.

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.
