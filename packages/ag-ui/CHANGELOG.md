# @dawn-ai/ag-ui

## 0.13.2

### Patch Changes

- c8b0675: AG-UI `TOOL_CALL_RESULT.content` now carries the tool's output — the text the model received — instead of the serialized LangChain `ToolMessage`. Permission interrupts name the tool call they gate (`toolCallId`; command, tool and memory gates), a tool, command or memory gate raised inside a subagent also carries `subagentRunId`, and every permission prompt advertises its answers as `responseSchema: { type: "string", enum: ["once", "always", "deny"] }`.
- 919eae4: New `@b4run/ag-ui/view` entry: the framework-free client half. `reduceTurns` folds AG-UI events into a thread's turns — tool steps with their `b4.step` labels, the plan, reasoning, nested subagent turns, and approvals attached to the calls they gate — and `stepLabel`/`groupSteps` turn steps into sentences. `reduceSubagentRuns` moved here (still re-exported from `./react`).
- 6b7f152: Advertise a route's AG-UI capabilities. `GET /agui/:routeId` returns an AG-UI `AgentCapabilities` document — client-provided tools, structured output, interrupts and approvals — computed by the same checks `POST` enforces, behind the same route middleware. `@b4run/ag-ui/client` adds `B4HttpAgent`, an `HttpAgent` whose `getCapabilities()` reads it, so CopilotKit's `/info` reports them; `@ag-ui/client` is an optional peer dependency for that subpath.
- ed43d4f: Carry AG-UI 1.0 content parts to the model. A user message's `image`, `audio`, `video` and `document` parts — inline, by URL, or as a provider file handle — reach the route's model as LangChain content blocks; what the model cannot take (read from its LangChain profile) is dropped and announced, in the server log and on the stream as `CUSTOM` `b4.content_parts_dropped`, never refused: the `422` envelope rejection of media parts is gone. Tools may return `B4ContentPart[]` (new in `@b4run/sdk`), which travels as `TOOL_CALL_RESULT.content`. The Agent Protocol run endpoints now bound their bodies at the same 8 MiB as `/agui`. `B4Message.content` (`@b4run/ag-ui`), `UnwrappedToolResult.content` (`@b4run/langchain`) and `MiddlewareAfterMessage.content` (`@b4run/sdk`) widened from `string` to `string | readonly B4ContentPart[]`, and chain, graph and workflow routes now receive `messages[].content` as that part array whenever the client sent parts (previously flattened to text), so code that narrows on `string` must handle the array.
- 2d07889: Serve the AG-UI HTTP+protobuf binding. `POST /agui/:routeId` answers `application/vnd.ag-ui.event+proto` — 4-byte big-endian length-prefixed protobuf frames — whenever the request's `Accept` admits it with a positive quality (named, or through a wildcard such as `*/*`), and `text/event-stream` otherwise; `@ag-ui/client` and CopilotKit name SSE and are unaffected. `GET /agui/:routeId` advertises `transport.httpBinary`, `reasoning: { supported: false }` and `state: { snapshots: false, deltas: false }` plus `persistentState` where B4.run wires the checkpointer (`true` for `agent()` routes, `false` for chain, graph and workflow routes, omitted otherwise).

  **Breaking:** `@b4run/ag-ui/sse` no longer exports `encodeAgUiSse(event, accept): string`. Use `encodeAgUiEvent(event, accept): Uint8Array<ArrayBuffer>` for the frames and `agUiContentType(accept): string` for the header; both follow one negotiation rule. Unlike `encodeAgUiSse`, which wrote SSE whatever `accept` said, `encodeAgUiEvent` writes protobuf when `accept` admits it (including `*/*`): set `content-type` from `agUiContentType(accept)`, or call `encodeAgUiEvent(event)` without `accept` to keep SSE unconditionally. The bump is `patch` by the fixed-group 0.x convention. HTTP clients that do not name `text/event-stream` — `curl`, or `fetch` without an `accept` header, both of which send `*/*` — now receive protobuf from `POST /agui/:routeId`; send `accept: text/event-stream` to keep SSE.

- f13a243: `@b4run/ag-ui`'s optional `@copilotkit/react-core` peer range is now `>=1.76.0`. 1.76.0 is the first `@copilotkit/react-core` whose bundled AG-UI client speaks 1.0, the protocol B4.run serves since 0.13.1; earlier releases resolve a pre-1.0 `@ag-ui/*` (0.0.59 on 1.70–1.75) and cannot talk to the endpoint. The `/react` renderers are unchanged. pnpm warns about the unmet optional peer and installs; npm 7+ rejects it with `ERESOLVE`, so an app pinned below 1.76.0 upgrades CopilotKit together with `@b4run/ag-ui` (or installs with `--legacy-peer-deps`).
- 5caad96: **Breaking:** `agent()`'s `reasoning` is keyed by provider. `reasoning: { effort }` becomes `reasoning: { openai: { effort } }`; a flat `effort`, an unknown key, or a block for a provider the route does not resolve to now fails the route when its model is built (before, a misplaced setting was silently ignored — and the OpenAI effort itself never reached the request, because it was passed as the constructor field `reasoningEffort`, which `@langchain/openai` reads only per call). New controls make reasoning visible: `openai.summary: "auto" | "concise" | "detailed"` streams a reasoning summary (and moves the route to the Responses API); `anthropic.budgetTokens` enables extended thinking. The langchain adapter carries thinking and reasoning blocks as `reasoning` stream chunks; `@b4run/ag-ui` frames them as AG-UI 1.0 `REASONING_START` / `REASONING_MESSAGE_*` / `REASONING_END`, one span and one `role: "reasoning"` message per model invocation, every one closed before the run ends. `GET /agui/:routeId` advertises `reasoning: { supported: true, streaming: true, encrypted: false }` exactly when the route's config makes reasoning stream, `{ supported: false }` otherwise. `IdFactory` gains the `reasoning` and `reasoningSpan` kinds.

  `@b4run/testing`'s `finalMessage` now reads an assistant message whose `content` is a list of blocks (the OpenAI Responses API, Anthropic with tools bound), joining its `text` blocks; before, such a run reported an empty final message.

- 0cd999a: **Breaking (Agent Protocol stream):** a subagent's events now carry the same shapes as the root's. `subagent.message { chunk }` is replaced by `subagent.token { data, messageId }`; `subagent.tool_call` / `subagent.tool_result` carry `name` under the model's tool-call `id` instead of `tool` under an execution run id; new `subagent.reasoning`, `subagent.message_end` and `subagent.tool_call_args`; `subagent.start` gains `parent_call_id` (nested children) and `description`. The langchain adapter announces a child's tool calls from its own model turn with the same per-owner bookkeeping root uses, the dev server's attach digest coalesces `subagent.token` per child invocation, `@b4run/testing` reads the new shapes, and `@b4run/ag-ui` consumes them at the activity boundary with no change on the AG-UI wire (the `SUBAGENT_*` presentation follows in the next release).
- 0b33206: **Breaking:** subagents are presented with AG-UI 1.0's `SUBAGENT_STARTED/FINISHED/ERROR` events and `subagentRunId` attribution; the `b4.subagent` activity is removed. `toAguiEvents` announces a subagent when the `task` tool starts it (`subagentRunId` is the `task` tool-call id; `parentToolCallId`, `parentSubagentRunId` and `description` are carried), tags the child's text, reasoning, tool calls, results, usage and plan with that id, and closes every announced invocation before the run ends — `SUBAGENT_FINISHED { result }` on success, `{ outcome: suspended, interruptIds }` at a child's interrupt (the interrupt carries the child's `subagentRunId`), `SUBAGENT_ERROR` on failure, cancel (`code: "cancelled"`) or a stream that ended first (`code: "unterminated"`). The `task` call is an ordinary tool call again. Removed: `B4_SUBAGENT_ACTIVITY_TYPE`, `B4SubagentActivityContent`, `SubagentActivityCard`, `b4SubagentActivityRenderer`, `subagentActivityContentSchema`, `SubagentActivityContentOutput`; `b4ActivityRenderers` holds the plan renderer only. New in `@b4run/ag-ui/react`: `useSubagentRuns(agent)`, `reduceSubagentRuns`, `EMPTY_SUBAGENT_RUNS`, `isSubagentMessage`, `SubagentPanel` and the `SubagentRun` types. `GET /agui/:routeId` advertises `multiAgent: { supported, delegation, handoffs: false, subagents: [{ name, description }] }` from the subagent registry the `task` tool dispatches from. The research example, the research scaffold and the chat web client render subagents with the panel.
- 31c2633: AG-UI terminal events now report token usage. `RUN_FINISHED` (every outcome) and `RUN_ERROR` carry `usage: TokenUsage[]` — one entry per provider and model, aggregated across the run including subagent calls, with the protocol's inclusive totals and no zeros for counts a provider did not return; the key is omitted when nothing was reported. The langchain agent adapter emits a `usage` stream chunk (`{ provider, model, usage_metadata }`, a `subagent.usage` for a child's call) per finished model call, which also reaches the Agent Protocol stream as `event: usage`.
- 91726d5: The tool-call record behind client-provided tools now covers every tool call on an AG-UI run where the store is resolved (a route listed in `server.agui.clientTools`, `server.agui.clientToolStore` set, or the default `.b4/client-tool-calls.sqlite` still present from an earlier opt-in), on every route. A server tool call is recorded as identity only — thread, route, run, tool name, issued and settled times; no result text — and is never answerable. A `role: "tool"` message is consumed only when it names an open client call this server issued; one naming a server call, a closed call, or nothing is history. `RUN_FINISHED`'s `pendingToolCallIds` is now read from the record, scoped to the calls this run left parked.

  - `ClientToolCallRecord` gains `kind` (`"client" | "server"`) and `settledAt`; `ClientToolCallStore` gains `settle`; `ClientToolRecorder` gains `issue` and `settle`. An operator-supplied `clientToolStore` must implement `settle` or the boot fails naming it. The SQLite and Postgres stores append migration 2 (`kind`, `settled_at`); existing rows read as `client`.
  - The client-tool-call prune now also deletes server rows settled before the window (`server.agui.clientToolRetentionMs`); open rows of either kind are never deleted.
  - `B4ToolDefinition` gains an optional `clientTool: true` marker, set only by the client-tool stub. `@b4run/ag-ui`'s `pendingToolCallIds` option may return a Promise; a rejection ends the run as `RUN_ERROR`.

  Behavior changes on an app with a store:

  - Every server tool call on every AG-UI route is written to the store before it runs and settled after; a write failure fails that tool call. With the store unavailable, server tool calls on AG-UI runs fail until it is back. Apps with no store are unchanged.
  - Rolling upgrades on a shared Postgres store: a replica on the previous version has no `kind` filter and reads new server rows as open client rows (it may void them). Nothing becomes answerable, but finish the rollout before mixing traffic.

- bbc7871: Tools can export `display` (`ToolDisplay`): an icon and `running`/`done`/`sources` functions that say how a call reads to a person. The runtime evaluates it per call, streams it to AG-UI clients as `CUSTOM` `b4.step` events (`running` as the call starts, `completed` as it returns — both before the result; `failed` after an error result for every tool), and keeps it on the checkpointed tool message (`additional_kwargs.b4_step`). `b4 check` validates the export. The built-in workspace, memory, skill, plan and subagent tools ship labels. Built-in tools now carry labels, so the Agent Protocol stream gains `step`/`subagent.step` chunks.
- Updated dependencies [2c33a3f]
- Updated dependencies [ed43d4f]
- Updated dependencies [5caad96]
- Updated dependencies [61e5922]
- Updated dependencies [b61e133]
- Updated dependencies [91726d5]
- Updated dependencies [bbd4a0c]
- Updated dependencies [9547137]
- Updated dependencies [bbc7871]
  - @b4run/sdk@0.13.2

## 0.13.1

### Patch Changes

- 0c76234: Move to AG-UI protocol 1.0 (`@ag-ui/core`/`@ag-ui/encoder` 1.0.1; `@ag-ui/client` optional peer `>=1.0.1 <2.0.0`; validators at `@ag-ui/core/schemas`). Approval grants (new in this release) travel over AG-UI in `metadata.grant` only, on interrupts and on resume entries; a 1.0 client strips a top-level `grant` in both directions. Breaking for AG-UI clients relative to 0.13.0: a cancelled or shut-down run ends with `RUN_FINISHED { outcome: cancelled }` instead of `RUN_ERROR`; a request declaring a foreign protocol major is refused with `400 unsupported_protocol_version`; a null route result is omitted rather than sent as `result: null`; messages carrying image, audio, video or document parts are refused with `422 multimodal_not_supported` until multimodal input lands. `RUN_STARTED` declares `protocolVersion: "1.0"`; a turn that leaves client-provided tool calls parked names them in `outcome.pendingToolCallIds`; 1.0 content parts are read as text; reasoning and activity history is dropped on the way in. Examples and the research scaffold pin CopilotKit 1.76.0 and `@ag-ui/client` 1.0.1 exactly.
- 17f16ea: Add **approval grants**: a single-use capability bound to one parked tool call, minted when B4.run parks a human-in-the-loop approval and required when that approval is answered.

  Until now a parked approval was addressed by `interruptId` and `resumeKey`, and neither is a credential — `interruptId` is a timestamp plus ~31 bits of `Math.random`, disclosed in the persisted envelope, and `resumeKey` is LangGraph's deterministic position hash. `ThreadAccessPolicy` gates _who_ may touch a thread, but disclosure control is not consumption control: inside a session that legitimately holds the thread, nothing stopped the same approval being answered twice (applying a financial allocation twice) or an approval minted against an earlier proposal being applied to the current one. Replay protection was emergent from LangGraph advancing the checkpoint, not enforced or tested.

  A grant is 32 CSPRNG bytes, stored only as a SHA-256 hash in a B4-owned table added by an additive versioned migration under the existing `runMigrations` advisory lock. It is minted at the park site in `@b4run/core`, reaches the client on the channels that already carry the prompt (the AG-UI interrupt, `GET /threads/:id/pending_interrupts`, the attach `state` frame), and comes back as an opaque `grant` on the resume entry. Consumption is a conditional `UPDATE … WHERE consumed_at IS NULL` — atomic, durable, replica-safe. A reused grant gives `409 grant_consumed` echoing the recorded decision rather than re-executing; a wrong grant gives `403 grant_invalid`, indistinguishable from "no such row" so the endpoint is not an oracle; a grant whose parked call the thread has moved past is voided and gives `409 stale_interrupt`. `deny` and `cancelled` consume the grant too — a denial is a decision, and a re-answerable denial is a replay surface of its own.

  Off by default. `approvals.grants` in `b4.config.ts` takes `"off"` (unchanged behavior), `"optional"` (an interrupt that **has** a grant requires it; one parked without a grant resumes as before — the softness is per-interrupt-age, never per-request, or `"optional"` would be a bypass), or `"required"`. The minter is injected through LangGraph's `config.configurable`, the same channel this repo already uses for live per-call identity, so nothing in core's call graph grows a storage handle. That injection is optional by construction, and the absence **fails closed**: under `"required"`, a park with no minter aborts the turn loudly rather than parking a prompt that cannot be answered safely.

  Two limits, stated rather than implied. At-most-once _delivery_ is not exactly-once _effect_ — an application's own idempotency key does not become redundant. And the plaintext grant is at rest in the checkpointer's `writes`, because the park site carries it in the interrupt envelope; the hash-only grant store protects the consumption ledger, not the checkpoint.

## 0.13.0

## 0.12.0

## 0.11.2

## 0.11.1

## 0.11.0

## 0.10.0

### Minor Changes

- 1cadde8: Tool-call arguments now stream as they are generated. The LangChain agent adapter projects the argument fragments a provider streams into `tool_call_args` chunks, re-serialized token by token so their concatenation matches the `JSON.stringify(args)` delta sent today byte for byte, and the AG-UI translator emits them as one `TOOL_CALL_START`, several `TOOL_CALL_ARGS` deltas and one `TOOL_CALL_END` under the call's logical id. A client that renders from a tool call's arguments can paint progressively, the way it does for assistant text. Tool execution still receives the complete, parsed arguments from the unchanged `tool_call` announce; providers that stream no fragments produce exactly the output they did before; the built-in `writeTodos` and `task` calls stay on the single-delta path. The runtime's middleware `after` hook treats a fragment as proof a held message was not final, and the live tail renders nothing for fragments.

## 0.9.0

### Patch Changes

- 6a59e00: Add an `after` hook to the middleware lifecycle definition. `defineMiddleware({ handle, after })` runs `after` once per AG-UI run with the agent's final assistant message and the context `handle` allowed, before the client sees the message: return nothing to keep it, `{ finalMessage }` to replace it, or `reject(...)` to end the run with a `RUN_ERROR` (code `middleware_rejected`). With the hook defined the final assistant message is buffered and delivered whole before `RUN_FINISHED`; text before a tool call still streams live, and an app without the hook emits exactly the events it did before. `@b4run/ag-ui`'s `toAguiEvents` now forwards a string `code` from an upstream error onto `RUN_ERROR`.

## 0.8.36

## 0.8.35

## 0.8.34

## 0.8.33

### Patch Changes

- a239527: Keep concurrent nested model output in separate AG-UI assistant messages. Carry
  model invocation identity through runtime tokens and live-turn snapshots, and
  close each message when its model finishes. Legacy anonymous tokens and raw SSE
  string payloads remain supported.

## 0.8.32

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

- 21654e8: Align the CopilotKit v2 examples, research scaffold, and Dawn AG-UI runtime on CopilotKit 1.70 and AG-UI 0.0.59.
- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.

## 0.8.22

### Patch Changes

- 78ab2d7: Give the plan and subagent activity cards Dawn's visual identity, plus a
  customization ladder. Import `@dawn-ai/ag-ui/react/styles.css` for the default
  look in light and dark; override CSS custom properties to restyle; pass
  `classNames` to layer your own classes onto any part; pass `components` to
  replace a todo or tool row outright. Cards render structured-but-unstyled when
  the stylesheet is not imported, and every rule that styles an element is
  scoped so the sheet cannot affect the rest of your app.

  The stylesheet is the only styling the cards carry, so importing it is the
  difference between the default look and bare markup.

- 95abcf5: Expose Dawn planning and subagent progress as bounded standard AG-UI activity
  snapshots. The research web example renders plan checklists and delegated-work
  status from those snapshots, which exclude child prose, prompts, tool inputs,
  tool outputs, and final child answers. The generated research starter renders these
  activities in the web client it ships.
- 77bf84e: Close six gaps in the activity cards' customization ladder. The default
  appearance is unchanged.

  Rung 1 gains four custom properties — `--dawn-activity-margin`,
  `--dawn-activity-padding`, `--dawn-activity-header-weight`, and
  `--dawn-activity-badge-bg` — so the card's box spacing, the header's weight, and
  the depth badge's background are reachable without ejecting. `--dawn-activity-badge-bg`
  defaults to `var(--dawn-activity-border)`, so the badge keeps following the
  palette until it is pointed elsewhere. All three of the sheet's token blocks are
  now wrapped in `:where()`: they carry no specificity, so an application's own
  `:root` override wins in dark mode and under `data-dawn-theme`, not only in
  light. Overriding a token used to require a doubled `:root` selector to beat the
  package's own dark palettes.

  Rung 2 gains two `classNames` keys. `checklist` targets `ActivityChecklist`'s
  wrapper, and `marker` targets the disclosure triangle, which is now a real
  `aria-hidden` span instead of a `::before` — so it can be restyled, and its glyph
  no longer lands in the summary's accessible name.

  Four details worth knowing about the resulting surface:

  - `classNames.section` targets a card's labelled region only, so it is inert on
    `PlanActivityCard` and on a standalone `ActivityChecklist`. Use
    `classNames.checklist` for the checklist wrapper. Keeping them separate means
    one key cannot land on two nested elements and draw a box twice.
  - The disclosure marker is `.dawn-activity__marker` and the checklist wrapper is
    `.dawn-activity__checklist`.
  - Because the marker is a real element rather than generated content, its glyph
    is part of a `<summary>`'s `textContent`. Text assertions over a card header
    should expect it.
  - A partial `:root` palette override applies in dark mode and under
    `data-dawn-theme`, not only in light. Set palette tokens as a set, or point
    them at values that are themselves theme-aware, so a half-overridden palette
    does not mix with the package's.

  `classNames` entries are appended to the package defaults and never
  substituted, but the stylesheet is unlayered, so an appended class only takes
  effect on a property the sheet leaves unset on that element. The README says
  which properties those are and which remain rung-4 work.

- 9d347c8: Ship the plan and subagent activity renderers as `@dawn-ai/ag-ui/react`. A
  CopilotKit client can now render Dawn's built-in orchestration by passing
  `dawnActivityRenderers` to `renderActivityMessages`, instead of copying React
  components out of an example. The card components, the content schemas, and
  the parsed subagent content type are exported too, for clients that want their
  own presentation. React and `@copilotkit/react-core` are optional peer
  dependencies, so server-only consumers install nothing extra.
- 6488d32: Align the rxjs devDependency with the one `@ag-ui/client` actually uses.

  `@ag-ui/client` and its middleware siblings pin rxjs to exactly `7.8.1`, while
  this package's test-only devDependency asked for `7.8.2`. Two copies of rxjs
  meant two nominally distinct `Observable` declarations, so a test consuming a
  stream produced by `@ag-ui/client` could not describe it in types. rxjs is used
  only by the conformance test here; matching the version the objects come from is
  the point of the pin.

- a530e70: Documentation only: this package gains a canonical API reference on dawnai.org
  and a concise npm entrypoint. No runtime behavior changed. (`dawn docs` also
  now discovers every registered detailed API page.)
- 908d690: Carry the model's tool-call ID from a tool execution into the capability
  stream: `StreamTransformerInput` gains an optional `toolCallId`, and the
  planning capability echoes it as `tool_call_id` on `plan_update`. Child
  capability events keep their subagent's tool-call ID internal. This is the
  correlation plumbing behind presenting built-in orchestration work once; the
  presentation change that consumes it ships in this same release.
- 8e83609: Present each built-in orchestration action once. A `writeTodos` call whose plan
  activity was emitted, and a `task` call whose subagent activity was emitted, no
  longer also produce generic tool-call events, so activity-aware AG-UI clients
  stop showing a duplicate card for the same work. Every other tool is unchanged,
  and the generic events return as a fallback whenever the activity cannot be
  produced. An interrupt now also carries the tool-call ID it belongs to, taken
  from the Dawn envelope's call ID.

## 0.8.21

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

## 0.8.12

## 0.8.11

### Patch Changes

- f0261f1: Add `@dawn-ai/ag-ui`: translate Dawn's runtime stream to the AG-UI protocol and
  serve it at `POST /agui/{routeId}`, so CopilotKit and other AG-UI clients can
  drive Dawn agents. Additive — the existing Agent-Protocol endpoints are unchanged.
