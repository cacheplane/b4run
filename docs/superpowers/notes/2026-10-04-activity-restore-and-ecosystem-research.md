# Research: restoring activity turns from B4 storage, and the AG-UI ecosystem position

Date: 2026-10-04. Three read-only research tracks run after sub-project 2a of the activity-components
arc (`docs/superpowers/specs/2026-10-03-b4-activity-components-design.md`) merged (#926). They inform the
sub-project 2b spec (restore after reload, research example adoption) and the issues filed the same day.

## Executive summary

1. **Restore from the checkpoint, with breaking stamps, no new store.** B4 has no run id in storage and no
   runs table; the LangGraph checkpoint chain already keeps every superstep with a timestamp and B4 writes
   its own metadata through a saver wrapper. Stamping `b4_run`, a full `b4_step` on every ToolMessage (the
   `task` tool included, with `b4_subagent`), and a `b4:turn` summary in checkpoint metadata, plus a
   `listNamespaces` saver method, gives a full-fidelity `TurnView` from existing storage. A pure
   `turnsFromState()` in `@b4run/ag-ui/view` synthesises the AG-UI events the stream would have carried and
   folds them through the unchanged `reduceTurns`, served as `GET /threads/:id/turns`. One thing to verify
   first: `task` children probably already checkpoint under their own `checkpoint_ns`.
2. **AG-UI 1.0 leaves the holes we hit undefined.** Thread history/connect, resume provenance, a resumed-run
   signal and a step vocabulary are all app-layer today; CopilotKit's `AgentRunner` is pluggable with an
   explicit invitation for shared-storage runners, and no OSS multi-instance runner exists.
3. **threadplane already speaks AG-UI (0.0.59) and has no server-side restore on that path.** The
   first-mover position is not "an Angular AG-UI client" (CopilotKit ships one) but a host-independent,
   reducer-driven activity and approval kit, plus a client that restores nested subagents and approvals.

The three reports follow verbatim.

---

# Part 1 — Restore architecture


Research notes, worktree `vibrant-blackburn-42f930` at main after #926. All paths are repo-relative. Nothing was edited.

## 0. The short version

- B4 has **no runs table and no run id in storage** (`packages/cli/src/lib/dev/run-registry.ts:4-8`: "B4.run has no `run_id`… the thread id *is* the run identity"). The AG-UI `runId` is client-supplied and lands only on `client_tool_calls.run_id` rows (opt-in, pruned) and the in-memory live-turn hub. So **turn boundaries do not exist in durable state today** — every other gap in `TurnView` is downstream of this one.
- The checkpointer **already keeps the whole superstep history** per thread (`INSERT OR REPLACE` keyed by `checkpoint_id`, `packages/sqlite-storage/src/checkpointer/saver.ts:172-178`; nothing but `DELETE /threads/:id` removes rows, `saver.ts:225-236`) and every checkpoint carries `ts` (ISO, `@langchain/langgraph-checkpoint/dist/base.d.ts:21`) and `metadata.{source, step, parents}` plus B4's own `b4:checkpoint-routes` stamp written by a saver wrapper (`packages/cli/src/lib/runtime/checkpoint-route-provenance.ts:5,46-60`). That wrapper is the proven seam for stamping more B4 facts (run id, run start) into checkpoint metadata without a new table.
- `GET /threads/:id/state` returns only the **latest root-namespace tuple**: `{config, created_at: <now, not the checkpoint ts>, metadata, next, parent_config, values}` (`packages/cli/src/lib/dev/runtime-fetch-core.ts:2164-2176`). There is **no `/history` route** (grep of `runtime-fetch-core.ts` finds none) even though the saver implements `list` (`saver.ts:121-150`).
- Messages carry a lot already: `AIMessage.tool_calls` (stable provider ids across park/resume, `packages/langchain/src/agent-adapter.ts:912-922`), `ToolMessage.status: "error"` (`packages/langchain/src/agent-middleware.ts:166,194`; it is what the translator turns into `b4.step failed`, `packages/ag-ui/src/outbound.ts:227,238,704-707`), `additional_kwargs.b4_step` and `b4_content_parts` (only for converter tools **with a `display`**, `packages/langchain/src/tool-converter.ts:150-151,193-203`), reasoning/thinking content blocks (the adapter reads them off the chunk content, `agent-adapter.ts:849-858`, so the aggregated message in the checkpoint has them too), `todos` as a state channel (`packages/core/src/capabilities/built-in/planning.ts:54-55`).
- What messages do **not** carry: run attribution, wall-clock timestamps per step, the `b4.step` for display-less tools and for `task`, subagent nesting (a child's messages never reach the root `messages` channel — the `task` tool returns plain text, `packages/langchain/src/subagent-tool-bridge.ts:140-165,222-249`), and the interrupt a step parked on (that lives in the checkpoint's `pendingWrites` `__interrupt__` row, `packages/cli/src/lib/dev/pending-interrupts.ts:103-137`).
- Likely surprise worth verifying first: child subagent graphs are compiled with the checkpointer **omitted**, not `false` (`packages/cli/src/lib/runtime/execute-route-core.ts:1884-1889` passes `checkpointer: false` to `prepareRouteExecution`, which resolves to `undefined` at `:1427-1431`, and `packages/langchain/src/agent-adapter.ts:275` then omits the key). LangGraph JS's `_defaults` inherits the parent's checkpointer whenever `this.checkpointer !== false` and the config carries `__pregel_checkpointer` (`@langchain/langgraph/dist/pregel/index.js:881`-ish: `if (this.checkpointer === false) … else if (config.configurable["__pregel_checkpointer"] !== void 0) defaultCheckpointer = …`). The tool's config does carry LangGraph internals (`tool-converter.ts:114-116` names `checkpoint_ns`, `__pregel_task_id`). So a `task` child **probably already writes its own checkpoints under `checkpoint_ns = "tools:<task_id>"`** despite the comment "Child graphs are materialized natively with no child checkpointer" (`execute-route-core.ts:1868-1870`). If true, subagent restore is a namespace walk, not new storage. Needs a one-line runtime check (see open questions).

---

## 1. What is stored today, per thread

### 1.1 Checkpointer (`@b4run/sqlite-storage`, `@b4run/postgres-storage`)

Schema (SQLite `packages/sqlite-storage/src/checkpointer/schema.ts:7-28`; Postgres `packages/postgres-storage/src/schema.ts:233-256`, `bytea` for the same reason — NUL bytes from sandbox stdout, `:223-228`):

- `checkpoints(thread_id, checkpoint_ns DEFAULT '', checkpoint_id, parent_checkpoint_id, type, checkpoint BLOB, metadata BLOB)` PK `(thread_id, checkpoint_ns, checkpoint_id)`.
- `writes(thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)`.

Saver behaviour (`saver.ts`):
- `getTuple` without `checkpoint_id` → latest by `checkpoint_id DESC` for that namespace (`:98-104`); with it → exact row. `pendingWrites` are joined in (`:108-118`).
- `list(config, {before, limit})` → full history for a namespace, newest first, **without** pendingWrites (`:121-150`, comment `:145-147`). Nothing in the CLI calls it over HTTP.
- `put` is `INSERT OR REPLACE`, parent id from `config.configurable.checkpoint_id` (`:152-182`). Every superstep is kept.
- `deleteThread` is the only deletion (`:225-236`), called from `DELETE /threads/:id` (`runtime-fetch-core.ts:1868-1886`).
- Serialization is LangGraph's `JsonPlusSerializer` (`saver.ts:167-170`), so messages come back as `{lc, type: "constructor", id: ["langchain_core","messages","AIMessageChunk"], kwargs}` envelopes when read raw — the research web's `hydrate.ts` and the translator's `messageKeptParts` both already read `kwargs.additional_kwargs` (`packages/ag-ui/src/outbound.ts:286-296`).

Checkpoint payload: `Checkpoint { v, id, ts: string (ISO), channel_values, channel_versions, versions_seen, … }` (`@langchain/langgraph-checkpoint/dist/base.d.ts:21` for `ts`). `channel_values.messages` is the transcript; `channel_values.todos` is the plan (`planning.ts:54-55,113`). Metadata: `{source: "input"|"loop"|"update"|"fork", step, parents}` (`dist/types.d.ts:19-31`) plus B4's `"b4:checkpoint-routes": {checkpointId, routes[]}` (`checkpoint-route-provenance.ts:5,46-60`, read by `checkpointRoutes`).

Important LangGraph JS detail: **`config.metadata` is not merged into loop checkpoints.** `_putCheckpoint(inputMetadata)` builds `{...inputMetadata, step, parents}` with `inputMetadata = {source}` (`@langchain/langgraph/dist/pregel/loop.js:477,697,702,729,856-860`); only `updateState` merges `config.metadata` (`pregel/index.js:603-608`). So the `metadata.b4` the subagent bridge sets on `childConfig` (`subagent-tool-bridge.ts:109-117`) does **not** persist. Stamping must go through a saver wrapper like `routeCheckpointer` or through messages.

`GET /threads/:id/state` (`runtime-fetch-core.ts:2140-2181`): root namespace only (`checkpoint_ns: ""`, `:2164-2166`), `created_at: new Date().toISOString()` (`:2171`, so the response carries no checkpoint time — a defect for restore), `next` = channels of pendingWrites (`:2173`), `values = channel_values` (`:2174`). Ungated by default (`:3519-3523`: "ungated GET /threads/:id/state returns the messages… (Gating /state is tracked separately)"); the thread-access gate runs only when a policy is installed (`:2147-2162`).

### 1.2 Subagents (`task`) and `checkpoint_ns`

- The `task` tool (`packages/core/src/capabilities/built-in/subagents.ts:40-41`, display `TASK_DISPLAY` `:8-13`) is converted by `convertSubagentTaskToLangChain` (`subagent-tool-bridge.ts:51`). It invokes the resolved child graph **inline inside the tool body** with `childConfig = {...liveConfig, metadata: {...metadata, b4: {subagent_depth, subagent_stack}}}` (`:109-117,140-143`) and returns `extractFinalAiText(output)` — a **string** (`:160-165,222-249`). LangChain's ToolNode wraps that string in a ToolMessage with no `additional_kwargs`, so the `task` ToolMessage in the root transcript carries neither `b4_step` nor the child's messages (confirmed by the spec note at `docs/superpowers/specs/2026-10-03-b4-activity-components-design.md:194-196` and `apps/web/content/docs/ag-ui.mdx:569`).
- Live subagent visibility comes from `b4.subagent` custom events (`:138,147-158`) with `call_id`, `parent_call_id`, `tool_run_id`, `subagent`, `route_id`, `depth`, `description`, `final_message`/`error` — pure stream projections, never state (the reattach spec says so: `docs/superpowers/specs/2026-08-09-ap-stream-reattach-design.md:52-58`).
- Child graph construction: `prepareChild` → `prepareRouteExecution({checkpointer: false, …})` (`execute-route-core.ts:1884-1889`) → `resolvedCheckpointer = undefined` (`:1427-1431`) → `materializeAgent` omits `checkpointer` (`agent-adapter.ts:275`). Per LangGraph's `_defaults` (`pregel/index.js:881` region) an omitted checkpointer **inherits** the parent's via `configurable.__pregel_checkpointer`; only `=== false` disables inheritance. Hypothesis: child checkpoints exist under a nested `checkpoint_ns` (`tools:<task_id>` style). Evidence for: `interrupt_grants.checkpoint_ns` is "LangGraph's namespace for the parked task, stored verbatim" (`packages/sqlite-storage/src/interrupt-grants/schema.ts:35-38`; `packages/sdk/src/interrupt-grants.ts:90-96,109-121`), tests use values like `"park:perm-1"` (`packages/cli/test/approval-grants-endpoint.test.ts:225`) but those are fixtures. Evidence against: the author's comment (`execute-route-core.ts:1868-1870`) and the record spec's claim that a child park re-executes the whole `task` (`docs/superpowers/specs/2026-10-03-tool-call-record-scope-and-task-design.md:128-135`) — which is also what happens with an inherited checkpointer (a subgraph interrupt still re-enters the parent node). **Unverified; must be checked by running a `task` route and selecting `DISTINCT checkpoint_ns` from `.b4/*.sqlite`.**
- `GET /threads/:id/state` and `readPendingInterrupts` (`pending-interrupts.ts:195-204`) read `checkpoint_ns: ""` only. A child's parked interrupt is still visible at the root because LangGraph writes the `__interrupt__` into the parent task's writes (that is why the root-only read works today, `pending-interrupts.ts:103-137`), and the envelope carries `callId` (the task call) + `toolCallId` (the child's call) (`packages/core/src/capabilities/permission-gate.ts:473-482`; mapped to AG-UI `toolCallId`/`subagentRunId` at `packages/ag-ui/src/interrupts.ts:78-102`).

### 1.3 Agent Protocol threads store

Only a `threads` table — **no `runs` table** (SQLite `packages/sqlite-storage/src/threads/schema.ts:7-14`; Postgres `schema.ts:176-190`): `thread_id, created_at, updated_at, metadata JSON/jsonb, status ('idle'|'busy'|'interrupted')`. Store API (`threads/store.ts:19-31`): `createThread/getThread/deleteThread/listThreads/updateStatus/updateMetadata` (shallow merge; Postgres uses `metadata || $1::jsonb`, `packages/postgres-storage/src/threads.ts:191-199`). Metadata written by the runtime is just `{route: routeKey}` (`runtime-fetch-core.ts:2743-2758`, `agui-handler.ts:1172-1178`) with the reserved thread-access stamp guarded by `assertNoReservedKey` (`thread-metadata.ts:59-66`). Thread metadata is **client-writable** and echoed verbatim (`thread-metadata.ts:2-6`), so it is not a trustworthy home for a server-computed turn record unless a reserved sub-namespace is used (the existing pattern: `THREAD_ACCESS_METADATA_KEY`).

Status transitions: `busy` at run start (`:2758`, `:3164`, `agui-handler.ts:1178`), terminal via `terminalStatus({cancelled, sawInterrupt})` → `"interrupted"` or `"idle"` (`packages/cli/src/lib/dev/terminal-status.ts:36-41`; call sites `runtime-fetch-core.ts:2917,4310`, `agui-handler.ts:1395`). `"interrupted"` is overloaded cancelled-or-parked by design (`terminal-status.ts:27-33`). `runs/wait` leaves `idle` even when parked (`agent-protocol.mdx:229-231`). None of this records *when* or *which run*.

Run identity in process only: `RunRegistry` (`run-registry.ts:40-69`), single run per thread. AG-UI `runId` is validated as an opaque client string ≤256 chars (`run-envelope.ts:46-47,139-150`) and used for `RUN_STARTED`/`RUN_FINISHED` (`agui-handler.ts:1280-1288`) and to filter record rows (`:1301-1309`). Agent Protocol runs have no run id at all; the episode recorder uses `threadId` as `runId` (`execute-route-core.ts:2020-2023`: "No distinct run id exists in the runtime today").

### 1.4 Tool-call record (`client_tool_calls`, #909/#916/#918)

Columns (`packages/sqlite-storage/src/client-tool-calls/schema.ts`, Postgres `schema.ts:340-379`): `thread_id, tool_call_id, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at` (v1), `kind ('client'|'server'), settled_at` (v2), `parent_tool_call_id` (v3). Record shape `packages/sqlite-storage/src/client-tool-calls/types.ts:21-60`. Server rows are "identity only" (`agui-handler.ts:974-1003`): issued before the body, settled in `finally`, never settled across a park (`packages/langchain/src/tool-call-recording.ts:47-91`). `origin` = `{routeId: child route key, parentToolCallId: task call id}` from `metadata.b4.subagent_stack` (`tool-call-recording.ts:36-45`).

Limits that disqualify it as the restore home (the activity spec already says so, `2026-10-03-b4-activity-components-design.md:196-197`): recording of server rows is **opt-in** (`recordsServerCalls` only when some route is in `server.agui.clientTools` or `clientToolStore` is configured, `client-tool-runtime.ts:42-48`); AP runs (`runs/stream`, `runs/wait`) have no recorder (`tool-call-recording.ts:13-18`: "Present only on AG-UI runs"); rows are pruned at `now - max(retentionMs, ttlMs)` with a 10-minute default TTL (`client-tool-runtime.ts:12,114-122,182-203`); no label/args/result for server rows. What it does uniquely hold: `issued_at`/`settled_at` per call and `run_id` — the only per-step timestamps anywhere today.

### 1.5 Approval grants (`interrupt_grants`)

`thread_id, interrupt_id, checkpoint_ns, token_hash, issued_at, expires_at, consumed_at, consumed_decision, voided_at` (`interrupt-grants/schema.ts:48-60`; Postgres `schema.ts:295-315`). Hash only — the plaintext grant is at rest in the checkpoint `writes` (`permission-gate.ts:514-525`, `pending-interrupts.ts:84-96`). `consumed_decision` is the only durable record of **how** an approval was decided; voided rows are pruned after 7 days by default (`approval-grants.ts:65,492-517`). Parked (outstanding) interrupts are served by `GET /threads/:id/pending_interrupts` as `{interruptId, resumeKey, value, grant?}` (`runtime-fetch-core.ts:3636-3655`), gated on the parking route (`:3513-3523`).

### 1.6 Live-turn hub (reattach)

In-memory only: per-thread digest of `StreamChunk`s for the **current** turn, 2 MiB cap, closed at client-visible stream end including park (`packages/cli/src/lib/dev/live-turn-hub.ts:3-6,8-17`; reattach spec `2026-08-09-ap-stream-reattach-design.md:190-200`). It holds `runStartedAt`, `anchorCheckpointId`, `resume` (`live-turn-hub.ts:8-17`, opened at `agui-handler.ts:1149-1158`). Nothing survives the turn; "a reload-while-parked attach is always the durable path" (spec `:198`). The spec also warns: do not mix `/state` with an attach snapshot (`:422`).

### 1.7 Other per-thread durable facts

- Episodic memory (`packages/cli/src/lib/runtime/record-episode.ts`): one record per settled run with `outcome, toolsUsed, startedAt, finishedAt` — but disabled by default, 30-day TTL, capped at 500 (`:62-69`), and `runId = threadId` (`execute-route-core.ts:2020-2023`). Not a restore source.
- Workspace/sandbox association tables (`packages/sqlite-storage/src/workspace/*`) — irrelevant here.

---

## 2. What a message already carries (and what it does not)

| Fact needed by `TurnView` | In the checkpointed message? | Where |
|---|---|---|
| Tool call id, name, args | Yes — `AIMessage.tool_calls[]` with the provider id, stable across park→resume | `agent-adapter.ts:912-922`; hydrate converts object args to the string the UI wants (`packages/devkit/templates/app-research/web/app/lib/hydrate.ts:8-19`) |
| Tool result text/parts | Yes — `ToolMessage.content` plus `additional_kwargs.b4_content_parts` for part results | `tool-converter.ts:193-209`; reader `outbound.ts:286-296` |
| Step failed | Yes — `ToolMessage.status === "error"` (B4 sets it for thrown tools and for dangling calls when a run dies) | writers `agent-middleware.ts:160-171,184-196`; reader `outbound.ts:227,238`; emitted as `b4.step failed` `:704-707` |
| Step label/icon/sources (`completed`) | **Only** for converter tools with `display` (`b4_step = {icon?, label?, sources?}`); not for display-less tools, not for `task` (bridge returns a string), not the `running` label | `tool-converter.ts:150-151,193-203`; `tool-display.ts:14-18` |
| Reasoning text | Yes as content blocks `{type:"thinking", thinking}` / `{type:"reasoning", reasoning}` on the aggregated AIMessage (the adapter reads exactly these off the chunk; nothing strips them) | `agent-adapter.ts:842-858` |
| Reasoning/text message ids | **No correlation.** AG-UI ids are minted per stream (`msg-<uuid>`, `rsn-…`, `rspan-…`, `tr-…`) by `IdFactory`; the adapter uses LangChain's per-invocation `event.run_id` as `messageId` | `packages/ag-ui/src/ids.ts:5-43`; `agent-adapter.ts:896,900,931` |
| Usage / model | On the stream as a `usage` chunk from `usage_metadata` + `ls_provider`/`ls_model_name` (`agent-adapter.ts:826-838`); the persisted AIMessage keeps `usage_metadata` and `response_metadata` but not provider labels in a B4-defined place | |
| Timestamps | **None on messages.** The checkpoint `ts` is per superstep (one superstep ≈ one model call or one tool batch), which is good enough for `startedAt`/`settledAt` at step granularity if history is walked | `base.d.ts:21` |
| Run attribution | **None.** No message or checkpoint metadata names the AG-UI `runId`; `config.metadata.b4` is not persisted by LangGraph (see §1.1) | |
| Plan | Latest `todos` only in `channel_values.todos`; per-turn snapshots only via checkpoint history | `planning.ts:54-55` |
| Subagent child transcript | Not in root `messages`; possibly in a nested-namespace checkpoint (§1.2, unverified) | |
| Approval decided | Not on messages. Outstanding: checkpoint `pendingWrites` `__interrupt__`. Decided: `interrupt_grants.consumed_decision` (pruned after 7 days) and, for a deny, the gate's result text in the ToolMessage (`permission-gate.ts:538`) | |

---

## 3. Gaps and the storage-aligned fix for each

The rule I would adopt: **every fact a `TurnView` needs that is not already a message property becomes either (a) a B4-stamped `additional_kwargs` key on the message that caused it, or (b) a B4-stamped key in checkpoint metadata written by a saver wrapper; and `/state` grows a sibling that returns history across namespaces.** No new table.

### 3.1 Run/turn boundaries and status (`runId`, `status`, `startedAt`, `endedAt`, `error`)

Gap: nothing durable says where a turn starts or ends, or how it ended. `TurnStatus` is `working|awaiting|done|failed|stopped` (`turns.ts:28`).

Fix (breaking): stamp `additional_kwargs.b4_run = { runId, startedAt }` on **every** message the runtime emits in a turn. The cheapest single point is a B4 middleware/`wrapModelCall`-style hook in `packages/langchain/src/agent-middleware.ts` (the file already rewrites messages for dangling tool calls, `:150-176`) plus the converter's ToolMessage (`tool-converter.ts:193-209`) and the bridge's `task` result (make it return a `ToolMessage` instead of a string, `subagent-tool-bridge.ts:160-165`). The user `HumanMessage` is the natural turn opener; stamp it in the AG-UI inbound path (`packages/ag-ui/src/inbound.ts:50` already carries `id`) and in the AP run body path.

Plus: write the terminal facts once per turn into checkpoint metadata through the saver wrapper (`checkpoint-route-provenance.ts` pattern): `"b4:turn": { runId, startedAt, endedAt, status: "done"|"failed"|"stopped"|"awaiting", error?, failed }`. The run id and start are known at `liveTurnHub.open` time (`agui-handler.ts:1149-1158`), the end is known where `terminalStatus` is computed (`agui-handler.ts:1395`, `runtime-fetch-core.ts:2917,4310`). Since the last checkpoint of a turn is already written by then, this is an **extra metadata-only `put`** of the head tuple, or — simpler — a `b4:turn` write recorded on the *first* checkpoint of the next superstep. Alternative with the same cost: a `b4_turn` summary in **thread** metadata under a reserved key (there is precedent, `THREAD_ACCESS_METADATA_KEY`, `thread-metadata.ts:11-48`) but that holds only the last turn and is shallow-merged, so per-turn history belongs in the checkpoint chain.

For `awaiting`: derivable without new data — the head tuple's `pendingWrites` has `__interrupt__` (`pending-interrupts.ts:106-137`). For `stopped` vs `failed`: a cancelled AP run already leaves `"interrupted"` on the thread but no reason; the `b4:turn` stamp makes it explicit. For `failed`: the dangling-call repair already writes `status:"error"` ToolMessages (`agent-middleware.ts:160-171`), so `failed` count is partly derivable; the stamp carries the run-level `error` message that `RUN_ERROR` would have.

### 3.2 Per-step `startedAt` / `settledAt`

Gap: no timestamps on messages. `ToolStep.startedAt/settledAt` are reducer `now()` reads (`turns.ts:58-59,593-600,641-651`).

Fix: (a) stamp `additional_kwargs.b4_step.startedAt/settledAt` (ISO) in the converter (it knows both ends of the body, `tool-converter.ts:142-215`) and in the bridge; (b) fall back on checkpoint `ts` of the superstep that introduced the message when walking history. The record store's `issued_at/settled_at` already exist but are opt-in and pruned — do not depend on them.

### 3.3 `b4.step` for tools WITHOUT `display`, and on the `task` ToolMessage

Gap: `step` is `undefined` without `display` (`tool-converter.ts:150-151`) and the ToolMessage is only constructed when `partsForUi !== undefined || step !== undefined` (`:193-212`); the bridge returns a string.

Fix (breaking for anyone reading raw `/state`): always construct the ToolMessage in the converter, always set `b4_step = { status: "completed"|"failed", icon?, label?, sources?, startedAt, settledAt }` (the `running` label is a stream-only fact and does not need persisting; `stepLabel` already falls back on the tool name, `view/labels.ts`). Make the bridge return a `ToolMessage` with `b4_step` from `TASK_DISPLAY` and `b4_subagent = { callId, name, routeId, description?, depth, outcome: "done"|"failed"|"suspended", error? }` — the same fields `b4.subagent` streams (`subagent-tool-bridge.ts:125-136`). That lifts the spec's "the `task` tool's message does not carry it yet" caveat (`ag-ui.mdx:569`, `2026-10-03-b4-activity-components-design.md:194-196` — both pinned sentences will move).

### 3.4 Failed-step labels

Today `failed` is derived from `ToolMessage.status` (`outbound.ts:704-707`) and the view keeps the running label. With §3.3, the converter can persist the failed step directly: `describeDone` is only computed on success (`tool-converter.ts:150-151`), so add a `failed` label path (the view already has "a dedicated label for a permission deny is a server-side follow-up", `turns.ts:254-256`).

### 3.5 Reasoning spans

The blocks are in the checkpointed AIMessage (§2). Restore maps one AIMessage's thinking/reasoning blocks → one `ReasoningStep` with `status: "done"`, id = the message's persisted `id` (if any) or a derived `rsn:<messageIndex>`. Timing from the superstep `ts`. No storage change needed; OpenAI only persists summaries when `summary` is requested (`reasoning-config.ts:7-12`), same as live.

### 3.6 Plan snapshots per turn

`channel_values.todos` is the final plan. Per-turn snapshots exist in checkpoint history: each `writeTodos` call lands a `Command({update:{todos}})` (`planning.ts:54-55,78-89`), so the superstep after it has the new `todos` in `channel_values`. Walking `list()` (`saver.ts:121-150`) and diffing `todos` across checkpoints gives `PlanStep.todos` per turn and `updatedAt` from `ts`. Caveat: `list` returns tuples **without** `pendingWrites` (`:145-147`), fine for values. Cost: history walk per restore; bounded by turn count, not token count, if the walk stops at the previous `b4:turn` boundary.

### 3.7 Subagent nesting

Two options, depending on the §1.2 verification:
- If nested-namespace checkpoints exist: restore walks `checkpoints WHERE thread_id=? AND checkpoint_ns LIKE 'tools:%'` (or follows `metadata.parents`), rebuilding each child's `TurnView` from its own `messages` with the same message-level rules, keyed to the parent `task` call by the task id in the namespace. `SubagentStep.{name, description, status, result, error}` come from the new `b4_subagent` on the `task` ToolMessage (§3.3). The saver gains a `listNamespaces(threadId)` (one `SELECT DISTINCT checkpoint_ns`) — the only storage API addition.
- If they do not exist: compile the child with the inherited checkpointer deliberately (drop the `checkpointer: false` at `execute-route-core.ts:1889`) **or** persist the child's final `messages` into the `task` ToolMessage's `additional_kwargs.b4_subagent.messages`. The first is cleaner and also gives children durable parks; the second bloats the root checkpoint.

Nested interrupts already carry `callId` + `toolCallId` (`permission-gate.ts:473-482`), so `attachInterrupt`'s owner/step placement (`turns.ts:836-854`) works unchanged from the pending-interrupts snapshot.

### 3.8 Approvals (parked + decided)

Parked: `GET /threads/:id/pending_interrupts` already returns exactly what `approvalOf` needs (`interruptId`, `value.{kind, detail, toolCallId, callId}`, `grant`, `runtime-fetch-core.ts:3643-3648`; `turns.ts:319-334`). The restore endpoint should **include** that snapshot in its payload (it is read from the same tuple — `parsePendingInterrupts(tuple)` is pure, `pending-interrupts.ts:76-83,103`) so a client makes one call — subject to the same gate the standalone endpoint enforces (`:3513-3523`).

Decided: the view drops approvals on resume (`turns.ts:258-275`) so a restored `done` turn does not need them; if a "was approved/denied" badge is wanted later, `interrupt_grants.consumed_decision` is the source but is pruned after 7 days (`approval-grants.ts:65`). A durable alternative is stamping the decision into the gated ToolMessage's `b4_step` (`permission-gate.ts:538` knows the decision). Defer unless Brian wants it.

### 3.9 Where the reducer runs: server-side `GET /threads/:id/turns` vs client-side `turnsFromCheckpoint`

`@b4run/ag-ui/view` is edge-safe and framework-free (`packages/ag-ui/src/view/index.ts:1-5`; `api/ag-ui.mdx:49`), and the CLI already depends on `@b4run/ag-ui` (`agui-handler.ts` imports `toAguiEvents`). The clean design is one function in `./view`:

`turnsFromState(state: ThreadStateForTurns): TurnsView` — pure, input = `{ checkpoints: [{ns, id, ts, parentId, values:{messages, todos}, metadata}] , pendingInterrupts }`, output = `TurnsView`. Implement it as a **synthesizer**: emit the AG-UI events the live stream would have produced (RUN_STARTED with the `b4_run.runId`, TOOL_CALL_START/ARGS/END from `tool_calls`, TOOL_CALL_RESULT + `b4.step` from ToolMessages, REASONING_* from blocks, ACTIVITY_SNAPSHOT from `todos` diffs, SUBAGENT_STARTED/FINISHED + nested events from child namespaces, RUN_FINISHED with `outcome.interrupts` from `pendingInterrupts`) and fold them through the existing `reduceTurns` with `now` driven by the stamped timestamps. That reuses every ordering/merging rule and keeps the spec's promise "live, replay and restore of the same events produce identical views" (`2026-10-03-b4-activity-components-design.md:400`) literally testable: record a run's events, reduce; restore its checkpoint, synthesize, reduce; `toEqual`.

Then expose both:
- **Server**: `GET /threads/:id/turns` in `runtime-fetch-core.ts` next to `/state` (`:2140-2181`): read head + history + namespaces + pending interrupts, call `turnsFromState`, return `TurnsView` (plus `threadId`, thread status). One answer for every host (Workbench, research web, CopilotKit connector, Angular kit), gated like `/pending_interrupts`, and it hides the serde envelope shape that `hydrate.ts` warns drifts (`hydrate.ts:30-42`).
- **Client**: export `turnsFromState` from `./view` so a host that already has `/state` (or an edge host without the CLI) can compute locally. The server endpoint is a thin wrapper, so there is one implementation.

Trade-off: server-side costs a history walk per load (bounded; add `?since=<checkpoint_id>` later); client-side needs a `/state`-shaped payload that today lacks history/namespaces, so `/state` would have to grow (`?history=1&subgraphs=1`) — which is the same server work anyway. Recommend the server endpoint as the primary surface and the view function as the shared core.

---

## 4. Consistency

- **Two stores, not one.** The checkpointer and `ThreadsStore` are separate; a transcript can exist for a thread whose row is gone (`runtime-fetch-core.ts:2148-2152`) and `DELETE` orders checkpoints-then-row deliberately (`:1869-1886`). The research web's restore reads `/state` then `/pending_interrupts` (`packages/devkit/templates/app-research/web/app/lib/thread-source.ts:217,237`; same in `examples/research/web/app/lib/thread-source.ts`) and `GET /threads/:id` for status (`ag-ui.mdx:641`). A `/turns` endpoint should read checkpointer + thread row + (optionally) pending interrupts in one handler so the three stay consistent per response.
- **Prune/TTL that would delete restore data**: `client_tool_calls` (10 min TTL default / retention, `client-tool-runtime.ts:12,114-122`), `interrupt_grants` voided rows (7 days, `approval-grants.ts:65`), episodes (30 days, `record-episode.ts:62-66`). Checkpoints are **never** pruned (only `deleteThread`). Hence: put restore facts in checkpoints/messages, never in the record/grant stores.
- **Postgres parity**: both packages use append-only migration lists with "a shipped migration is frozen; append a version" (`interrupt-grants/schema.ts:9-17`; Postgres `schema.ts:147-156`), both pinned by DDL tests (`packages/postgres-storage/test/client-tool-calls-ddl.test.ts`, `interrupt-grants-ddl.test.ts`; SQLite `migrate.test.ts`). Postgres `runMigrations` takes an advisory lock and a per-component `<prefix>_<component>_migrations` table (`schema.ts:131-161`). The recommended design needs **no DDL change** (new facts live inside existing BLOB/bytea payloads and `additional_kwargs`); the only storage API change is `listNamespaces(threadId)` (one query on both savers) and possibly `list` returning `ts` cheaply (it already does via the decoded checkpoint). Checkpointer conformance tests exist for both (`packages/sqlite-storage/test/checkpointer.test.ts`, `packages/postgres-storage/test/checkpointer-conformance.test.ts`).

---

## 5. Breaking-change surface

- `apps/web/content/docs/dev-server/agent-protocol.mdx`: endpoint table (`:32-45`) gains `GET /threads/:thread_id/turns`; `/state` row (`:39`) if `created_at` becomes the checkpoint `ts`; sections "Recovering prompts without a live stream" (`:151-160`) and "Client disconnect" (`:233-239`). `scripts/check-docs.mjs` pins the endpoint strings (`:2798-2809`, `:5022-5047` "is missing endpoint text") and route lists (`:2224`, `:2669`, `:2684`, `:2888`).
- `apps/web/content/docs/ag-ui.mdx:569` and `:641`, the `task`-does-not-carry-`b4_step` sentence; `apps/web/content/docs/api/ag-ui.mdx:98-135` export table for `./view` (add `turnsFromState`) — the API tables are the ones a docs assertion pin tends to fingerprint (memory: "docs assertion-fingerprint pin"); `apps/web/content/docs/api/langchain.mdx` mentions `/state`; `persistence.mdx`, `state.mdx`, `thread-access.mdx` reference `/state`.
- Specs to amend: `2026-10-03-b4-activity-components-design.md:194-197,359-361` (restore via `/state`; "tool-call record is not the durable home"); `2026-08-09-ap-stream-reattach-design.md:422` (do not mix `/state` with attach).
- Tests: research template/web `hydrate.ts` + `hydrate.test.ts` (`packages/devkit/templates/app-research/web/app/lib/`, `examples/research/web/app/lib/`) read `values.messages`/`values.todos` — they keep working if `/state` is only extended, and can be deleted if the web moves to `/turns`; Workbench harness W7 probes `/api/b4/threads/t-1/state` (`test/harness/workbench-browser.test.ts:77`, `workbench-page.test.ts:171-188`); `packages/cli/test/runtime-fetch-handler.test.ts`, `agui-endpoint.test.ts` pin `/state` 404 semantics (`runtime-fetch-core.ts:1793-1795`); translator tests for `b4.step` (`packages/ag-ui/test`); `scripts/published-artifact-smoke.mjs` has no `/state` probe (grep empty) — nothing release-pinned moves unless the smoke script is edited (then `scripts/release/test/fixtures/release-script-hashes.json` must be regenerated per AGENTS.md).
- Wire-visible breaking bits: ToolMessages now always carry `additional_kwargs.b4_step` (and `b4_run`, `b4_subagent`), the `task` result becomes a `ToolMessage` object (AG-UI `TOOL_CALL_RESULT.content` text is unchanged — `toolResultView` reads `content`, `outbound.ts:220-240`), and raw `/state.values.messages` consumers see the new keys. `/state.created_at` semantics change if fixed.
- Changeset: one file, fixed group, **`patch`** on every touched package (`.changeset/config.json:5-8`; AGENTS.md "minor takes every package to 1.0.0"), body starting with `**Breaking:**` as `packages/cli/CHANGELOG.md:849` does. Packages touched: `@b4run/langchain` (converter/bridge/middleware), `@b4run/ag-ui` (`./view` `turnsFromState`), `@b4run/cli` (`/turns`, metadata stamp), `@b4run/sqlite-storage` + `@b4run/postgres-storage` (`listNamespaces`), `@b4run/sdk` if the `b4_*` keys/types are exported there, `@b4run/devkit` if the research template moves to `/turns`.

---

## Recommended design

Treat the LangGraph checkpoint chain as the turn log it already almost is. Stamp three B4-owned facts where they are born: `additional_kwargs.b4_run = {runId, startedAt}` on every message of a turn (human, AI, tool), `additional_kwargs.b4_step = {status, icon?, label?, sources?, startedAt, settledAt}` on every ToolMessage from the converter and the bridge (display or not; `task` included, plus `b4_subagent` identity/outcome), and a `b4:turn` summary `{runId, startedAt, endedAt, status, error?, failed}` in checkpoint metadata written by a saver wrapper alongside the existing `b4:checkpoint-routes` stamp. Leave reasoning, `tool_calls`, `status:"error"`, `todos` and parked interrupts where they already are. Make the child subagent graph checkpoint under its own `checkpoint_ns` (verify it already does; if not, stop passing `checkpointer: false`) so a child's turn is a namespace walk. Add one saver method, `listNamespaces(threadId)`, on both storage packages — no DDL.

Put the reconstruction in `@b4run/ag-ui/view` as `turnsFromState(...)`: a pure synthesizer that turns checkpoint history + pending interrupts into the AG-UI events the stream would have carried and folds them through the unchanged `reduceTurns`, so restore is provably the same reducer as live/replay. Serve it from the CLI as `GET /threads/:id/turns` (gated like `/pending_interrupts`, one response = head tuple + history + namespaces + parked interrupts + thread status) and let hosts that already hold `/state` call the same function client-side. Ship as one fixed-group `patch` changeset with a `**Breaking:**` lead, moving the docs/spec/check-docs pins listed in §5, and point the research template and Workbench at `/turns` so `hydrate.ts`'s hand-rolled serde reading can go.

## Open questions for Brian

1. **Do `task` children already checkpoint under a nested `checkpoint_ns`?** LangGraph's inheritance rule says yes unless `checkpointer === false` reaches compile, and B4 omits the key rather than passing `false` (`execute-route-core.ts:1427-1431`, `agent-adapter.ts:275`). If yes, the comment at `execute-route-core.ts:1868-1870` is wrong and the subagent restore is cheap; if no, do you accept children writing checkpoints (storage growth, durable child parks) or prefer embedding the child's final messages in the `task` ToolMessage?
2. **Run id for Agent Protocol runs.** `runs/stream`/`runs/wait` have no run id (`run-registry.ts:4-8`). Mint one server-side (ULID) when the client sends none, or require it in the AP body (breaking for AP clients)?
3. **Where should the per-turn summary live**: checkpoint metadata via saver wrapper (per-turn history, consistent with `b4:checkpoint-routes`) vs a reserved key in thread metadata (last turn only, cheap read)? Or both?
4. **Timestamps in `additional_kwargs` vs superstep `ts`.** Stamping `startedAt/settledAt` on messages is exact but widens the message; superstep `ts` is free but coarser. Accept coarse for v1?
5. **Should `/turns` embed `pending_interrupts`** (one round-trip, but inherits that endpoint's route-identity gate and the "`/state` is ungated" asymmetry at `runtime-fetch-core.ts:3519-3523`), or stay separate and leave the two-call restore?
6. **Fix `/state.created_at`** to the checkpoint `ts` (breaking for anyone reading it as "now") and/or add `?history=1`?
7. **Decided approvals**: do restored turns need "approved/denied" badges (requires stamping the decision onto the ToolMessage, since `interrupt_grants` is pruned), or is dropping them on resume (current view behaviour, `turns.ts:258-275`) fine?
8. **Reasoning id strategy on restore**: derived ids (`rsn:<messageIndex>`) are stable per checkpoint but differ from the live ids; acceptable since nothing correlates them across a reload?
9. **Retire `hydrate.ts`** in the research template/example and move the Workbench's `/state` probe (W7) to `/turns` in the same PR, or stage it?

---

# Part 2 — Ecosystem


Date: 2026-10-04. Repo baseline: `@b4run/ag-ui` 0.13.1 pins `@ag-ui/core|encoder` 1.0.1, peer `@copilotkit/react-core >=1.76.0` (dev 1.76.0); `b4.step` is `CUSTOM {toolCallId, status: running|completed|failed, label?, icon?, sources?}` (`packages/ag-ui/src/step.ts`); `@b4run/ag-ui/view` already exports a framework-free `reduceTurns`/`reduceSubagentRuns`/`groupSteps` (`packages/ag-ui/src/view/index.ts`).

Dates in this doc come from the cited pages/registry; where a page gave none I say so.

---

## 1. AG-UI protocol (1.0, frozen 2026-09-17; announced 2026-09-30)

Sources: spec index https://docs.ag-ui.com/spec/1.0 ; schema https://docs.ag-ui.com/spec/1.0/schema ; changelog https://docs.ag-ui.com/spec/1.0/changelog ; capabilities https://docs.ag-ui.com/spec/1.0/basic/capabilities ; interrupts https://docs.ag-ui.com/concepts/interrupts ; activity https://docs.ag-ui.com/spec/1.0/events/activity ; events https://docs.ag-ui.com/concepts/events ; subagents https://docs.ag-ui.com/concepts/subagents ; releases https://github.com/ag-ui-protocol/ag-ui/releases ; 1.0 blog https://www.copilotkit.ai/blog/ag-ui-1.0 (2026-09-30).

Release timeline (releases page): 1.0 core frozen across TS/Python/.NET on 2026-09-17 ("wire protocol version now sends 1.0"); `@ag-ui/client` 1.0.1 on 2026-09-29 ("fixed reconnection with pending interrupts; improved thread history reading"); `@ag-ui/mastra` 1.1.5 on 2026-09-30 (tool approval surfaces as interrupts).

### (i) Replaying/restoring a thread's history — UNDER-SPECIFIED, actively being filled by SDK convention

- The spec has **no connect/history contract**. `AgentCapabilities.transport.resumable` is reserved for "resuming interrupted streams by sequence number", but the capabilities page says "neither HTTP binding carries sequence numbers, resumes a stream", and "No transport binding in this version carries a capabilities exchange" (no discovery mechanism either). No capability field relates to history/replay.
- Issue **#2105** (open, 2026-07-02) https://github.com/ag-ui-protocol/ag-ui/issues/2105 asks how the reserved `resumable` transport should work (sequence on `BaseEvent` vs envelope; SSE `Last-Event-ID` vs `resumeFrom: {runId, afterSequence}` on `RunAgentInput`; server ring buffer/TTL; "replay sends only pre-existing events without re-running"). No maintainer response visible.
- Discussion **#1160** "Conversation history via AG-UI" (2026-02-20 → 2026-08-07) https://github.com/ag-ui-protocol/ag-ui/discussions/1160 : consensus that history is app-layer (`threadId` durable, app-owned `GET /threads`, append-only event store compacted to snapshots); langovoi (2026-06-15) notes `MESSAGES_SNAPSHOT` lacks `runId` references (hurts regeneration/branching); kasuteru (2026-08-07) asks to standardize because "everyone needs conversation history". **No protocol decision.**
- `@ag-ui/client` 1.0.1 has `AbstractAgent.connectAgent()` but the protected `connect()` throws `AGUIConnectNotImplementedError` by default; third parties note "AG-UI defines no HTTP contract for it: no URL, method or body, and no rule for replaying history or resuming live" (agui-inspector #95, opened 2026-10-04, https://github.com/dogganidhal/agui-inspector/issues/95).
- PR **#2837** (AlemTuzlak, 2026-09-25, review requested changes; merge not visible) https://github.com/ag-ui-protocol/ag-ui/pull/2837 : `HttpAgent.connect()` POSTs `RunAgentInput` to `{url}/connect`; ADK middleware replies `RUN_STARTED, MESSAGES_SNAPSHOT, STATE_SNAPSHOT, RUN_FINISHED`; 404/405 = no connect route. Explicitly "The 1.0 spec is not changed: this is an HttpAgent convention" and "restores saved history only. It does not rejoin a run that is still streaming." Restored messages get new ids (reviewer note).
- PR **#2846** (merged 2026-09-28) https://github.com/ag-ui-protocol/ag-ui/pull/2846 : `connectAgent()` may read a thread with pending interrupts; after replay ending in `RUN_FINISHED outcome: interrupt`, `pendingInterrupts` stays set. Connect is "read-only ... replays the thread's history".
- So the de-facto connect shape is **snapshot replay (messages+state), not event replay**. Nobody in the protocol defines event-level replay of `STEP_*`/`CUSTOM`/`ACTIVITY_*`/subagent lifecycle, nor live rejoin. CopilotKit's runner does event replay but as a product convention (see §2).

### (ii) Interrupt/resume metadata — SPECIFIED on the wire, under-specified in semantics

- Schema: `Interrupt {id, reason, message?, toolCallId?, responseSchema?, expiresAt?, metadata?, subagentRunId?}`; `ResumeEntry {interruptId, status: resolved|cancelled, payload?, metadata?}` — the interrupts page describes `ResumeEntry.metadata` as "optional envelope data (signatures, routing keys, etc.)"; `Metadata` is open-by-key with `"ag-ui"` reserved; "last write wins". A single resume array MUST address every open interrupt; invalid/expired → `RUN_ERROR`; replaying identical `(threadId, interruptId, status, payload)` must be safe.
- **Wire limit (c) confirmed:** RUN_STARTED carries no resume signal; "Resumption is initiated solely through the RunAgentInput containing the resume array". CopilotKit issue #6999 (closed, fix PR #7001, 2026-09-09) https://github.com/CopilotKit/CopilotKit/issues/6999 settled that a standard resume is "a new run ... fresh wire run ID" — so a consumer only sees a new `RUN_STARTED` on the same thread. B4's `reduceTurns` already documents this gap ("The wire carries no resume signal", `view/turns.ts`).
- **Limit (b) is a CopilotKit limit, not a protocol limit:** the wire allows `ResumeEntry.metadata`; CopilotKit's `useInterrupt().resolve(payload?, interruptId?)` "records { status: 'resolved', payload }" with no metadata parameter (https://docs.copilotkit.ai/reference/hooks/useInterrupt).
- Adjacent proposals: pydantic-ai **#6452** (open, p:3, needs-discussion) https://github.com/pydantic/pydantic-ai/issues/6452 "Optional provenance for HITL tool approvals over UI adapters" — three directions (signed pause tokens bound into the interrupt id; pluggable server-side verification; docs-only); nothing implemented. microsoft/agent-framework **#8150** (closed via PR #8163, 2026-09-08) https://github.com/microsoft/agent-framework/issues/8150 puts `checkpoint_id` under per-interrupt `metadata.agent_framework` for multi-worker resume and argues it "belongs in the protocol mapping". Vercel AI SDK already ships `experimental_toolApprovalSecret` (HMAC binds approval to tool name, call id, input; forged approvals rejected) https://ai-sdk.dev/docs/agents/tool-approvals . Discussion #827 (2025-12-17 → 2026-03) https://github.com/ag-ui-protocol/ag-ui/discussions/827 produced the arrays design but left resume metadata semantics and "signalling a resumed run" open.
- Resume robustness is a live bug class across integrations: ag-ui-langgraph #2854 (re-emits answered interrupts after partial resume), #2855/#2178 (multi-interrupt legacy resume), pydantic-ai #7040 (partial resume silently strips), #6923 (invalid payload denies silently), agent-framework #8140 (resume duplicates the interrupted turn; "LangGraph, Mastra, CrewAI, Strands all short-circuit before reading messages on a resume" and dedupe by message id).

### (iii) Steps / activity vocabulary — STEP is a thin "node name"; ACTIVITY is the 1.0 home for structured progress; no vocabulary exists

- `StepStarted/StepFinished {stepName, metadata?, subagentRunId?}`. Concepts page: stepName "could be the name of a node or function that is currently executing"; "Frontends can use these events to update progress indicators"; "optional but highly recommended". No relation to tool calls or activity defined, no nesting/concurrency rules, no label/icon/status fields. assistant-ui's AG-UI runtime: "`STEP_STARTED/FINISHED` are received but ignored" (https://www.assistant-ui.com/docs/runtimes/ag-ui/runtime-options).
- `ACTIVITY_SNAPSHOT {messageId, activityType, content, replace?=true}` / `ACTIVITY_DELTA {messageId, activityType, patch (RFC 6902)}` create `ActivityMessage {role:"activity", activityType, content, metadata?, subagentRunId?}`. "activityType is an open string: the set is the producer's, not the protocol's" — **no registry**. Activity messages are "rendering material for the consumer, not conversation the agent resumes from"; "a consumer MUST strip activity messages from the messages it sends in run input"; they can appear in `MESSAGES_SNAPSHOT` with role `activity`, so they are the only progress construct the protocol lets a snapshot restore. Known hosts' activity types: CopilotKit `a2ui-surface`, `mcp-apps`, open-generative-ui (assistant-ui maps others to `agui-activity/<type>` data parts); CopilotKit docs examples use `"PLAN"`, `"SEARCH"`.
- `CUSTOM {name, value, metadata?, subagentRunId?}`: "extension mechanism"; teams should "document their custom events". No guidance on CUSTOM vs ACTIVITY vs STEP. B4's `b4.step` is per-toolCall, status-bearing, non-persistent (CUSTOM is not in snapshots) — which is exactly why the kit cannot restore labels from a `MESSAGES_SNAPSHOT`; an `ACTIVITY_SNAPSHOT` keyed to the toolCallId (or `ToolCall.metadata`, which the schema allows) would be restorable.
- Gap: no standard for "plain-language progress line for a tool call" (label, icon, status, sources, completion). ChatKit is the closest closed vocabulary (task types `custom, thought, search, file, image`, `task_group`, `workflow`, items with `title/summary/status`; https://developers.openai.com/api/docs/guides/custom-chatkit); assistant-ui uses "tasks" with `parentTaskId/depth` and "2/5 tasks running" (https://www.assistant-ui.com/docs/tools/multi-agent); AI SDK Elements "Chain of Thought" component uses step labels like "searching the web / analyzing results" with status complete|active|pending (https://ai-sdk.dev/elements/components/chain-of-thought); ChatGPT-style panels render "titled steps" and "Thought for Ns".

### (iv) Subagents — attribution specified, rendering deliberately left open

- `SubagentStarted {subagentRunId, name, description?, parentSubagentRunId?, parentToolCallId?, parentMessageId?}`, `SubagentFinished {result?, outcome?}`, `SubagentError {message, code?}`. Concepts page: UI "should group output by producer"; `parentToolCallId/parentMessageId` let a client "render the subagent's output inside the tool-call card"; attribution transfers onto messages so `MESSAGES_SNAPSHOT` "carries subagentRunId per-message" and grouping can be rebuilt from history alone; consumers must accept unannounced ids, track concurrent streams independently, treat resumed ids as continuations, enforce close-before-RUN_FINISHED. **No MUST on nested vs top-level rendering** — limit (d) is a host choice.
- Hosts: CopilotKit PR **#7444** (merged; opened 2026-09-25, base→main 2026-09-30) https://github.com/CopilotKit/CopilotKit/pull/7444 groups subagent messages in CopilotChat for React/Vue/Angular — removed from the main list, rendered "under its tool call (parentToolCallId), inside its parent group (parentSubagentRunId), or where its first message was", collapsed with Running/Done/Waiting/Failed, via shared `ɵbuildSubagentLayout`. Whether it shipped in 1.76.0/1.77.0 is not stated (not in the 1.77.0 notes I could read) — **verify against the package you ship against before assuming (d) persists**. assistant-ui `react-ag-ui` 0.0.63 (2026-10-02) nests under `ToolCallMessagePart.messages` joined on `parentToolCallId`, metadata on `metadata.custom.agui`, but "nested structure doesn't survive reload". TanStack AI PR #1438 (merged 2026-09-24) renders `type: 'subagent'` cards with full child transcripts persisted and rebuilt on reload.

### (v) How other servers handle history/interrupts over AG-UI

- **LangGraph** (`@ag-ui/langgraph` / `ag-ui-langgraph`): standard interrupts via `RUN_FINISHED outcome.interrupt`, `resume[]` (legacy `forwardedProps.command.resume` deprecated); exposes `/history/{thread_id}` (checkpoints, time travel) and `/fork` as **non-protocol** routes; dedupes replayed transcripts by message id. LangGraph Platform `GET /threads/{id}/history` returns checkpoint states (default limit 10; known ~24h window issue #5292).
- **ADK**: experimental `POST .../connect` (PR #2837) and a state-read route; #2865 bug drops client-sent history on a new thread's first run.
- **Mastra**: interrupts only since `@ag-ui/mastra` 1.1.5 (2026-09-30, PR #2867); CopilotKit docs page still titled "Interrupts (Not Supported)" for Mastra.
- **Pydantic AI**: `requires_approval=True` → interrupt outcome; `on_cancel` to persist `all_messages()`; history is client-replayed messages; provenance open (#6452).
- **Strands**: 0.4.x native interrupts "with persistence", concurrent run refusal per thread; frontend tool results reconciled into snapshots (0.4.1, 2026-09-23).
- **Agno / LlamaIndex / CrewAI**: history via framework sessions / client-replayed messages; CrewAI 0.3.1 retains context on `CopilotKitState`; Agno workflows not exposed over AG-UI (feature request). No one implements a connect or event-replay route.

### Where B4 can propose an RFC with a working implementation

1. **Connect/history contract** — the biggest explicit hole (#1160, #2105, #2837's "not in spec", agui-inspector #95). An RFC needs: route (`POST /connect`), replay body (snapshot-first vs full events), the rule that replay never re-executes, how `RUN_STARTED` for a replayed run is marked (`metadata["ag-ui"].replay=true`?), live rejoin, and pending interrupts after replay. B4 has the event store (orchestration ledger, tool-call records, thread store) to ship a reference.
2. **Resume provenance** — `ResumeEntry.metadata` exists but nothing says what goes there; #6452/#8150/AI SDK's HMAC show three vendors converging independently. An RFC could reserve `metadata["ag-ui"].grant` or a `signature` convention plus an `Interrupt.metadata` issuance token.
3. **Resumed-run signal** — a `RunStarted.metadata["ag-ui"].resumesInterruptIds` (or `RunAgentInput.resume` echoed on `RUN_STARTED`) so stateless clients glue turns without the 409 heuristic B4 relies on.
4. **Tool-step activity profile** — a documented `activityType` (e.g. `tool-step` / `b4.step` → `ag-ui/tool-progress`) whose `content` is `{toolCallId, status, label, icon?, sources?}` and whose snapshot form survives `MESSAGES_SNAPSHOT`. Needs a `metadata`-only variant for hosts (CopilotKit) that drop unknown activity types.

---

## 2. CopilotKit (≥1.76; 1.77.0 is latest, 2026-10-02)

Sources: runner docs https://docs.copilotkit.ai/backend/agent-runner and https://docs.copilotkit.ai/mastra/backend/agent-runner ; threads https://docs.copilotkit.ai/intelligence/threads-explained ; useInterrupt https://docs.copilotkit.ai/reference/hooks/useInterrupt ; subagents https://docs.copilotkit.ai/multi-agent/subagents ; releases https://github.com/CopilotKit/CopilotKit/releases ; npm registry (fetched 2026-10-04).

- **`AgentRunner` is pluggable and documented.** `abstract run(request): Observable<BaseEvent>; connect(request): Observable<BaseEvent>; isRunning(request): Promise<boolean>; stop(request): Promise<boolean|undefined>`. `run` receives threadId, cloned agent, AG-UI input and persisted input messages; `connect` receives threadId + optional headers/joinCode. Docs: "the runner owns all backing storage"; "stores AG-UI events and thread message snapshots"; connect "replays the thread's latest message snapshot and remaining run events"; custom runners must handle `connect()` before any `run()`; guidance is to subclass `InMemoryAgentRunner`; explicit invitation: "provide a custom runner backed by shared storage (Redis, PostgreSQL, etc.)". Example cited: AWS AgentCore extends the in-memory runner and synthesizes missing tool results from replayed history.
- **Official persistent runners:** `InMemoryAgentRunner` (maxThreads 1000, maxRunsPerThread 100, maxBytes 512 MiB; LRU; `onConcurrentRun: "supersede"`), `SqliteAgentRunner` (`@copilotkit/sqlite-runner`, first published 2026-03-29 as 1.55.0-next.7, latest 1.77.0 on 2026-10-02; `better-sqlite3 ^12.2.0` optional peer; single instance), `IntelligenceAgentRunner` (hosted CopilotKit Intelligence: "records AG-UI events and constructs a replay"; replay cursor catch-up; live runs continue over WebSocket after replay; Redis lock). **No official Redis/Postgres OSS runner.** `GET /threads` is exposed only by InMemory; `injectThreads`/thread lists need Intelligence. Serverless caveat: issue #3553 (connect fails on Vercel/Cloud Run with in-memory runner).
- **connect/history semantics:** event replay + snapshot, product-defined; issue #6981 (open, 2026-09-09) shows the cost of non-persisted activities: Open Generative UI cards vanish on reconnect because `MESSAGES_SNAPSHOT` carries tool calls but not activities; proposed fix is a pure "projector" rebuilding activities from tool-call args — the same shape as B4's `reduceTurns`.
- **`useInterrupt`:** `render({event, interrupt, interrupts, result, resolve, cancel})`; `resolve(payload?, interruptId?)` → `{status:"resolved", payload}`; resume starts "once every open interrupt is addressed", "fresh runId on the same thread" (post-#7001, 1.75.2 "standard interrupt resume improvements" 2026-09-30). No metadata hook → limit (b) stands; an upstream PR adding an optional third `metadata` argument (and plumbing to `ResumeEntry.metadata`) is small and spec-aligned.
- **Activity/tool renderers:** React `useRenderActivityMessage()` / Angular `registerRenderActivityMessage` + `CopilotActivity` (PR #6033 by Manfred Steyer) select by `activityType` with schema validation; tool renderers via `useRenderTool`/`registerRenderToolCall`; HITL via `useHumanInTheLoop`/`registerHumanInTheLoop`; 1.75.0 added `transformMessages` on `CopilotChatMessageView` (Vue/Angular in PR #7509). Subagent grouping per PR #7444 (above).
- **Angular:** `@copilotkit/angular` is official (first publish 0.1.1 on 2026-06-18; 0.5.2 on 2026-09-08 is `latest`; peers Angular 20–22 per the full registry, ^22 per `/latest` view — inconsistent, see unverified). Blog "Introducing CopilotKit for Angular" 2026-07-23 (maintained by Soverius AI; admits "isn't widely used in CopilotKit production yet", gaps in testing/CI/docs, breaking changes expected). Public API: `provideCopilotKit`, `injectAgentStore`, `injectCapabilities`, `injectInterrupt`/`InterruptController`, `registerHumanInTheLoop`, `injectThreads` (Intelligence-backed), `CopilotActivity`, `registerRenderActivityMessage`, A2UI + Open Generative UI, MCP Apps; 1.75.1 (2026-09-29) "Angular now renders A2UI without Lit"; 1.77.0 "Vue and Angular hosts consolidation onto shared package".
- **Dojo/HITL patterns:** docs show interrupt-based and tool-based HITL per framework (`/langgraph-python/human-in-the-loop/interrupt-flow`, `/ag2/human-in-the-loop/useInterrupt`, headless variant); A2UI/Open Generative UI are the generative-UI paths.
- **A B4-backed persistent runner** would: subclass `InMemoryAgentRunner` (or implement `AgentRunner`), key by threadId, append every outbound AG-UI event per run to B4 storage (sqlite/postgres stores already exist in `@b4run/sqlite-storage`/`@b4run/postgres-storage`), serve `connect()` as `RUN_STARTED(metadata replay) → MESSAGES_SNAPSHOT → stored CUSTOM/STEP/SUBAGENT/ACTIVITY events of the open run → RUN_FINISHED`, handle connect-before-run, and (differentiator) rejoin a live run by tailing the ledger. Upstreaming is **plausible as a community package** (docs explicitly invite shared-storage runners; sqlite runner is first-party precedent), but an OSS Redis/Postgres runner competes with the paid Intelligence tier, so expect it to live as `@b4run/copilotkit-runner` rather than under `@copilotkit/*`.

---

## 3. Other chat-UI hosts

- **assistant-ui** (`@assistant-ui/react-ag-ui` 0.0.63, 2026-10-02): history via `adapters.history.load()` + `fromAgUiMessages` (reasoning folds onto next assistant message, orphan tool calls get containers, encrypted reasoning preserved); interrupts → `requires-action` with `metadata.custom.agui.interrupts`, `useAgUiInterrupts`/`useAgUiSubmitInterruptResponses`/`useAgUiSteerAway`; subagents nested in `ToolCallMessagePart.messages` (not restored nested); activities → `agui-activity/<type>` data parts; `STEP_*` ignored; PR #8067 records tool interactions and keeps them through rebuilds; changelog 2026-09-15 persists run error/timing in ai-sdk/v6 format. Vocabulary: "tasks" (Agent Status chip, Task Card, `parentTaskId`, `depth`).
- **Vercel AI SDK 6 / UI**: `needsApproval` → parts with `approval-requested|approval-responded|output-denied`; `addToolApprovalResponse` with optional `reason`; `lastAssistantMessageIsCompleteWithApprovalResponses`; HMAC `experimental_toolApprovalSecret`; persistence via `responseMessages` (bugs #10196/#10169/#10980 around approval + persistence). Rich restore = typed parts in stored `UIMessage[]`; TanStack AI adds AG-UI subagent cards with full transcript persistence (PR #1438).
- **LangChain Agent Chat UI / Agent Server**: restore from `/threads/{id}/history` checkpoints; hide messages via `do-not-render-` id prefix / `langsmith:nostream`; historical subgraph replay fixed in Agent Server changelog. Restores messages + tool calls, not step labels.
- **OpenAI ChatKit** (Oct 2025 launch): server `Store.load_thread_items()` restores typed items — `user_message, assistant_message, client_tool_call, widget, task (custom|thought|search|file|image), task_group, workflow, hidden_context, end_of_turn` with `title/summary/status`; "chain-of-thought visualizations" built in. This is the most complete closed vocabulary for plain-language steps.
- **Google ADK web**: sessions restore from `SessionService` events; Trace tab groups traces by user message (adk-web discussion #59); history rendering bugs on contentless A2A events (#523).
- **Vocabulary map:** ChatGPT "Thought for Ns" + titled steps; ChatKit `task/thought/workflow`; assistant-ui `tasks`; AI SDK Elements "Chain of Thought" steps with status; B4 `b4.step` label/icon/status/sources. No cross-vendor standard.

---

## 4. Angular

- **Official:** `@copilotkit/angular` exists (0.1.1 2026-06-18 → 0.5.2 2026-09-08; blog 2026-07-23; ANGULARarchitects articles 2026-04-20 onward by Manfred Steyer, who also authored `CopilotActivity` PR #6033). It ships HITL (`registerHumanInTheLoop`, `injectInterrupt`), activity renderers, subagent grouping (PR #7444 names Angular), A2UI/Open Generative UI, threads (Intelligence-only). The Angular HITL article coverage is thin (ANGULARarchitects: approvals/subagents/history "not covered").
- **threadplane** (github.com/cacheplane/angular-agent-framework; npm `@threadplane/chat` created 2026-05-25, latest 0.2.0, modified 2026-09-18): packages `chat, langgraph, ag-ui, render, a2ui, middleware, telemetry`; Angular 20–22; durable threads, approvals via interrupts, generative UI registry, subagent streaming, tool-call progress; dual adapter (LangGraph Platform or AG-UI). This already predates CopilotKit's Angular package by ~3 weeks on npm.
- **First-of-kind?** An Angular AG-UI *chat* client is **not** first (CopilotKit Angular, threadplane itself). An Angular **activity/approval component kit that is host-independent and driven by a pure reducer** (`@b4run/ag-ui/view` → `@b4run/ag-ui-angular`) is unoccupied: CopilotKit's Angular activity story is `activityType`-keyed renderers for *their* message model, with no turn-summary/plain-language-step vocabulary; threadplane has tool-call progress but no shared reducer with a React sibling.
- **What makes threadplane a reference AG-UI Angular client:** (1) implement `AbstractAgent.connect()` against a documented `/connect` route and restore turns incl. steps/subagents (nobody restores nested subagents today — assistant-ui and CopilotKit both lose or don't document it); (2) approvals that echo `ResumeEntry.metadata` (grant) — no client does; (3) subagent groups rebuilt from `subagentRunId` on snapshot messages per the concepts page; (4) `ActivityMessage` renderers for an open `activityType` registry plus A2UI; (5) a conformance story against `@ag-ui/client` 1.0.1 (B4 already has a `runAgent` conformance gate).

---

## 5. Competitive-advantage assessment

| Move | First or parallel | Evidence |
|---|---|---|
| **A. Durable AG-UI thread replay via pluggable CopilotKit runner on B4 storage** | **Parallel on the runner (sqlite exists; Intelligence is the hosted answer); first for OSS multi-instance Postgres + live-run rejoin + full event replay of CUSTOM/STEP/SUBAGENT** | Docs invite shared-storage runners; no OSS Redis/Postgres runner found; `connect` replays "latest snapshot + remaining run events"; #6981 shows hosts need projectors for non-persisted activities; issue #3553 serverless pain. |
| **B. RFC: resume metadata / grants on interrupts** | **First to propose a protocol convention; parallel in spirit** with pydantic-ai #6452 (open, undecided), agent-framework #8150 (vendor metadata), AI SDK HMAC (non-AG-UI) | `ResumeEntry.metadata` and `Interrupt.metadata` already exist with "signatures" named as the intended use but no convention; `useInterrupt.resolve` lacks the parameter. A working B4 grant + a CopilotKit PR + a spec note is a credible RFC. |
| **C. Standard plain-language step vocabulary** | **First in AG-UI** (STEP has only `stepName`; ACTIVITY has no registry; CUSTOM is ad hoc); **parallel** to ChatKit tasks / assistant-ui tasks / AI SDK Elements | `activityType is an open string`; assistant-ui ignores STEP; CopilotKit examples use `"PLAN"/"SEARCH"`. Proposing a reserved `ag-ui` activity profile for tool progress with snapshot persistence fills a documented hole. |
| **D. First Angular AG-UI activity/approval component kit** | **Not first for Angular AG-UI** (CopilotKit Angular since 2026-06; threadplane since 2026-05); **first for a host-independent, reducer-driven kit with turn summaries + nested subagent turns + grant-aware approvals** | CopilotKit Angular blog admits immaturity; its approvals/subagent/history docs for Angular are thin; no other Angular AG-UI kit found. |
| **E. Host-independent TurnsView reducer** | **First as a published, framework-free AG-UI view model** | assistant-ui's reducer is tied to its message model; CopilotKit's `ɵbuildSubagentLayout` is internal (ɵ-prefixed); CopilotKit #6981 proposes a pure projector but only for Open Generative UI; TanStack's is inside `chat()`. `@b4run/ag-ui/view` already exists; the gap is positioning + conformance fixtures. |

---

## Ranked issues worth filing

1. **[b4run] Ship `@b4run/copilotkit-runner`: a B4-storage `AgentRunner` with full event replay and live-run rejoin.** Implement CopilotKit's documented `AgentRunner` (`run/connect/isRunning/stop`) over B4's sqlite/postgres stores: append every outbound AG-UI event per `(threadId, runId)`, serve `connect()` as a replayed `RUN_STARTED` (marked replay in `metadata`) + `MESSAGES_SNAPSHOT` + stored `CUSTOM b4.step`/`STEP_*`/`SUBAGENT_*`/`ACTIVITY_*` events + terminal `RUN_FINISHED` (keeping `outcome: interrupt` so `pendingInterrupts` restores), tail the ledger for runs still streaming, and handle connect-before-run. Evidence: docs invite shared-storage runners, only sqlite (single-instance) and hosted Intelligence exist, #3553 and #6981 show the pain. Advantage A: first OSS multi-instance runner that restores B4's activity kit losslessly.
2. **[upstream ag-ui] RFC: `/connect` history contract + replay marking.** Propose the spec text PR #2837 says it does not add: route, body, snapshot-vs-event replay, "replay never re-executes", `RUN_STARTED.metadata["ag-ui"].replay`, pending interrupts after replay, live rejoin vs `transport.resumable` (#2105). Reference impl = item 1 + threadplane connect. Evidence: #1160, #2105, #2837, agui-inspector #95 all say the contract is undefined.
3. **[upstream CopilotKit] `useInterrupt().resolve(payload, interruptId, { metadata })` (React/Vue/Angular).** Small PR plumbing an optional metadata bag into `ResumeEntry.metadata`, which the 1.0 schema already defines ("signatures, routing keys"). Unblocks echoing B4's server-minted grant. Evidence: limit (b) is host-side only; pydantic-ai #6452 wants the same channel.
4. **[upstream ag-ui] RFC: approval provenance via `Interrupt.metadata` + `ResumeEntry.metadata` (grants/signatures).** Define a reserved key (e.g. `metadata["ag-ui"].grant` or `signature`) issued on the interrupt and echoed on resume, with validation → `RUN_ERROR`. B4 ships the implementation (approval grants, prune, `b4 approvals`). Evidence: #6452 undecided, #8150 vendor-keyed, AI SDK HMAC proves the pattern. Advantage B.
5. **[upstream ag-ui] RFC: resumed-run signal on `RUN_STARTED`.** `RunStarted.metadata["ag-ui"].resumes: interruptId[]` (server-asserted) so clients glue the resume onto the awaiting turn without B4's `409 resume_required` heuristic (documented in `view/turns.ts`). Evidence: #6999/#7001 made resume a fresh runId; spec says RUN_STARTED carries nothing. Ties to item 2.
6. **[b4run] Emit `b4.step` as an `ACTIVITY_SNAPSHOT` profile (keep CUSTOM for one release).** `activityType: "b4.step"` (or proposed `ag-ui/tool-progress`), `content: {toolCallId, status, label, icon?, sources?}`, so steps survive `MESSAGES_SNAPSHOT` and render through CopilotKit/Angular `renderActivityMessages` and assistant-ui `agui-activity/<type>` without a connector. Then propose the profile upstream (item 7). Evidence: activity is the only restorable progress construct; `STEP_*` is ignored by assistant-ui; CUSTOM is not in snapshots.
7. **[upstream ag-ui] RFC: tool-progress activity profile / step vocabulary.** Document a reserved activity profile for plain-language tool steps (status enum, label, icon enum, sources) and clarify STEP vs ACTIVITY vs CUSTOM guidance, with B4 + threadplane as two independent implementations. Evidence: "activityType is an open string", no registry; ChatKit/assistant-ui/AI SDK each invented one. Advantage C.
8. **[threadplane] Reference AG-UI Angular client: `connect()`-based restore that rebuilds nested subagent turns and awaiting approvals.** Implement `AbstractAgent.connect` against item 2's route; restore turns via `@b4run/ag-ui/view` so subagent nesting survives reload (assistant-ui and CopilotKit do not document this); approvals carry grant metadata. Advantage D (first host-independent Angular kit; first client to restore nested subagents from snapshot attribution).
9. **[b4run] Publish `@b4run/ag-ui/view` as the reference client-side model with conformance fixtures.** Recorded AG-UI 1.0 streams (live, replayed, restored) → deep-equal `TurnsView`; document it for assistant-ui/TanStack/Angular consumers. Evidence: every host has a private reducer (CopilotKit `ɵbuildSubagentLayout`, assistant-ui, TanStack) and #6981 is asking for exactly a pure projector. Advantage E.
10. **[b4run] Verify CopilotKit subagent grouping (#7444) against the pinned `react-core` and retire or narrow limit (d).** If 1.77.0 includes it, the kit's nested-turn rendering should compose with (not fight) CopilotChat groups; if not, pin the version at which it lands. Evidence: PR merged ~2026-09-30; release notes read did not list it.
11. **[b4run] `@b4run/ag-ui-angular` on `@b4run/ag-ui/view`, consumable from both `@copilotkit/angular` (via `registerRenderActivityMessage`/`transformMessages`) and threadplane.** Evidence: CopilotKit Angular lacks a turn-summary/plain-language-step kit; threadplane has progress but no shared reducer. Advantage D.

## Claims I could NOT verify

- Whether CopilotKit PR #7444 (subagent grouping) shipped in 1.76.0 or 1.77.0 (release notes I could read did not list it); hence whether limit (d) still holds on 1.77.0.
- Whether ag-ui PR #2837 (`HttpAgent.connect` + ADK `/connect`) has merged and in which `@ag-ui/client` version (page showed review "requested changes", dated 2026-09-25; `@ag-ui/client` 1.0.1 notes mention "improved thread history reading", which may be #2846 only).
- `@copilotkit/angular` peer range: registry packument summarizer reported `^20||^21||^22`, the `/latest` view reported `^22.0.0` only; also 0.5.2 (2026-09-08) is `latest` while CopilotKit 1.75.1/1.77.0 notes describe Angular changes — the Angular package may have moved to a newer tag/package I did not locate.
- threadplane README "patch-only 0.0.x" summary vs npm `@threadplane/chat@0.2.0` — one of the two is stale; and whether threadplane already implements `connect()`/restore (README summary says "durable threads with persistence" but I did not read the code).
- CopilotKit Intelligence's "replay cursor" wire details and whether it is reachable to self-hosters.
- Exact Cursor/Devin/Claude UI step vocabularies (only secondary descriptions found); ChatKit launch date (Oct 2025) from a secondary source.
- Agno's and LlamaIndex's exact AG-UI history behaviour (only session_id/STATE_DELTA level detail found).
- `fromAgUiMessages` behaviour for `ActivityMessage` role entries in assistant-ui (page did not say whether activity messages restore).
- The CopilotKit v1.77.0 release date was rendered as "October 2, 2024" by the fetcher; npm shows `@copilotkit/react-core` 1.77.0 published 2026-10-02, which I treat as authoritative.

---

# Part 3 — threadplane


Read-only survey of `/Users/blove/repos/angular-agent-framework` (threadplane,
HEAD `79aabe3fd`) against the B4 worktree spec
`docs/superpowers/specs/2026-10-03-b4-activity-components-design.md`.
All paths below are absolute; `TP` = `/Users/blove/repos/angular-agent-framework`,
`B4` = `<b4run worktree>`.

---

## 1. threadplane architecture

### Layout, versions, build

- Nx + npm workspace (`TP/nx.json`, `TP/package.json` workspaces `packages/*`,
  `apps/*`, `libs/*`). Angular `~21.1.0` installed (`TP/package.json:50-56`,
  `node_modules/@angular/core` 21.1.6); published peers are
  `^20.0.0 || ^21.0.0 || ^22.0.0` (`TP/libs/chat/package.json:22-25`) and a CI
  lane builds a packaged consumer against Angular 20/21/22
  (`TP/.github/workflows/ci.yml:149-194`, matrix at line 158).
- Six publishable libs, fixed-version group, released together via Nx Release
  (`TP/nx.json` `release.groups.publishable`: chat, langgraph, ag-ui, render,
  a2ui, telemetry; `TP/docs/RELEASE.md:1-45`). Current version `0.2.0`
  (`TP/libs/chat/package.json:3`). Minor bumps, never 1.0 without owner
  approval (`TP/docs/RELEASE.md:3`). Publish is tag-driven with npm OIDC
  provenance (`TP/.github/workflows/publish.yml:1-40`).
- Angular libs build with ng-packagr through `@nx/angular:package`
  (`TP/libs/chat/project.json:21-40`), `compilationMode: partial`
  (`TP/libs/chat/tsconfig.lib.prod.json`), entry `src/public-api.ts`
  (`TP/libs/chat/ng-package.json:5`). Secondary entries `@threadplane/chat/debug`
  and `/testing` (`TP/tsconfig.base.json` paths). Lint prefixes are
  `chat`/`a2ui` for selectors (`TP/libs/chat/eslint.config.mjs:26-41`).
- Tests: Vitest + `@analogjs/vite-plugin-angular`, jsdom, `pool: 'forks'`
  (`TP/libs/chat/vite.config.mts`), TestBed via `platformBrowserTesting`
  (`TP/libs/chat/src/test-setup.ts`). Playwright e2e for the examples
  (`TP/examples/chat/angular/e2e/*.spec.ts`, incl. `keyboard-accessibility`,
  `interrupt-approval`, `research-subagent`). **No axe tooling anywhere**
  (`rg axe-core` finds nothing outside node_modules). Deterministic LLM via
  `@copilotkit/aimock` (`TP/package.json:72`) and an internal e2e harness
  (`TP/libs/e2e-harness/README.md`).
- Conventions (spec `TP/docs/superpowers/specs/2026-04-04-chat-component-library-design.md`
  "Angular Version & Patterns"): standalone only, Signals, `OnPush`
  everywhere, `@if/@for`, `input()`/`output()`. Zoneless in the examples
  (`TP/examples/ag-ui/angular/src/app/app.config.ts:20`). No `$localize`/i18n
  anywhere in `libs/chat`. SSR: client-only by design
  (`TP/docs/limitations.md` §2); the few guards are `typeof document`
  (`TP/libs/chat/src/lib/styles/chat-tokens.ts:437`).

### How it talks to agents

threadplane is adapter-based. `@threadplane/chat` consumes a runtime-neutral
`Agent` contract (`TP/libs/chat/src/lib/agent/agent.ts:26-92`):
`messages`, `status`, `isLoading`, `error`, `toolCalls`, `state` signals;
`submit/stop/retry/regenerate`; optional `interrupt`, `subagents`,
`clientTools`, `checkStatus`; required `events$`.

- **LangGraph adapter** (`@threadplane/langgraph`, `TP/libs/langgraph`): wraps
  `@langchain/langgraph-sdk` `runs.stream`/`joinStream`/`threads.getHistory`
  (`TP/libs/langgraph/src/lib/transport/fetch-stream.transport.ts:106-173`)
  behind a `StreamManager` bridge (`internals/stream-manager.bridge.ts`).
- **AG-UI adapter** (`@threadplane/ag-ui`, `TP/libs/ag-ui`): already exists.
  `provideAgent({url, threadId?, headers?, persistence?})` builds an
  `HttpAgent` from `@ag-ui/client` and wraps it with `toAgent()`
  (`TP/libs/ag-ui/src/lib/provide-agent.ts:15-60,140-197`,
  `to-agent.ts:150`). It subscribes with `source.subscribe({ onEvent })`
  (`to-agent.ts:665-670`) and reduces every event
  (`TP/libs/ag-ui/src/lib/reducer.ts`). **Pinned to `@ag-ui/client` /
  `@ag-ui/core` `^0.0.59`** (`TP/libs/ag-ui/package.json` peers; lockfile
  `0.0.59` at `TP/package-lock.json:692-724`; node_modules currently stale at
  0.0.52). B4 is on `@ag-ui/core 1.0.1` with peer `@ag-ui/client >=1.0.1`
  (`B4/packages/ag-ui/package.json`). The adapter already reduces
  `SUBAGENT_STARTED/FINISHED/ERROR`, `ACTIVITY_SNAPSHOT/DELTA`,
  `REASONING_MESSAGE_*`, `RUN_FINISHED` with `outcome.type === 'interrupt'`,
  and the `CUSTOM on_interrupt` bridge (`reducer.ts:148-600`; docs table in
  `TP/apps/website/content/docs/ag-ui/reference/event-mapping.mdx:74-175`).
  It does **not** handle `pendingToolCallIds` (no hits in `reducer.ts`).
- No CopilotKit client anywhere; the only `@copilotkit/*` dependency is
  `aimock` for tests. `@ag-ui/langgraph` is a devDependency only
  (`TP/package.json:43`).
- Backends in the repo: Python `ag-ui-langgraph` + FastAPI
  (`TP/examples/ag-ui/python/pyproject.toml`), a Mastra deploy
  (`TP/.github/workflows/deploy-ag-ui-mastra.yml`), LangGraph Platform/`langgraph dev`
  for the chat example, and a docs section for LangChain Deep Agents
  (planning/filesystem/subagents/memory/skills:
  `TP/apps/website/content/docs/deep-agents/getting-started/introduction.mdx`).

### Message / thread model

- `Message` (`TP/libs/chat/src/lib/agent/message.ts:7-47`): `id`, `delivery`,
  `role`, `content: string | ContentBlock[]`, `toolCallId?`, `name?`,
  `reasoning?`, `reasoningDurationMs?`, `extra?`, `citations?`,
  `toolCallIds?`.
- `MessageDelivery` (`agent/message-delivery.ts:15-21`):
  `{generation, phase:'streaming'} | {generation, phase:'complete', outcome}`
  with `outcome ∈ success|error|aborted|interrupted|paused`. This is the
  natural source for `.b4-turn__text[data-live]`.
- `ToolCall` (`agent/tool-call.ts`): `id,name,args,status(pending|running|complete|error),result?,error?`.
- `Subagent` (`agent/subagent.ts:7-21`): `toolCallId`, `name?`, and
  **signals** `status`, `messages`, `toolCalls?`, `state`. Keyed differently
  per adapter; `chat-tool-calls` re-keys by `toolCallId`
  (`primitives/chat-tool-calls/chat-tool-calls.component.ts:126-134`).
- `AgentInterrupt` (`agent/agent-interrupt.ts`): `{id, value: unknown, resumable}`.
  AG-UI projects the native batch as `value: { interrupts, runId }`
  (`TP/libs/ag-ui/src/lib/to-agent.ts:238-249`).
- Per-message tool-call scoping: `resolveMessageToolCalls` uses
  `message.toolCallIds` or `tool_use` blocks
  (`primitives/chat-tool-calls/resolve-message-tool-calls.ts:17-34`).

### Restore after reload (today)

- **LangGraph**: `threadId` is a `Signal<string|null>` bound to the URL by
  `injectThreadRouting` (`TP/libs/chat/src/lib/routing/thread-routing.ts:40-87`;
  example wiring `TP/examples/chat/angular/src/app/shell/demo-shell.component.ts:152-165`).
  On switch/connect the bridge calls `transport.getHistory(threadId)` →
  `client.threads.getHistory` (`fetch-stream.transport.ts:171-173`), takes
  `history[0].values.messages` into `messages$`, strips `messages` from
  `values$`, rebuilds `toolCalls$` from messages (`syncToolCallsFromMessages`),
  and re-hydrates pending interrupts from checkpoint tasks
  (`stream-manager.bridge.ts:634-692`, `hydrateInterruptsFromHistory` at 1649).
  Subagents are **not** restored: they come only from child-namespace stream
  events (`internals/subagent-tracker.ts`), so a reloaded thread shows tool
  calls with results but no subagent cards, no reasoning timing, no step
  order beyond message order. Threads list via `client.threads.search/get/update`
  (`threads/threads-adapter.ts:125-233`).
- **AG-UI**: no server fetch at all. Optional app-owned `persistence`
  (`AgUiInterruptPersistence` with `load`/`compareAndSwap`/`reconcile`,
  `TP/libs/ag-ui/src/lib/interrupt-persistence.ts:5-27`) stores
  `{committed: ThreadSnapshot, session, resumeInput?}`; on boot `hydrate()`
  replays a synthetic `MESSAGES_SNAPSHOT` and restores the interrupt session
  (`to-agent.ts:220-236`). Requires a stable configured `threadId`
  (`provide-agent.ts:59`). The example deliberately omits it because the
  protocol "sends the full client-side message list on every runAgent()" and
  there is no snapshot-on-connect (`TP/examples/ag-ui/angular/src/app/app.config.ts:22-34`).

### Approvals / HITL

The `<chat>` composition renders **no** interrupt UI itself
(`compositions/chat/chat.component.ts:170-340` has no `chat-interrupt*`).
Consumers compose one of:
- `<chat-interrupt-panel [agent] (action)>` inline `role="alert"` with a
  four-action vocabulary (`compositions/chat-interrupt-panel/chat-interrupt-panel.component.ts:104-129`)
  — what the examples use (`TP/examples/chat/angular/src/app/shell/demo-shell.component.html:140,153`).
- `<chat-approval-card [agent] [matchKind] (action)>` — a native `<dialog>`
  `showModal()` with Cancel/Edit/Approve and a `#body` template slot
  (`compositions/chat-approval-card/chat-approval-card.component.ts:17-170`).
- `<chat-interrupt>` plain `role="status"` primitive.
Resume is `agent.submit({ resume })`; AG-UI adds generation-aware guards
(`AgUiSubmitOptions.interruptGeneration`, `to-agent.ts:94-97`).

### Subagents, tool-call region, trace, indicators

- Tool-call region: `<chat-tool-calls [agent] [message] [grouping] [groupSummary] [excludeToolNames]>`
  groups consecutive same-name calls, renders `<chat-subagent-card>` when a
  call spawned a subagent, else `<chat-tool-call-card>`, with per-tool-name
  override via `<ng-template chatToolCallTemplate="name|*">` content children
  (`chat-tool-calls.component.ts:57-160`, directive at
  `chat-tool-call-template.directive.ts:33-41`). It is embedded in `<chat>`'s
  `ai` message template and forwards projected `[chatToolCallTemplate]`
  content (`chat.component.ts:232-236`). Default group label heuristics in
  `group-summary.ts`.
- Disclosure primitive `<chat-trace [state] [defaultExpanded]>`: header
  `<button aria-expanded>` + `traceIcon/traceLabel/traceMeta` slots, body
  `max-height: 250px; overflow: auto` (`primitives/chat-trace/chat-trace.component.ts:17-36`,
  `styles/chat-trace.styles.ts`). Auto-expands on running/error, user
  override persists, override resets on re-entry to running/error.
- `<chat-tool-call-card>` = trace + mono name + 10px status pill + Inputs/Output
  `<pre>` (`compositions/chat-tool-call-card/chat-tool-call-card.component.ts`).
- `<chat-subagent-card>` = trace + name/id/status pill + per-message markdown
  and nested tool cards (`compositions/chat-subagent-card/chat-subagent-card.component.ts:68-90`).
- Reasoning: `<chat-reasoning>` pill ("Thinking…" / "Thought for 9s" /
  "Show reasoning"), merged across consecutive reasoning steps in `<chat>`
  (`primitives/chat-reasoning/chat-reasoning.component.ts`,
  `chat.component.ts:218-231`).
- Typing: `<chat-typing-indicator>` three `.chat-typing__dot` spans,
  `role="status"` (`primitives/chat-typing-indicator/chat-typing-indicator.component.ts:38-46`),
  suppressed while the current bubble streams (`chat.component.ts:303-310`).
- Planning: there is no todo/plan renderer in `libs/chat`; the deep-agents
  planning page projects `state.todos` into an app-owned panel
  (`TP/apps/website/content/docs/deep-agents/capabilities/planning.mdx`).

### Theming and design guidance

- Tokens `--tplane-chat-*` + `--a2ui-*` defaults are injected once into
  `<head>` as `<style id="tplane-chat-root-tokens">` wrapped in
  `@layer tplane-chat` (`styles/chat-tokens.ts:381-443`). Light/dark by
  `prefers-color-scheme` or `[data-theme]`/`[data-threadplane-chat-theme]`
  (`chat-tokens.ts:392-402`). Token table and override story:
  `TP/apps/website/content/docs/chat/guides/theming.mdx`.
- Component styles are per-component emulated-encapsulation strings
  (`styles/*.styles.ts`), unlayered. Only `chat-streaming-md` and
  `markdown-math` use `ViewEncapsulation.None` (`streaming/streaming-markdown.component.ts:111`).
- Design guidance: `TP/docs/superpowers/specs/2026-04-05-chat-ui-redesign.md`
  ("Neutral by default", "AI = text, Human = bubble (ChatGPT pattern)",
  "Centered column", "Template overrides"), continuation notes in
  `TP/docs/superpowers/context/2026-04-06-chat-library-continuation.md:55,129`,
  and the component-library spec above. No separate a11y guidance doc.

### Existing plugin / slot mechanisms

1. `ng-template[chatMessageTemplate="human|ai|tool|system"]` on
   `<chat-message-list>` replaces a whole message type
   (`primitives/chat-message-list/message-template.directive.ts`).
2. `ng-template[chatToolCallTemplate="name|*"]` inside `<chat-tool-calls>`,
   forwarded by `<chat>` (`chat.component.ts:232-236`). Context is a single
   `ToolCall` + `status` — per call, not per turn.
3. Named content slots on `<chat>`: `[chatHeader]`, `[chatWelcomeSuggestions]`,
   `[chatInputModelSelect]` (`chat.component.ts:184,200,330`).
4. Generative-UI registries (`@threadplane/render` `provideViews`, a2ui
   catalog) and `MARKDOWN_VIEW_REGISTRY` DI token.
There is **no slot that replaces the whole tool-call region per message**
and no "activity renderer" slot; sub-project 4's two slots are new.

---

## 2. Fit with the §5.6 DOM contract

### Mapping

| B4 contract | threadplane today | Notes |
|---|---|---|
| `section.b4-turn[data-state]` | the `ai` template body of one assistant message: `<chat-reasoning>` + `<chat-tool-calls>` + `<chat-tool-views>` (`chat.component.ts:207-292`) | one assistant `Message` per model step; a turn spans several messages. threadplane already merges reasoning runs across messages (`reasoningRun(i)`), so "one turn summary at the run's first step" has a precedent. |
| `button.b4-turn__summary[aria-expanded]` | `chat-trace` header / `.ctc__group-header` | group header lacks `aria-expanded` (below). |
| `.b4-turn__text[data-live]` | `message.delivery.phase === 'streaming'` (`chat.component.ts:214`) | |
| `li.b4-step[data-kind=tool]` | `<chat-tool-call-card>` (`ToolCallInfo`) | status enum maps 1:1 except B4 `awaiting`. |
| `li.b4-step[data-kind=reasoning]` | `<chat-reasoning>` | threadplane keeps duration (`reasoningDurationMs`). |
| `li.b4-step[data-kind=subagent]` + `.b4-step__children` | `<chat-subagent-card>` anchored by `Subagent.toolCallId` | child `messages`/`toolCalls` are **signals** on `Subagent`; a connector must read them inside `computed`. |
| `li.b4-step[data-kind=plan]` + `.b4-checklist` | none in chat lib (deep-agents `todos` panel is app code) | new. |
| `li.b4-step[data-kind=group]` | `.ctc__group` consecutive same-name grouping | same idea; B4 `groupSteps` replaces `summarizeGroup`. |
| `.b4-approval[data-state]` | `<chat-interrupt-panel>` (inline, `role="alert"`) / `<chat-approval-card>` (`<dialog>`) | threadplane has no per-step attachment; B4 attaches by `Interrupt.toolCallId`. Decision vocabulary differs: threadplane approve/edit/cancel vs B4 once/always/deny. |
| `.b4-visually-hidden[role=status]` | `chat-typing-indicator` `role="status"` only | new per-turn region. |

### Host CSS that would fight `@layer b4-activity`

- No `all: unset`, no global element resets, no shadow DOM in `libs/chat`
  (greps for `all: unset`, `ViewEncapsulation.ShadowDom`, `::ng-deep`, bare
  `button|ol|li {` in `styles/` all empty). Emulated encapsulation means
  threadplane's component rules cannot reach B4's elements unless B4 renders
  inside a threadplane component's own template; the kit's own components
  are safe.
- **One unlayered `!important` global rule does reach B4**: the reduced-motion
  block `*, *::before, *::after { animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important; transition-duration: 0.01ms !important }`
  (`chat-tokens.ts:281-287`) is appended outside `@layer tplane-chat`
  (`chat-tokens.ts:424-425`). Unlayered `!important` beats anything in
  `@layer b4-activity`. Consequence: under reduced motion the B4 shimmer is
  killed (desired), but any B4 looping animation would be frozen at iteration
  1 rather than disabled — acceptable because §5.4 says B4 has no looping
  animation under reduced motion; just do not rely on `animation` for state.
- `:host { font-family: var(--tplane-chat-font-family); color: var(--tplane-chat-text) }`
  on every chat component (`chat-tokens.ts:256-261`): B4 inherits the host
  font (per §5.2) and must set its own `color` from `--b4-activity-text`,
  otherwise it inherits threadplane's — fine, since the defaults are the
  same values.
- The `ai` message host is a full-width block, `line-height: 1.55`,
  `font-size: var(--tplane-chat-font-size)` = 1rem (`styles/chat-message.styles.ts:20-28`).
  B4 sets 14px step sentences explicitly, so no clash.
- `chat-trace` body `max-height: 250px; overflow: auto` (`chat-trace.styles.ts:28-35`)
  would clip a nested `.b4-turn` if the connector renders inside a trace;
  the slot should replace `<chat-tool-calls>` at the message level, not nest.
- Theme switching differs: threadplane follows the OS by default
  (`prefers-color-scheme`, `chat-tokens.ts:392`); B4 follows the host
  (`.dark`/`[data-theme="dark"]`, `data-b4-theme`, `B4/packages/ag-ui/src/react/styles.css:12-15`).
  threadplane also honors `[data-theme="dark"]` (`chat-tokens.ts:399-402`),
  so the shared case works; an OS-dark/host-light page will paint
  threadplane dark and B4 light unless the connector sets
  `data-b4-theme="auto"`. The connector should document or set this.
- Tailwind v4 preflight is **not** in the chat example (`TP/examples/chat/angular/src/styles.css`
  has only `html, body` rules); `libs/example-layouts` peers tailwind, so
  host apps may have `@layer base` resets. Layer order: a Tailwind
  `@layer theme, base, components, utilities` statement followed by
  `@layer b4-activity` puts B4 last and winning among layers. Fine.

### Upstream bugs listed in the spec — all confirmed present

1. **Reduced-motion selector mismatch**: `chat-tokens.ts:289-297` targets
   `.tplane-chat-typing-dot`, `.tplane-chat-caret`, `.tplane-chat-welcome__pulse`;
   the real classes are `.chat-typing__dot`
   (`chat-typing-indicator.component.ts:41-43`, `chat-typing-indicator.styles.ts:14`),
   `.chat-message__caret` (`chat-message.styles.ts:48`), and no welcome
   pulse class exists. `.chat-reasoning__pulse` (`chat-reasoning.styles.ts:35-46`)
   and `.chat-genui-skeleton` shimmer are also looping; only the latter is
   listed. Effect: with the `*` rule the dots freeze mid-loop at
   `iteration-count: 1`, the exact failure the comment at
   `chat-tokens.ts:276-278` says it avoids. The unit test only asserts the
   media block exists (`styles/chat-tokens.spec.ts:5-8`).
2. **Missing `aria-expanded` on the tool-call group header**:
   `chat-tool-calls.component.ts:65` `<button class="ctc__group-header" (click)="toggleGroup($index)">`
   has no `aria-expanded`; expansion is only on the parent `div[data-expanded]`
   (line 64). `chat-trace` (line 21) and `chat-reasoning` (line 46) do it right.
3. **Success-green contrast**: `--tplane-chat-success: #16a34a` (`chat-tokens.ts:19`)
   is used as text on `.sac__pill[data-status="complete"]` at 11px
   (`chat-subagent-card.component.ts:47-56`) — ≈3.3:1 on white, below 4.5:1.
   B4 picked `#15803d` (`B4/packages/ag-ui/src/react/styles.css:24`).
4. **Sub-24px targets**: `chat-trace` header has `padding: 0` and inherits
   `font-size-sm` 0.875rem (`chat-trace.styles.ts:3-17`), so the button is
   ~17–21px tall; chevrons are 10–12px (`chat-trace.styles.ts:18-23`,
   `chat-tool-calls.component.ts:47-50`); the status pill is 10px text
   (`chat-tool-call-card.component.ts:30-43`); the reasoning header is
   `padding: 4px 10px` at 12px text ≈ 22px (`chat-reasoning.styles.ts:12-25`).
   The `.ctc__group-header` (8px vertical padding) does clear 24px.
   No `focus-visible` rule exists for trace/tool-call/group headers
   (`rg focus-visible` hits only error, welcome, project-list).

---

## 3. Shape of `@b4run/ag-ui-angular` for minimal glue

- **Packaging**: ng-packagr, `compilationMode: partial`, peers
  `@angular/core ^20 || ^21 || ^22` to match threadplane's matrix, plus
  `@b4run/ag-ui` (for `./view`). `@b4run/ag-ui`'s `./view` subpath is clean
  for a browser bundle: it imports only `@ag-ui/core` (`EventType` + types),
  `@b4run/sdk` (`isToolDisplayIcon`, types) and sibling files
  (`B4/packages/ag-ui/src/view/turns.ts:1-25`, `view/step.ts:1-4`); no
  `process`/`node:`/`window` (`rg` empty); React/CopilotKit/`@ag-ui/client`
  peers are optional (`peerDependenciesMeta`, `B4/packages/ag-ui/package.json`).
  `@b4run/sdk` root touches `node:` only under `src/testing/*`. threadplane's
  apps build with `@angular/build:application` (esbuild) and
  `moduleResolution: bundler` (`TP/examples/chat/angular/project.json`,
  `TP/tsconfig.base.json`), so an ESM `exports`-map package imports without
  `allowedCommonJsDependencies`. Two caveats: `@ag-ui/core` will be
  installed twice (threadplane 0.0.59 top-level, 1.0.1 nested under
  `@b4run/ag-ui`) — runtime fine, types don't unify, so the connector must
  accept threadplane events structurally; and `zod` 3 vs 4 coexist already
  in threadplane (`TP/package.json` has both 3.25 and 4.4.3 via growth-capture).
- **Components** (mirroring `B4/packages/ag-ui/src/react/activity/*`):
  - `TurnActivityComponent` (`b4-turn-activity`): `turn = input.required<TurnView>()`,
    `labels`, `hiddenTools`, `defaultOpen`; `OnPush`; `ViewEncapsulation.None`
    so the shared `styles.css` classes apply, or emulated with host-only
    styles and the global stylesheet doing the work (threadplane does the
    latter for tokens). Expansion state as `signal`s inside, like `chat-trace`.
  - `StepComponent`, `StepGroupComponent`, `PlanStepComponent`,
    `ReasoningStepComponent`, `SubagentStepComponent`, `StepDetailComponent`,
    `SourceChipsComponent`, `DisclosureComponent`.
  - `ApprovalCardComponent` (`b4-approval-card`): `approval = input.required<ApprovalView>()`,
    `state` (`awaiting|deciding|failed`), `decide = output<{ id; decision: 'once'|'always'|'deny'; scope? }>()`.
  - A `b4ActivityStyles` side-effect or documented `@import "@b4run/ag-ui/react/styles.css"`
    (threadplane's docs show the `styles` array / `@import` pattern,
    `TP/libs/chat/src/themes/default-light.css:9-11`).
- **`provideB4Activity({ labels?, hiddenTools?, theme? })`** returning
  `EnvironmentProviders` with an `InjectionToken<B4ActivityConfig>`; keep it
  optional (threadplane just removed a do-nothing `provideChat()`,
  `TP/libs/chat/CHANGELOG.md` "Removed"), so only ship it if it configures
  something real (label overrides, theme attribute, decision sender).
- **Signals over `TurnsView`**: a tiny `B4TurnsStore` (`signal<TurnsView>`
  + `apply(event)` calling `reduceTurns`) is enough; expose
  `turns = computed(...)` and `turnForMessage(messageId)`.
- **Live timing**: React has `useLive`; Angular equivalent is an
  `effect` + `setInterval` under `DestroyRef`, or `toSignal(interval())`.
- **Tests**: Vitest + analog plugin as in threadplane so the same fixtures
  run; add axe (`vitest-axe` or `axe-core` directly) since §8 wants it and
  threadplane has none.

### Connector `@b4run/ag-ui-angular/threadplane`

- Needs raw AG-UI events. `provideAgent` hides the `HttpAgent`; the public
  `toAgent(source)` is exported (`TP/libs/ag-ui/src/public-api.ts:1`), so the
  connector can construct its own `HttpAgent`, call `source.subscribe({ onEvent })`
  a second time (AG-UI `AbstractAgent.subscribe` is multi-subscriber), and
  hand the same source to `toAgent`. Alternatively upstream a
  `rawEvents$`/`onEvent` tap on `AgUiAgent` (candidate issue below).
- Message ↔ turn linkage: `Message.toolCallIds` (set by the reducer at
  `reducer.ts:288-292,399`) joins a `TurnView` to the assistant message
  whose `ai` template hosts the slot.
- Decisions: call `agent.submit({ resume })` with the AG-UI 1.0 resume shape
  and pass `interruptGeneration` from `interruptSession()`
  (`to-agent.ts:94-97,120`).

---

## 4. Restore in threadplane — what B4 would need to provide

- LangGraph path: `GET /threads/{id}/history` via the SDK is the only read
  (`fetch-stream.transport.ts:171-173`); values.messages are the source of
  truth and tool results are reconstructed from `ToolMessage`s. Nothing
  polls `/threads/:id/state`; `checkStatus` is `getHistory`-based
  (`stream-manager.bridge.ts:212`). A B4-served LangGraph-compatible
  `threads.getHistory` would restore text + tool calls but not activity
  steps (no `b4.step`, no subagent events, no reasoning timing).
- AG-UI path: no server read at all; the only hook is the app-owned
  `persistence.store.load(key)` returning `{committed:{messages,state}, session, resumeInput?}`
  (`interrupt-persistence.ts:5-27`) and `reconcile(record)` for uncertain
  resumes. The natural B4 shape is therefore **an HTTP endpoint the connector
  can adapt into that `store`**: `GET /agui/threads/:id` →
  `{ messages, state, pendingInterrupts, events? }` where `events` (or a
  replayable AG-UI event log) lets `reduceTurns` rebuild full-fidelity turns
  (the spec's "live, replayed or restored produce identical views",
  §6.1). Threadplane's own spec already flags "snapshot replay on connect"
  as the missing piece (`TP/examples/ag-ui/angular/src/app/app.config.ts:22-34`).
  `MESSAGES_SNAPSHOT` alone loses steps, plan, subagents and approvals'
  per-step attachment; a `pendingInterrupts` list is needed because
  threadplane's `hydrate()` sets `source.pendingInterrupts` (`to-agent.ts:229`).
- Thread lists: threadplane expects `threads.search/get/update/delete`
  with `metadata.{title,archived,pinned,projectId,pinnedOrder}`
  (`threads-adapter.ts:125-233`); B4's Agent Protocol threads store already
  covers search/get.

---

## 5. Ecosystem opportunity

threadplane **already speaks AG-UI** (0.0.59) with interrupts (native
`RUN_FINISHED` outcome + legacy `on_interrupt`, Mastra command profile),
subagents (`SUBAGENT_*`, `ACTIVITY_*`), reasoning, client tools, citations,
generative UI (json-render + A2UI), and an app-owned persistence contract. It
is the only Angular AG-UI client in its dependency graph or docs; there is no
`@copilotkit/angular` anywhere. Making it the reference AG-UI 1.0 Angular
host is mostly a version cut-over plus the activity layer.

Candidate issues (repo in brackets):

1. **[threadplane] Cut `@threadplane/ag-ui` over to AG-UI 1.0.** Peers are
   `^0.0.59` (`TP/libs/ag-ui/package.json`); the adapter design listed "AG-UI
   1.0 ships" as its revisit trigger (`TP/docs/superpowers/specs/2026-04-27-ag-ui-adapter-design.md:190`).
   1.0 adds `pendingToolCallIds` on `RUN_FINISHED` (unhandled in
   `reducer.ts`), formalizes `Interrupt.toolCallId` and grants at
   `metadata.grant`, and B4's `./view` depends on `@ag-ui/core 1.0.1`. Without
   this, every B4 host integration ships two `@ag-ui/core` copies and
   type-casts at the seam. Matters because it decides whether the connector
   is thin or an adapter-of-an-adapter.
2. **[threadplane] Expose a raw event tap on `AgUiAgent`** (`events$` only
   carries `state_update`/`custom`, `TP/libs/chat/src/lib/agent/agent-event.ts:6-30`).
   A `rawEvents$: Observable<BaseEvent>` or an `onEvent` option on
   `ToAgentOptions` lets `reduceTurns` run without a second `HttpAgent`
   subscription. Matters because the connector otherwise bypasses
   `provideAgent` and loses persistence/telemetry wiring.
3. **[threadplane] Per-message "activity" slot and a tool-call-region
   replacement slot on `<chat>`.** Today only per-call
   `chatToolCallTemplate` exists (`chat.component.ts:232-236`); the `ai`
   template hard-codes `<chat-reasoning>` + `<chat-tool-calls>`. Proposed:
   `ng-template[chatActivityTemplate]` with `{ $implicit: message, index, toolCalls, subagents }`
   that replaces that block when present. This is the sub-project 4 slot and
   is useful to any custom renderer, not just B4.
4. **[threadplane] Fix the reduced-motion selector list** (`chat-tokens.ts:289-297`)
   to `.chat-typing__dot`, `.chat-message__caret`, `.chat-reasoning__pulse`,
   and assert real class names in `chat-tokens.spec.ts`. Small, WCAG 2.3.3.
5. **[threadplane] `aria-expanded` + `aria-controls` on `.ctc__group-header`**
   (`chat-tool-calls.component.ts:65`) and a `:focus-visible` ring on
   `chat-trace__header`/`chat-reasoning__header`. WCAG 4.1.2 / 2.4.7.
6. **[threadplane] Raise disclosure targets to ≥24px and fix
   `--tplane-chat-success` text contrast** (`chat-trace.styles.ts:4-17`,
   `chat-tokens.ts:19`, `chat-subagent-card.component.ts:56`). WCAG 2.5.8 /
   1.4.3; B4's `--b4-activity-complete: #15803d` is the suggested value.
7. **[threadplane] Restore subagent and reasoning detail from history** in
   the LangGraph bridge — `refreshHistory` rebuilds `toolCalls$` only
   (`stream-manager.bridge.ts:655-684`); subagent cards vanish on reload. For
   AG-UI, adopt a server snapshot endpoint when one exists (see 8).
8. **[b4run] Thread snapshot/replay endpoint for AG-UI hosts**:
   `GET /agui/threads/:id` returning messages, state, pending interrupts and
   a replayable event log (or the `TurnsView` itself), so `reduceTurns`
   gives the same view after reload as live (§6.1). Also the natural
   backing for threadplane's `AgUiInterruptPersistence.store`/`reconcile`.
   Feeds the parallel storage track.
9. **[b4run] Angular example + CI lane for `@b4run/ag-ui-angular`** driving
   threadplane's `<chat>` against the research backend through Playwright
   with the §5.6 DOM-contract assertions and axe (threadplane has no axe
   today). This is what makes threadplane a "reference host" claim
   checkable.
10. **[threadplane] Plan/todo rendering in the chat lib.** Deep Agents
    planning is documented as an app-owned panel over `state.todos`
    (`planning.mdx`); B4's `PlanStep` + `b4.plan` activity gives an
    in-transcript checklist. Either adopt the B4 component or add a
    first-party `chat-plan` primitive; today threadplane renders no plan in
    the transcript.
11. **[b4run] Decision vocabulary bridge**: threadplane's approval UIs emit
    approve/edit/cancel or a four-action panel; B4 is once/always/deny with
    scope. The connector needs a documented mapping, and `edit` is deferred
    in B4 (§10). Worth an issue so hosts know what to expect.

---

## Recommendation

Do sub-project 3 first, but scope it to the kit and a CopilotKit-free demo
host, and start sub-project 4 with the three upstream threadplane PRs that
have no B4 dependency (the slot — issue 3, the raw-event tap — issue 2, and
the a11y fixes — issues 4–6) in parallel, because those are the only parts of
4 Brian controls on a clean release cadence and they unblock the connector
regardless of protocol version. Then land the connector once threadplane's
AG-UI 1.0 cut-over (issue 1) is decided; until then the connector must adapt
0.0.59 events structurally and ship two `@ag-ui/core` copies. The three
biggest risks: (1) the **AG-UI 0.0.59 vs 1.0.1 split** — a nested
`@ag-ui/core` and non-unifying types at the connector seam, and
`pendingToolCallIds`/grant semantics threadplane does not know; (2) the
**turn-vs-message mismatch** — threadplane renders per assistant message and
`<chat>` hard-codes reasoning + tool-call rendering, so without the new slot
a B4 turn either duplicates threadplane's trace cards or has to be spliced
across several `ai` bubbles (the reasoning-run merge at
`chat.component.ts:218-231` shows how fiddly that gets); (3) **restore
fidelity** — threadplane has no server read on the AG-UI path and the
LangGraph path restores only messages/tool results, so a reloaded thread will
show a degraded turn until the B4 snapshot/replay endpoint (issue 8) exists;
promising "same view live or restored" in docs before then would be
overstating it.
