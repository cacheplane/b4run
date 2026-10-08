# @dawn-ai/langchain

## 0.14.0

### Patch Changes

- b006a95: Every `TOOL_CALL_START` B4.run sends now carries `parentMessageId`: the id of the model message that announced the call — the id that message's `TEXT_MESSAGE_*` events use when it streamed text, a fresh one when it only called tools, the subagent's own message for a subagent's call. A chat host that builds its message list from AG-UI events now gets an assistant message during a tool-only phase, and keeps a model message's text and calls together. `eventsFromState` (and so `GET /threads/:id/events`) files replayed calls the same way, under the checkpointed AIMessage's id. The langchain adapter's `tool_call` and `tool_call_args` chunks carry the model invocation as `data.messageId`, and the CLI's `tool_call` stream chunk carries it as `messageId`. `mergeTurnMessages` (and so `useB4ChatSlots`) still renders one activity per turn: the turn's first assistant message with tool calls holds every call of the turn, after its text when it has some.

  `turnForMessage` and `<b4-message-activity [messages]>` accept messages that list their tool calls as `toolCallIds: string[]` as well as AG-UI's `toolCalls: { id }[]` (`toolCallIds` is read when `toolCalls` is absent); `@b4run/ag-ui/view` exports `toolCallIdsOf`.

  `@b4run/ag-ui/view` exports `toResumeEntries(decisions, interrupts)`: the AG-UI `resume` entries for approval decisions, `once`/`always` resolved with that payload, `deny` cancelled, each interrupt's grant at `metadata.grant`. It returns `{ ok: false, reason: "undecided" }` until every parked interrupt is decided, since B4.run resumes only when all of them are answered. `B4ApprovalDecision` (`@b4run/ag-ui/angular/events`) is now an alias of the view's `InterruptDecision`.

- d0bb6a1: A parked call keeps its running label after a reload. When a permission gate (tool, command, path or memory) parks a call whose tool has a `display`, the interrupt envelope now carries `step: { icon, label }`, the `display.running` label and icon the runtime streamed as the call's `running` `b4.step`. The envelope is checkpointed with the interrupt, so `GET /threads/:id/turns`, `/events` and `/pending_interrupts` return it, and AG-UI clients find it at `metadata.step`. `eventsFromState` replays it as the parked call's `running` step, so a restored awaiting step shows the same label and icon as the live run, and the approval card reads "The agent wants to file N738ZU KSTP to KRST" instead of "wants to use fileFlightPlan". The field is additive; an interrupt parked before this release restores as before. Tool run contexts carry the display as `step`.
- 1180d4c: **Breaking:** every tool call now returns a `ToolMessage` whose `additional_kwargs.b4_step` is complete (`status`, `startedAt`, `settledAt`, the gate `decision`, and the display's icon, label and sources), display or not; the `task` tool returns a `ToolMessage` (not a string) carrying `b4_step` and `b4_subagent` with the child's checkpoint namespace; a thrown tool's error message is built by the converter with a `failed` step, and a branded denial persists as a `denied` step (with `decision: "deny"`) on a `success` ToolMessage — not a failure, so a denied `returnDirect` call still ends the run with the denial as its result. Raw `GET /threads/:id/state` readers see the new keys. Permission gates report `once | always | deny` into the tool context (`onGateDecision`). The runtime stamps `b4:turn` (`done | failed | stopped`, `error`, `endedAt`) on the head checkpoint's metadata when a run ends (never on a parked head, only on a head the turn wrote), and both checkpointers gain `listNamespaces(threadId)`.

  `@b4run/ag-ui/view` gains `turnsFromState(input)`: rebuild a thread's `TurnsView` from its checkpoint history and parked interrupts by synthesising the AG-UI events the live stream would have carried and folding them through the unchanged `reduceTurns`; output carries `warnings` for ignored stamps. `GET /threads/:id/turns` serves it in the next release. Threads written before these stamps do not restore.

- 2c33a3f: `GET /agui/:routeId` now reports a `multimodal` section for an `agent()` route: `input.image`, `input.pdf`, `input.audio` and `input.video` come from the route model's LangChain profile with the provider's converter limits — the same judgment that keeps or drops each part at run time — and `image`/`pdf` describe the inline `data` source (URL support varies by provider and is reported by the dropped-parts warning). `input.file` and `output` are always `false`. The section is omitted for a raw runnable, a chain/graph/workflow route, or a provider package that is missing or cannot be read; the rest of the document is unaffected. `@b4run/langchain` exports `readModelProfile`, which reads a model's profile off its provider class without constructing it.

  Client-provided tool results may carry content parts. A `role: "tool"` answer's parts are stored as sent and replayed to the model under the tool-result rules; the UI gets every part on `TOOL_CALL_RESULT`. A call closed by the abandon path replays the stored result as its text and logs a warning. The 64 KiB result cap is measured on text/JSON with inline media bytes excluded.

  - `ClientToolCallRecord.result` and `ClientToolCallStore.answer`'s `result` widen from `string` to `B4MessageContent` (`@b4run/sdk`); `ClientToolResumeValue.clientToolResult` widens the same way (`@b4run/core`). A custom store must keep and return parts.
  - `@b4run/sdk` exports `encodeClientToolResult`/`decodeClientToolResult`: a part list is kept in the existing text column as a self-describing JSON envelope. Text results, including rows written before this release, are stored and read back unchanged; no migration. A rollback to an earlier release reads a stored part-list result as its JSON envelope text; resume or abandon such calls before downgrading. The SQLite and Postgres stores use the codec and gained a direct `@b4run/sdk` dependency.
  - The dropped-parts warning again ends by pointing at `GET /agui/<route>` for what the route accepts.

- ed43d4f: Carry AG-UI 1.0 content parts to the model. A user message's `image`, `audio`, `video` and `document` parts — inline, by URL, or as a provider file handle — reach the route's model as LangChain content blocks; what the model cannot take (read from its LangChain profile) is dropped and announced, in the server log and on the stream as `CUSTOM` `b4.content_parts_dropped`, never refused: the `422` envelope rejection of media parts is gone. Tools may return `B4ContentPart[]` (new in `@b4run/sdk`), which travels as `TOOL_CALL_RESULT.content`. The Agent Protocol run endpoints now bound their bodies at the same 8 MiB as `/agui`. `B4Message.content` (`@b4run/ag-ui`), `UnwrappedToolResult.content` (`@b4run/langchain`) and `MiddlewareAfterMessage.content` (`@b4run/sdk`) widened from `string` to `string | readonly B4ContentPart[]`, and chain, graph and workflow routes now receive `messages[].content` as that part array whenever the client sent parts (previously flattened to text), so code that narrows on `string` must handle the array.
- 5caad96: **Breaking:** `agent()`'s `reasoning` is keyed by provider. `reasoning: { effort }` becomes `reasoning: { openai: { effort } }`; a flat `effort`, an unknown key, or a block for a provider the route does not resolve to now fails the route when its model is built (before, a misplaced setting was silently ignored — and the OpenAI effort itself never reached the request, because it was passed as the constructor field `reasoningEffort`, which `@langchain/openai` reads only per call). New controls make reasoning visible: `openai.summary: "auto" | "concise" | "detailed"` streams a reasoning summary (and moves the route to the Responses API); `anthropic.budgetTokens` enables extended thinking. The langchain adapter carries thinking and reasoning blocks as `reasoning` stream chunks; `@b4run/ag-ui` frames them as AG-UI 1.0 `REASONING_START` / `REASONING_MESSAGE_*` / `REASONING_END`, one span and one `role: "reasoning"` message per model invocation, every one closed before the run ends. `GET /agui/:routeId` advertises `reasoning: { supported: true, streaming: true, encrypted: false }` exactly when the route's config makes reasoning stream, `{ supported: false }` otherwise. `IdFactory` gains the `reasoning` and `reasoningSpan` kinds.

  `@b4run/testing`'s `finalMessage` now reads an assistant message whose `content` is a list of blocks (the OpenAI Responses API, Anthropic with tools bound), joining its `text` blocks; before, such a run reported an empty final message.

- 0cd999a: **Breaking (Agent Protocol stream):** a subagent's events now carry the same shapes as the root's. `subagent.message { chunk }` is replaced by `subagent.token { data, messageId }`; `subagent.tool_call` / `subagent.tool_result` carry `name` under the model's tool-call `id` instead of `tool` under an execution run id; new `subagent.reasoning`, `subagent.message_end` and `subagent.tool_call_args`; `subagent.start` gains `parent_call_id` (nested children) and `description`. The langchain adapter announces a child's tool calls from its own model turn with the same per-owner bookkeeping root uses, the dev server's attach digest coalesces `subagent.token` per child invocation, `@b4run/testing` reads the new shapes, and `@b4run/ag-ui` consumes them at the activity boundary with no change on the AG-UI wire (the `SUBAGENT_*` presentation follows in the next release).
- 31c2633: AG-UI terminal events now report token usage. `RUN_FINISHED` (every outcome) and `RUN_ERROR` carry `usage: TokenUsage[]` — one entry per provider and model, aggregated across the run including subagent calls, with the protocol's inclusive totals and no zeros for counts a provider did not return; the key is omitted when nothing was reported. The langchain agent adapter emits a `usage` stream chunk (`{ provider, model, usage_metadata }`, a `subagent.usage` for a child's call) per finished model call, which also reaches the Agent Protocol stream as `event: usage`.
- 861f84a: `b4 build --target langsmith` compiles an app's `src/auth.ts` instead of refusing it. The build writes `.b4/build/auth.ts`, a LangGraph `Auth` that runs the app's `authenticate`, and sets `langgraph.json` `auth` with `disable_studio_auth: true`. `reject` becomes its status, and an anonymous request is a 401, since LangGraph has no anonymous user. An `ownedThreads` thread policy compiles to owner-stamp metadata filters; any other policy is still refused. Tools read the caller as `ctx.principal` from LangGraph's auth user.

  The build refuses an auth file that compares a secret from an `x-*` header, which LangGraph copies into stored run config. It also refuses memory scoped by `user`, `tenant` or `agent`, and warns that `src/middleware.ts` is not deployed. `createLangSmithAuth` is exported from `@b4run/cli/runtime`.

- bcfc8b8: An app can now declare one place that resolves who is calling: `src/auth.ts` default-exports `defineAuth({ authenticate })`. B4.run calls `authenticate` once per request, before middleware and the thread-access policy, and passes the result to middleware and the thread-access policy as `req.principal` and to every tool as `ctx.principal`. A principal is any object with a string `id`. `undefined` makes the request anonymous, `reject(...)` answers it before any endpoint runs, and a throw or malformed result fails it with a 500.

  `b4 typegen` declares the type `authenticate` resolves to on `B4Register`, so `ctx.principal` is typed. The node and web build targets carry `src/auth.ts` in their build, and the `langsmith` target refuses an app that has one. An auth file that does not default-export `defineAuth` fails the boot with `B4_E3005`. The harness takes a `principal` option, and `createAgentProtocolInjector` takes `auth`.

  **Breaking:** `ThreadAccessRequest.headers` is removed. A thread-access policy that read identity from headers must move that read into `src/auth.ts` and use `req.principal`. The `basic` and `navlog` templates are migrated, and the `navlog` template no longer ships `src/middleware.ts`.

- 05db71b: A tool call blocked by `tools.approve` or `tools.constrain` now settles its `b4.step` with `status: "denied"` (icon only) instead of `completed`. `B4_STEP_STATUSES` and `B4StepStatus` gain `denied`; `reduceTurns` settles the step as `denied`, drops the running label and sources it does not replace, and never counts it toward `turn.failed`; `stepLabel` reads it as "Denied x" (an app's `done` override never runs for it); the React `Step` renders `data-state="denied"` with a "· denied" tail and the tool's own icon.
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
- Updated dependencies [d0bb6a1]
- Updated dependencies [c8b0675]
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
- Updated dependencies [fc59949]
- Updated dependencies [bcfc8b8]
- Updated dependencies [936b7bf]
- Updated dependencies [936b7bf]
- Updated dependencies [91726d5]
- Updated dependencies [bbd4a0c]
- Updated dependencies [9547137]
- Updated dependencies [18bc4fd]
- Updated dependencies [bbc7871]
- Updated dependencies [d45b2dc]
- Updated dependencies [b1ae324]
  - @b4run/core@0.14.0
  - @b4run/sdk@0.14.0
  - @b4run/workspace@0.14.0

## 0.13.1

### Patch Changes

- f9350c4: `agent({ retry })` now applies to each model call instead of the whole run. `maxAttempts` (default 3) becomes the chat model's `maxRetries` (`maxAttempts - 1`), so LangChain retries each model request, including later calls in a tool loop, up to that many times; `maxAttempts: 1` now fails fast. Before, LangChain's default of 6 retries applied whatever `retry` said, and B4.run restarted the whole run on top of it when nothing had streamed yet.

  B4.run also sends a model call again after a capacity rate limit that LangChain hands back without retrying (a `429` with no `Retry-After`), waiting `min(baseDelay * 2^n + jitter, 10s)`. A `429` whose `Retry-After` is over 60 seconds (LangChain waits out shorter ones itself) isn't retried: the error surfaces at once, keeping the wait in `retryAfterMs`. This is the only place `baseDelay` applies; it was previously never read on an agent route. A quota `429` isn't retried, an abort during the wait stops it, and a response that fails after part of it streamed isn't retried, so no token is sent twice. The run itself is never restarted, so tools never run twice, and a transient error outside the model call (for example a checkpointer connection reset before the first event) now fails the turn instead of being retried with the run.

  The route's summarization model gets the same `maxRetries` (`defaultSummarize` and a custom `summarize` receive it as `maxRetries`), and the `b4 memory consolidate` / `reflect` model takes its attempts from a new `memory.distill.retry: { maxAttempts }` in `b4.config.ts` (default 3 per call, instead of LangChain's 6). `memory.distill.retry` is validated by `b4 check` and by the `b4 memory consolidate` / `reflect` commands (not by `b4 dev` or the runtime, which never read `memory.distill`): a `baseDelay` (distillation has nothing for it to pace), an unknown key in `memory.distill` or its `retry` (including a near-miss case typo such as `Distill`, `distil`, or `Retry`), a non-object parent, `memory: null` or `memory.distill: null` (previously read as empty), a misplaced `retry`/`maxAttempts`, or a `maxAttempts` that isn't a whole number of at least 1 fails with the new error code `B4_E1009` (Invalid memory config) instead of falling back to the default. `modelMaxRetries(retry)` is exported for other code that builds a chat model from an agent's `retry`.

  An invalid `retry` (a `maxAttempts` below 1 or not a whole number, a negative `baseDelay`) now fails the route when it first runs, and so does an unknown key on the `retry` object (for example `maxAttemps`) or a non-object `retry` — the error names the bad key and the valid keys, `maxAttempts` and `baseDelay`. A route that exports its own LangChain runnable keeps its model's own `maxRetries`, and is no longer restarted on a failure either if it streams; one with only `invoke` (no `streamEvents`) is still re-run whole by the legacy fallback, up to 3 times on a message-matched transient error.

- 377c1e9: A thread whose last run was cut off between a model turn and its tool calls (by `recursionLimit`, an abort or a crash) no longer fails every later turn. The checkpoint keeps that assistant message with `tool_calls` and no results, which providers refuse (OpenAI: "An assistant message with 'tool_calls' must be followed by tool messages"). Agent routes now give each such call an error result in the history the model is sent, so the next turn runs; the checkpoint itself is unchanged.
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

- Updated dependencies [f9350c4]
- Updated dependencies [a683816]
- Updated dependencies [17f16ea]
- Updated dependencies [3b1be6e]
- Updated dependencies [c7282f4]
- Updated dependencies [b0605d7]
  - @b4run/sdk@0.13.1
  - @b4run/core@0.13.1
  - @b4run/workspace@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [f2ee6cf]
- Updated dependencies [3b489a5]
- Updated dependencies [0dd8fff]
- Updated dependencies [1da86ae]
- Updated dependencies [79c5f63]
- Updated dependencies [0d06d72]
- Updated dependencies [fcf6d83]
  - @b4run/workspace@0.13.0
  - @b4run/sdk@0.13.0
  - @b4run/core@0.13.0

## 0.12.0

### Patch Changes

- ef4c901: Agent routes now run on LangChain's `createAgent` instead of LangGraph's deprecated `createReactAgent`, and a `returnDirect` tool ends the run only when it succeeds. A failed call (the tool threw, or the model's arguments failed its schema) now goes back to the model, which can correct the call and retry; the first successful result ends the run. Previously the error ended the run, so a validating tool could not use `returnDirect`.

  B4 installs its own `createAgent` middleware for what `createReactAgent` did through options: prompt fragments re-rendered from live state, summarization's condensed history, and tool errors returned to the model as `status: "error"` results in the same `Error: … Please fix your mistakes.` form as before. A route without summarization or a `returnDirect` tool keeps the same number of graph steps per model/tool turn, so `recursionLimit` budgets are unchanged.

  `@b4run/langchain` now depends on `langchain` ^1.5.12, and its `@langchain/core` peer range rises from ^1.1.47 to ^1.2.12 (the range `langchain` itself requires).

- 212c43d: The missing model provider error (`B4_E4001`) now suggests the install command for the package manager that launched the process (`npm install`, `pnpm add`, `yarn add` or `bun add`, read from `npm_config_user_agent`), defaulting to `npm install` instead of always printing `pnpm add`.
- Updated dependencies [ef4c901]
- Updated dependencies [7f81d24]
  - @b4run/core@0.12.0
  - @b4run/sdk@0.12.0
  - @b4run/workspace@0.12.0

## 0.11.2

### Patch Changes

- @b4run/core@0.11.2
- @b4run/sdk@0.11.2
- @b4run/workspace@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [c282336]
  - @b4run/sdk@0.11.1
  - @b4run/core@0.11.1
  - @b4run/workspace@0.11.1

## 0.11.0

### Minor Changes

- 54aa602: A tool module can export `returnDirect = true` to end the run on its result instead of handing control back to the model for another turn. LangGraph's prebuilt agent already routes such a tool straight to the end of the graph; B4 now reads the export during tool discovery, carries it on the tool definition, and sets it on the LangChain tool. The run's last message is then the tool result: no closing assistant message is produced, the AG-UI stream ends after `TOOL_CALL_RESULT`, and a middleware `after` hook sees an empty final message. A non-boolean export is a discovery error.

### Patch Changes

- 18961bb: Assistant text now streams for providers that deliver it as content blocks. LangChain's Anthropic integration coerces a chunk's content to a plain string only when the request binds no tools, and every B4 agent binds tools, so an Anthropic-backed agent produced no assistant text tokens at all; the same shape reaches the adapter from OpenAI's Responses API. The agent adapter now reads a chunk's `text` blocks, ignoring thinking, citation and tool-input deltas, so those models stream their prose like any other.
- a30db23: LangChain dependencies move to their current releases: `@langchain/core` 1.2.12, `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/openai` 1.5.13, `@langchain/anthropic` 1.5.11, `@langchain/google-genai` 2.3.2, `@langchain/xai` 1.4.13 and `@langchain/openrouter` 0.4.13, with the peer ranges raised to match. The lockfile is deduplicated so that every workspace package resolves the same single copy of `@langchain/langgraph` and `@langchain/core`.
- Updated dependencies [a30db23]
- Updated dependencies [54aa602]
  - @b4run/core@0.11.0
  - @b4run/sdk@0.11.0
  - @b4run/workspace@0.11.0

## 0.10.0

### Minor Changes

- 1cadde8: Tool-call arguments now stream as they are generated. The LangChain agent adapter projects the argument fragments a provider streams into `tool_call_args` chunks, re-serialized token by token so their concatenation matches the `JSON.stringify(args)` delta sent today byte for byte, and the AG-UI translator emits them as one `TOOL_CALL_START`, several `TOOL_CALL_ARGS` deltas and one `TOOL_CALL_END` under the call's logical id. A client that renders from a tool call's arguments can paint progressively, the way it does for assistant text. Tool execution still receives the complete, parsed arguments from the unchanged `tool_call` announce; providers that stream no fragments produce exactly the output they did before; the built-in `writeTodos` and `task` calls stay on the single-delta path. The runtime's middleware `after` hook treats a fragment as proof a held message was not final, and the live tail renders nothing for fragments.

### Patch Changes

- Updated dependencies [71bccb3]
  - @b4run/workspace@0.10.0
  - @b4run/core@0.10.0
  - @b4run/sdk@0.10.0

## 0.9.0

### Patch Changes

- 7c9627f: Apply a client-supplied `hashbrown.responseSchema` on the AG-UI run body to the route's root model, or reject the run. `POST /agui/:routeId` used to accept the field and read nothing from it, so a Hashbrown client that expected the final message to match its UI schema got an unconstrained model and found out only when a reply failed to parse. On an `agent` route the schema is now bound as the provider's native schema-constrained output alongside the route's tools — OpenAI `response_format` (`json_schema`, `strict: true`) and Anthropic `output_config.format` — so tool-calling turns are untouched and only the final message is constrained. A malformed schema, a non-agent route, or a provider with no such mode is refused with `422` and the new `B4_E5402` (`invalid_response_schema` / `response_schema_not_supported`) before any run side effect. Runs without the field are unchanged. `@b4run/langchain` gains `JsonSchemaResponseFormat`, `createChatModel({ responseFormat })`, `streamAgent({ responseFormat })` and the `JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS` list.
- 16ef75f: Emit a `tool_result` when a tool throws, so AG-UI clients see `TOOL_CALL_RESULT`.

  `@b4run/langchain`'s agent adapter mapped `on_tool_end` to a `tool_result`
  chunk and emitted nothing for a non-interrupt `on_tool_error`, so a client saw
  `TOOL_CALL_START`, `TOOL_CALL_ARGS` and `TOOL_CALL_END` for a failing tool and
  never a `TOOL_CALL_RESULT`; the error ToolMessage LangGraph hands the model
  appeared only inside `RUN_FINISHED.result.messages`. The adapter now holds a
  thrown root execution and resolves it from the `status: "error"` ToolMessage
  the tool node appends for the model, emitting a `tool_result` keyed by the same
  tool-call id whose `output` is that ToolMessage — serialized exactly like a
  successful result. `interrupt()` throws are unaffected.

  `@b4run/testing`'s `collectRunResult` now builds `run.toolResults` from the
  streamed `tool_result` chunks (reading a ToolMessage, a Command's ToolMessage,
  or a plain output), so a thrown tool is marked `isError` without reading the
  final messages; a stream that carried no tool results still falls back to
  `deriveToolResults` over the final messages.

- Updated dependencies [7c9627f]
- Updated dependencies [516c038]
- Updated dependencies [6a59e00]
- Updated dependencies [7410154]
- Updated dependencies [9927409]
  - @b4run/sdk@0.9.0
  - @b4run/workspace@0.9.0
  - @b4run/core@0.9.0

## 0.8.36

### Patch Changes

- Updated dependencies [6d16bb1]
  - @b4run/core@0.8.36
  - @b4run/sdk@0.8.36
  - @b4run/workspace@0.8.36

## 0.8.35

### Patch Changes

- Updated dependencies [89a5958]
- Updated dependencies [814f4f9]
- Updated dependencies [c9a4d87]
- Updated dependencies [80aa142]
- Updated dependencies [12726b4]
- Updated dependencies [0aa4d42]
- Updated dependencies [765e6e1]
- Updated dependencies [acfc786]
- Updated dependencies [10a6cbb]
  - @b4run/workspace@0.8.35
  - @b4run/sdk@0.8.35
  - @b4run/core@0.8.35

## 0.8.34

### Patch Changes

- 5843672: Keep tool middleware context scoped to the current request, including resumed
  approval runs. Agent graphs capturing middleware context no longer share the
  compiled graph cache, preventing earlier request identity or authorization
  from reaching later tool calls. Context-free agents retain their existing cache.
  - @b4run/core@0.8.34
  - @b4run/sdk@0.8.34
  - @b4run/workspace@0.8.34

## 0.8.33

### Patch Changes

- a239527: Keep concurrent nested model output in separate AG-UI assistant messages. Carry
  model invocation identity through runtime tokens and live-turn snapshots, and
  close each message when its model finishes. Legacy anonymous tokens and raw SSE
  string payloads remain supported.
  - @b4run/core@0.8.33
  - @b4run/sdk@0.8.33
  - @b4run/workspace@0.8.33

## 0.8.32

### Patch Changes

- Updated dependencies [0003db2]
- Updated dependencies [9e3c42e]
- Updated dependencies [0003db2]
- Updated dependencies [0003db2]
  - @b4run/workspace@0.8.32
  - @b4run/sdk@0.8.32
  - @b4run/core@0.8.32

## 0.8.31

### Patch Changes

- @b4run/core@0.8.31
- @b4run/sdk@0.8.31
- @b4run/workspace@0.8.31

## 0.8.30

### Patch Changes

- 6039fd2: Preserve null in generated tool parameter schemas, including required and optional nullable fields, and validate null alternatives without accepting unrelated values at runtime.
- Updated dependencies [80a98ad]
- Updated dependencies [18c7b61]
- Updated dependencies [6039fd2]
  - @b4run/sdk@0.8.30
  - @b4run/core@0.8.30
  - @b4run/workspace@0.8.30

## 0.8.29

### Patch Changes

- Updated dependencies [481489e]
  - @b4run/sdk@0.8.29
  - @b4run/core@0.8.29
  - @b4run/workspace@0.8.29

## 0.8.28

### Patch Changes

- Updated dependencies [39ceb2e]
  - @b4run/sdk@0.8.28
  - @b4run/core@0.8.28
  - @b4run/workspace@0.8.28

## 0.8.27

### Patch Changes

- Updated dependencies [b05b96d]
  - @b4run/sdk@0.8.27
  - @b4run/core@0.8.27
  - @b4run/workspace@0.8.27

## 0.8.26

### Patch Changes

- Updated dependencies [c7fd197]
  - @dawn-ai/core@0.8.26
  - @dawn-ai/sdk@0.8.26
  - @dawn-ai/workspace@0.8.26

## 0.8.25

### Patch Changes

- @dawn-ai/core@0.8.25
- @dawn-ai/sdk@0.8.25
- @dawn-ai/workspace@0.8.25

## 0.8.24

### Patch Changes

- @dawn-ai/core@0.8.24
- @dawn-ai/sdk@0.8.24
- @dawn-ai/workspace@0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- Updated dependencies [7e62bb1]
  - @dawn-ai/core@0.8.23
  - @dawn-ai/sdk@0.8.23
  - @dawn-ai/workspace@0.8.23

## 0.8.22

### Patch Changes

- bedad77: Documentation only: every public export of this package now has an API reference
  page on dawnai.org, and the package README leads with a concise entrypoint. No
  runtime behavior changed.
- 1ca14d3: Stop recording an episodic memory for a turn that parked on a human-in-the-loop
  approval. On the non-streaming route path — the one `POST /threads/:id/runs/wait`
  uses — the agent adapter discarded the interrupt and returned only the final
  state, which never carries `__interrupt__` under `streamEvents`. The recorder
  therefore treated the park as a completed run, and the resuming turn recorded a
  second episode for the same run: recall saw both a fragment and a duplicate.

  The adapter now offers `executeAgentTurn`, which reports the final output and
  whether the turn parked, and both route paths tell the recorder which happened.
  `executeAgent` is unchanged for existing callers.

- ffdbcd9: Key root AG-UI/Agent-Protocol tool events by the model's tool-call ID
  (logical identity) whenever the model provides one, instead of the internal
  execution run ID. Interrupted-and-resumed tool calls now re-emit under the
  same ID, so standard AG-UI clients converge them into a single tool card
  instead of showing a duplicate. Streams without model tool-call IDs keep the
  previous behavior.
- 908d690: Carry the model's tool-call ID from a tool execution into the capability
  stream: `StreamTransformerInput` gains an optional `toolCallId`, and the
  planning capability echoes it as `tool_call_id` on `plan_update`. Child
  capability events keep their subagent's tool-call ID internal. This is the
  correlation plumbing behind presenting built-in orchestration work once; the
  presentation change that consumes it ships in this same release.
- d42774e: **Breaking:** scenario files must default export `scenarios("<route>")` from
  `@dawn-ai/sdk/testing`. A plain default-exported array now throws
  `RunScenarioLoadError` at load; wrap the array in `scenarios("/route")` to
  migrate.

  Add route-scoped fluent `dawn test` scenarios with generated application-tool
  types, invocation-local in-process tool mocks, and declarative mock call
  assertions.

- Updated dependencies [bedad77]
- Updated dependencies [a530e70]
- Updated dependencies [8398c90]
- Updated dependencies [3c68800]
- Updated dependencies [3c68800]
- Updated dependencies [f317dd7]
- Updated dependencies [908d690]
- Updated dependencies [3c68800]
- Updated dependencies [d42774e]
- Updated dependencies [984c3ad]
- Updated dependencies [496b54c]
- Updated dependencies [67030fa]
- Updated dependencies [730b136]
  - @dawn-ai/workspace@0.8.22
  - @dawn-ai/core@0.8.22
  - @dawn-ai/sdk@0.8.22

## 0.8.21

### Patch Changes

- c2c19da: **Edge runtime: `process.env` reads no longer crash a worker.**

  `@dawn-ai/cli/fetch` links for Cloudflare workerd with no `node:` specifiers,
  which is why the emitted `wrangler.toml` omits `nodejs_compat` — and without
  that flag `process` is not defined, so a bare `process.env.X` is a
  `ReferenceError` rather than a quiet `undefined`. Six such reads were on the
  fetch graph. The worst sat in the openai model constructor, so it fired on the
  first turn of the app this target scaffolds.

  - New in `@dawn-ai/core`: `readRuntimeEnv(name)` and `seedRuntimeEnv(env)`.
    `readRuntimeEnv` consults `process.env` first and falls back to whatever an
    edge entry point seeded, so behavior under Node is unchanged. `seedRuntimeEnv`
    is re-exported from `@dawn-ai/cli/fetch` alongside `seedModelImporter`.
  - `OPENAI_BASE_URL` (in `createChatModel` and `openaiEmbedder`) reads through the
    seam rather than being guarded away. It is configuration, not debug output: a
    guard would have replaced a crash with a deployment whose base URL could not
    be set at all.
  - The `DAWN_DEBUG_MEMORY`, `DAWN_DEBUG_SUMMARIZATION`, `DAWN_DEBUG_INTERRUPTS`
    and `DAWN_DEBUG_CONSTRAINTS` reads use the same seam, so they stay off by
    default where there is no `process` and can still be switched on by seeding.
  - `test/fetch-entry-purity.test.ts` now gates Node-only globals, not just
    `node:` import edges — a bare global leaves no edge, which is why this class
    shipped past a green suite. The bundle is linked with each of `process`,
    `Buffer`, `global`, `__dirname`, `__filename` and `require` rewritten to a
    sentinel by esbuild's scope-aware `define`, so string literals, comments,
    property names and shadowed locals cannot produce a false hit. Dawn-owned code
    must reference none of them at all; the wider graph must contain no reference
    that lacks a `typeof` guard in the same statement.

- c2c19da: **A Dawn app now serves more than one request per isolate on Cloudflare
  workerd.** Three defects, each found only by running the whole thing inside real
  workerd, and none of them fixed by reaching for `nodejs_compat`.

  - **The bundle did not link**, from one specifier and it was Dawn's own.
    `@dawn-ai/langchain` imported `dispatchCustomEvent` from
    `@langchain/core/callbacks/dispatch`, whose entry statically imports
    `node:async_hooks` in order to infer the config off `AsyncLocalStorage` when a
    caller omits one. Both Dawn call sites already pass an explicit config, which
    is exactly what upstream's `.../dispatch/web` entry requires, so the swap
    changes no behavior — and on Node the same `AsyncLocalStorage` instance is
    still installed by `@langchain/langgraph`'s main entry.
  - **Every request after the first threw** `Cannot perform I/O on behalf of a
different request`. On workerd an `AbortController` is an I/O object owned by
    the request that constructed it, and the runtime handler is necessarily
    constructed inside request one because global scope refuses to construct one at
    all — so a handler-scoped shutdown controller limited an isolate to exactly one
    request. The shutdown signal is now minted per request, with `close()` aborting
    the live set and every "are we shutting down?" check reading a plain value.
    Node semantics are unchanged: the same abort, and the same drain across
    in-flight requests, the run registry, and pending store disposals.
  - **The model had no credential.** A turn returned HTTP 200 carrying a
    well-formed stream whose only content was a missing-credentials run error:
    `OPENAI_BASE_URL` already went through the runtime-env seam, but each provider
    package reads its API key off `process.env`, and there is no `process` on
    workerd. `createChatModel` now resolves each provider's key through the same
    seam — a no-op on Node, where the seam prefers `process.env`.

  Two tests come with them. The gated `edge-workerd` lane drives four sequential
  AG-UI turns through the emitted artifacts under `wrangler dev --local` against
  Postgres, asserting on the reply text rather than the status, because a dead
  model wiring still answers 200. Its cheap ungated counterpart bundles the emitted
  `app.mjs` the way `wrangler` does — Workers export conditions, nothing external
  but `node:` itself — and requires zero `node:` specifiers; the existing purity
  gate externalizes `@langchain/*`, which is precisely why the first defect above
  reached the runtime unseen.

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

- c2c19da: The compiled-graph cache now honors a per-request checkpointer. `createReactAgent`
  embeds the checkpointer in the graph it returns, and the cache was keyed on the
  agent descriptor alone — so on a runtime that builds stores per request, every
  request after the one that first materialized a route ran its graph against that
  first request's checkpointer, which had since been disposed. On Cloudflare workerd
  a connection is bound to the I/O context of the request that opened it, so this
  would have hung for ~30s on alternating requests.

  The key is now the pair (descriptor, checkpointer). Node behavior is unchanged: an
  app with one boot-resolved checkpointer still compiles each agent's graph once per
  process. Because a request's stores are built and disposed together, keying on the
  checkpointer also rebinds the tools that close over that request's permissions and
  memory stores.

- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
  - @dawn-ai/core@0.8.21
  - @dawn-ai/sdk@0.8.21
  - @dawn-ai/workspace@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/core@0.8.20
- @dawn-ai/sdk@0.8.20
- @dawn-ai/workspace@0.8.20

## 0.8.19

### Patch Changes

- Updated dependencies [9dde7c6]
  - @dawn-ai/core@0.8.19
  - @dawn-ai/sdk@0.8.19
  - @dawn-ai/workspace@0.8.19

## 0.8.18

### Patch Changes

- c6b08a9: Add keyed, parent-owned subagent delegation policies with fail-closed
  constraints and approval. Subagents now run as native resumable LangGraph
  subgraphs, and interrupt resume uses one complete multi-entry request envelope.

  This intentionally removes array-form subagent registration, tool policy on
  the internal `task` mechanism, and scalar interrupt resume. Confirm the fixed
  0.x patch release intent with Brian before release.

- Updated dependencies [c6b08a9]
  - @dawn-ai/sdk@0.8.18
  - @dawn-ai/core@0.8.18
  - @dawn-ai/workspace@0.8.18

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
- Updated dependencies [7f4bce6]
- Updated dependencies [1a9ae7b]
  - @dawn-ai/core@0.8.17
  - @dawn-ai/sdk@0.8.17
  - @dawn-ai/workspace@0.8.17

## 0.8.16

### Patch Changes

- d845720: Runtime edge-readiness (deploy-anywhere B3, PR 1 of 3).

  New `@dawn-ai/cli/fetch` entry exposes the web-standard runtime with a module
  graph that contains none of Dawn's own filesystem, SQLite, or CLI code —
  enforced by an esbuild-metafile test that also pins the remaining upstream
  `node:` edges so the set can only shrink.

  `serveRuntime`/`startRuntimeServer`/`createRuntimeFetchHandler` now accept an
  injected checkpointer, threads store, permissions store, memory store,
  middleware, and a `DawnConfig` object (`seedDawnConfig`). With everything
  supplied, nothing reads `dawn.config.ts` or opens SQLite — including subagent
  turns, which previously rebuilt their own stores. On the injected path a
  missing store fails loudly at boot instead of silently falling back.

  Capability markers read through a new sync `MarkerFs` facade (node
  implementation behind `@dawn-ai/core/node`), the subagents descriptor map is
  derived from the static module manifest with no dynamic imports, the manifest
  now carries `src/middleware.ts`, and `@dawn-ai/memory` gained pure
  `./namespace` and `./reconcile` subpaths. Behavior with nothing injected is
  unchanged.

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).
- Updated dependencies [d845720]
- Updated dependencies [2da55fa]
  - @dawn-ai/core@0.8.16
  - @dawn-ai/sdk@0.8.16
  - @dawn-ai/workspace@0.8.16

## 0.8.15

### Patch Changes

- Updated dependencies [029a2cf]
  - @dawn-ai/core@0.8.15
  - @dawn-ai/sdk@0.8.15
  - @dawn-ai/workspace@0.8.15

## 0.8.14

### Patch Changes

- Updated dependencies [937be0f]
- Updated dependencies [83e5153]
  - @dawn-ai/core@0.8.14
  - @dawn-ai/sdk@0.8.14
  - @dawn-ai/workspace@0.8.14

## 0.8.13

### Patch Changes

- 20f0407: Consolidate the existing `@dawn-ai/ag-ui` package as Dawn's pure canonical AG-UI
  adapter. Its root API now maps standard `RunAgentInput` requests and Dawn stream
  chunks, including standard interrupt outcomes and addressed resume decisions,
  while the focused `@dawn-ai/ag-ui/sse` subpath provides event-stream encoding
  without taking ownership of a server or runtime transport.

  The CLI AG-UI endpoint now uses the canonical adapter, applies the same request
  projection as other runtime middleware, and emits canonical events without the
  former custom state event shapes. Pending checkpoint interrupts are resolved
  through the standard resume contract.

  The langchain adapter surfaces each tool invocation's `run_id` on its
  `tool_call` and `tool_result` chunks, and the CLI preserves those IDs through
  Dawn and AG-UI streams for reliable `toolCallId` correlation. Local in-process
  `dawn run` also assigns agent routes a one-shot thread ID so the default SQLite
  checkpointer can execute the same route shape supported by `dawn dev`.

- 5bbd6e3: Add a `recursionLimit` option to `agent()`. It maps to LangGraph's per-run
  super-step ceiling (default 25), so deep agents — a coordinator that dispatches
  subagents and makes many tool calls — can raise the limit instead of aborting
  with a recursion error.
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
  - @dawn-ai/core@0.8.13
  - @dawn-ai/workspace@0.8.13

## 0.8.12

### Patch Changes

- Updated dependencies [e413b05]
  - @dawn-ai/core@0.8.12
  - @dawn-ai/sdk@0.8.12
  - @dawn-ai/workspace@0.8.12

## 0.8.11

### Patch Changes

- @dawn-ai/core@0.8.11
- @dawn-ai/sdk@0.8.11
- @dawn-ai/workspace@0.8.11

## 0.8.10

### Patch Changes

- @dawn-ai/core@0.8.10
- @dawn-ai/sdk@0.8.10
- @dawn-ai/workspace@0.8.10

## 0.8.9

### Patch Changes

- d3d94af: Argument-level tool constraints: `agent({ tools: { constrain: { deployProd: (args, ctx) => … } } })` runs a per-tool predicate against the model's arguments at call time, returning allow / deny-with-reason / `{ approve: true }` (escalate to the HITL prompt). Predicates may be async and receive a read-only policy context; a throwing or off-contract predicate fails closed. The tool run context now also carries the live `threadId` + route params. `dawn check` validates `constrain` tool names and warns on `approve`/`constrain` overlap.
- ca9bc13: Add `@dawn-ai/memory-pgvector` — a Postgres + pgvector MemoryStore backend for
  production/multi-instance vector memory. Enable with
  `memory: { store: pgvectorMemoryStore({ connectionString, dimensions }) }`. HNSW
  (cosine) vector retrieval; reuses the exact same pure hybrid ranking (RRF +
  recency/confidence) as the default sqlite backend, so recall ordering is
  identical across backends. Adds a shared `runMemoryStoreConformance` kit
  (@dawn-ai/testing) run against both backends. Dimensions ≤2000 use `vector`,
  ≤4000 use `halfvec` (text-embedding-3-large); pgvectorscale/DiskANN and in-SQL
  RRF are deferred. Also pins `openaiEmbedder` to float embedding encoding
  (`encodingFormat: "float"`) — avoids a base64 decode interop quirk that could
  yield wrong embedding dimensionality against some proxies/mocks.
- 1dd2147: Opt-in vector/semantic recall for long-term memory. Enable with
  `memory: { vector: { embedder: openaiEmbedder() } }`: recall becomes hybrid —
  keyword (IDF) and vector (cosine) candidate lists fused co-equally by Reciprocal
  Rank Fusion, with a bounded recency/confidence second stage. Keyword recall is
  never dropped (dense retrieval is weak on exact IDs/codes/names), and default
  keyword-only recall is unchanged. Pluggable `Embedder` (`openaiEmbedder`,
  `fakeEmbedder`); embeddings stored as Float32 BLOBs in the existing node:sqlite
  store (zero new native deps), tagged by embedder id with graceful keyword-only
  fallback on model change. pgvector is a planned follow-up backend.
- Updated dependencies [d3d94af]
- Updated dependencies [628f0c1]
- Updated dependencies [1dd2147]
  - @dawn-ai/sdk@0.8.9
  - @dawn-ai/core@0.8.9
  - @dawn-ai/workspace@0.8.9

## 0.8.8

### Patch Changes

- Updated dependencies [dd02f56]
- Updated dependencies [5ccae68]
- Updated dependencies [57e8cd9]
  - @dawn-ai/core@0.8.8
  - @dawn-ai/workspace@0.8.8
  - @dawn-ai/sdk@0.8.8

## 0.8.7

### Patch Changes

- Updated dependencies [6a683c8]
  - @dawn-ai/core@0.8.7
  - @dawn-ai/sdk@0.8.7
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
- Updated dependencies [1d51b75]
  - @dawn-ai/workspace@0.8.6
  - @dawn-ai/core@0.8.6
  - @dawn-ai/sdk@0.8.6

## 0.8.5

### Patch Changes

- Updated dependencies [f195096]
  - @dawn-ai/core@0.8.5
  - @dawn-ai/sdk@0.8.5
  - @dawn-ai/workspace@0.8.5

## 0.8.4

### Patch Changes

- Updated dependencies [4e3e020]
  - @dawn-ai/core@0.8.4
  - @dawn-ai/sdk@0.8.4
  - @dawn-ai/workspace@0.8.4

## 0.8.3

### Patch Changes

- Updated dependencies [2744a5c]
- Updated dependencies [7339ded]
  - @dawn-ai/core@0.8.3
  - @dawn-ai/sdk@0.8.3
  - @dawn-ai/workspace@0.8.3

## 0.8.2

### Patch Changes

- @dawn-ai/core@0.8.2
- @dawn-ai/sdk@0.8.2
- @dawn-ai/workspace@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [89b2a73]
  - @dawn-ai/workspace@0.8.1
  - @dawn-ai/core@0.8.1
  - @dawn-ai/sdk@0.8.1

## 0.8.0

### Minor Changes

- Unknown model ids now get advisory warnings instead of late provider 404s. `dawn check`/`verify` warn (exit code unchanged) when an agent route's `model` isn't in the curated list for its resolved provider (`openai`, `google`, `anthropic`, `xai`), with did-you-mean suggestions; the runtime prints the same `[dawn:models]` advisory once per model at chat-model construction. Curated lists are values now (`CURATED_MODEL_IDS` etc.) with types derived, Anthropic and xAI ids included; `validateModelId` and `inferProvider` are exported from `@dawn-ai/sdk`. Note: the narrow `GoogleModelId` union dropped the vendor-retired `gemini-3-pro-preview` (replaced by `gemini-3.1-pro-preview`).

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.7.0

### Patch Changes

- Updated dependencies [917a99f]
- Updated dependencies [a38ff61]
- Updated dependencies [fa8bdd4]
  - @dawn-ai/workspace@0.3.0
  - @dawn-ai/core@0.7.0
  - @dawn-ai/sdk@0.7.0

## 0.6.0

### Patch Changes

- @dawn-ai/core@0.6.0
- @dawn-ai/sdk@0.6.0
- @dawn-ai/workspace@0.2.0

## 0.5.0

### Patch Changes

- b6e71a7: Tool-output offload stubs now show a readable multi-line preview when the offloaded content is a single-line JSON blob (e.g. a tool that returned an object, whose newlines were escaped). `buildStub` pretty-prints JSON for the preview slice only — the stored file, its content hash, the size threshold, and the tool message content are all unchanged. Plain-text outputs are unaffected.
  - @dawn-ai/core@0.5.0
  - @dawn-ai/sdk@0.5.0
  - @dawn-ai/workspace@0.2.0

## 0.4.0

### Patch Changes

- @dawn-ai/core@0.4.0
- @dawn-ai/sdk@0.4.0
- @dawn-ai/workspace@0.2.0

## 0.3.0

### Minor Changes

- 8133553: Add opt-in conversation summarization (Phase 3 sub-project 6b). When a thread's history exceeds a token threshold, the agent is fed a condensed view — a running summary of older turns plus the most recent turns verbatim — while the **full history stays intact in the checkpoint**. This is non-destructive: summarization runs as a LangGraph `preModelHook` that returns `llmInputMessages` for the turn only and never rewrites saved `messages`, so `GET /threads/:id/state`, resume, and restart always see the complete history (and there is no tool-call/result pairing hazard).

  Enable it in `dawn.config.ts`:

  ```ts
  export default {
    summarization: {
      enabled: true, // default false
      maxTokens: 12_000, // threshold over which older turns are summarized
      keepRecentTurns: 6, // most-recent turns kept verbatim
      // model defaults to the route's model
      // tokenCounter defaults to a lazy gpt-tokenizer (o200k_base) counter
      // summarize defaults to a built-in single-LLM-call running-summary fold
    },
  };
  ```

  Both the token counter and the summarizer are pluggable (`tokenCounter`, `summarize`). The running summary is cached in agent state and refreshed incrementally — each turn folds only the newly-aged messages, so cost stays bounded. The turn-boundary split is pairing-safe (a tool-call message is never separated from its results). When summarization is disabled (the default), behavior is unchanged and `gpt-tokenizer` is never loaded. If the summarizer call fails on a given turn, the agent falls back to the full history for that turn rather than failing the run.

- 027b1cc: Add tool-output offloading. When a tool returns output larger than `toolOutput.offloadThresholdChars` (default 40,000), the full payload is written to `workspace/tool-outputs/` and the in-context ToolMessage is replaced with a preview+pointer stub; the agent retrieves the full content with the existing `readFile` tool (which bypasses the size cap for `tool-outputs/` paths). Active automatically when a workspace exists. The directory is bounded by a size + TTL cap (defaults 256MB / 3h) with throttled evict-on-write and LRU-by-access eviction (readFile bumps mtime for tool-outputs/ files). Large content never enters message state, so there is no tool-call/result pairing hazard. Configurable via `dawn.config.ts` `toolOutput`. The `FilesystemBackend` interface gains optional `statFile`/`removeFile`/`touchFile`/`mkdir` methods and an optional per-call `maxBytes` override on `readFile`.

### Patch Changes

- 30db6ed: Offloaded tool-output filenames are now deterministic — keyed on the originating `tool_call_id` (with a content-hash fallback when absent) instead of `timestamp+random`. This makes offloaded paths stable and traceable and enables deterministic agent e2e tests. The openai chat model now also honors `OPENAI_BASE_URL`, allowing a local mock provider (used by the new CI-safe aimock-based agent e2e regression tests for the discriminated-union tool-input and tool-output-offload-retrieval paths).
- b51de58: Add `@dawn-ai/testing` — a productized, aimock-backed package for writing deterministic, CI-safe tests of Dawn agents.

  The model is mocked at the HTTP wire via `@copilotkit/aimock`, so tests exercise the real agent loop, tool calls, streaming, state, offloading, and summarization without a live API key. Three layers, one package:

  - **In-process (default):** `createAgentHarness({ appRoot, route })` runs your route through Dawn's runtime; the fastest layer and the one most users reach for.
  - **http-inject:** `injectAgentProtocol({ appRoot })` drives the full Agent-Protocol request→response pipeline in-process via `light-my-request` (no port bound) — for framework/SSE coverage.
  - **subprocess:** `startSubprocessApp({ appRoot })` boots a real `dawn dev` — for restart/persistence scenarios.

  A fluent `script()` builder compiles multi-turn tool-call conversations to aimock fixtures (auto `turnIndex`/`hasToolResult`, fixed `tool_call_id`s), and `expect*` matchers assert agent behavior: `expectToolCalled().withArgs()`, `expectFinalMessage()`, `expectStreamedTokens()`, `expectState().field()`, `expectOffloaded()`. A local-only `record()` helper captures real interactions into fixtures (CI replays strict/read-only).

  `@dawn-ai/cli` gains a `@dawn-ai/cli/runtime` programmatic export subpath (`streamResolvedRoute`, `createRuntimeRegistry`, `runTypegen`, `createRuntimeRequestListener`, …) and `buildOffload` now resolves the workspace relative to the app root (no behavior change under `dawn dev`, where cwd is the app root).

  `@dawn-ai/langchain` fixes a bug where the streamed `tool_call` event carried `undefined` tool arguments — `on_tool_start` now reads `event.data.input` (the field LangChain populates with tool args), so stream consumers (e.g. UI tool-call displays) receive the real arguments.

  Dawn's own aimock e2e lane (SP5 union schema, SP6a tool-output offloading, conversation summarization) was migrated onto this package in-process, removing the per-test `pnpm pack` + install + dev-server boot.

- Updated dependencies [55b69f0]
- Updated dependencies [2e3bc8d]
- Updated dependencies [8133553]
- Updated dependencies [027b1cc]
- Updated dependencies [d4efa2a]
  - @dawn-ai/core@0.3.0
  - @dawn-ai/workspace@0.2.0
  - @dawn-ai/sdk@0.3.0

## 0.2.0

### Minor Changes

- ad17e85: Upgrade `@langchain/core` (0.3 → 1.x), `@langchain/langgraph` (0.2 → 1.x), `@langchain/openai` (0.3 → 1.x), and `zod` (3 → 4). Removes the dual-zod-version cast workaround in `tool-converter.ts`; `DynamicStructuredTool` now accepts Standard Schema directly. Downstream consumers must align on the new peer ranges (`@langchain/core >=1.1.0`).
- cfc3e8c: Add Agent Protocol HTTP endpoints backed by a Dawn-native SQLite checkpointer (phase-3 sub-project 7).

  - New `@dawn-ai/sqlite-storage` package: `sqliteCheckpointer` (a `BaseCheckpointSaver` over Node's built-in `node:sqlite`, no native deps) and `createThreadsStore`. Requires Node 22.13+ (where `node:sqlite` is available without the `--experimental-sqlite` flag).
  - `dawn.config.ts` gains `checkpointer` and `threadsStore` fields — both pluggable, with SQLite-backed defaults at `.dawn/checkpoints.sqlite` and `.dawn/threads.sqlite`.
  - The dev server's HTTP layer is reshaped to the Agent Protocol: `POST /threads`, `GET`/`DELETE /threads/{id}`, `POST /threads/{id}/runs/stream`, `POST /threads/{id}/runs/wait`, `GET /threads/{id}/state`, `POST /threads/{id}/resume`. The legacy `POST /runs/stream` is removed.
  - Conversation state and permission interrupts now survive a server restart. `MemorySaver` is removed from `@dawn-ai/langchain`; the checkpointer is supplied by the caller. Permission resume is state-based (reads the parked interrupt from the checkpoint) and resolves the route durably from thread metadata.

- c777569: Support nested structures in tool input schemas: nested objects, arrays of objects, `Record<string,T>` maps, and object unions (arbitrary depth, capped at 8 levels). Previously any non-flat input type was silently coerced to `string` in both the generated JSON Schema and the runtime Zod schema. Schemas are emitted fully inlined (no `$ref`); `Record` maps and object unions are incompatible with provider strict mode (documented), which Dawn does not currently enable.
- 34e615b: Add the first phase-3 harness capability: planning. A `plan.md` file in a route directory now opts the agent into a built-in `write_todos` tool, a `todos` state channel, a Dawn-locked planning prompt fragment, and a `plan_update` SSE event. Introduces `CapabilityMarker` and `applyCapabilities` in `@dawn-ai/core` — the autowiring spine that all later phase-3 capabilities (skills, subagents, etc.) will reuse.
- affeb46: Capability tools can now mutate state channels via a Dawn-native `{result, state}` wrapped return shape — `result` becomes the agent-visible ToolMessage; `state` is a partial channel update applied via reducers. The langchain bridge translates this into a LangGraph `Command({update})` internally; capability authors don't import from `@langchain/langgraph`. Plain tool returns (anything not matching the strict wrapper shape) work unchanged.

  Planning's `write_todos` adopts the new shape, fixing the previously-documented re-emission loop: the `todos` state channel now actually reflects the agent's writes between turns, so the agent stops re-calling `write_todos` with the same content. The `plan_update` stream transformer also reads defensively from both legacy and Command-shaped tool outputs so the SSE event keeps firing.

- 1005b3a: Add provider-aware agent materialization. Agent configs can now carry an optional `provider`, and the LangChain runtime infers providers for known model families or lazy-loads the explicit provider integration package for built-in provider IDs.
- e8462db: `agent({...})` now accepts an optional `reasoning: { effort }` field. Maps to OpenAI's `reasoningEffort` parameter (`none | minimal | low | medium | high | xhigh`). Non-reasoning models silently ignore it. Useful for tool-use-heavy agents that aren't following directives at the default reasoning depth.

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.
- Updated dependencies [17fa4aa]
- Updated dependencies [82dd52f]
- Updated dependencies [8e02fe1]
- Updated dependencies [cfc3e8c]
- Updated dependencies [dd242ac]
- Updated dependencies [c777569]
- Updated dependencies [34e615b]
- Updated dependencies [2ba0773]
- Updated dependencies [affeb46]
- Updated dependencies [12ee95f]
- Updated dependencies [1005b3a]
- Updated dependencies [e8462db]
  - @dawn-ai/core@0.2.0
  - @dawn-ai/sdk@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [8c63c1a]
  - @dawn-ai/sdk@0.1.8

## 0.1.7

### Patch Changes

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

- Updated dependencies [db635b1]
- Updated dependencies [db635b1]
- Updated dependencies [db635b1]
  - @dawn-ai/sdk@0.1.7

## 0.1.6

### Patch Changes

- @dawn-ai/sdk@0.1.6

## 0.1.5

### Patch Changes

- 0127c57: Fix tool schema wiring so OpenAI receives valid function parameters from codegen-generated tools.json
  - @dawn-ai/sdk@0.1.5

## 0.1.4

### Patch Changes

- @dawn-ai/sdk@0.1.4

## 0.1.3

### Patch Changes

- @dawn-ai/sdk@0.1.3

## 0.1.2

### Patch Changes

- @dawn-ai/sdk@0.1.2

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.
- Updated dependencies [5c18b2d]
  - @dawn-ai/sdk@0.0.2

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.

- Updated dependencies [0f32260]
  - @dawn-ai/sdk@0.0.1
