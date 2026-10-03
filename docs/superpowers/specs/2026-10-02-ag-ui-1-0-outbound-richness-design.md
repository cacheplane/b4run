# AG-UI 1.0 sub-project 2 — outbound richness: usage, reasoning, subagent lifecycle and attribution

Issue: cacheplane/b4run#885. Parent spec:
`docs/superpowers/specs/2026-10-01-ag-ui-1-0-cutover-design.md` (§3.1 and §9
name this sub-project). Cut-over landed in #888 (`0c76234d`); capabilities
(`GET /agui/:routeId`) are PR #883.

Spec sources, read from `ag-ui-protocol/ag-ui` `docs/spec/1.0/` and the
`@ag-ui/client` 1.0.1 source (`verify/verify.ts`, `apply/default.ts`,
`enforce/enforce.ts`) on 2026-10-01: `events/reasoning.mdx`,
`events/subagents.mdx`, `events/lifecycle.mdx` (token usage, steps),
`events/activity.mdx`, `basic/capabilities.mdx`, `schema.json`.

## 1. Decisions

Accepted during brainstorming on 2026-10-01/02; implementation does not
relitigate them.

1. **Three features in, two deferred.** In: `usage`, `REASONING_*`,
   `SUBAGENT_*` with `subagentRunId` attribution. Deferred with rationale
   (§8): `ACTIVITY_DELTA`, `STEP_*`.
2. **Reasoning text is produced, not just translated.** Both providers get
   the knob that makes reasoning stream: OpenAI Responses `summary`,
   Anthropic extended-thinking `budgetTokens`.
3. **Provider-shaped `ReasoningConfig`** (`{ openai?: {...}, anthropic?: {...} }`),
   replacing the flat `{ effort }`. A sub-object for a provider the route does
   not resolve to is a route-load error. Breaking; no compatibility shim.
4. **`SUBAGENT_*` plus the attributed child stream is the only subagent
   representation.** The `b4.subagent` activity, `SubagentActivityCard`, and
   the ledger's suppression of `task` tool frames are removed. Child text,
   reasoning, tool calls/results and plan go on the wire tagged
   `subagentRunId`, always — no per-route switch. Breaking; no compatibility
   shim.
5. **Examples migrate** (chat web, research web, research scaffold template)
   to the new events in the same PR that makes the breaking change.
6. **Capability claims are derived from the code that enforces them**:
   `reasoning.supported` from the exact fields the chat-model factory
   forwards, `multiAgent.subagents` from the descriptor map the `task` tool
   dispatches from.

## 2. Architecture

Nothing in LangGraph, the Agent Protocol handlers, or the SSE
`/threads/:id/stream` encoding changes. Two layers change.

### 2.1 Producer — `packages/langchain/src/agent-adapter.ts`

`classifyStreamEvent` emits new and changed `AgentStreamChunk`s. Unknown chunk
types already pass through every other consumer (`execute-route-core` default
branch, `middleware-after`, `live-turn-hub`, `@b4run/testing` `run-result`,
SSE `event: <type>`), so the new types are harmless outside AG-UI.

| Chunk | Source | Shape |
|---|---|---|
| `reasoning` | `on_chat_model_stream` content blocks of type `thinking` (Anthropic, field `thinking`), `reasoning` (LangChain standard, field `reasoning`; OpenAI Responses, `summary[].text`) | `{ type: "reasoning", data: string, messageId: run_id }` — the same `messageId` the invocation's `token`s carry; the invocation's `message_end` closes both. Empty text emits nothing. |
| `usage` | `on_chat_model_end` `output.usage_metadata` (object), root and child | `{ type: "usage", data: { provider?: string, model?: string, usage_metadata: unknown } }`; `provider` = `metadata.ls_provider` lower-cased, `model` = `metadata.ls_model_name`; each omitted when absent |
| `subagent.start` | `b4.subagent` custom event, `phase: start` | existing `{ call_id, subagent, route_id, depth }` plus `parent_call_id?` (the previous `metadata.b4.subagent_stack` entry's `callId`, present at depth ≥ 2) and `description?` (the child descriptor's `description`) |
| `subagent.end` | unchanged | `{ ...identity, final_message }` or `{ ...identity, error }` |
| `subagent.token`, `subagent.message_end`, `subagent.reasoning`, `subagent.tool_call`, `subagent.tool_call_args`, `subagent.tool_result`, `subagent.plan_update`, `subagent.usage` | the child's events | `data` is **identical to the root chunk of the same name** (for `token`/`reasoning`: `{ ...identity, data: string, messageId }`; for `tool_call`: `{ ...identity, id, name, input }`, etc.), plus the identity fields `{ call_id, subagent, route_id, depth }` |

Removed: `subagent.message { chunk }`. Changed: child tool chunks are keyed by
the model's **logical** tool-call id, announced from the child's
`on_chat_model_end` (today: execution `run_id` from `on_tool_start`, field
`tool`). `RootToolProjectionState` becomes per-owner state — one for root,
one per child `call_id` — so the announce/result pairing, streamed-args, held
starts and `message_end` tracking all apply to children exactly as to root.
`childData` still drops a child capability event's `tool_call_id` (including
`plan_update`'s): the ledger never suppresses child frames, so the child plan
has no use for it.

The `subagent.` prefix is kept deliberately: it is what stops child text from
being read as assistant prose by the Agent Protocol transcript, `after`
middleware and the live-turn hub.

The `b4.subagent` dispatch in `subagent-tool-bridge.ts` adds `parent_call_id`
(from the parent stack) and `description` (from the resolved child's
descriptor when the resolver exposes it; the `SubagentResolver` result gains
an optional `description`).

### 2.2 Translator — `packages/ag-ui/src/outbound.ts`

`toAguiEvents` threads an **owner** (`undefined` for root, `call_id` for a
child) through its text, reasoning, tool and plan helpers; every event
produced under a child owner carries `subagentRunId: call_id`. `subagent.X`
takes the same code path as `X` with that owner. Per-owner state: open text
message, identified messages, open reasoning spans/messages, streamed tool
calls, fallback tool-call ids. The translator owns all 1.0 discipline: nothing
it opens — text, reasoning span or message, tool call, subagent — survives
`RUN_FINISHED`.

Root events never carry `subagentRunId` (never `null`). `RUN_STARTED`,
`RUN_FINISHED`, `RUN_ERROR` never carry it.

## 3. Usage

- **Collect.** One `usage` chunk per `on_chat_model_end` with an object
  `usage_metadata`; none otherwise — never a zero for an unreported count.
  LangChain's internal retries produce one `on_chat_model_end`; B4's
  capacity-429 layer re-invokes the model call and that second call's tokens
  are real and counted.
- **Aggregate.** `toAguiEvents` maps each chunk through
  `tokenUsageFromLangChainMetadata(usage_metadata, { provider, model })`
  (`@ag-ui/core` 1.0.1; encodes the inclusive-total rule for LangChain's
  accounting, returns `undefined` when no count is usable — dropped) and at
  the terminal event emits `usage: aggregateTokenUsage(entries)` — one entry
  per `(provider, model)`, unreported counts `undefined`. The key is omitted
  when there are no entries (never `[]`).
- **Where.** Every terminal shape: `RUN_FINISHED` success, interrupt and
  cancelled; `RUN_ERROR` (tokens accrued before the failure — which is why
  collection is per call, not attached to `done`). Child calls are included
  (`subagent.usage` is collected identically). A resumed run reports only its
  own calls.
- **Labels.** `ls_provider`/`ls_model_name` are LangChain's standard run
  metadata on every `BaseChatModel` (`ChatOpenAI` → `openai`,
  `ChatAnthropic` → `anthropic`, `ChatOllama` → `ollama`). Absent labels are
  omitted; the counts still go out.
- **Side effect.** The `usage` chunk also reaches the Agent Protocol SSE
  stream and `@b4run/testing`'s `RunResult` as an untyped pass-through.
  Documented; no typed API in this sub-project.
- No capability section exists for usage; nothing is advertised.

## 4. Reasoning

### 4.1 SDK (`@b4run/sdk`, breaking)

```ts
export interface ReasoningConfig {
  readonly openai?: {
    readonly effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
    readonly summary?: "auto" | "concise" | "detailed"
  }
  readonly anthropic?: {
    readonly budgetTokens: number // integer >= 1024
  }
}
```

`reasoning: { effort }` is removed. The repo's uses
(`examples/chat/server/src/app/{chat,coordinator}/index.ts`) become
`reasoning: { openai: { effort: "high", summary: "auto" } }`.
`apps/web/content/docs/reasoning-effort.mdx` is rewritten for the new shape
(slug kept).

### 4.2 Factory (`chat-model-factory.ts`)

Reads only `reasoning[resolvedProvider]`:

- `openai` → ChatOpenAI `reasoning: { effort?, summary? }` (replacing
  `reasoningEffort`), plus `useResponsesApi: true` when `summary` is set —
  summaries exist only on the Responses API.
- `anthropic` → ChatAnthropic `thinking: { type: "enabled", budget_tokens }`.

### 4.3 Validation (route load; surfaced by `b4 check` and at boot)

- A `reasoning` sub-object for a provider other than the route's resolved
  provider is an error naming the route, the sub-object key and the resolved
  provider (replacing today's silent ignore of `effort` off-OpenAI).
- `anthropic.budgetTokens` must be an integer ≥ 1024.
- Model-level support (does this `claude-*` id accept thinking?) is not
  validated by B4; the provider's error surfaces as a model-call failure.

### 4.4 Extraction (adapter)

`chunkReasoning(content)` — sibling of `chunkText` — concatenates the text of
`thinking` blocks (`thinking`), `reasoning` blocks (`reasoning`, or
`summary[].text` for the OpenAI Responses shape). `redacted_thinking`,
`signature_delta` and encrypted content are ignored: `encrypted: false`, and
B4 stores or returns nothing to the provider (LangGraph's checkpointed
`AIMessage` already carries what the provider needs; untouched).

### 4.5 Framing (translator)

Per model invocation (owner + `messageId` = run id): the first `reasoning`
chunk opens `REASONING_START { messageId: spanId }` then
`REASONING_MESSAGE_START { messageId: reasoningId, role: "reasoning" }`; each
delta is `REASONING_MESSAGE_CONTENT`. `spanId` and `reasoningId` come from the
id factory (`nextId("reasoningSpan")`, `nextId("reasoning")`), distinct from
each other and from the invocation's text message id — the 1.0 reducer warns
when an id is shared across activity, reasoning and text messages. Both close
(`REASONING_MESSAGE_END`, then `REASONING_END`) at the invocation's
`message_end`, at the first `tool_call` announce for that invocation, or at
any terminal boundary (`done`, interrupt, stream end, error, cancel) via the
same flush path that closes text and streamed tool calls. Reasoning and text
of one invocation may interleave (Anthropic interleaved thinking): both stay
open until `message_end`. Token-less invocations (reasoning only, e.g. before
a tool call) are closed by the `tool_call` announce. Child `subagent.reasoning`
gets the same treatment under its owner.

Inbound is unchanged: `role: "reasoning"` history is dropped.

### 4.6 Capability

Ships in PR 2 with the translator change. Descriptor routes only: `reasoning: { supported, streaming: true, encrypted: false }`
where `supported` is `openai.summary !== undefined` or
`anthropic.budgetTokens !== undefined` on the route's descriptor for its
resolved provider — the fields the factory forwards. `openai.effort` alone →
`supported: false` (it reasons, nothing streams). Omitted for graph and raw
runnable routes.

## 5. Subagents

### 5.1 Lifecycle (translator)

- `subagent.start` → `SUBAGENT_STARTED { subagentRunId: call_id, name: subagent, parentToolCallId: call_id, parentSubagentRunId?: parent_call_id, description? }`.
  `subagentRunId` **is** the `task` tool-call id: stable across interrupt →
  resume (the resumed run re-announces it; the spec allows an id to reappear
  "when a suspended invocation is continued"), and each run's translator
  starts with an empty open-set. `route_id` and `depth` stay off the wire
  (depth is implied by the parent chain).
- `subagent.end { final_message }` → `SUBAGENT_FINISHED { subagentRunId, result: final_message, outcome: { type: "success" } }`
  (`result` omitted when `final_message` is `undefined`/`null`).
  `subagent.end { error }` → `SUBAGENT_ERROR { subagentRunId, message: error }`.
  The `task` tool's own `tool_result` flows separately as an ordinary
  `TOOL_CALL_RESULT`.
- Child interrupt: the adapter stamps `callId` onto child permission interrupt
  values (`projectInterruptValue`). At the terminal interrupt boundary each
  still-open subagent closes with
  `SUBAGENT_FINISHED { outcome: { type: "suspended", interruptIds } }` listing
  the pending interrupts whose `callId` is that subagent (`interruptIds`
  omitted when none: suspended because a descendant interrupted). Each such
  `Interrupt` carries `subagentRunId`. Deepest first, so a parent closes after
  its child.
- Cancelled, or `done`/stream-end with a subagent still open:
  `SUBAGENT_ERROR { subagentRunId, message, code: "cancelled" | "unterminated" }`,
  deepest first, before `RUN_FINISHED`. `RUN_ERROR` abandons open subagents
  per spec; nothing is emitted for them.
- Malformed streams: a `subagent.start` for an id already open in this run,
  or any `subagent.*` chunk for an id never announced in this run, is
  dropped. The translator never re-announces or invents an invocation.

### 5.2 Attribution

Every event produced from a `subagent.*` chunk carries `subagentRunId:
call_id`: text, reasoning, tool frames and results, and the child's plan
snapshot (`b4.plan`, `messageId: b4:plan:<call_id>`, `replace: true`). Depth-2
children announce with `parentSubagentRunId` and attribute to their own id.
"Announce before attribute" holds because the adapter dispatches `start`
before the child graph runs.

### 5.3 Removals

- `b4.subagent`: `B4_SUBAGENT_ACTIVITY_TYPE`, `B4SubagentActivityContent`, the
  subagent state machine in `activities.ts`, `SubagentActivityCard`.
  `activities.ts` keeps the plan projector, now owner-aware
  (`b4:plan:<runId>` for root, `b4:plan:<call_id>` for a child).
- `task` leaves the ledger's `ORCHESTRATION_TOOLS`; `OrchestrationToolName`
  narrows to `"writeTodos"`. The interrupt-time drop of held frames still
  applies to `writeTodos`.
- `check-docs.mjs` pins on the removed exports and on `ag-ui.mdx` wording
  ("no raw child stream", "activities exclude …", the orchestration
  presentation section) move with the docs.

### 5.4 Capability

Descriptor routes with a non-empty `subagents` map:
`multiAgent: { supported: true, delegation: true, handoffs: false, subagents: [{ name, description? }] }`,
from the descriptor map the `task` tool resolver dispatches from. Omitted
when the route has no subagents and for graph/raw-runnable routes (omitted
reads as unknown; B4 never claims `supported: false` for something a raw
runnable might wire itself).

## 6. React surface and examples

`@b4run/ag-ui/react`:

- `useSubagentRuns(agent)` subscribes via `agent.subscribe({ onEvent })` and
  reduces `SUBAGENT_STARTED/FINISHED/ERROR` plus every event carrying
  `subagentRunId` into `Map<string, SubagentRun>`:
  `{ subagentRunId, name, description?, parentToolCallId?, parentSubagentRunId?, status: "running" | "completed" | "suspended" | "failed", result?, error?, children: string[], toolCalls: Array<{ id, name, args: string, result?: string, status: "running" | "completed" }>, plan?: todos, text: string, reasoning: string }`.
  Cleared on `RUN_STARTED` for a different `threadId`; retained across runs
  on the same thread (a resumed child re-announces and updates in place).
- `SubagentPanel` renders the tree (nested by `parentSubagentRunId`), reusing
  `ActivityChecklist` for the child plan and the existing stylesheet.
- `b4ActivityRenderers` keeps only the `b4.plan` renderer.

Examples/template: `examples/research/web` and
`packages/devkit/templates/app-research/web` drop `SubagentCard.tsx` and the
subagent branch of `activity-renderers.tsx`; `Transcript.tsx` mounts
`SubagentPanel` from `useSubagentRuns(agent)` on the `useAgent()` instance it
already holds. `examples/chat/web/app/page.tsx` drops the subagent renderer
registration. Reasoning needs no example UI code: CopilotKit 1.76 renders
`role: "reasoning"` messages natively; the chat example's `summary: "auto"`
makes them appear.

## 7. Verification

- `packages/ag-ui/test/conformance.test.ts` (real 1.0 `HttpAgent.runAgent`,
  `console.warn` = failure) gains canned runs: reasoning interleaved with text
  closed by `message_end`; reasoning cut off by a tool call and by an
  interrupt; a two-level subagent tree with attributed text/tools/plan ending
  in success; a child interrupt → `suspended` with `interruptIds` and a tagged
  `Interrupt`, then a resume re-announcing the same id; cancel with a subagent
  open → `SUBAGENT_ERROR` before `RUN_FINISHED cancelled`; `usage` on success,
  interrupt, cancelled and `RUN_ERROR`, omitted when nothing reported; a
  child chunk for an unannounced id dropped without a verifier throw.
- `packages/ag-ui/test/outbound*.test.ts`: exact sequences, id discipline
  (span ≠ reasoning ≠ text), aggregation grouping, ledger without `task`.
- `packages/langchain/test/agent-adapter*.test.ts`: fixtures for Anthropic
  `thinking`, OpenAI Responses `reasoning` summary, standard `reasoning`
  blocks; `usage_metadata` with/without details; child model turns announcing
  logical tool ids; `parent_call_id` at depth 2; `subagent.message` gone.
- `chat-model-factory.test.ts`: provider mapping, cross-provider and
  `budgetTokens < 1024` errors; a `b4 check` test for the message.
- `packages/cli/test/agui-capabilities.test.ts`: `reasoning`/`multiAgent`
  derivation; omitted for graph/raw routes and when nothing is set.
- React: `useSubagentRuns` reduction (tree, suspended, failed, reset) and
  `SubagentPanel` render.
- Suites whose fixtures use `subagent.message` or `b4.subagent` are updated.

Docs (all in `check-docs`'s scanned set): `ag-ui.mdx` outbound table and
activity/orchestration sections; `api/ag-ui.mdx` exports;
`reasoning-effort.mdx`; `upgrading.mdx` for the three breaking changes
(`ReasoningConfig` shape; `b4.subagent`/`SubagentActivityCard` removal;
`subagent.*` chunk shapes); `recipes/research-web-ui.mdx`.
`pnpm --dir apps/web seo:lastmod` after each content commit.

## 8. Deferred

- **`ACTIVITY_DELTA`.** Plan content is a short todo list; replacement
  snapshots are already correct and small; a JSON Patch adds a client-side
  patch-failure mode (the reducer warns and keeps the prior value) for no
  bandwidth gain.
- **`STEP_*`.** B4 has no step boundary worth labelling — the model-turn /
  tool-node alternation is LangGraph-internal and not surfaced as a chunk;
  numbering turns would be noise, and the spec treats steps as labels, not
  containers.

## 9. Delivery

Four PRs, each with a `patch` changeset, in order:

1. **Usage** — adapter `usage` chunk, translator aggregation, conformance,
   docs. Independent.
2. **Reasoning** — SDK breaking change, factory, validation, adapter
   extraction, translator framing, example routes, `reasoning-effort.mdx`,
   upgrading entry, **and the `reasoning` capability section**: #883 merged
   before this PR, and #906's pin in `outbound.test.ts` requires the claim to
   flip in the same change as the translator. Subsumes #897.
3. **Subagents** — adapter child projection, lifecycle/attribution,
   removals, React hook/panel, examples/template, docs, upgrading entries,
   **and the `multiAgent` capability section**. Stacked on 1 (child `usage`
   already collected).

(The separate capabilities PR planned as 4 dissolved into 2 and 3 once #883
landed.) Each passes `pnpm ci:validate`; 3 must also leave
`copilotkit-examples-e2e` green.

## 10. Risks

- **Per-owner state in the adapter** is a refactor of `classifyStreamEvent`'s
  root-only bookkeeping. Mitigated by keeping the root path byte-identical in
  behaviour (existing adapter tests are the regression net) and adding child
  fixtures.
- **Provider block shapes drift.** `chunkReasoning` recognises three shapes
  by field presence; a provider that renames a field silently yields no
  reasoning (never a crash). Fixture tests pin the three shapes known today.
- **CopilotKit renders nothing for `SUBAGENT_*`.** Covered by the B4 panel;
  if CopilotKit later renders subagents natively the panel becomes optional.
- **`useResponsesApi: true`** changes the OpenAI wire for routes that set
  `summary`. Tool calling, structured output and streamed args already work
  on both APIs in `@langchain/openai` 1.5; the aimock fixtures for the
  examples must be re-recorded for the Responses shape where `summary` is set.
