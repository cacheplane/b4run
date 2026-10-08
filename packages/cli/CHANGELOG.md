# @dawn-ai/cli

## 0.14.0

### Patch Changes

- b006a95: Every `TOOL_CALL_START` B4.run sends now carries `parentMessageId`: the id of the model message that announced the call — the id that message's `TEXT_MESSAGE_*` events use when it streamed text, a fresh one when it only called tools, the subagent's own message for a subagent's call. A chat host that builds its message list from AG-UI events now gets an assistant message during a tool-only phase, and keeps a model message's text and calls together. `eventsFromState` (and so `GET /threads/:id/events`) files replayed calls the same way, under the checkpointed AIMessage's id. The langchain adapter's `tool_call` and `tool_call_args` chunks carry the model invocation as `data.messageId`, and the CLI's `tool_call` stream chunk carries it as `messageId`. `mergeTurnMessages` (and so `useB4ChatSlots`) still renders one activity per turn: the turn's first assistant message with tool calls holds every call of the turn, after its text when it has some.

  `turnForMessage` and `<b4-message-activity [messages]>` accept messages that list their tool calls as `toolCallIds: string[]` as well as AG-UI's `toolCalls: { id }[]` (`toolCallIds` is read when `toolCalls` is absent); `@b4run/ag-ui/view` exports `toolCallIdsOf`.

  `@b4run/ag-ui/view` exports `toResumeEntries(decisions, interrupts)`: the AG-UI `resume` entries for approval decisions, `once`/`always` resolved with that payload, `deny` cancelled, each interrupt's grant at `metadata.grant`. It returns `{ ok: false, reason: "undecided" }` until every parked interrupt is decided, since B4.run resumes only when all of them are answered. `B4ApprovalDecision` (`@b4run/ag-ui/angular/events`) is now an alias of the view's `InterruptDecision`.

- d0bb6a1: A parked call keeps its running label after a reload. When a permission gate (tool, command, path or memory) parks a call whose tool has a `display`, the interrupt envelope now carries `step: { icon, label }`, the `display.running` label and icon the runtime streamed as the call's `running` `b4.step`. The envelope is checkpointed with the interrupt, so `GET /threads/:id/turns`, `/events` and `/pending_interrupts` return it, and AG-UI clients find it at `metadata.step`. `eventsFromState` replays it as the parked call's `running` step, so a restored awaiting step shows the same label and icon as the live run, and the approval card reads "The agent wants to file N738ZU KSTP to KRST" instead of "wants to use fileFlightPlan". The field is additive; an interrupt parked before this release restores as before. Tool run contexts carry the display as `step`.
- e6cfa3d: Restore a CopilotKit chat from B4's storage. `GET /threads/:thread_id/events` replays a thread as the AG-UI events its live runs carried (`eventsFromState` in `@b4run/ag-ui/view`), behind the same gate as `/turns` (new `thread.events` operation). `@b4run/ag-ui/copilotkit-runtime` adds `createB4AgentRunner(InMemoryAgentRunner, { url, fetch })`, which builds a CopilotKit runtime runner whose `connect` replays it, so a reload, a restart or another instance restores the chat, its activity and a parked approval.
- 29acd56: **Breaking:** `GET /threads/:thread_id/state` reports `created_at` as the checkpoint's time instead of the request time. New `GET /threads/:thread_id/turns` rebuilds a thread's activity turns (`@b4run/ag-ui/view`'s `TurnsView`) from its checkpoints, parked interrupts embedded, gated like `/pending_interrupts`; a denied call restores as a `denied` step, not a failed one. `ThreadOperation` gains `thread.turns`. Threads from releases before the `b4_step`/`b4:turn` stamps do not restore.
- 1180d4c: **Breaking:** every tool call now returns a `ToolMessage` whose `additional_kwargs.b4_step` is complete (`status`, `startedAt`, `settledAt`, the gate `decision`, and the display's icon, label and sources), display or not; the `task` tool returns a `ToolMessage` (not a string) carrying `b4_step` and `b4_subagent` with the child's checkpoint namespace; a thrown tool's error message is built by the converter with a `failed` step, and a branded denial persists as a `denied` step (with `decision: "deny"`) on a `success` ToolMessage — not a failure, so a denied `returnDirect` call still ends the run with the denial as its result. Raw `GET /threads/:id/state` readers see the new keys. Permission gates report `once | always | deny` into the tool context (`onGateDecision`). The runtime stamps `b4:turn` (`done | failed | stopped`, `error`, `endedAt`) on the head checkpoint's metadata when a run ends (never on a parked head, only on a head the turn wrote), and both checkpointers gain `listNamespaces(threadId)`.

  `@b4run/ag-ui/view` gains `turnsFromState(input)`: rebuild a thread's `TurnsView` from its checkpoint history and parked interrupts by synthesising the AG-UI events the live stream would have carried and folding them through the unchanged `reduceTurns`; output carries `warnings` for ignored stamps. `GET /threads/:id/turns` serves it in the next release. Threads written before these stamps do not restore.

- 52b19ec: A new `b4.config.ts` option, `agentsMd: { writable: false }`, presents `workspace/AGENTS.md` to agent routes as read-only project guidance instead of agent memory. The injected block is headed `# Project guidance`, says the file is maintained by the app's authors, and tells the model not to modify it, in place of the default `# Memory` header's `writeFile` instruction. The over-64 KiB notice uses the same header. The default (`writable: true`, or no `agentsMd`) is unchanged. The option changes only the prompt; enforce it with a `FilesystemMiddleware` over `backends.filesystem` that refuses writes to `AGENTS.md`, and deny or gate `runBash` for routes that can reach the workspace, since a shell command bypasses that middleware.

  `b4 check` and route preparation validate the option through one resolver and reject, with the new `B4_E1010` (Invalid agentsMd config), an `agentsMd` that isn't an object (`agentsMd: false` included), an unknown key in it such as `writeable`, and a non-boolean `writable`, so a misspelled or mistyped key inside `agentsMd` is an error rather than silently leaving the file writable. `CapabilityMarkerContext` gains `agentsMd?: { writable: boolean }`, which the agents-md marker reads.

- 6b7f152: Advertise a route's AG-UI capabilities. `GET /agui/:routeId` returns an AG-UI `AgentCapabilities` document — client-provided tools, structured output, interrupts and approvals — computed by the same checks `POST` enforces, behind the same route middleware. `@b4run/ag-ui/client` adds `B4HttpAgent`, an `HttpAgent` whose `getCapabilities()` reads it, so CopilotKit's `/info` reports them; `@ag-ui/client` is an optional peer dependency for that subpath.
- 2c33a3f: `GET /agui/:routeId` now reports a `multimodal` section for an `agent()` route: `input.image`, `input.pdf`, `input.audio` and `input.video` come from the route model's LangChain profile with the provider's converter limits — the same judgment that keeps or drops each part at run time — and `image`/`pdf` describe the inline `data` source (URL support varies by provider and is reported by the dropped-parts warning). `input.file` and `output` are always `false`. The section is omitted for a raw runnable, a chain/graph/workflow route, or a provider package that is missing or cannot be read; the rest of the document is unaffected. `@b4run/langchain` exports `readModelProfile`, which reads a model's profile off its provider class without constructing it.

  Client-provided tool results may carry content parts. A `role: "tool"` answer's parts are stored as sent and replayed to the model under the tool-result rules; the UI gets every part on `TOOL_CALL_RESULT`. A call closed by the abandon path replays the stored result as its text and logs a warning. The 64 KiB result cap is measured on text/JSON with inline media bytes excluded.

  - `ClientToolCallRecord.result` and `ClientToolCallStore.answer`'s `result` widen from `string` to `B4MessageContent` (`@b4run/sdk`); `ClientToolResumeValue.clientToolResult` widens the same way (`@b4run/core`). A custom store must keep and return parts.
  - `@b4run/sdk` exports `encodeClientToolResult`/`decodeClientToolResult`: a part list is kept in the existing text column as a self-describing JSON envelope. Text results, including rows written before this release, are stored and read back unchanged; no migration. A rollback to an earlier release reads a stored part-list result as its JSON envelope text; resume or abandon such calls before downgrading. The SQLite and Postgres stores use the codec and gained a direct `@b4run/sdk` dependency.
  - The dropped-parts warning again ends by pointing at `GET /agui/<route>` for what the route accepts.

- ed43d4f: Carry AG-UI 1.0 content parts to the model. A user message's `image`, `audio`, `video` and `document` parts — inline, by URL, or as a provider file handle — reach the route's model as LangChain content blocks; what the model cannot take (read from its LangChain profile) is dropped and announced, in the server log and on the stream as `CUSTOM` `b4.content_parts_dropped`, never refused: the `422` envelope rejection of media parts is gone. Tools may return `B4ContentPart[]` (new in `@b4run/sdk`), which travels as `TOOL_CALL_RESULT.content`. The Agent Protocol run endpoints now bound their bodies at the same 8 MiB as `/agui`. `B4Message.content` (`@b4run/ag-ui`), `UnwrappedToolResult.content` (`@b4run/langchain`) and `MiddlewareAfterMessage.content` (`@b4run/sdk`) widened from `string` to `string | readonly B4ContentPart[]`, and chain, graph and workflow routes now receive `messages[].content` as that part array whenever the client sent parts (previously flattened to text), so code that narrows on `string` must handle the array.
- 2d07889: Serve the AG-UI HTTP+protobuf binding. `POST /agui/:routeId` answers `application/vnd.ag-ui.event+proto` — 4-byte big-endian length-prefixed protobuf frames — whenever the request's `Accept` admits it with a positive quality (named, or through a wildcard such as `*/*`), and `text/event-stream` otherwise; `@ag-ui/client` and CopilotKit name SSE and are unaffected. `GET /agui/:routeId` advertises `transport.httpBinary`, `reasoning: { supported: false }` and `state: { snapshots: false, deltas: false }` plus `persistentState` where B4.run wires the checkpointer (`true` for `agent()` routes, `false` for chain, graph and workflow routes, omitted otherwise).

  **Breaking:** `@b4run/ag-ui/sse` no longer exports `encodeAgUiSse(event, accept): string`. Use `encodeAgUiEvent(event, accept): Uint8Array<ArrayBuffer>` for the frames and `agUiContentType(accept): string` for the header; both follow one negotiation rule. Unlike `encodeAgUiSse`, which wrote SSE whatever `accept` said, `encodeAgUiEvent` writes protobuf when `accept` admits it (including `*/*`): set `content-type` from `agUiContentType(accept)`, or call `encodeAgUiEvent(event)` without `accept` to keep SSE unconditionally. The bump is `patch` by the fixed-group 0.x convention. HTTP clients that do not name `text/event-stream` — `curl`, or `fetch` without an `accept` header, both of which send `*/*` — now receive protobuf from `POST /agui/:routeId`; send `accept: text/event-stream` to keep SSE.

- 5caad96: **Breaking:** `agent()`'s `reasoning` is keyed by provider. `reasoning: { effort }` becomes `reasoning: { openai: { effort } }`; a flat `effort`, an unknown key, or a block for a provider the route does not resolve to now fails the route when its model is built (before, a misplaced setting was silently ignored — and the OpenAI effort itself never reached the request, because it was passed as the constructor field `reasoningEffort`, which `@langchain/openai` reads only per call). New controls make reasoning visible: `openai.summary: "auto" | "concise" | "detailed"` streams a reasoning summary (and moves the route to the Responses API); `anthropic.budgetTokens` enables extended thinking. The langchain adapter carries thinking and reasoning blocks as `reasoning` stream chunks; `@b4run/ag-ui` frames them as AG-UI 1.0 `REASONING_START` / `REASONING_MESSAGE_*` / `REASONING_END`, one span and one `role: "reasoning"` message per model invocation, every one closed before the run ends. `GET /agui/:routeId` advertises `reasoning: { supported: true, streaming: true, encrypted: false }` exactly when the route's config makes reasoning stream, `{ supported: false }` otherwise. `IdFactory` gains the `reasoning` and `reasoningSpan` kinds.

  `@b4run/testing`'s `finalMessage` now reads an assistant message whose `content` is a list of blocks (the OpenAI Responses API, Anthropic with tools bound), joining its `text` blocks; before, such a run reported an empty final message.

- 0cd999a: **Breaking (Agent Protocol stream):** a subagent's events now carry the same shapes as the root's. `subagent.message { chunk }` is replaced by `subagent.token { data, messageId }`; `subagent.tool_call` / `subagent.tool_result` carry `name` under the model's tool-call `id` instead of `tool` under an execution run id; new `subagent.reasoning`, `subagent.message_end` and `subagent.tool_call_args`; `subagent.start` gains `parent_call_id` (nested children) and `description`. The langchain adapter announces a child's tool calls from its own model turn with the same per-owner bookkeeping root uses, the dev server's attach digest coalesces `subagent.token` per child invocation, `@b4run/testing` reads the new shapes, and `@b4run/ag-ui` consumes them at the activity boundary with no change on the AG-UI wire (the `SUBAGENT_*` presentation follows in the next release).
- 0b33206: **Breaking:** subagents are presented with AG-UI 1.0's `SUBAGENT_STARTED/FINISHED/ERROR` events and `subagentRunId` attribution; the `b4.subagent` activity is removed. `toAguiEvents` announces a subagent when the `task` tool starts it (`subagentRunId` is the `task` tool-call id; `parentToolCallId`, `parentSubagentRunId` and `description` are carried), tags the child's text, reasoning, tool calls, results, usage and plan with that id, and closes every announced invocation before the run ends — `SUBAGENT_FINISHED { result }` on success, `{ outcome: suspended, interruptIds }` at a child's interrupt (the interrupt carries the child's `subagentRunId`), `SUBAGENT_ERROR` on failure, cancel (`code: "cancelled"`) or a stream that ended first (`code: "unterminated"`). The `task` call is an ordinary tool call again. Removed: `B4_SUBAGENT_ACTIVITY_TYPE`, `B4SubagentActivityContent`, `SubagentActivityCard`, `b4SubagentActivityRenderer`, `subagentActivityContentSchema`, `SubagentActivityContentOutput`; `b4ActivityRenderers` holds the plan renderer only. New in `@b4run/ag-ui/react`: `useSubagentRuns(agent)`, `reduceSubagentRuns`, `EMPTY_SUBAGENT_RUNS`, `isSubagentMessage`, `SubagentPanel` and the `SubagentRun` types. `GET /agui/:routeId` advertises `multiAgent: { supported, delegation, handoffs: false, subagents: [{ name, description }] }` from the subagent registry the `task` tool dispatches from. The research example, the research scaffold and the chat web client render subagents with the panel.
- 61e5922: Approval grant records are now pruned. Every `InterruptGrantStore` gains `prune({ before })`, which deletes records whose `voidedAt` is before `before` and nothing else. `voidOutstanding` now also voids consumed grants whose prompt the thread moved past (every unvoided row of the thread not in the keep list), so a consumed grant is voided once its resumed turn completes and ages out from there; a consumed grant whose resume never completed, and an outstanding grant however old, are never deleted: in both cases the prompt is still parked, and a parked prompt with no grant row resumes without a grant under `approvals.grants: "optional"`. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement both; a custom store must match.

  `approvals.grantStore` is now shape-checked at boot while grants are on: a store missing any method, `prune` included, fails the boot naming the missing methods. A custom store written before this release must add `prune`.

  The runtime sweeps the store wherever it voids superseded grants, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `approvals.grantRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot). `b4 approvals prune [--retention <ms>]` runs the same pass by hand.

- b25fc3b: A route can require approval on every call of a tool, with no standing approval possible: write the `tools.approve` entry as `{ tool: "fileFlightPlan", allowAlways: false }` instead of the bare name (bare names keep today's behavior, and the two forms mix in one list). For such a tool every call prompts in interactive mode even when the permission store holds an allow rule for it, the interrupt envelope carries `allowAlways: false`, and the AG-UI interrupt advertises `responseSchema.enum: ["once", "deny"]`, so the activity kit's approval card offers only Allow once and Deny. A client that answers `always` anyway gets `once`: the call runs, nothing is persisted, and the step records `once`. Bypass mode still allows and a deny rule still denies; non-interactive mode and contexts without interrupts fail closed, an allow rule notwithstanding, so a headless run of such a tool needs bypass. `@b4run/sdk` exports `ApproveEntry`, `NormalizedApproveEntry` and `normalizeApproveEntries`; `b4 check` validates the object form (unknown names, malformed entries, overlap with `constrain`), and the reserved `task` check covers it. The navlog example and scaffold approve `fileFlightPlan` this way, so on a shared permission store one visitor can no longer approve filing for everyone.
- b61e133: Client tool call records are now pruned. Every `ClientToolCallStore` gains `prune({ before })`, which deletes answered or voided records settled before `before` and outstanding records whose `expiresAt` is before `before`, and keeps every outstanding record that is unexpired or has no expiry. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement it; a store set in `server.agui.clientToolStore` must implement it too, or the boot fails naming the missing method.

  The runtime sweeps the store when an AG-UI turn settles, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `server.agui.clientToolRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot), never shorter than `clientToolTtlMs`. `b4 client-tools prune [--retention <ms>]` runs the same pass by hand.

- 0231fb5: Align on AG-UI 1.0.2 and CopilotKit 1.77.1. `@b4run/ag-ui` and `@b4run/cli` now depend on `@ag-ui/core` (and `@ag-ui/encoder`) 1.0.2, the release CopilotKit 1.77.1 and `@copilotkit/angular` 0.5.3 are built on, so an app using them resolves one `@ag-ui/core` version with B4.run. The navlog scaffold generated by `create-b4-app` pins `@ag-ui/client` 1.0.2 and `@copilotkit/react-core`/`@copilotkit/runtime` 1.77.1. The optional peer ranges are unchanged: `@ag-ui/client` `>=1.0.1 <2.0.0` and `@copilotkit/react-core` `>=1.76.0`.
- fd0c456: A consumed approval grant records who answered it. `InterruptGrantRecord` gains `consumedBy`, the `id` of the principal `src/auth.ts` resolved for the resuming request, or `null` for an anonymous answer. It's for audit only: grants stay caller-unbound, and no check reads it. `consume()` takes an optional `by`. The SQLite and Postgres grant stores add the `consumed_by` column in a new version-2 migration, and rows written before it read as `null`. A custom `InterruptGrantStore` must store and return the new field.
- 861f84a: `b4 build --target langsmith` compiles an app's `src/auth.ts` instead of refusing it. The build writes `.b4/build/auth.ts`, a LangGraph `Auth` that runs the app's `authenticate`, and sets `langgraph.json` `auth` with `disable_studio_auth: true`. `reject` becomes its status, and an anonymous request is a 401, since LangGraph has no anonymous user. An `ownedThreads` thread policy compiles to owner-stamp metadata filters; any other policy is still refused. Tools read the caller as `ctx.principal` from LangGraph's auth user.

  The build refuses an auth file that compares a secret from an `x-*` header, which LangGraph copies into stored run config. It also refuses memory scoped by `user`, `tenant` or `agent`, and warns that `src/middleware.ts` is not deployed. `createLangSmithAuth` is exported from `@b4run/cli/runtime`.

- 00b85cf: Long-term memory can now be scoped to the caller. `memory.resolveScope` runs per request and receives `principal`, the caller `src/auth.ts` resolved, so `resolveScope: ({ principal }) => (principal ? { user: principal.id } : {})` gives each caller its own memory.

  **Behavior change:** a dimension a route's `memory.ts` declares and `resolveScope` leaves without a value now makes memory unavailable for that request. `remember` and `recall` answer that memory is unavailable, the memory index is empty, and no episode is recorded. The request no longer falls back to the shared `workspace+route` namespace. An app that declared `user` or `tenant` without resolving it must resolve it, or drop the dimension.

  With a `src/auth.ts`, `GET /memory/candidates` lists only the caller's own namespaces (and shared ones), and approving or rejecting another caller's candidate answers `404`. `defineAuth` accepts `canReviewMemory(principal)` to let a reviewer see every namespace. Apps without an auth file are unchanged.

- fc59949: A `readFile`, `writeFile`, `editFile` or `listDir` call that parks for approval outside the workspace now names the tool call it gates: the path gate's permission interrupt carries `toolCallId` like the command, tool and memory gates already did, so an AG-UI client attaches the approval to the call's step instead of showing it unanchored. `createWorkspaceFs` accepts an optional `toolCallId`, and the `ctx.fs` handed to a route's own tools carries the call's id.
- bcfc8b8: An app can now declare one place that resolves who is calling: `src/auth.ts` default-exports `defineAuth({ authenticate })`. B4.run calls `authenticate` once per request, before middleware and the thread-access policy, and passes the result to middleware and the thread-access policy as `req.principal` and to every tool as `ctx.principal`. A principal is any object with a string `id`. `undefined` makes the request anonymous, `reject(...)` answers it before any endpoint runs, and a throw or malformed result fails it with a 500.

  `b4 typegen` declares the type `authenticate` resolves to on `B4Register`, so `ctx.principal` is typed. The node and web build targets carry `src/auth.ts` in their build, and the `langsmith` target refuses an app that has one. An auth file that does not default-export `defineAuth` fails the boot with `B4_E3005`. The harness takes a `principal` option, and `createAgentProtocolInjector` takes `auth`.

  **Breaking:** `ThreadAccessRequest.headers` is removed. A thread-access policy that read identity from headers must move that read into `src/auth.ts` and use `req.principal`. The `basic` and `navlog` templates are migrated, and the `navlog` template no longer ships `src/middleware.ts`.

- 936b7bf: The package READMEs install with npm, list `create-b4-app`'s `--template basic|navlog` and `--dist-tag` options, install `@b4run/cli` as a runtime dependency, and show a tool that needs approval in the SDK example.
- 936b7bf: The package READMEs show the navlog demo's poster, linked to the full demo video, in place of the README animation.
- 73c9289: `serve()` accepts a `guard`: a handler that runs ahead of the runtime/fallback split for every request and may answer it itself (a 401 for a missing internal token, a 429, an origin rejection). It is the seam a single-process deployment uses to authenticate the whole service, health check included, before any route runs. `ServeGuard` is exported from `@b4run/cli` and `@b4run/cli/runtime`.

  `serve({ fallback })` no longer crashes on a request target that does not parse as a URL (such as `GET //`) or on a fallback that throws synchronously; both now reach the fallback or answer 500.

- e9bfd30: Add `serve()`, a Node entry point that answers B4.run's own routes and the application's from one listener. An app that serves its own HTTP surfaces beside the agent had to hand-write that split: mount the runtime for the paths it believes B4.run owns, send the rest to its handler, log the address, and unwind both in the right order on SIGINT. `serve({ appRoot, middleware, port, fallback })` owns all of it; an app that serves nothing of its own omits `fallback` and the runtime answers every path.

  Which paths the runtime owns is B4.run's fact, not the application's, so it is now stated once: `/healthz`, `/readyz`, `/agui`, `/threads`, `/memory`, and `/workspace` — with any deeper path under each — live in one definition that both `serve` and the Vercel build target's route table (`VERCEL_RUNTIME_ROUTE_SRC`) are built from. A hand-written prefix list goes stale the moment the runtime grows a surface: the new endpoint reaches the application handler and answers 404, or, behind a single-page fallback, an HTML document with a 200.

  `/workspace/*` is now routed to the runtime function on Vercel; before, a `spaFallback` build sent it to the SPA.

  Shutdown runs in the only order that terminates — stop accepting, close the runtime so in-flight runs abort and streams finish, then drop the connections still held open. `installSignalHandlers` defaults to `true` here (unlike `serveRuntime`), because this is an entry point rather than a component of a larger host.

  Closes #737

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

- bbc7871: Tools can export `display` (`ToolDisplay`): an icon and `running`/`done`/`sources` functions that say how a call reads to a person. The runtime evaluates it per call, streams it to AG-UI clients as `CUSTOM` `b4.step` events (`running` as the call starts, `completed` as it returns — both before the result; `failed` after an error result for every tool), and keeps it on the checkpointed tool message (`additional_kwargs.b4_step`). `b4 check` validates the export. The built-in workspace, memory, skill, plan and subagent tools ship labels. Built-in tools now carry labels, so the Agent Protocol stream gains `step`/`subagent.step` chunks.
- Updated dependencies [e2f717a]
- Updated dependencies [b006a95]
- Updated dependencies [ad56b6d]
- Updated dependencies [d0bb6a1]
- Updated dependencies [c8b0675]
- Updated dependencies [d0bb6a1]
- Updated dependencies [7a7dbec]
- Updated dependencies [e6cfa3d]
- Updated dependencies [29acd56]
- Updated dependencies [1180d4c]
- Updated dependencies [1c73d80]
- Updated dependencies [b300d2c]
- Updated dependencies [2cbca78]
- Updated dependencies [7de7aa3]
- Updated dependencies [919eae4]
- Updated dependencies [52b19ec]
- Updated dependencies [6b7f152]
- Updated dependencies [2c33a3f]
- Updated dependencies [ed43d4f]
- Updated dependencies [2d07889]
- Updated dependencies [f13a243]
- Updated dependencies [5caad96]
- Updated dependencies [0cd999a]
- Updated dependencies [0b33206]
- Updated dependencies [31c2633]
- Updated dependencies [b1ae324]
- Updated dependencies [d58cf4d]
- Updated dependencies [61e5922]
- Updated dependencies [b25fc3b]
- Updated dependencies [b61e133]
- Updated dependencies [0231fb5]
- Updated dependencies [a5b0f48]
- Updated dependencies [fd0c456]
- Updated dependencies [861f84a]
- Updated dependencies [00b85cf]
- Updated dependencies [03fb4e6]
- Updated dependencies [fc59949]
- Updated dependencies [bcfc8b8]
- Updated dependencies [936b7bf]
- Updated dependencies [936b7bf]
- Updated dependencies [b1ae324]
- Updated dependencies [b1ae324]
- Updated dependencies [05db71b]
- Updated dependencies [b1ae324]
- Updated dependencies [91726d5]
- Updated dependencies [bbd4a0c]
- Updated dependencies [9547137]
- Updated dependencies [18bc4fd]
- Updated dependencies [bbc7871]
- Updated dependencies [d45b2dc]
- Updated dependencies [b1ae324]
  - @b4run/ag-ui@0.14.0
  - @b4run/langchain@0.14.0
  - @b4run/core@0.14.0
  - @b4run/sdk@0.14.0
  - @b4run/sqlite-storage@0.14.0
  - @b4run/workspace@0.14.0
  - @b4run/langgraph@0.14.0
  - @b4run/permissions@0.14.0
  - @b4run/memory@0.14.0

## 0.13.1

### Patch Changes

- f9350c4: `agent({ retry })` now applies to each model call instead of the whole run. `maxAttempts` (default 3) becomes the chat model's `maxRetries` (`maxAttempts - 1`), so LangChain retries each model request, including later calls in a tool loop, up to that many times; `maxAttempts: 1` now fails fast. Before, LangChain's default of 6 retries applied whatever `retry` said, and B4.run restarted the whole run on top of it when nothing had streamed yet.

  B4.run also sends a model call again after a capacity rate limit that LangChain hands back without retrying (a `429` with no `Retry-After`), waiting `min(baseDelay * 2^n + jitter, 10s)`. A `429` whose `Retry-After` is over 60 seconds (LangChain waits out shorter ones itself) isn't retried: the error surfaces at once, keeping the wait in `retryAfterMs`. This is the only place `baseDelay` applies; it was previously never read on an agent route. A quota `429` isn't retried, an abort during the wait stops it, and a response that fails after part of it streamed isn't retried, so no token is sent twice. The run itself is never restarted, so tools never run twice, and a transient error outside the model call (for example a checkpointer connection reset before the first event) now fails the turn instead of being retried with the run.

  The route's summarization model gets the same `maxRetries` (`defaultSummarize` and a custom `summarize` receive it as `maxRetries`), and the `b4 memory consolidate` / `reflect` model takes its attempts from a new `memory.distill.retry: { maxAttempts }` in `b4.config.ts` (default 3 per call, instead of LangChain's 6). `memory.distill.retry` is validated by `b4 check` and by the `b4 memory consolidate` / `reflect` commands (not by `b4 dev` or the runtime, which never read `memory.distill`): a `baseDelay` (distillation has nothing for it to pace), an unknown key in `memory.distill` or its `retry` (including a near-miss case typo such as `Distill`, `distil`, or `Retry`), a non-object parent, `memory: null` or `memory.distill: null` (previously read as empty), a misplaced `retry`/`maxAttempts`, or a `maxAttempts` that isn't a whole number of at least 1 fails with the new error code `B4_E1009` (Invalid memory config) instead of falling back to the default. `modelMaxRetries(retry)` is exported for other code that builds a chat model from an agent's `retry`.

  An invalid `retry` (a `maxAttempts` below 1 or not a whole number, a negative `baseDelay`) now fails the route when it first runs, and so does an unknown key on the `retry` object (for example `maxAttemps`) or a non-object `retry` — the error names the bad key and the valid keys, `maxAttempts` and `baseDelay`. A route that exports its own LangChain runnable keeps its model's own `maxRetries`, and is no longer restarted on a failure either if it streams; one with only `invoke` (no `streamEvents`) is still re-run whole by the legacy fallback, up to 3 times on a message-matched transient error.

- 0c76234: Move to AG-UI protocol 1.0 (`@ag-ui/core`/`@ag-ui/encoder` 1.0.1; `@ag-ui/client` optional peer `>=1.0.1 <2.0.0`; validators at `@ag-ui/core/schemas`). Approval grants (new in this release) travel over AG-UI in `metadata.grant` only, on interrupts and on resume entries; a 1.0 client strips a top-level `grant` in both directions. Breaking for AG-UI clients relative to 0.13.0: a cancelled or shut-down run ends with `RUN_FINISHED { outcome: cancelled }` instead of `RUN_ERROR`; a request declaring a foreign protocol major is refused with `400 unsupported_protocol_version`; a null route result is omitted rather than sent as `result: null`; messages carrying image, audio, video or document parts are refused with `422 multimodal_not_supported` until multimodal input lands. `RUN_STARTED` declares `protocolVersion: "1.0"`; a turn that leaves client-provided tool calls parked names them in `outcome.pendingToolCallIds`; 1.0 content parts are read as text; reasoning and activity history is dropped on the way in. Examples and the research scaffold pin CopilotKit 1.76.0 and `@ag-ui/client` 1.0.1 exactly.
- 216befd: An AG-UI approval resume is now answered only on the route that parked it. `/agui/:routeId` takes its route from the URL, so a caller admitted by middleware to one route could send a `resume` for a permission prompt parked by another route, and every `createAgent` route resolves another's park because they share node names: the decision was applied under the wrong route's graph, prompt and tools, and, where the routes shared a tool, the gated tool ran for a caller the parking route would refuse. Such a resume now gets `409` `resume_route_mismatch` after the thread-access gate and before any approval grant is checked or consumed; the parking route is not echoed. The owner is the thread's `parked_route`, or its `metadata.route` before the park is recorded, the same chain the Agent Protocol endpoints use. A thread with no route recorded at all keeps the previous behaviour, as `/threads/:id/resume` falls back to the caller's `route`.

  `/threads/:id/resume` now resolves the route from the thread's `parked_route` first, then the in-memory map, `metadata.route` and the body's `route`. An agent run that fails before its graph runs repoints `metadata.route` while the park survives, so the previous order let a resume run on the repointed route under that route's middleware. The route is also resolved before approval grants are checked, so a resume refused for its route no longer consumes a single-use grant.

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

- Updated dependencies [f9350c4]
- Updated dependencies [0c76234]
- Updated dependencies [a683816]
- Updated dependencies [377c1e9]
- Updated dependencies [17f16ea]
- Updated dependencies [3b1be6e]
- Updated dependencies [c7282f4]
- Updated dependencies [b0605d7]
  - @b4run/langchain@0.13.1
  - @b4run/sdk@0.13.1
  - @b4run/core@0.13.1
  - @b4run/ag-ui@0.13.1
  - @b4run/sqlite-storage@0.13.1
  - @b4run/permissions@0.13.1
  - @b4run/workspace@0.13.1
  - @b4run/langgraph@0.13.1
  - @b4run/memory@0.13.1

## 0.13.0

### Patch Changes

- 1f335b1: `createAgentHarness` and `defineEval` accept a `responseSchema`: the JSON Schema a Hashbrown client sends as `hashbrown.responseSchema`. The harness binds it on the root model exactly as the server does for an AG-UI run, with the same validation and provider-facing name. Scripted, live and recorded runs then send the model the same `response_format` production sends. Before, a recording made through the harness ran unconstrained, so it could capture replies production never produces, such as an empty final message. A route or provider that cannot constrain its output fails the run instead of running unconstrained. `@b4run/cli/runtime` now exports `readResponseFormat`, the server's parser for that field.
- c301d77: Managed workspaces no longer re-read and re-verify the thread's whole captured source bundle before every filesystem or exec call. The bundle is read from storage and verified once when a session is admitted, and later calls on that session reuse the verified, frozen copy while the association still names the same operation and source digest. A new session, after idle reaping, an abort, or a failed call, reads and verifies the stored bundle again, so a tampered bundle is still refused at admission. `readInitialFile` also indexes the verified bundle once instead of re-hashing it for every file. On a 951-file, 10 MB workspace a warm backend call drops from about 340 ms to about 0.1 ms.
- 5260ecb: Security fix: the `node` build target now carries the app's thread access policy in its build. Previously `b4 build` left `src/thread-access.ts` out of `.b4/build/modules.mjs` and the generated `server.mjs` probed the disk for it at boot, where a missing file reads as "no policy" — so a built node app whose policy file was absent at boot (deleted, or left out of the image) served every thread endpoint ungated. The policy is now a static import of the manifest and `server.mjs` records that the build saw one, so a missing policy file or a manifest older than the policy makes the server refuse to start instead of serving open, matching the `hono` and `vercel` targets. Rebuild node apps that have a thread access policy. The built manifest now imports the policy when it loads, including in `b4 check` after `b4 build`, so a policy that requires an environment variable at import time needs it there too; `b4 check` now says so when an app module throws while the manifest loads.
- 3b489a5: A `sandbox.thread` resolver may return `permissions`: that thread's permission gates then use its own allow-list in place of the app's, keep the app's mode and every denial (the app's and the thread's), and save an "Always" decision to the thread's record in the workspace installation, never to `.b4/permissions.json` or a configured `permissions.store`. A subagent runs under its parent thread's permissions. `createThreadPermissionsStore` builds such a store over any `PermissionsStore` and passes the store conformance suite. Empty and whitespace-only permission patterns are refused in a thread's lists. An "Always" whose pattern the thread's record cannot hold (longer than `MAX_THREAD_GRANT_LENGTH`, empty or containing NUL) allows that call once with a warning instead of failing the run.
- 0dd8fff: `sandbox.thread` decides each thread's whole sandbox (workspace, image and policy) once, at the thread's first admission. The image goes through the new optional `ManagedWorkspaceProvider.resolveImageEnvironment`, and its identity is recorded in the thread's creation intent; the image reference and the policy overrides are recorded beside the association in the same transaction, and every reconnect runs the thread's recorded policy over the app's. `dockerSandbox({ images })` bounds which images a thread may name and refuses anything else before any Docker call; `image` is optional when `images` is given. A thread may not open a network the app denies, and `security` stays per app. `b4 check`, `b4 build` and startup refuse unknown `sandbox` keys and `thread` beside `workspace`; a thread-sandbox app builds to a `{ version: 2, kind: "thread" }` artifact. The installation now stores a workspace's source only after its environment resolves, so a refused image leaves no source behind.

  **Behaviour change:** `b4 check`, `b4 build` and startup now refuse any key in the `sandbox` block other than `workspace`, `thread`, `provider`, `network`, `env`, `resources`, `security` and `idleTimeoutMs`. A misspelt key used to be ignored silently, which left every thread in a per-app sandbox; rename or remove any other key.

- 90b68be: Recording now fails at record time when replay would reject the recording. Previously `getRecordedFixtures()` returned whatever aimock captured, while replay loads fixtures through aimock's validator. A turn whose assistant message came back empty therefore produced a tape that the next replay refused with `content is empty string`. `getRecordedFixtures()` now applies the same validation and throws an error naming each rejected turn and its user message, with the likely causes. `b4 eval --record` reports it as `Refused to record <eval> › <case>` with exit code 2 and does not write that case's fixture file. If the run's answer is a tool call, `returnDirect` on that tool ends the run on its result, so no empty closing turn is recorded.
- 1da86ae: A sandbox with no `network` setting now defaults to `{ mode: "allow" }`. The previous default was `{ mode: "allow", denylist: ["169.254.169.254"] }`, but neither the Docker nor the Kubernetes provider enforces an allow-mode `denylist`. The entry claimed a block on the cloud metadata endpoint that never took effect, and runtime behavior is unchanged: allow-mode egress was open before and is open now. On a cloud VM, set `network: { mode: "deny" }` when the sandbox does not need the network. Otherwise block the endpoint outside B4.run, with a host firewall or egress proxy for Docker, or with the `b4-sandbox-infra` chart's default-deny egress backstop or your own NetworkPolicy for Kubernetes. The `SandboxPolicy.network` JSDoc and the sandbox and configuration docs now say which lists each reference provider ignores.
- 79c5f63: Hand a thread its workspace at creation. `sandbox.stagedWorkspaces` serves `PUT /workspace/sources/:digest` (a content-addressed `SourceBundle` upload, verified against its digest, one at a time per process with `429 upload_in_flight` to a second, within `uploadTimeoutMs`, default 120 s, `408` past it, and within `maxStagedBytes`, default 1 GiB, `507` past it) and accepts `workspace: { sourceDigest, environmentLinks?, baseline? }` on `POST /threads`, which may name only an uploaded source (never one an admission stored for another thread) and is checked against the upload's recorded file paths without re-reading its bytes; the app's resolver (`sandbox.thread`, or a function `sandbox.workspace`) receives it as `thread.staged` at the thread's first admission, and sources nothing references are reclaimed after `retentionMs` (default 24 hours), at boot and before each upload. The option needs a resolver and a thread-access policy; `b4 check`, `b4 build` and boot refuse it otherwise.

  Behaviour changes:

  - **`ThreadAccessRequest.requestedWorkspace` is a new required field** (`ThreadAccessRequestedWorkspace | undefined`, exported from `@b4run/sdk`): `{ sourceDigest }` on the new `workspace.source.put` operation (a `create` with no thread) and the whole reference plus `uploadedBy` on a `thread.create` that names a workspace, `undefined` everywhere else. A stamp a policy returns on `workspace.source.put` is kept as the upload's uploader and handed back in `uploadedBy`, so a policy can require a caller to choose only what it uploaded. Code that builds a `ThreadAccessRequest` by hand needs `requestedWorkspace: undefined`; `@b4run/testing`'s `createThreadAccessHarness` accepts it on a check. `ThreadOperation` gains `"workspace.source.put"`, so an exhaustive `switch` over it needs a case. Enabling `stagedWorkspaces` means auditing the policy's `create` handler.
  - **`POST /threads` refuses a `workspace` field it will not serve** (`400 workspace_not_accepted`, after the policy's decision) instead of ignoring it, in every app. In an app with `stagedWorkspaces` it also refuses a body over 1 MiB (`413 payload_too_large`, after a policy that refuses the caller has answered), and runs at most four creates naming a workspace at once (`429 workspace_create_in_flight`); every other app reads its create body as before.
  - **`DELETE /threads/:thread_id`** forgets the thread's staged workspace before its row, and boot forgets the staged workspace of any thread whose row is gone.

- fcf6d83: Read a thread's workspace over HTTP. `sandbox.workspaceRead: "http"` serves `POST /threads/:thread_id/workspace/inspect`, a bounded read-only inventory of a thread's managed workspace, authorized by the app's thread-access policy as the new `thread.workspace` operation; `b4 check`, `b4 build` and boot refuse it without a policy. `sandbox.workspaceReadTimeoutMs` bounds one read (default 120 s). `readThreadWorkspace` in `@b4run/cli/workspace` is the client. `inspectWorkspace` gains `root` and throws `WorkspaceInspectionError` with a code (`invalid_options`, `root_missing`, `refused`, `changed`); B4.run's bounded reads throw `WorkspaceReadLimitError` with their existing messages, and the Docker and Kubernetes batched walk's entry-limit refusal is a `WorkspaceInspectionError`. `ThreadOperation` gains a member, so an exhaustive `switch` over it needs a case. On Node, a request body a handler stops reading part-way is now discarded rather than resetting the connection, so a refusal such as a 413 reaches the client.
- Updated dependencies [f2ee6cf]
- Updated dependencies [3b489a5]
- Updated dependencies [0dd8fff]
- Updated dependencies [1da86ae]
- Updated dependencies [79c5f63]
- Updated dependencies [0d06d72]
- Updated dependencies [fcf6d83]
  - @b4run/workspace@0.13.0
  - @b4run/permissions@0.13.0
  - @b4run/sqlite-storage@0.13.0
  - @b4run/sdk@0.13.0
  - @b4run/core@0.13.0
  - @b4run/langchain@0.13.0
  - @b4run/memory@0.13.0
  - @b4run/langgraph@0.13.0
  - @b4run/ag-ui@0.13.0

## 0.12.0

### Patch Changes

- ef4c901: Agent routes now run on LangChain's `createAgent` instead of LangGraph's deprecated `createReactAgent`, and a `returnDirect` tool ends the run only when it succeeds. A failed call (the tool threw, or the model's arguments failed its schema) now goes back to the model, which can correct the call and retry; the first successful result ends the run. Previously the error ended the run, so a validating tool could not use `returnDirect`.

  B4 installs its own `createAgent` middleware for what `createReactAgent` did through options: prompt fragments re-rendered from live state, summarization's condensed history, and tool errors returned to the model as `status: "error"` results in the same `Error: … Please fix your mistakes.` form as before. A route without summarization or a `returnDirect` tool keeps the same number of graph steps per model/tool turn, so `recursionLimit` budgets are unchanged.

  `@b4run/langchain` now depends on `langchain` ^1.5.12, and its `@langchain/core` peer range rises from ^1.1.47 to ^1.2.12 (the range `langchain` itself requires).

- Updated dependencies [ef4c901]
- Updated dependencies [212c43d]
- Updated dependencies [7f81d24]
  - @b4run/langchain@0.12.0
  - @b4run/core@0.12.0
  - @b4run/ag-ui@0.12.0
  - @b4run/langgraph@0.12.0
  - @b4run/memory@0.12.0
  - @b4run/permissions@0.12.0
  - @b4run/sdk@0.12.0
  - @b4run/sqlite-storage@0.12.0
  - @b4run/workspace@0.12.0

## 0.11.2

### Patch Changes

- Republishes the 0.11.1 changes, which never reached npm. The 0.11.1 release commit could not pass its required CI run, so no 0.11.1 packages were published. This release carries the same fixes: `@b4run/cli` exports `B4Config`, so `config()` in `b4.config.ts` typechecks under pnpm, and the basic template uses `config()` again.
  - @b4run/ag-ui@0.11.2
  - @b4run/core@0.11.2
  - @b4run/langchain@0.11.2
  - @b4run/langgraph@0.11.2
  - @b4run/memory@0.11.2
  - @b4run/permissions@0.11.2
  - @b4run/sdk@0.11.2
  - @b4run/sqlite-storage@0.11.2
  - @b4run/workspace@0.11.2

## 0.11.1

### Patch Changes

- 837bcfb: `@b4run/cli` now exports the `B4Config` type alongside `config()`. Under pnpm's isolated `node_modules`, an app depends only on `@b4run/cli` and cannot resolve `@b4run/core`, so `export default config({})` in `b4.config.ts` failed `tsc` with TS2883 (the inferred `B4Config` type could not be named). This affected the research template. The basic template's `b4.config.ts` now uses `config({})` too.
- Updated dependencies [c282336]
  - @b4run/sdk@0.11.1
  - @b4run/core@0.11.1
  - @b4run/langchain@0.11.1
  - @b4run/langgraph@0.11.1
  - @b4run/permissions@0.11.1
  - @b4run/workspace@0.11.1
  - @b4run/sqlite-storage@0.11.1
  - @b4run/memory@0.11.1
  - @b4run/ag-ui@0.11.1

## 0.11.0

### Minor Changes

- 54aa602: A tool module can export `returnDirect = true` to end the run on its result instead of handing control back to the model for another turn. LangGraph's prebuilt agent already routes such a tool straight to the end of the graph; B4 now reads the export during tool discovery, carries it on the tool definition, and sets it on the LangChain tool. The run's last message is then the tool result: no closing assistant message is produced, the AG-UI stream ends after `TOOL_CALL_RESULT`, and a middleware `after` hook sees an empty final message. A non-boolean export is a discovery error.

### Patch Changes

- a30db23: LangChain dependencies move to their current releases: `@langchain/core` 1.2.12, `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/openai` 1.5.13, `@langchain/anthropic` 1.5.11, `@langchain/google-genai` 2.3.2, `@langchain/xai` 1.4.13 and `@langchain/openrouter` 0.4.13, with the peer ranges raised to match. The lockfile is deduplicated so that every workspace package resolves the same single copy of `@langchain/langgraph` and `@langchain/core`.
- 0093dea: `b4 run` and `b4 test` now regenerate `.b4/` tool schemas before executing routes in-process, so a tool added or changed since the last `b4 typegen` is bound with its current input schema instead of a stale or permissive one. A typegen failure is reported on stderr and the route still runs. `b4 typegen` also removes a route's stale `tools.json` once the route has no analyzable tools left.
- Updated dependencies [18961bb]
- Updated dependencies [a30db23]
- Updated dependencies [54aa602]
  - @b4run/langchain@0.11.0
  - @b4run/core@0.11.0
  - @b4run/sqlite-storage@0.11.0
  - @b4run/memory@0.11.0
  - @b4run/ag-ui@0.11.0
  - @b4run/langgraph@0.11.0
  - @b4run/permissions@0.11.0
  - @b4run/sdk@0.11.0
  - @b4run/workspace@0.11.0

## 0.10.0

### Minor Changes

- 71bccb3: `sandbox.workspace` may now be a `WorkspaceResolver`: host code called once per thread, at first admission, with the thread id and its stored client metadata, returning that thread's initial workspace definition. The result is captured and recorded by digest exactly as a static definition is; `b4 build` records a resolver marker in place of captured source and startup refuses an artifact whose form disagrees with the config; `b4 check` reports the per-thread form.

### Patch Changes

- 1cadde8: Tool-call arguments now stream as they are generated. The LangChain agent adapter projects the argument fragments a provider streams into `tool_call_args` chunks, re-serialized token by token so their concatenation matches the `JSON.stringify(args)` delta sent today byte for byte, and the AG-UI translator emits them as one `TOOL_CALL_START`, several `TOOL_CALL_ARGS` deltas and one `TOOL_CALL_END` under the call's logical id. A client that renders from a tool call's arguments can paint progressively, the way it does for assistant text. Tool execution still receives the complete, parsed arguments from the unchanged `tool_call` announce; providers that stream no fragments produce exactly the output they did before; the built-in `writeTodos` and `task` calls stay on the single-delta path. The runtime's middleware `after` hook treats a fragment as proof a held message was not final, and the live tail renders nothing for fragments.
- Updated dependencies [1cadde8]
- Updated dependencies [71bccb3]
  - @b4run/langchain@0.10.0
  - @b4run/ag-ui@0.10.0
  - @b4run/workspace@0.10.0
  - @b4run/core@0.10.0
  - @b4run/sqlite-storage@0.10.0
  - @b4run/memory@0.10.0
  - @b4run/langgraph@0.10.0
  - @b4run/permissions@0.10.0
  - @b4run/sdk@0.10.0

## 0.9.0

### Minor Changes

- 516c038: Read a managed workspace from a trusted host process. `ManagedWorkspaceProvider` gains an optional `openWorkspaceReader` addressed by the published `ReadyWorkspace` (implemented for Docker as a read-only bind of the managed volume in a separate networkless container that never touches a session), `@b4run/sqlite-storage` gains `openWorkspaceInstallationReader` (a lock-free read-only view of an installation another process owns), and `@b4run/cli/workspace` gains `openManagedWorkspaceReader` / `withManagedWorkspaceReader`, which resolve a thread to its published workspace through that store. `scopedWorkspaceReader` is exported from `@b4run/workspace` as the shared always-close lifetime.

### Patch Changes

- 7c9627f: Apply a client-supplied `hashbrown.responseSchema` on the AG-UI run body to the route's root model, or reject the run. `POST /agui/:routeId` used to accept the field and read nothing from it, so a Hashbrown client that expected the final message to match its UI schema got an unconstrained model and found out only when a reply failed to parse. On an `agent` route the schema is now bound as the provider's native schema-constrained output alongside the route's tools — OpenAI `response_format` (`json_schema`, `strict: true`) and Anthropic `output_config.format` — so tool-calling turns are untouched and only the final message is constrained. A malformed schema, a non-agent route, or a provider with no such mode is refused with `422` and the new `B4_E5402` (`invalid_response_schema` / `response_schema_not_supported`) before any run side effect. Runs without the field are unchanged. `@b4run/langchain` gains `JsonSchemaResponseFormat`, `createChatModel({ responseFormat })`, `streamAgent({ responseFormat })` and the `JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS` list.
- 67b18fe: `createAgentHarness` accepts a `middlewareContext` option — a value or a `(run) => context` function evaluated per `run()`/`resume()` — so tools that read `ctx.middleware` can be exercised in-process even though the harness bypasses `middleware.ts`. `defineEval` accepts the same field and `b4 eval` forwards it to the harness.
- 6a59e00: Add an `after` hook to the middleware lifecycle definition. `defineMiddleware({ handle, after })` runs `after` once per AG-UI run with the agent's final assistant message and the context `handle` allowed, before the client sees the message: return nothing to keep it, `{ finalMessage }` to replace it, or `reject(...)` to end the run with a `RUN_ERROR` (code `middleware_rejected`). With the hook defined the final assistant message is buffered and delivered whole before `RUN_FINISHED`; text before a tool call still streams live, and an app without the hook emits exactly the events it did before. `@b4run/ag-ui`'s `toAguiEvents` now forwards a string `code` from an upstream error onto `RUN_ERROR`.
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

- 9927409: Derive tool schemas with the app's own `tsconfig.json` and fail loudly on unresolved input types. The tool program `extractToolSchemasForRoute` / `extractToolTypesForRoute` build now reads the nearest `tsconfig.json` above the app root (honoring `extends`, `paths`, and `baseUrl`; an explicit `tsconfig` option is also accepted), so an input type imported through a path alias no longer resolves to `any` and derives its real schema. When a declared input type still resolves to `any`/`unknown`, or an import it depends on does not resolve, extraction throws `UnresolvedToolInputTypeError` naming the tool file, the type, and the tsconfig used; `b4 typegen` and `b4 verify` surface it as a failure instead of writing `{ properties: {} }`. Tools that take no input (`{}`, `Record<string, never>`, no parameter) keep working.
- Updated dependencies [7c9627f]
- Updated dependencies [516c038]
- Updated dependencies [6a59e00]
- Updated dependencies [7410154]
- Updated dependencies [16ef75f]
- Updated dependencies [9927409]
  - @b4run/langchain@0.9.0
  - @b4run/sdk@0.9.0
  - @b4run/workspace@0.9.0
  - @b4run/sqlite-storage@0.9.0
  - @b4run/ag-ui@0.9.0
  - @b4run/core@0.9.0
  - @b4run/langgraph@0.9.0
  - @b4run/permissions@0.9.0
  - @b4run/memory@0.9.0

## 0.8.36

### Patch Changes

- 6d16bb1: Add `build.vercel.maxDuration`, the runtime function's `maxDuration` in seconds. A composed function under `build.vercel.functions` could already declare one; the runtime function — the one that runs the agent, and so the one a long tool-using run outgrows — could not, leaving the ceiling to the project's dashboard setting with no way to state it in the repository.

  Omitted, nothing changes: no `maxDuration` is written and Vercel applies the project default. Set, the value is written onto `functions/<name>.func/.vc-config.json` and `validateVercelOutput` requires exactly that value there, so the published tree cannot disagree with the config it was built from. The duration is validated as a positive integer under `B4_E1003`, by the same assertion the composed functions use.

- Updated dependencies [6d16bb1]
  - @b4run/core@0.8.36
  - @b4run/langchain@0.8.36
  - @b4run/ag-ui@0.8.36
  - @b4run/langgraph@0.8.36
  - @b4run/memory@0.8.36
  - @b4run/permissions@0.8.36
  - @b4run/sdk@0.8.36
  - @b4run/sqlite-storage@0.8.36
  - @b4run/workspace@0.8.36

## 0.8.35

### Patch Changes

- 814f4f9: `b4 check` no longer reports a clean `0 routes discovered` for an app whose `package.json` lacks `"type": "module"`. Route discovery now fails with `B4_E1006` naming the app root's `package.json`, and a route `index.ts` with no recognisable export fails with `B4_E1007` naming the file, the exports it found, and, when the module was loaded as CommonJS, the nested `package.json` that caused it — listing every unrecognised route entry in the app in one error rather than one per run. Closes #685.
- 89a5958: Ship a checked-in b4 launcher so workspace installations create the command link before the CLI build output exists.
- f20ba3b: `GET /healthz` is now a pure liveness probe: it never builds per-request stores, so a `vercel` or `hono` deployment with `DATABASE_URL` unset or its database unreachable answers 200 instead of 500. Dependency readiness moved to the new `GET /readyz`, which probes the threads, checkpointer and permissions stores and answers 503 naming each failing dependency, with connection-string credentials redacted (#688).
- c9a4d87: Add optional `setup(ctx)` and `dispose()` lifecycle hooks to `defineMiddleware`. The object form `defineMiddleware({ setup, dispose, handle })` runs `setup` once, lazily, before the first gated request, shares one in-flight call across concurrent first requests, and retries it on the next request if it rejects, so a transient outage never poisons the process. `dispose` runs from the Node runtimes' shutdown path after in-flight requests drain. The function form is unchanged.
- 4b1b398: A middleware `reject(status)` that omits the body now answers with that status instead of a 500. The runtime built the reply with `Response.json(body)`, which throws when `body` is `undefined`, so the documented body-omitted form of `reject` reached the caller as `500 Unexpected runtime server failure` — turning an intended 401 or 403 into a server error on the AG-UI and Agent Protocol run endpoints. A body-less reject now sends an empty payload under the JSON content-type at the requested status; rejects that do supply a body are unchanged.

  On the Node targets, body-less replies are now framed with `Content-Length: 0` rather than `Transfer-Encoding: chunked`, restoring how the pre-`fetch`-core server framed them and extending the adapter's existing content-length rule for JSON to cover empty payloads. The statuses that forbid a body (204, 205, 304) keep Node's own suppression and send no `Content-Length`.

- 03be72b: Namespace generated Postgres stores per deployment environment. The `hono` and `vercel` targets' `stores.mjs` now reads `B4_PG_SCHEMA` and `B4_PG_TABLE_PREFIX` per request, each a lowercase identifier or a `$NAME` reference to another variable, so `B4_PG_SCHEMA=$VERCEL_ENV` keeps a Vercel project's preview and production deployments in separate schemas of one database. Unset bindings keep `public.b4_*`. A bad value fails the request by name instead of falling back to `public`. Behavior change in `@b4run/postgres-storage`: `schema` and `tablePrefix` must now be lowercase. A mixed-case value previously passed validation and was folded to lowercase by unquoted DDL, so it never named the tables it appeared to, and its advisory-lock key differed from the lowercase spelling of the same tables. Such a value now throws at construction. Pass the lowercase spelling the database was already using. The enforced pattern is exported as `IDENTIFIER_PATTERN`.
- b090ad4: A route that returns nothing no longer makes `POST /threads/:id/runs/wait` answer 500. The endpoint serialized the route's return value with `Response.json`, which throws on `undefined`, so a run that had actually succeeded came back as `Unexpected runtime server failure` while `POST /threads/:id/runs/stream` reported the same run as done. Such a run now answers 200 with the body `null`, so callers that read a property off the parsed body should narrow it first. Falsy outputs (`0`, `false`, `""`) are unaffected.

  `null` rather than the empty body the pre-`fetch`-core server sent: B4's own client for this endpoint parses every 200 body, and an empty one reads as a malformed payload, which would trade the 500 for a transport error.

  `undefined` was not the only value `JSON.stringify` refuses, and a route's output is unconstrained. A circular object or a BigInt hit the same catch and produced the same opaque failure; the endpoint now answers 500 with a message naming the route and the serialization error instead. All five build targets share this code path (#714).

- 5a38599: Log the real cause of a store failure. A Postgres connection the WebSocket driver could not open used to reach the runtime log as `[object ErrorEvent]`; the runtime now renders the message, code and nested cause chain of whatever was thrown, and the generated `stores.mjs` reports a store initialisation failure once with the store kind and a credential-free connection target. `@b4run/cli/fetch` exports the `serializeError`, `formatErrorChain`, `errorStackOf` and `describeConnectionTarget` helpers behind it.
- 12726b4: Type `build.targets` in `config()` as the union of known build target names (`"node" | "langsmith" | "hono" | "vercel"`, exported as `BuildTargetName`) instead of `readonly string[]`, so a misspelled target such as `"vercell"` fails to type-check rather than at `b4 build`. The union is derived from the new `BUILD_TARGET_NAMES` tuple in `@b4run/core`, and the CLI's target registry is typed over it, so the two cannot drift. Untyped configs are still validated at build and check time with the same error message.
- 0aa4d42: Let `build.vercel` describe the whole Vercel Build Output tree: a `static` directory with an optional SPA fallback, extra Node `functions` bundled from an entry with `runtime`/`maxDuration`/`supportsResponseStreaming`, and `routes` ordered ahead of the filesystem phase, the runtime function, and the SPA fallback. The runtime function is named `b4.func` once static assets are configured (or whatever `functionName` says) so it no longer shadows `static/index.html`; a bare runtime build still emits `index.func` behind the same catch-all. `validateVercelOutput` accepts the composed tree while keeping the runtime function config exact.

  Under a SPA fallback the runtime route is scoped to the surfaces the runtime owns — `/healthz`, `/readyz`, `/agui`, `/threads`, `/memory` — so every other path reaches the SPA document. A surface missing from that list would serve HTML with a 200 instead of reaching the runtime, so the composed route is covered by a test per surface.

  The runtime function now declares `supportsResponseStreaming: true`. It serves SSE on `/agui/:routeId` and `/threads/:id/runs/stream`, and without the flag Vercel's Node launcher buffers the response, so a deployed frontend received nothing until a run finished. Extra functions could already opt in; the function that always streams could not.

  Every `build.vercel` rejection now carries the `B4_E1003` code and its docs link, so a malformed `static.dir` reports the same way as an unknown option rather than printing a bare line.

  These keys join `reconcileVercelJson` in one validated `build.vercel`: a single resolver owns the shape, so `b4 check` and `b4 build` reject an unknown key or a malformed value the same way for every option, and the composed tree is only built from a shape that was checked.

- 1456422: Name the Vercel runtime function `b4.func` in every build. It was `index.func` unless `build.vercel.static` was configured, but the Build Output API also serves a function named `index` at `/`, where it shadows a static `index.html`. That hazard belongs to the name rather than to whether a particular build emits static assets, so the name is off the root always and an app that grows a frontend later does not have to rename its function to get one.

  `.vercel/output/functions/b4.func/` replaces `.vercel/output/functions/index.func/`, and `config.json` routes to `/b4`. Anything reading the published tree by path, such as a local smoke script importing the bundle, follows the new path. `build.vercel.functionName: "index"` restores the old layout for a build with no static assets.

- 0429cec: Let the `vercel` target's generated stores reach a plain Postgres without a WebSocket proxy, and document `B4_PG_WS_PROXY`.

  - The Vercel `stores.mjs` now selects a driver per request: `@neondatabase/serverless` for a `*.neon.tech` host or when `B4_PG_WS_PROXY` is set, and a pooled `pg` connection (through the new `createPostgresPool` export of `@b4run/postgres-storage/node`) for every other host, so the built bundle runs against a local database with no proxy. `B4_PG_DRIVER=neon|pg` overrides the detection; `pg` is refused on the `hono` target.
  - `B4_PG_WS_PROXY` accepts `host:port`, `ws://host:port`, or `wss://host:port` (the last keeps TLS on) on both targets, and any other scheme, path, or query is rejected with a message naming the variable and the accepted forms instead of failing inside the driver.
  - `normalizeWsProxy` and `selectPostgresDriver` are exported from `@b4run/cli/fetch` for hand-composed store factories.

- acfc786: Let the `vercel` build target publish somewhere other than `.vercel/output`: `b4 build --out-dir <dir>` or `build.vercel.outDir` in `b4.config.ts`, resolved relative to the app root, with the flag taking precedence. A directory that contains the app root is rejected before anything is written, and `--out-dir` is an error when `"vercel"` is not a configured target.

  Relax the Vercel output validator so a composed Build Output tree still validates: `config.json` must be version 3 and contain a route whose `dest` is `/index`, rather than matching the exact catch-all the build writes. Extra routes and top-level keys added after the build are accepted.

- 10a6cbb: Add `build.vercel.reconcileVercelJson` so a prebuilt Vercel flow (`vercel deploy --prebuilt`, no Vercel Git integration) can opt the `vercel` target out of `vercel.json` reconciliation. With it set to `false`, `b4 build` neither requires, writes, nor inspects a committed `vercel.json` whose `buildCommand` would never run, and no longer fails on a committed `fluid: false`. Because reconciliation stays on unless the flag is exactly `false`, `b4 check` and `b4 build` reject every near miss with `B4_E1003` — a non-boolean value, a non-object `build.vercel`, an unknown key inside it, or the flag misplaced directly on `build` — rather than reading as configured while still reconciling. Fluid compute guidance is unchanged for the deployed project.
- 3f32ad8: `b4 verify` now renders the registry error code for every phase, not just `runtime`. An app root whose `package.json` lacks `"type": "module"` fails with `[B4_E1006]` and a route entry with no recognisable export fails with `[B4_E1007]` — the same codes `b4 check` reports for those apps. The `--json` payload carries the code too: a failed check's `error` object gains an optional `code` field, present only when the underlying failure has a registry entry.
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
  - @b4run/langchain@0.8.35
  - @b4run/sqlite-storage@0.8.35
  - @b4run/langgraph@0.8.35
  - @b4run/permissions@0.8.35
  - @b4run/memory@0.8.35
  - @b4run/ag-ui@0.8.35

## 0.8.34

### Patch Changes

- Updated dependencies [5843672]
  - @b4run/langchain@0.8.34
  - @b4run/ag-ui@0.8.34
  - @b4run/core@0.8.34
  - @b4run/langgraph@0.8.34
  - @b4run/memory@0.8.34
  - @b4run/permissions@0.8.34
  - @b4run/sdk@0.8.34
  - @b4run/sqlite-storage@0.8.34
  - @b4run/workspace@0.8.34

## 0.8.33

### Patch Changes

- a239527: Keep concurrent nested model output in separate AG-UI assistant messages. Carry
  model invocation identity through runtime tokens and live-turn snapshots, and
  close each message when its model finishes. Legacy anonymous tokens and raw SSE
  string payloads remain supported.
- Updated dependencies [a239527]
  - @b4run/langchain@0.8.33
  - @b4run/ag-ui@0.8.33
  - @b4run/core@0.8.33
  - @b4run/langgraph@0.8.33
  - @b4run/memory@0.8.33
  - @b4run/permissions@0.8.33
  - @b4run/sdk@0.8.33
  - @b4run/sqlite-storage@0.8.33
  - @b4run/workspace@0.8.33

## 0.8.32

### Patch Changes

- 0003db2: Add provider-owned managed workspaces with immutable source capture, durable installation ownership and associations, resumable creation/deletion, and incarnation-scoped compute sessions. Node builds retain verified source artifacts; tools receive permission-bound initial bytes and workspace provenance. Docker implements managed preparation and recovery. Add file metadata and binary reads, disposable workspace execution, and isolated test-harness cleanup. Migrate the code-fixer example to ordinary author tools with independently verified, approval-bound candidate export.
- 9e3c42e: Expose a detached parsed request body to execution middleware on AG-UI and
  Agent Protocol POST endpoints. Applications can validate client context and
  resume decisions through the existing middleware API without modifying runtime
  input or adding protocol-specific hooks.
- Updated dependencies [0003db2]
- Updated dependencies [9e3c42e]
- Updated dependencies [0003db2]
- Updated dependencies [0003db2]
- Updated dependencies [0003db2]
  - @b4run/workspace@0.8.32
  - @b4run/sqlite-storage@0.8.32
  - @b4run/sdk@0.8.32
  - @b4run/core@0.8.32
  - @b4run/langchain@0.8.32
  - @b4run/memory@0.8.32
  - @b4run/langgraph@0.8.32
  - @b4run/permissions@0.8.32
  - @b4run/ag-ui@0.8.32

## 0.8.31

### Patch Changes

- @b4run/ag-ui@0.8.31
- @b4run/core@0.8.31
- @b4run/langchain@0.8.31
- @b4run/langgraph@0.8.31
- @b4run/memory@0.8.31
- @b4run/permissions@0.8.31
- @b4run/sdk@0.8.31
- @b4run/sqlite-storage@0.8.31

## 0.8.30

### Patch Changes

- 80a98ad: Authorize a thread's row before claiming its run slot on `POST /agui/:routeId`.
  The AG-UI handler previously ran `runRegistry.begin` before rechecking the
  concrete row, so on the create-race path a caller the recheck ultimately denies
  held the victim thread's run slot for the width of that recheck — a client-chosen
  thread id let a denied caller brick a concurrent authorized run on the same
  thread with a transient `run_in_flight` 409. The row authorization (and the
  implicit create, when the turn makes one) now runs before the slot is claimed,
  mirroring the Agent Protocol run handlers. Behavior is unchanged for authorized
  callers and for hook-less apps.
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

- 111d45c: Add `b4 threads tail <thread-id>` — reattach to a thread from the terminal.
  It consumes `GET /threads/:thread_id/runs/stream`, printing a snapshot (the
  committed transcript, the in-flight turn's output so far, and any parked
  human-in-the-loop prompts) and then following live frames until the turn ends.
  When no turn is live in the target process it prints the durable
  checkpoint-backed snapshot and exits, so it works across restarts and replicas.

  `--url` points at a server other than `http://127.0.0.1:3000`, `--header` is
  repeatable for middleware that authenticates the thread's route, and `--json`
  prints raw SSE frames for scripting. Attaching takes no run slot and cancels
  nothing.

  This is B4.run's first first-party Agent Protocol stream client: it parses the
  documented wire defensively rather than importing the server's frame types, so
  the published contract now has a consumer that exercises it.

- 18c7b61: Route skills, `plan.md`, and `memory.md` now work on the `hono` and `vercel` targets: `b4 build` bundles them into the static manifest and the runtime serves them through the new `staticMarkerFs` in `@b4run/core`. The build no longer gates skills off those targets; instead `b4 build` and `b4 check` enforce a per-file size limit (32 KiB for `SKILL.md` and `memory.md`, 64 KiB for `plan.md`) and fail with `B4_E1005` by name. `@b4run/core` also exports `MAX_PLAN_BYTES` and `MAX_MEMORY_BYTES`.
- Updated dependencies [80a98ad]
- Updated dependencies [18c7b61]
- Updated dependencies [6039fd2]
  - @b4run/sdk@0.8.30
  - @b4run/core@0.8.30
  - @b4run/langchain@0.8.30
  - @b4run/langgraph@0.8.30
  - @b4run/permissions@0.8.30
  - @b4run/ag-ui@0.8.30
  - @b4run/memory@0.8.30
  - @b4run/sqlite-storage@0.8.30

## 0.8.29

### Patch Changes

- Updated dependencies [481489e]
  - @b4run/sdk@0.8.29
  - @b4run/core@0.8.29
  - @b4run/langchain@0.8.29
  - @b4run/langgraph@0.8.29
  - @b4run/permissions@0.8.29
  - @b4run/ag-ui@0.8.29
  - @b4run/memory@0.8.29
  - @b4run/sqlite-storage@0.8.29

## 0.8.28

### Patch Changes

- Updated dependencies [39ceb2e]
  - @b4run/sdk@0.8.28
  - @b4run/core@0.8.28
  - @b4run/langchain@0.8.28
  - @b4run/langgraph@0.8.28
  - @b4run/permissions@0.8.28
  - @b4run/ag-ui@0.8.28
  - @b4run/memory@0.8.28
  - @b4run/sqlite-storage@0.8.28

## 0.8.27

### Patch Changes

- Updated dependencies [b05b96d]
  - @b4run/sdk@0.8.27
  - @b4run/core@0.8.27
  - @b4run/langchain@0.8.27
  - @b4run/langgraph@0.8.27
  - @b4run/permissions@0.8.27
  - @b4run/ag-ui@0.8.27
  - @b4run/memory@0.8.27
  - @b4run/sqlite-storage@0.8.27

## 0.8.26

### Patch Changes

- c7fd197: Add `server.cors`, off by default.

  A Dawn server sends no `Access-Control-*` header unless `dawn.config.ts` sets
  `server.cors`. With the block absent the runtime answers exactly as it did
  before — no header on any response, and `OPTIONS` still falling through the
  route table to its 404. Opening a server to other origins is a deployment
  decision, so nothing is inferred.

  ```ts
  server: {
    cors: {
      origins: ["https://app.example.com"];
    }
  }
  ```

  Set it when a browser client talks to Dawn directly rather than through a
  same-origin proxy. Origins are compared exactly after normalizing case and a
  trailing slash; note that `localhost` and `127.0.0.1` are different origins to
  a browser, so list both if your dev client may be opened at either.

  Every response carries the headers, including error responses and the shutdown
  503 — a browser that cannot read a 404 reports an opaque CORS failure instead,
  which is the most confusing way to debug this. A request from an origin that
  is not on the list is still served normally and simply carries no CORS header;
  answering 403 there would break non-browser clients that happen to send an
  `Origin`. A preflight from a disallowed origin does get a 403.

  The policy is validated once at boot, so a malformed origin list fails on
  startup rather than on the first cross-origin request. `origins: "*"` combined
  with `credentials: true` is rejected outright: browsers refuse a wildcard
  allow-origin on a credentialed request, so accepting it would produce a server
  that looks configured and fails only in the console.

  Defaults for the rest: `credentials` false; `methods` `GET, POST, DELETE,
OPTIONS`; `headers` echoes the browser's own `Access-Control-Request-Headers`;
  `exposeHeaders` empty; `maxAgeSeconds` 600.

  CORS controls which origins a browser will let read a response. It does not
  decide who may call the server — pair it with `defineThreadAccess`.

- Updated dependencies [c7fd197]
  - @dawn-ai/core@0.8.26
  - @dawn-ai/langchain@0.8.26
  - @dawn-ai/ag-ui@0.8.26
  - @dawn-ai/langgraph@0.8.26
  - @dawn-ai/memory@0.8.26
  - @dawn-ai/permissions@0.8.26
  - @dawn-ai/sdk@0.8.26
  - @dawn-ai/sqlite-storage@0.8.26

## 0.8.25

### Patch Changes

- 95901e7: Re-cut the release so the repaired release automation runs end to end.

  There are no functional changes to any package in this version: the published
  0.8.24 packages and these are built from the same sources. 0.8.24 published
  correctly, but its release ceremony could not finish because two defects in
  that candidate's own smoke lanes made them fail on every attempt, and every
  release job outside the controller runs from the frozen candidate commit, so
  the fixes could not reach it.

  This version is the first candidate to carry the repaired publish retry and
  smoke lanes, which is what proves them.

  - @dawn-ai/ag-ui@0.8.25
  - @dawn-ai/core@0.8.25
  - @dawn-ai/langchain@0.8.25
  - @dawn-ai/langgraph@0.8.25
  - @dawn-ai/memory@0.8.25
  - @dawn-ai/permissions@0.8.25
  - @dawn-ai/sdk@0.8.25
  - @dawn-ai/sqlite-storage@0.8.25

## 0.8.24

### Patch Changes

- 7495d06: Cut a new patch release. The previous version bump was never tagged or published: its merge commit failed CI on a literal chart-version pin in the Kubernetes documentation checks, and the release controller binds a candidate to the commit that introduced its version. The pin is now a floor, so this bump can be released. No runtime behavior changes.
  - @dawn-ai/ag-ui@0.8.24
  - @dawn-ai/core@0.8.24
  - @dawn-ai/langchain@0.8.24
  - @dawn-ai/langgraph@0.8.24
  - @dawn-ai/memory@0.8.24
  - @dawn-ai/permissions@0.8.24
  - @dawn-ai/sdk@0.8.24
  - @dawn-ai/sqlite-storage@0.8.24

## 0.8.23

### Patch Changes

- 21654e8: Align the CopilotKit v2 examples, research scaffold, and Dawn AG-UI runtime on CopilotKit 1.70 and AG-UI 0.0.59.
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

- Updated dependencies [21654e8]
- Updated dependencies [7e62bb1]
  - @dawn-ai/ag-ui@0.8.23
  - @dawn-ai/core@0.8.23
  - @dawn-ai/langchain@0.8.23
  - @dawn-ai/langgraph@0.8.23
  - @dawn-ai/memory@0.8.23
  - @dawn-ai/permissions@0.8.23
  - @dawn-ai/sdk@0.8.23
  - @dawn-ai/sqlite-storage@0.8.23

## 0.8.22

### Patch Changes

- b9381c4: Record an AG-UI turn that parks on a permission prompt as `interrupted` rather
  than `idle`. A parked turn takes the same completion path as one that finishes,
  so the thread reported that the agent was done while it was still waiting on a
  human, and a client that reloaded never re-rendered the prompt. The status now
  holds on every path out of the turn, including a turn that parked and then
  failed and one whose client disconnected after the park.
- 6cce98d: Add `GET /threads/{thread_id}/pending_interrupts`, which returns the human-in-the-loop
  interrupts parked on a thread together with each interrupt's payload, so a client that
  reloaded can re-render a permission prompt from durable checkpoint state alone. Standard
  Agent Protocol middleware gates the endpoint using the route that parked the interrupts,
  falling back to the route last run on the thread when nothing is parked; a thread with no
  resolvable route is refused with `thread_route_unknown`. Because the endpoint is a `GET`,
  middleware can now observe a `req.method` of `"GET"`, and `req.params` is empty there —
  middleware that assumed `"POST"` or read route params needs updating.

  Parked turns now report thread status `"interrupted"` instead of `"idle"` on
  `GET /threads/{thread_id}`, from the run stream and the resume endpoint. `/runs/wait` is
  a blocking JSON call and still reports `"idle"` when its turn parks; use
  `pending_interrupts` to detect a park there. The `"interrupted"` status is shared with
  cancelled runs, and `pending_interrupts` is the discriminator — a non-empty list means
  the agent is waiting on a human.

  `PendingInterrupt` (exported from `@dawn-ai/cli/runtime`) gains an optional
  `value?: unknown` carrying that payload. It is optional so existing code that constructs
  the object keeps compiling; the parse always populates it.

- 3c68800: Keep Agent Protocol SSE streams alive during silent runs with periodic comment
  frames, and mark run and resume streams `no-transform` for intermediaries.
- a530e70: Documentation only: this package gains a canonical API reference on dawnai.org
  and a concise npm entrypoint. No runtime behavior changed. (`dawn docs` also
  now discovers every registered detailed API page.)
- 3c68800: Fix a case where `dawn docs` could serve a stale bundled documentation set after
  an upgrade.
- 2be1448: Add a first-class Vercel build target with validated Fluid function output,
  static route registration, and source plus prebuilt deployment coverage.
- 3c68800: **Correction: the edge quickstart named the wrong module manifest, and
  `providerPackages` is not exported from `@dawn-ai/cli/fetch`.**

  Two errata against the docs and changelog that shipped with the `hono` build
  target. `dawn docs` carries the fixes.

  - **The `@dawn-ai/cli/fetch` snippet under _Edge runtimes_ imported
    `./.dawn/build/modules.mjs`.** That is the `node` target's manifest: it reaches
    `node:path`, `node:url` and `@dawn-ai/cli/runtime`, which pulls in tsx and
    esbuild. Bundled the way `wrangler` bundles — browser platform, Workers export
    conditions — it fails on fourteen unresolved builtins, several of them bare
    (`fs`, `child_process`), so `nodejs_compat` would not have rescued it either.
    The snippet now names `modules.edge.mjs`, which is what the generated
    `app.mjs` already imported. A new ungated test reads that snippet out of the
    docs page and bundles it under those exact conditions, so the two cannot drift
    again; a negative control bundles the `node` manifest and requires it to fail.

  - **The same section said the fetch entry and the `hono` target could each be
    used "on its own".** `modules.edge.mjs` is emitted only by the `hono` target,
    so the fetch entry alone leaves you with no edge-safe manifest. The two are
    layered, not alternatives: enable `hono`, then compose the pieces it writes
    however you like. Hand-building the manifest remains possible via the exported
    `buildStaticRouteModule` and `DawnStaticModules`, and the docs now say so
    instead of implying the target is optional.

  - **The `0.8.21` changelog entry said `seedModelImporter` and `providerPackages`
    are re-exported from `@dawn-ai/cli/fetch`.** Only `seedModelImporter` is.
    `providerPackages` maps a provider id to its package name — a build-time
    lookup the `hono` target uses to generate the static import switch, and of no
    use to a runtime that needs real static imports rather than package names. It
    is staying where it is rather than being added to the edge entry to make the
    sentence true; it remains public from `@dawn-ai/langchain` for anyone writing
    an import map by hand. Published changelogs are not being rewritten — this is
    the correction.

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

- 1ca14d3: Stop recording an episodic memory for a turn that parked on a human-in-the-loop
  approval. On the non-streaming route path — the one `POST /threads/:id/runs/wait`
  uses — the agent adapter discarded the interrupt and returned only the final
  state, which never carries `__interrupt__` under `streamEvents`. The recorder
  therefore treated the park as a completed run, and the resuming turn recorded a
  second episode for the same run: recall saw both a fragment and a duplicate.

  The adapter now offers `executeAgentTurn`, which reports the final output and
  whether the turn parked, and both route paths tell the recorder which happened.
  `executeAgent` is unchanged for existing callers.

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

- 81ebe73: Load the documentation navigation from the exported registry when generating bundled CLI docs, and include recall time-window inputs in generated route tool types.
- 56d2758: Scaffold the Dawn Workbench alongside the agent.

  `npm create dawn-ai-app` now generates a two-package npm workspace instead of a
  flat server-only app. `server/` holds everything that used to sit at the project
  root and runs on port 3002; `web/` is the Dawn Workbench — a Next 16 client with
  a thread rail, a streaming transcript, plan and subagent activity cards, tool
  cards, permission prompts that survive a reload, a memory-candidate panel, and a
  connect screen — on port 3010. One `npm install` at the root installs both, and
  the root scripts delegate into the package that owns each job.

  The template's web tree mirrors `examples/research/web` under a parity guard that
  compares the two trees byte-for-byte, so the shipped scaffold cannot drift from
  the example it is dogfooded against.

  Two fixes fall out of the restructure. `dawn verify`'s dependency probe now walks
  parent `node_modules` directories the way Node itself resolves, so hoisted
  workspace dependencies are no longer reported as missing. And the generated web
  package ships an ambient CSS declaration, so `npm run typecheck` succeeds on a
  freshly scaffolded app rather than only after a build has generated Next's own
  type declarations.

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

- bcfd42c: Check the model package each app actually needs in `dawn verify`.

  The dependency probe hardcoded `@langchain/openai` and looked for it in the
  app's own `node_modules`, which was wrong in both directions.

  An app whose routes use Anthropic was told to install `@langchain/openai`, which
  it never imports, and was told nothing about `@langchain/anthropic`, which it
  does — an optional peer no install step provides, so the app passed verify and
  then failed at its first model call. The required package now comes from the
  providers the routes use, read from the same provider map `dawn build` uses to
  decide which specifiers to bake into an edge bundle.

  In the other direction, the probe reported packages that were installed and
  working. `@langchain/core`, `@langchain/langgraph` and the provider packages are
  imported by `@dawn-ai/langchain`, not by the app, so the walk now starts at that
  package — resolving its symlink first — and falls back to the app root. Under
  pnpm a package's dependencies sit in the store beside it, reachable from the
  importer and deliberately not from the app, so every pnpm-based Dawn app saw
  three warnings telling it to install packages it already had.

- Updated dependencies [78ab2d7]
- Updated dependencies [95abcf5]
- Updated dependencies [77bf84e]
- Updated dependencies [9d347c8]
- Updated dependencies [6488d32]
- Updated dependencies [bedad77]
- Updated dependencies [a530e70]
- Updated dependencies [3c68800]
- Updated dependencies [8398c90]
- Updated dependencies [3c68800]
- Updated dependencies [3c68800]
- Updated dependencies [1ca14d3]
- Updated dependencies [ffdbcd9]
- Updated dependencies [f317dd7]
- Updated dependencies [908d690]
- Updated dependencies [8e83609]
- Updated dependencies [3c68800]
- Updated dependencies [d42774e]
- Updated dependencies [984c3ad]
- Updated dependencies [496b54c]
- Updated dependencies [67030fa]
- Updated dependencies [730b136]
  - @dawn-ai/ag-ui@0.8.22
  - @dawn-ai/permissions@0.8.22
  - @dawn-ai/langgraph@0.8.22
  - @dawn-ai/langchain@0.8.22
  - @dawn-ai/sqlite-storage@0.8.22
  - @dawn-ai/core@0.8.22
  - @dawn-ai/memory@0.8.22
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

- c2c19da: **`@dawn-ai/postgres-storage`: `assumeMigrated`** — a new opt-out on every store
  option type. `ready()` resolves immediately instead of opening a transaction,
  taking `pg_advisory_xact_lock` and re-running the `CREATE … IF NOT EXISTS` pass.
  Set it only when the same process has already migrated that database to the
  store's current version. It exists for per-request store lifetimes: a store
  memoizes its migration on the instance, so a factory that rebuilds stores every
  request paid three migration transactions per request — and the three advisory
  locks serialized concurrent requests on the same component key. The lock itself
  is unchanged; what is skipped is a pass already known to have completed.

  **`hono` build target fixes.**

  - The generated `stores.mjs` now migrates once per isolate behind a module-scope
    flag and passes `assumeMigrated` thereafter.
  - `wrangler.toml`: the generated marker is read back, so a rebuild recognizes
    its own scaffold instead of warning about it, writing a duplicate into
    `.dawn/build/`, and reporting that duplicate as the artifact. A marked file is
    still never overwritten.
  - The build now fails, naming the config key, when `checkpointer`,
    `threadsStore`, `permissions.store` or `memory.store` is configured: the
    handle cannot cross the build boundary, and the emitted Postgres store was
    taking its place with nothing said.
  - The provider import map is exhaustive or the build fails. A route that cannot
    be imported, or an agent whose provider cannot be inferred, is an error rather
    than a silently narrower map; `summarization.model` is included, so an app
    with openai routes and an anthropic summarization model no longer builds green
    and fails at request time on a package that was never bundled.
  - All validation now runs before the first artifact is written.
  - The emitted entry throws, naming the cause, when no Workers env is bound to a
    request or `DATABASE_URL` is unset, rather than building a pool with no
    connection string.
  - Worker names generated from a package name now start with a letter, which
    Cloudflare requires.
  - `hono` is no longer a dependency of `@dawn-ai/cli`, which does not import it.
    The generated app does, and the build's dependency notice names it along with
    `@dawn-ai/postgres-storage` and `@neondatabase/serverless`.

- c2c19da: fix(edge): resolve the `ctx.fs` filesystem backend at first use, not at route preparation

  `prepareRouteExecution` built the author-facing workspace handle (`ctx.fs`) for
  every route execution, and constructing it resolved a filesystem backend
  eagerly. On a runtime with no boot fallbacks and no `backends.filesystem` in
  config — i.e. every deployed `hono`-target worker — that threw during
  preparation, so every agent turn returned a 500 over a handle the turn never
  touched. A worker could not opt out: the emitted entry inlines only the
  serializable half of `dawn.config.ts`, and the edge capability gate rejects
  `backends.filesystem` because a live object cannot cross a build boundary.

  `createWorkspaceFs` now accepts a thunk for `backend` and resolves (and
  memoizes) it on the first filesystem operation, and the CLI runtime hands it
  one when — and only when — the runtime has no fallback to construct from. The
  failure is deferred, not defused: a route that genuinely reads the workspace
  still throws by name, at the operation that needed a filesystem, with the same
  message it raised before. The node lane is unchanged, backend included: it
  still resolves its process-shared `localFilesystem()` at preparation, since
  there the call cannot fail.

  The `workspaceRoot` guard in `createWorkspaceFs` stays eager — the root is
  known at construction time, so a host that passes a relative one hears about it
  immediately rather than on some later file operation.

- c2c19da: Per-request stores are now disposed only after BOTH the response body has
  settled and the run that request started has released its slot. Route work
  outlives its response on three paths — an aborted AG-UI stream, an abandoned
  `/runs/wait`, a cancelled AP stream — and all three keep writing through the
  stores a response-triggered teardown would have closed. `close()` also waits
  for in-flight disposals, so a host awaiting shutdown knows the pools are shut.

  A runtime that reaches a store no layer supplied now answers with a 500 that
  names the missing store and carries the new `DAWN_E5301` code, instead of a
  generic failure with nothing to diagnose.

- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
  - @dawn-ai/core@0.8.21
  - @dawn-ai/langchain@0.8.21
  - @dawn-ai/sdk@0.8.21
  - @dawn-ai/langgraph@0.8.21
  - @dawn-ai/permissions@0.8.21
  - @dawn-ai/ag-ui@0.8.21
  - @dawn-ai/memory@0.8.21
  - @dawn-ai/sqlite-storage@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/ag-ui@0.8.20
- @dawn-ai/core@0.8.20
- @dawn-ai/langchain@0.8.20
- @dawn-ai/langgraph@0.8.20
- @dawn-ai/memory@0.8.20
- @dawn-ai/permissions@0.8.20
- @dawn-ai/sdk@0.8.20
- @dawn-ai/sqlite-storage@0.8.20

## 0.8.19

### Patch Changes

- 251e1d5: `close()` now drains in-flight runs, not just in-flight HTTP requests, before releasing sandboxes.

  A cancelled `/runs/wait` answers with plain JSON, and the fetch wrapper only holds an in-flight slot for `text/event-stream` bodies — so `activeRequests` had already dropped to zero while the abandoned route was still executing against its sandbox. A routine `close()` (a rolling deploy, say) could therefore call `releaseAll()` mid-tool-call. The same applied to a cancelled stream whose route ignores `ctx.signal`.

  The run registry already tracks exactly this — a run holds its slot for as long as its route may still be running, including after the response was sent — so `close()` now waits on both counters. The wait stays bounded by the existing drain deadline, and cancelling a run can now delay shutdown by up to that deadline rather than returning immediately.

- aecb2e1: `dawn memory --help` now lists the subcommands.

  Commander only knew about `--cwd`, so the help output showed the description and that
  one flag — `consolidate`, `reflect`, `prune` and every subcommand flag were discoverable
  only by triggering an error (running no subcommand, or an unknown one). The usage text
  already existed; it is now attached to `--help` as well.

- 9dde7c6: **New package `@dawn-ai/postgres-storage`** — a Postgres backend for all three
  of Dawn's durable runtime stores (deploy-anywhere B3, PR 2b). Dawn's defaults
  (`.dawn/checkpoints.sqlite`, `.dawn/threads.sqlite`, `.dawn/permissions.json`)
  assume one long-lived process with a writable disk; a multi-instance or
  ephemeral-filesystem deploy has neither.

  ```ts
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  export default config({
    checkpointer: postgresCheckpointer({ pool }),
    threadsStore: createPostgresThreadsStore({ pool }),
    permissions: {
      mode: "non-interactive",
      store: createPostgresPermissionsStore({ pool, mode: "non-interactive" }),
    },
  });
  ```

  - `postgresCheckpointer()` — a LangGraph `BaseCheckpointSaver`. Checkpoints,
    metadata, and pending-write values are stored as opaque `bytea`, matching the
    SQLite backend's BLOB; `jsonb` is deliberately not used, because it rejects a
    NUL byte (SQLSTATE `22P05`) and a lone surrogate (`22P02`), both of which
    reach checkpoints through normal tool output.
  - `createPostgresThreadsStore()` — the Agent Protocol threads store. Two
    behaviors differ from SQLite because Postgres has concurrent writers:
    `createThread` upserts instead of throwing on a duplicate id, and
    `updateMetadata` merges in one statement (`metadata || $1::jsonb`) so a
    concurrent patch cannot be lost.
  - `createPostgresPermissionsStore()` — runtime grants in a shared table rather
    than a per-process JSON file. `match()` is synchronous, so the store is a
    cache with async hydration and delegates the decision to the same
    `matchPermission` the file store uses.

  Any Postgres 14+ database works; no extensions are required. Migrations are
  lazy, memoized per process, and taken under a `pg_advisory_xact_lock`, so N
  instances cold-starting against a virgin database converge rather than racing.
  Options are shared across the three stores (`PostgresStoreOptions`) so one `pg`
  pool can serve all of them. Each store exposes `close()`; a store built from an
  injected pool deliberately does not end that pool, and the runtime handler's
  `close()` never touches stores — the app owns store teardown.

  `pg` opens a raw TCP socket, so these stores run on Node, Bun, and Vercel
  functions. Cloudflare Workers provides no raw TCP and would need Hyperdrive or
  an HTTP-based driver; no Workers configuration is verified here.

  **`@dawn-ai/core`: `DawnConfig.permissions.store`** — a new optional field for
  supplying a custom `PermissionsStore`, additive and defaulting to the existing
  file-backed store. A custom store owns its own mode and allow/deny lists: Dawn
  deliberately does not re-apply the sibling `permissions.mode` / `allow` / `deny`
  fields or the `DAWN_PERMISSIONS_MODE` env override on top of it, since
  re-wrapping would double-apply them. `@dawn-ai/cli` honors the field on both the
  HTTP and direct-call route paths.

  **`@dawn-ai/testing`: three store conformance kits** —
  `runCheckpointerConformance`, `runThreadsStoreConformance`, and
  `runPermissionsStoreConformance`. Each encodes the incumbent SQLite/file store's
  contract and runs against any implementation, so a new backend is held to the
  same behavior rather than to its own. Legitimate capability differences are
  declared with flags rather than asserted away.

- Updated dependencies [9dde7c6]
  - @dawn-ai/core@0.8.19
  - @dawn-ai/langchain@0.8.19
  - @dawn-ai/ag-ui@0.8.19
  - @dawn-ai/langgraph@0.8.19
  - @dawn-ai/memory@0.8.19
  - @dawn-ai/permissions@0.8.19
  - @dawn-ai/sdk@0.8.19
  - @dawn-ai/sqlite-storage@0.8.19

## 0.8.18

### Patch Changes

- 7088072: Fix two defects found smoke-testing the published 0.8.17 artifacts.

  **`dawn memory` subcommand flags were rejected by the CLI.** `memory` is registered as
  `memory [subcommand] [args...]`, and commander claimed every `--flag` after the
  subcommand for itself — so each one failed with `error: unknown option` before the
  handler that parses it ever ran. This made every documented subcommand flag unusable
  from the real CLI: `prune --cap`, `prune --namespace`, and all five distillation flags
  (`--dry-run`, `--namespace`, `--model`, `--provider`, `--max-batches`), including the
  `--dry-run` the cron recipe recommends for a zero-cost plan. The `prune` flags have been
  broken since they were introduced; the distillation flags since 0.8.17.

  The command now uses `passThroughOptions()` (with `enablePositionalOptions()` on the
  program, which commander requires for it). The flags reached the handler correctly all
  along — the repo's tests called `runMemoryCommand([...])` directly and so never crossed
  commander's parsing layer. Added tests that drive the real program.

  **A fresh `create-dawn-ai-app` research app failed `npm test` out of the box.** The
  research template's `test/research.test.ts.template` is kept exactly in sync with the
  dogfooded `examples/research/server/test/research.test.ts`, but the Memory Inspector
  change that reworded CLI approve output to `approved <id> (activated)` updated only the
  example. The template kept asserting `Approved: <id>`, so the default template — the one
  whose generated README tells users to run `npm test` — shipped a failing suite from
  0.8.14 through 0.8.17. Fixed the assertion and added a parity test asserting the shared
  test files stay identical, so the example can no longer be fixed without the template.

- c6b08a9: Add keyed, parent-owned subagent delegation policies with fail-closed
  constraints and approval. Subagents now run as native resumable LangGraph
  subgraphs, and interrupt resume uses one complete multi-entry request envelope.

  This intentionally removes array-form subagent registration, tool policy on
  the internal `task` mechanism, and scalar interrupt resume. Confirm the fixed
  0.x patch release intent with Brian before release.

- Updated dependencies [c6b08a9]
  - @dawn-ai/sdk@0.8.18
  - @dawn-ai/core@0.8.18
  - @dawn-ai/permissions@0.8.18
  - @dawn-ai/langchain@0.8.18
  - @dawn-ai/ag-ui@0.8.18
  - @dawn-ai/langgraph@0.8.18
  - @dawn-ai/memory@0.8.18
  - @dawn-ai/sqlite-storage@0.8.18

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

- 7f4bce6: Memory distillation: `dawn memory consolidate` and `dawn memory reflect`.

  Two explicitly-invoked passes that compact accumulated memories. Neither runs
  automatically — nothing is wired into the runtime, a request, or the lazy
  retention pass.

  **`dawn memory consolidate`** groups active episodic records older than
  `consolidate.olderThanMs` (default 7 days) per (namespace, ISO week), spends one
  model call per batch, and writes a summary record (kind `episodic`, tagged
  `consolidated`, `data = { period, sourceCount, derivedFrom }`, `effectiveAt` at
  the window's end, no expiry by default). The summary is written FIRST and its
  sources superseded only afterwards, so a crash leaves a redundant summary rather
  than orphaned sources with nothing summarizing them. Each superseded source is
  additionally stamped with `consolidate.sourceTtlMs` (default 7 days) so the
  normal prune reaps it later — a superseded row is invisible to `recall` but still
  occupies a slot in the per-namespace episodic cap. Summaries are never
  re-consolidated (`data.derivedFrom` excludes them from every pass).

  **`dawn memory reflect`** derives durable insights per namespace from records
  newer than that namespace's watermark (the highest `data.coveredUntil` on its
  existing reflections), between `reflect.minNewRecords` (10) and
  `reflect.maxRecords` (100). Insights are written as **candidates by default**
  (`reflect.writes: "candidate" | "auto"`) — a model's generalization about your
  users gets a human read before `recall` can surface it. Approve them with
  `dawn memory approve` or the Inspector, exactly like any other candidate write.

  **Cron-safe.** Both commands share the flags
  `[--dry-run] [--namespace <prefix>] [--model <id>] [--provider <id>] [--max-batches <n>]`
  and are threshold-aware no-ops: below the thresholds they print one line, exit
  `0`, and never construct a model — so they never read an API key. `--dry-run`
  reports the full plan while making zero model calls, and `--max-batches`
  (default 5) bounds the spend of any single invocation. That makes
  `0 3 * * * cd /srv/app && npx dawn memory consolidate && npx dawn memory reflect`
  free on an idle app and safe on an app with no credentials configured.

  Configured under `memory.distill` in `dawn.config.ts` (`model` defaults to
  `gpt-5-mini`; `provider` is inferred from the model id, falling back to
  `openai`).

  **Distilled records are written to be findable.** Recall is keyword match, and a
  model asked to generalize writes an abstraction that names none of its sources
  ("earlier-week deployment windows are lower risk" for a batch about _griffin_) —
  which no realistic question retrieves, and for consolidation the sources that did
  carry the name are already superseded. Both distillation prompts now require the
  concrete entities (service and project names, ticket/error identifiers,
  filenames, people) to be carried through verbatim. Measured live, this is the
  difference between an insight that ranks first for "griffin deploys" and one that
  does not appear at all.

  **`recall` no longer invites guessed time windows.** The `since`/`until` schema
  descriptions now steer the model to relative offsets (`"-7d"`, resolved against
  the request clock) and state that it does not know today's date. A model asked
  "what did I work on last week?" would otherwise supply an absolute window from
  around its training cutoff — observed live: a 2026 store queried with
  `since: "2023-10-02"` — which matches nothing, silently, because an empty result
  is indistinguishable from an empty store.

  **Placeholder model output can never destroy history.** Both prompts end with
  their own schema example (`{"summary": "..."}`); a model that echoes it back
  returns a payload that is structurally valid and semantically empty. Written, that
  summary would then supersede the real episodes it claims to summarize — whose
  content is the only other copy. A summary or insight carrying no letter and no
  digit anywhere is now a parse failure, so the batch fails loudly and its sources
  stay active.

  **A zero-insight reflection pass still advances the watermark.** It persists one
  `superseded` sentinel (content `(no insights from this pass)`) carrying
  `coveredUntil`, invisible to `recall`. Without it, a namespace whose memories
  legitimately yield no durable insight was re-examined — and re-paid for — on
  every cron run, forever.

  **One failed source link can no longer split a batch.** A batch is the atom of
  idempotency (its summary id hashes its own source-id list), so each source's
  supersede/expiry pair is now isolated: a transient failure on one source leaves
  that source active and unstamped while the rest of the batch links normally,
  instead of leaving the survivors to form a different chunk — and a second
  overlapping summary — on the next run. The batch still reports as failed.
  `--max-batches 0` now reports the deferred work rather than claiming there is
  nothing to do.

  **`kind: "reflection"` is now accepted** by `defineMemory` and the generated
  `remember` tool, where it previously threw. Reflections are append-only, like
  episodic writes — a later insight never supersedes an earlier one. This is
  **additive, not breaking**: no existing app changes behavior and no action is
  required. `procedural` remains typed-but-unwired and still throws.

- 1a9ae7b: Support TypeScript 7 workspaces and generated apps, and move Dawn's Next.js applications
  to Next 16.3's experimental CLI type checker with `experimental.useTypeScriptCli`.

  Consolidate tool analysis in Core behind one compiler boundary and program, with shared
  projections for declarations, JSON Schema, and Vite Zod metadata. Core internally pins
  the exact TypeScript 6 compatibility wrapper and implementation until the native compiler
  API can be revisited for TypeScript 7.1. Generated JSON schemas now preserve mapped-type
  optionality and use a compiler-neutral fallback for collection intersections.

  Generate collision-safe Vite metadata bindings and remove the unsupported `extractJsDoc`
  and `extractParameterType` exports. Their removal is an intentional breaking change.

  Add permanent packed-consumer and exact-version post-publish verification for the
  TypeScript tooling packages.

- Updated dependencies [713797f]
- Updated dependencies [7f4bce6]
- Updated dependencies [1a9ae7b]
  - @dawn-ai/core@0.8.17
  - @dawn-ai/sdk@0.8.17
  - @dawn-ai/permissions@0.8.17
  - @dawn-ai/langchain@0.8.17
  - @dawn-ai/memory@0.8.17
  - @dawn-ai/langgraph@0.8.17
  - @dawn-ai/ag-ui@0.8.17
  - @dawn-ai/sqlite-storage@0.8.17

## 0.8.16

### Patch Changes

- 451c000: Add `POST /threads/:thread_id/cancel` to stop an in-flight Agent Protocol run, and enforce one run per thread.

  Runs previously had no way to be stopped short of killing the process — the only `AbortSignal` reaching a route was the server shutdown signal. Cancellation now works across `/runs/stream`, `/runs/wait`, and `/resume`, and keeps checkpointed state (LangGraph's `action=interrupt` semantics; there is no rollback). The endpoint returns `200 {thread_id, status:"interrupted"}`, `404` for an unknown thread, or `409` when no run is in flight. A cancelled SSE run ends with `done` carrying `{"cancelled":true}`, distinguishing it from a failure; a cancelled `runs/wait` returns `409` with code `run_cancelled`, since it has not committed to a response body yet.

  **Behaviour change:** a second concurrent run on a thread that is already running now returns `409` with code `run_in_flight` instead of being admitted. Concurrent runs previously drove the same LangGraph checkpoint thread and interleaved their writes last-writer-wins, silently corrupting thread state, so this converts data loss into a clear error. The gate is keyed on in-memory state rather than the persisted thread status, so a process that crashes mid-run does not leave the thread permanently unusable.

  Client-disconnect behaviour is unchanged and now documented rather than incidental: Agent Protocol runs continue (matching LangGraph Platform's `on_disconnect: "continue"` default for a durable, resumable surface), while AG-UI keeps aborting because it is ephemeral with nothing to reattach to.

  Also fixes an unbounded memory leak in the AG-UI handler, which composed `AbortSignal.any([shutdownSignal, requestController.signal])` once per request. A composed signal is retained for the lifetime of its source, and the shutdown signal lives as long as the process, so memory grew with total historical request count and was never freed — roughly 92 MB per 200k requests on Node 24. Both the AG-UI handler and the new run registry use a manual listener with explicit removal instead.

  Run tracking is process-local, so the concurrency gate and `/cancel` assume a single replica — a constraint that already applied to Dawn's pod-local threads database and checkpoints, and is now documented in the `dawn-app` chart README.

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
  - @dawn-ai/memory@0.8.16
  - @dawn-ai/langchain@0.8.16
  - @dawn-ai/ag-ui@0.8.16
  - @dawn-ai/langgraph@0.8.16
  - @dawn-ai/permissions@0.8.16
  - @dawn-ai/sdk@0.8.16
  - @dawn-ai/sqlite-storage@0.8.16

## 0.8.15

### Patch Changes

- 029a2cf: Episodic memory: Dawn apps can now remember what happened. An opt-in runtime
  recorder (`memory.episodes.enabled`) writes one episode per agent run from the
  trace — input, outcome, tools used, duration — with TTL + per-namespace cap
  retention; routes can also author episodes via `defineMemory({ kind: "episodic" })`
  (append-only, never superseded). `recall` gains `since`/`until` time windows
  (ISO or relative like "-24h"); the Inspector gains a timeline view; `dawn memory
prune` runs retention manually.

  BREAKING: `MemoryStore` now requires `prune(opts)`; `search`/`browse` accept
  `since`/`until` and exclude expired rows when `now` is supplied. Custom stores
  must implement `prune` (`runMemoryStoreConformance` enforces the contract).

- 48dbddf: `dawn build`'s node target now emits `.dawn/build/modules.mjs` — a generated
  static module manifest that imports every route, tool, state definition, and
  route memory module and inlines their schemas. The built `server.mjs` boots
  from it, so production startup performs no route-tree scanning or per-file
  discovery. The runtime accepts the manifest via a new optional
  `modules` field on `serveRuntime`/`startRuntimeServer` (absent = dynamic
  discovery, unchanged), and `dawn check` fails on a manifest that has drifted
  from the routes on disk. Static and dynamic serving are verified
  response-equivalent end to end. This is the mechanism the upcoming edge build
  targets consume.
- Updated dependencies [029a2cf]
  - @dawn-ai/memory@0.8.15
  - @dawn-ai/core@0.8.15
  - @dawn-ai/langchain@0.8.15
  - @dawn-ai/ag-ui@0.8.15
  - @dawn-ai/langgraph@0.8.15
  - @dawn-ai/permissions@0.8.15
  - @dawn-ai/sqlite-storage@0.8.15

## 0.8.14

### Patch Changes

- 937be0f: New `@dawn-ai/inspector`: a browser-based runtime inspector (`dawn inspect`) with a
  Memory panel — browse, search (recall-equivalent hybrid), inspect, and govern
  memories with supersede-aware approval. Ships as a scaffold devDependency.

  BREAKING: `MemoryStore` now requires `browse(q?)` and `stats(opts?)`; custom stores
  must implement them (the built-in sqlite/pgvector stores already do, and
  `runMemoryStoreConformance` enforces the contract). The config-facing store type is
  now the full `MemoryStore` contract. `dawn memory approve` now supersedes a
  contradicting active row instead of leaving two actives.

- 83e5153: Load the app once per process. `dawn.config.ts` is memoized per app root; the
  runtime passes its boot-resolved checkpointer, threads store, and permissions
  store into route execution instead of reconstructing them per request (three
  SQLite opens per turn eliminated); the memory store opens lazily on first use
  and is shared between the memory HTTP routes and the memory capability; route
  modules, tools, state, and route memory load once per route and are cached for
  the process lifetime, and the per-request route rediscovery is gone. In
  `dawn dev`, tool/state/reducer edits now restart the child runtime — fixing a
  stale-module bug where such edits silently did not apply (the previous
  re-import mechanism was a no-op under tsx) — and the restart log names the
  reason. Groundwork for build-time static wiring and the edge deploy targets.
- Updated dependencies [937be0f]
- Updated dependencies [83e5153]
  - @dawn-ai/memory@0.8.14
  - @dawn-ai/core@0.8.14
  - @dawn-ai/langchain@0.8.14
  - @dawn-ai/ag-ui@0.8.14
  - @dawn-ai/langgraph@0.8.14
  - @dawn-ai/permissions@0.8.14
  - @dawn-ai/sqlite-storage@0.8.14

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

- 2b6be86: Run app middleware for the `POST /agui/{routeId}` endpoint, matching
  `runs/stream` / `runs/wait` / `resume`. A middleware that rejects now blocks an
  AG-UI run (returning its status/body), and a middleware that returns `context`
  has it threaded into the run — so auth, rate-limiting, and context injection
  apply to AG-UI clients too, not just the Agent-Protocol endpoints.
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
- ee83a96: Add dev-server HTTP endpoints for memory candidates so a web client can review
  durable-memory proposals without the CLI: `GET /memory/candidates`,
  `POST /memory/candidates/:id/approve` (candidate → active, 404/409 guarded), and
  `POST /memory/candidates/:id/reject`. Backed by the same store methods as
  `dawn memory list/approve/reject`.
- 361a9ac: `dawn verify` now runs an environment preflight. A new `runtime` check asserts the running Node version meets Dawn's `22.13.0` floor (a stale Node fails verify) and, when `dawn.config.ts` configures a sandbox provider, runs the provider's Docker daemon preflight. The `deps` env-var check is now provider-aware: it derives the required API-key env var from the providers your routes actually use (e.g. `ANTHROPIC_API_KEY` for an Anthropic-only app) instead of always nagging about `OPENAI_API_KEY`.
- df54695: Internal refactor: the runtime server now runs on a transport-agnostic
  `(Request) => Promise<Response>` core (`createRuntimeFetchHandler`, exported from
  `@dawn-ai/cli/runtime`), with the Node listener reimplemented as a thin adapter
  over it. No behavior change — routes, status codes, headers, JSON error bodies,
  SSE framing, streaming incrementality, and shutdown/drain semantics are
  preserved (verified against the full suite unchanged plus new wire-parity
  tests). The `@dawn-ai/testing` Agent-Protocol harness now drives the fetch core
  directly (dropping `light-my-request`). This is the first step of the
  deploy-anywhere epic: edge build targets (Cloudflare Workers / Vercel / Hono)
  build on this core.
- Updated dependencies [20f0407]
- Updated dependencies [5bbd6e3]
- Updated dependencies [18df470]
  - @dawn-ai/ag-ui@0.8.13
  - @dawn-ai/langchain@0.8.13
  - @dawn-ai/core@0.8.13
  - @dawn-ai/langgraph@0.8.13
  - @dawn-ai/memory@0.8.13
  - @dawn-ai/permissions@0.8.13
  - @dawn-ai/sqlite-storage@0.8.13

## 0.8.12

### Patch Changes

- e413b05: Add a production serve path. `dawn build` now emits a Node/Docker target (a
  `server.mjs` over the Dawn runtime plus a hardened Dockerfile) alongside the existing
  LangSmith `langgraph.json`, selectable via `build.targets`. The new `dawn start`
  command serves the runtime on 0.0.0.0 (HOST/PORT configurable). This is the first
  server that runs the Dawn runtime in production, so a deployed app engages the
  execution sandbox and serves both Agent Protocol and AG-UI. The langgraphjs/LangSmith
  path does not run the runtime and does not engage the sandbox.
- Updated dependencies [e413b05]
  - @dawn-ai/core@0.8.12
  - @dawn-ai/langchain@0.8.12
  - @dawn-ai/ag-ui@0.8.12
  - @dawn-ai/langgraph@0.8.12
  - @dawn-ai/memory@0.8.12
  - @dawn-ai/permissions@0.8.12
  - @dawn-ai/sqlite-storage@0.8.12

## 0.8.11

### Patch Changes

- f0261f1: Add `@dawn-ai/ag-ui`: translate Dawn's runtime stream to the AG-UI protocol and
  serve it at `POST /agui/{routeId}`, so CopilotKit and other AG-UI clients can
  drive Dawn agents. Additive — the existing Agent-Protocol endpoints are unchanged.
- Updated dependencies [f0261f1]
  - @dawn-ai/ag-ui@0.8.11
  - @dawn-ai/core@0.8.11
  - @dawn-ai/langchain@0.8.11
  - @dawn-ai/langgraph@0.8.11
  - @dawn-ai/memory@0.8.11
  - @dawn-ai/permissions@0.8.11
  - @dawn-ai/sqlite-storage@0.8.11

## 0.8.10

### Patch Changes

- e3c253b: Type generated `remember.data` from each route's `defineMemory()` Zod schema
  instead of `Record<string, unknown>`, so route code gets compile-time memory fact
  shape checks that match runtime validation. `pgvectorMemoryStore()` now validates
  the dimension ceiling during construction, failing invalid configs before opening
  a pool or initializing schema.
  - @dawn-ai/core@0.8.10
  - @dawn-ai/langchain@0.8.10
  - @dawn-ai/langgraph@0.8.10
  - @dawn-ai/memory@0.8.10
  - @dawn-ai/permissions@0.8.10
  - @dawn-ai/sqlite-storage@0.8.10

## 0.8.9

### Patch Changes

- d3d94af: Argument-level tool constraints: `agent({ tools: { constrain: { deployProd: (args, ctx) => … } } })` runs a per-tool predicate against the model's arguments at call time, returning allow / deny-with-reason / `{ approve: true }` (escalate to the HITL prompt). Predicates may be async and receive a read-only policy context; a throwing or off-contract predicate fails closed. The tool run context now also carries the live `threadId` + route params. `dawn check` validates `constrain` tool names and warns on `approve`/`constrain` overlap.
- 628f0c1: Add a `kubernetesSandbox` provider: run each thread's sandbox as a Kubernetes Pod
  with a per-thread PersistentVolumeClaim for the durable workspace, implementing the
  same `SandboxProvider` contract as `dockerSandbox`. Tier-1 hardening maps onto Pod
  SecurityContext (non-root via `fsGroup`, read-only rootfs, dropped capabilities,
  no-new-privileges, RuntimeDefault seccomp); sandbox pods mount no ServiceAccount
  token. Per-thread NetworkPolicy provides best-effort egress control (requires a
  policy-capable CNI; `dawn check` warns when unconfirmed). New `resources.diskGb`
  sets the PVC size.
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
- Updated dependencies [ca9bc13]
- Updated dependencies [1dd2147]
  - @dawn-ai/core@0.8.9
  - @dawn-ai/langchain@0.8.9
  - @dawn-ai/memory@0.8.9
  - @dawn-ai/langgraph@0.8.9
  - @dawn-ai/permissions@0.8.9
  - @dawn-ai/sqlite-storage@0.8.9

## 0.8.8

### Patch Changes

- 6fb2b10: Improve the default scaffold and packaged external verification.

  The research scaffold now dogfoods reviewable memory and the Docker sandbox,
  shared scaffold tools can run through sandbox-aware workspace APIs, generated
  apps use pnpm 11 build policy in `pnpm-workspace.yaml`, and packaged scaffold
  tests install the current packed devkit templates instead of stale registry
  contents.

- dd02f56: New memory write-governance mode `writes: "ask"`: memory supersedes (belief contradictions) prompt a HITL Once/Always/Deny interrupt with old-vs-new detail; ADDs and idempotent updates flow silently; headless behaves as `auto`. New `kind: "memory"` permission interrupt, `gateMemorySupersede`, `suggestedMemoryPattern`, and a `dawn check` warning for the `ask` + `approve: ["remember"]` double-gate overlap.
- 57e8cd9: Harden the Docker sandbox by default: drop all Linux capabilities, no-new-privileges,
  a PID limit (512), a read-only root filesystem (workspace + /tmp stay writable), and
  run-as-non-root (uid/gid 1000:1000 via a create-time root chown-init) — expressed as a
  provider-agnostic `SandboxPolicy.security` intent. `resources.timeoutMs` is now enforced
  per command (in-container `timeout`, exit 124). All hardening is on by default with
  per-flag opt-outs (`readOnlyRootFilesystem`, `runAsNonRoot`, etc.). Behavior changes only
  for apps already using `sandbox`; runtime system-directory writes / global installs now
  fail under the defaults — bake system deps into your image or opt out.
- Updated dependencies [dd02f56]
- Updated dependencies [26780ab]
- Updated dependencies [5ccae68]
  - @dawn-ai/core@0.8.8
  - @dawn-ai/permissions@0.8.8
  - @dawn-ai/memory@0.8.8
  - @dawn-ai/langchain@0.8.8
  - @dawn-ai/langgraph@0.8.8
  - @dawn-ai/sqlite-storage@0.8.8

## 0.8.7

### Patch Changes

- 6a683c8: Smarter recall: long-term-memory `recall` now ranks results by IDF-weighted
  relevance blended with recency decay and stored confidence, instead of pure
  recency — a six-week-old fact that actually answers the query outranks
  yesterday's marginal match. Deterministic (no clock, no network, no new deps;
  same store + same query → same order), zero-config (tune via
  `DawnConfig.memory.recall` only if needed), and query-less searches (the
  injected index, `dawn memory list`) keep their recency order.
- Updated dependencies [6a683c8]
  - @dawn-ai/memory@0.8.7
  - @dawn-ai/core@0.8.7
  - @dawn-ai/langchain@0.8.7
  - @dawn-ai/langgraph@0.8.7
  - @dawn-ai/permissions@0.8.7
  - @dawn-ai/sqlite-storage@0.8.7

## 0.8.6

### Patch Changes

- 9d115de: `dawn dev` startup readiness timeout is now configurable via `DAWN_DEV_READY_TIMEOUT_MS` (default unchanged at 5s). Also de-flakes the dev-command disposal test that raced child startup against the readiness window in CI.
- 4ede7b8: Add an opt-in execution sandbox: a provider-agnostic `SandboxProvider` contract
  with a Docker reference (`dockerSandbox`), giving each conversation thread a
  hard-isolated workspace (filesystem + shell + network). Enable via
  `dawn.config.ts` `sandbox: { provider: dockerSandbox({ image }) }`; without it,
  behavior is unchanged. Adds a typed `config()` helper. When sandboxed, the
  materialized agent cache is bypassed so tools bind per-thread. Honest scope:
  Docker's boundary (not a microVM); `allow`-mode network denylist is best-effort
  in the Docker reference. New package `@dawn-ai/sandbox` (+ `@dawn-ai/sandbox/testing`
  `fakeSandbox` and a provider conformance kit).
- 1d51b75: Per-tool approval gating: `agent({ tools: { approve: ["deployProd"] } })` makes any named tool require a HITL permission prompt per call (`kind: "tool"` interrupt). Decisions persist name-level under the reserved `tool` key in `.dawn/permissions.json` (exact-name matching); pre-approve via `permissions.allow.tool`. `dawn check` validates `approve` names and warns on overlap with the internally-gated workspace tools, `deny`, and the unsupported `task` case.
- Updated dependencies [4ede7b8]
- Updated dependencies [1d51b75]
  - @dawn-ai/core@0.8.6
  - @dawn-ai/langchain@0.8.6
  - @dawn-ai/permissions@0.8.6
  - @dawn-ai/langgraph@0.8.6
  - @dawn-ai/memory@0.8.6
  - @dawn-ai/sqlite-storage@0.8.6

## 0.8.5

### Patch Changes

- 91d999c: Add `dawn add <name>` — fetch an integration blueprint (a Markdown guide served from dawnai.org) and print it for your coding agent to apply. `dawn add` lists the catalog; `dawn add <url>` applies a third-party blueprint. Ships with pgvector, pinecone, opentelemetry, and docker blueprints.
- Updated dependencies [f195096]
  - @dawn-ai/core@0.8.5
  - @dawn-ai/langchain@0.8.5
  - @dawn-ai/langgraph@0.8.5
  - @dawn-ai/memory@0.8.5
  - @dawn-ai/permissions@0.8.5
  - @dawn-ai/sqlite-storage@0.8.5

## 0.8.4

### Patch Changes

- f8c3a21: Bundle the Dawn documentation inside `@dawn-ai/cli` as a version-matched markdown tree, add a `dawn docs` command to read it locally, ship a `SKILL.md`, and scaffold a root `AGENTS.md` pointer into new apps. Coding agents can now read Dawn's docs offline, matched to the installed version.
- 4e3e020: Fix long-term memory being unusable by real agents: the generated `remember`/`recall`
  tools now expose input schemas to the model. `remember.data` is the route's own
  `defineMemory()` zod schema (threaded through `MemoryContext.schema`), so the model
  knows exactly what to pass; previously both tools shipped without a schema, so a real
  model called them with empty/invalid args and every write was rejected by validation.
  Found by a live smoke test against a real model — the deterministic aimock suite
  couldn't catch it because it scripts exact tool arguments.
- Updated dependencies [4e3e020]
  - @dawn-ai/core@0.8.4
  - @dawn-ai/langchain@0.8.4
  - @dawn-ai/langgraph@0.8.4
  - @dawn-ai/memory@0.8.4
  - @dawn-ai/permissions@0.8.4
  - @dawn-ai/sqlite-storage@0.8.4

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

- Updated dependencies [2744a5c]
- Updated dependencies [7339ded]
  - @dawn-ai/memory@0.8.3
  - @dawn-ai/core@0.8.3
  - @dawn-ai/langchain@0.8.3
  - @dawn-ai/langgraph@0.8.3
  - @dawn-ai/permissions@0.8.3
  - @dawn-ai/sqlite-storage@0.8.3

## 0.8.2

### Patch Changes

- 5372180: Add `dawn eval --record`. Records replayable aimock fixtures from a real-model
  eval run into per-case sibling `<evalBasename>.<caseSlug>.fixtures.json` files,
  auto-loaded on a plain (replay) `dawn eval`. Inline `script()` fixtures stay
  authoritative (record skips those cases); the gate still applies during record
  but captured fixtures are flushed per-case before the verdict. New
  `@dawn-ai/testing` harness capability: `createAgentHarness({ record: true })` +
  `harness.getRecordedFixtures()`.
  - @dawn-ai/core@0.8.2
  - @dawn-ai/langchain@0.8.2
  - @dawn-ai/langgraph@0.8.2
  - @dawn-ai/permissions@0.8.2
  - @dawn-ai/sqlite-storage@0.8.2

## 0.8.1

### Patch Changes

- 407303f: Friendlier import errors. When a route, tool, or config module fails to load with the opaque ESM error "does not provide an export named X", Dawn now identifies the offending package and explains the likely cause and fix — an older hoisted `@langchain/core` (with the installed-vs-required versions and an `npm ls` pointer) or a CommonJS dependency imported with named bindings under Dawn's ESM resolver. `CliError` now preserves the original error via `cause`. Also aligns `@dawn-ai/sqlite-storage`'s `@langchain/core` peer floor to `^1.1.47` to match the rest of the suite.
- Updated dependencies [407303f]
- Updated dependencies [89b2a73]
  - @dawn-ai/sqlite-storage@0.8.1
  - @dawn-ai/core@0.8.1
  - @dawn-ai/langchain@0.8.1
  - @dawn-ai/langgraph@0.8.1
  - @dawn-ai/permissions@0.8.1

## 0.8.0

### Minor Changes

- Unknown model ids now get advisory warnings instead of late provider 404s. `dawn check`/`verify` warn (exit code unchanged) when an agent route's `model` isn't in the curated list for its resolved provider (`openai`, `google`, `anthropic`, `xai`), with did-you-mean suggestions; the runtime prints the same `[dawn:models]` advisory once per model at chat-model construction. Curated lists are values now (`CURATED_MODEL_IDS` etc.) with types derived, Anthropic and xAI ids included; `validateModelId` and `inferProvider` are exported from `@dawn-ai/sdk`. Note: the narrow `GoogleModelId` union dropped the vendor-retired `gemini-3-pro-preview` (replaced by `gemini-3.1-pro-preview`).

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.7.0

### Minor Changes

- 9fd967f: Friendlier tool-discovery errors. Default-exporting a LangChain `tool()` (StructuredTool) from a route tool file now produces a targeted error naming the export and showing the 3-line plain-function wrapper conversion; the generic "must default export a function" error now describes what was actually exported and links the tools documentation.
- a38ff61: Sandboxed `ctx.fs` for route tools and workflow/graph entries. Tools and route entries now receive a `WorkspaceFs` handle (`readFile`, `readBinaryFile`, `writeFile`, `listDir`) that resolves paths against the route's `workspace/` directory and runs the same permission gate as the agent-facing workspace tools — no more dropping to `node:fs`. The permission gate is extracted to a shared core module; in execution contexts where interactive prompts can't appear (workflow/graph entries), outside-workspace access fails closed with guidance to add an allow rule.

### Patch Changes

- Updated dependencies [a38ff61]
  - @dawn-ai/core@0.7.0
  - @dawn-ai/langchain@0.7.0
  - @dawn-ai/langgraph@0.7.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/sqlite-storage@0.2.0

## 0.6.0

### Patch Changes

- @dawn-ai/core@0.6.0
- @dawn-ai/langchain@0.6.0
- @dawn-ai/langgraph@0.6.0
- @dawn-ai/permissions@0.1.8
- @dawn-ai/sqlite-storage@0.2.0

## 0.5.0

### Minor Changes

- b4a2295: Add eval authoring: a new `@dawn-ai/evals` package (`defineEval`, built-in + `custom` + `llmJudge` scorers, composable `gate.*` policies, `dataset` as array/path/function) and a `dawn eval` command that runs an agent route over a dataset and reports/gates on scores. Default execution is deterministic replay (per-case aimock fixtures, CI-safe); `dawn eval --live` runs the real model locally (gated on `OPENAI_API_KEY`, never in CI). Evals are discovered from `src/app/<route>/evals/*.eval.ts`, mirroring the `run.test.ts` convention.

### Patch Changes

- Updated dependencies [b6e71a7]
  - @dawn-ai/langchain@0.5.0
  - @dawn-ai/core@0.5.0
  - @dawn-ai/langgraph@0.5.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/sqlite-storage@0.2.0

## 0.4.0

### Patch Changes

- @dawn-ai/core@0.4.0
- @dawn-ai/langchain@0.4.0
- @dawn-ai/langgraph@0.4.0
- @dawn-ai/permissions@0.1.8
- @dawn-ai/sqlite-storage@0.2.0

## 0.3.0

### Minor Changes

- b51de58: Add `@dawn-ai/testing` — a productized, aimock-backed package for writing deterministic, CI-safe tests of Dawn agents.

  The model is mocked at the HTTP wire via `@copilotkit/aimock`, so tests exercise the real agent loop, tool calls, streaming, state, offloading, and summarization without a live API key. Three layers, one package:

  - **In-process (default):** `createAgentHarness({ appRoot, route })` runs your route through Dawn's runtime; the fastest layer and the one most users reach for.
  - **http-inject:** `injectAgentProtocol({ appRoot })` drives the full Agent-Protocol request→response pipeline in-process via `light-my-request` (no port bound) — for framework/SSE coverage.
  - **subprocess:** `startSubprocessApp({ appRoot })` boots a real `dawn dev` — for restart/persistence scenarios.

  A fluent `script()` builder compiles multi-turn tool-call conversations to aimock fixtures (auto `turnIndex`/`hasToolResult`, fixed `tool_call_id`s), and `expect*` matchers assert agent behavior: `expectToolCalled().withArgs()`, `expectFinalMessage()`, `expectStreamedTokens()`, `expectState().field()`, `expectOffloaded()`. A local-only `record()` helper captures real interactions into fixtures (CI replays strict/read-only).

  `@dawn-ai/cli` gains a `@dawn-ai/cli/runtime` programmatic export subpath (`streamResolvedRoute`, `createRuntimeRegistry`, `runTypegen`, `createRuntimeRequestListener`, …) and `buildOffload` now resolves the workspace relative to the app root (no behavior change under `dawn dev`, where cwd is the app root).

  `@dawn-ai/langchain` fixes a bug where the streamed `tool_call` event carried `undefined` tool arguments — `on_tool_start` now reads `event.data.input` (the field LangChain populates with tool args), so stream consumers (e.g. UI tool-call displays) receive the real arguments.

  Dawn's own aimock e2e lane (SP5 union schema, SP6a tool-output offloading, conversation summarization) was migrated onto this package in-process, removing the per-test `pnpm pack` + install + dev-server boot.

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

- 55b69f0: Fix tool-output offloading so retrieval tools are exempt. Previously the workspace `readFile` tool — the very tool the agent uses to read back an offloaded output — had its own (large) result offloaded again, replacing it with a second pointer stub. The agent could never see the retrieved content. Retrieval/inspection tools (`readFile`, `listDir`) are now never offloaded; the new `dawn.config.ts` `toolOutput.noOffloadTools` option adds further exemptions (merged with the always-exempt built-ins). Found by a live-API smoke test.
- Updated dependencies [30db6ed]
- Updated dependencies [b51de58]
- Updated dependencies [55b69f0]
- Updated dependencies [2e3bc8d]
- Updated dependencies [8133553]
- Updated dependencies [027b1cc]
- Updated dependencies [d4efa2a]
  - @dawn-ai/langchain@0.3.0
  - @dawn-ai/core@0.3.0
  - @dawn-ai/langgraph@0.3.0
  - @dawn-ai/permissions@0.1.8
  - @dawn-ai/sqlite-storage@0.2.0

## 0.2.0

### Minor Changes

- 17fa4aa: Configurable env loading for `dawn dev` and `dawn verify`. The env file is now resolved by precedence: `--env-file <path>` flag > `dawn.config.ts` `env` field > default `./.env`. Shell-exported variables still win over file contents.

  - New optional `DawnConfig.env` field (a path relative to the app root). Local-only — it does not affect the deploy artifact; `langgraph.json` env detection (`.env.example` → `.env`) is unchanged.
  - New `--env-file <path>` flag on `dawn dev` and `dawn verify`.
  - A shared `resolveEnvPath` resolver now backs both `dev` and `verify`, so they agree on which file they read.
  - `loadEnvFile(dir)` is refactored to `loadEnvFiles(absPaths)` with a back-compat wrapper retained; the LangSmith auto-trace and shell-wins behaviors are preserved.

  This unblocks monorepo apps: a nested app can set `env: "../../.env"` to load the workspace-root env file.

- ad17e85: Upgrade `@langchain/core` (0.3 → 1.x), `@langchain/langgraph` (0.2 → 1.x), `@langchain/openai` (0.3 → 1.x), and `zod` (3 → 4). Removes the dual-zod-version cast workaround in `tool-converter.ts`; `DynamicStructuredTool` now accepts Standard Schema directly. Downstream consumers must align on the new peer ranges (`@langchain/core >=1.1.0`).
- cfc3e8c: Add Agent Protocol HTTP endpoints backed by a Dawn-native SQLite checkpointer (phase-3 sub-project 7).

  - New `@dawn-ai/sqlite-storage` package: `sqliteCheckpointer` (a `BaseCheckpointSaver` over Node's built-in `node:sqlite`, no native deps) and `createThreadsStore`. Requires Node 22.13+ (where `node:sqlite` is available without the `--experimental-sqlite` flag).
  - `dawn.config.ts` gains `checkpointer` and `threadsStore` fields — both pluggable, with SQLite-backed defaults at `.dawn/checkpoints.sqlite` and `.dawn/threads.sqlite`.
  - The dev server's HTTP layer is reshaped to the Agent Protocol: `POST /threads`, `GET`/`DELETE /threads/{id}`, `POST /threads/{id}/runs/stream`, `POST /threads/{id}/runs/wait`, `GET /threads/{id}/state`, `POST /threads/{id}/resume`. The legacy `POST /runs/stream` is removed.
  - Conversation state and permission interrupts now survive a server restart. `MemorySaver` is removed from `@dawn-ai/langchain`; the checkpointer is supplied by the caller. Permission resume is state-based (reads the parked interrupt from the checkpoint) and resolves the route durably from thread metadata.

- dd242ac: Add the `agents-md` built-in capability: Dawn now auto-injects `<workspace>/AGENTS.md` into every agent's system prompt under a `# Memory` heading on every model turn. Always-on (no opt-in marker). Preserves the feedback loop — the agent updates its memory via `writeFile` and the next turn sees the change automatically. Re-reads the file each turn (64 KiB cap; oversize, empty, or unreadable files render empty or a one-line notice).
- 34e615b: Add the first phase-3 harness capability: planning. A `plan.md` file in a route directory now opts the agent into a built-in `write_todos` tool, a `todos` state channel, a Dawn-locked planning prompt fragment, and a `plan_update` SSE event. Introduces `CapabilityMarker` and `applyCapabilities` in `@dawn-ai/core` — the autowiring spine that all later phase-3 capabilities (skills, subagents, etc.) will reuse.
- 2ba0773: Add the phase-3 skills capability. A route with `src/app/<route>/skills/<name>/SKILL.md` files now exposes them to the agent via:

  - An always-on `# Skills` section in the system prompt listing each skill's name + description
  - A `readSkill({ name })` tool the agent calls to load a skill's full body on demand

  Each `SKILL.md` requires YAML frontmatter with `description`; `name` defaults to the directory name and can be overridden. The body lives in conversation history after `readSkill` returns it (not re-injected each turn) — matches the deepagents / Claude Code convention. Typegen includes `readSkill` in `RouteTools` when a route has skills. The chat example ships two seeded skills (`workspace-conventions`, `recover-from-failure`).

### Patch Changes

- 82dd52f: Correct package README links and CLI/runtime examples, export the SDK reasoning type, and fix `dawn build` agent deployment entry generation.
- 13bc466: Fix SSE event payload double-wrap. `toSseEvent` used to emit `data: {"data": <value>}` for the built-in `chunk` event and for capability-contributed events like `plan_update`, when it should emit `data: <value>` directly. The shaped events (`tool_call`, `tool_result`, `done`) are unchanged.
- 36552c1: docs: rebrand "LangGraph Platform" → "LangSmith" in user-visible CLI strings, README, and comments. The `langgraph.json` artifact format is unchanged.
- Updated dependencies [17fa4aa]
- Updated dependencies [82dd52f]
- Updated dependencies [8e02fe1]
- Updated dependencies [ad17e85]
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
  - @dawn-ai/langchain@0.2.0
  - @dawn-ai/langgraph@0.2.0
  - @dawn-ai/sqlite-storage@0.2.0
  - @dawn-ai/permissions@0.1.8

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

  - @dawn-ai/core@0.1.8
  - @dawn-ai/langchain@0.1.8
  - @dawn-ai/langgraph@0.1.8

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

- Updated dependencies [db635b1]
- Updated dependencies [db635b1]
  - @dawn-ai/langchain@0.1.7
  - @dawn-ai/core@0.1.7
  - @dawn-ai/langgraph@0.1.7

## 0.1.6

### Patch Changes

- Use codegen schemas in dawn build output — tool descriptions and JSON Schema from .dawn/routes/<id>/tools.json are now injected into generated entry files for LangGraph Platform deployment.
  - @dawn-ai/core@0.1.6
  - @dawn-ai/langchain@0.1.6
  - @dawn-ai/langgraph@0.1.6

## 0.1.5

### Patch Changes

- 0127c57: Fix tool schema wiring so OpenAI receives valid function parameters from codegen-generated tools.json
- Updated dependencies [0127c57]
  - @dawn-ai/langchain@0.1.5
  - @dawn-ai/core@0.1.5
  - @dawn-ai/langgraph@0.1.5

## 0.1.4

### Patch Changes

- 86e24c0: Switch to pure OIDC trusted publishing (no npm token required)
  - @dawn-ai/core@0.1.4
  - @dawn-ai/langchain@0.1.4
  - @dawn-ai/langgraph@0.1.4

## 0.1.3

### Patch Changes

- 78745f6: chore: validate trusted publishing pipeline
  - @dawn-ai/core@0.1.3
  - @dawn-ai/langchain@0.1.3
  - @dawn-ai/langgraph@0.1.3

## 0.1.2

### Patch Changes

- Fix watch-mode typegen not picking up file changes due to ESM import cache
  - @dawn-ai/core@0.1.2
  - @dawn-ai/langchain@0.1.2
  - @dawn-ai/langgraph@0.1.2

## 0.1.0

### Minor Changes

- fbe7770: Add codegen wiring to dawn dev and build commands

  - `dawn typegen` now emits `.dawn/routes/<id>/tools.json` and `.dawn/routes/<id>/state.json` alongside the existing `.dawn/dawn.generated.d.ts`
  - `dawn dev` runs typegen on startup and re-runs on state.ts/tools changes (path-based watch routing with 100ms debounce)
  - `dawn build` runs typegen as a pre-step after route discovery
  - App template includes zod-based state.ts for stateful route scaffolding

### Patch Changes

- Updated dependencies [fbe7770]
  - @dawn-ai/core@0.1.0

## 0.0.2

### Patch Changes

- 5c18b2d: Fix workspace:\* protocol leaking into published package dependencies.
- Updated dependencies [5c18b2d]
  - @dawn-ai/core@0.0.2
  - @dawn-ai/langchain@0.0.2
  - @dawn-ai/langgraph@0.0.2

## 0.0.1

### Patch Changes

- 0f32260: Normalize the public Dawn packages for publishing, including release metadata,
  packed artifact validation, and packaged template assets for `@dawn-ai/devkit`.

  Make `create-dawn-app` standalone by default so external scaffolds use release
  channel package specifiers, while keeping explicit internal monorepo scaffolding
  behind a guarded `--mode internal` path.

- Updated dependencies [0f32260]
  - @dawn-ai/core@0.0.1
  - @dawn-ai/langchain@0.0.1
  - @dawn-ai/langgraph@0.0.1
