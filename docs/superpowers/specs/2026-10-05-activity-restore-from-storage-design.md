# Activity restore from storage — design

Sub-project 2b-restore of the activity-components arc
(`2026-10-03-b4-activity-components-design.md`). Research behind every decision here is in
`docs/superpowers/notes/2026-10-04-activity-restore-and-ecosystem-research.md` (Part 1).
Decided with Brian on 2026-10-04 and 2026-10-05.

## 1. Problem and decisions

The activity kit renders a thread from AG-UI events (`reduceTurns` in `@b4run/ag-ui/view`). After a
page reload a host rebuilds the thread from B4's storage, not from events, and today that storage
cannot produce a `TurnView`: there is no run identity, tool steps persist their label only for tools
with a `display`, the `task` tool returns a plain string, no turn records how or when it ended, and
nothing reads the subagent children's checkpoints.

Decisions (do not relitigate):

- **Restore from the checkpoint chain we already keep.** No parallel per-thread event store. Breaking
  changes to stored messages are acceptable; alignment with existing storage is the rule.
- **No run id in storage.** A turn is a user message and everything until the next one; a resume
  after an approval continues the same turn, which is what the checkpoint shows. Per-turn facts
  attach to the turn, not to a transport run id.
- **Server endpoint with a shared core.** `turnsFromState()` in `@b4run/ag-ui/view` is the one
  implementation; `GET /threads/:id/turns` serves it; `/state` stays the raw read with its
  `created_at` fixed.
- **Timestamps where they are free.** Turn boundaries from checkpoint timestamps; per-step times
  stamped by the converter and the `task` bridge.
- **Approvals.** Parked interrupts are embedded in `/turns`; the decision on a gated call is stamped
  on its ToolMessage.
- **No backward compatibility.** Threads written before this release are not supported by `/turns`;
  a missing stamp is handled exactly like a malformed one (ignored, with a warning), with no
  special-casing of old data.
- Adoption of the kit by the navlog example (formerly research) and its scaffold template, the W7/W8
  harness rewrite against the DOM contract, legacy card removal, axe and the keyboard pass are
  **sub-project 2b-adopt**, specified separately after this ships.

## 2. What is stamped into existing storage

No new tables or stores. Three B4-owned facts are written where they are born.

### 2.1 Every ToolMessage carries a complete `additional_kwargs.b4_step`

The converter (`packages/langchain/src/tool-converter.ts`) builds a ToolMessage for every tool
call, with or without a `display`. The `task` bridge (`subagent-tool-bridge.ts`) returns a
ToolMessage instead of a string.

```ts
interface PersistedStep {
  status: "completed" | "failed" | "denied"
  icon?: ToolDisplayIcon
  label?: string            // display.done when present; the tool-name fallback stays client-side
  sources?: ToolDisplaySource[]
  startedAt: string         // ISO, when the body started
  settledAt: string         // ISO, when the body returned or threw
  decision?: "once" | "always" | "deny"   // present when the call went through a permission gate
}
```

`failed` covers thrown tools. `denied` is a call a permission or argument constraint blocked
(the converter recognises the branded result from cacheplane/b4run#936), persisted exactly as the
live stream reports it since cacheplane/b4run#946: `status: "denied"` with the icon only, never a
success label or sources. A denial is not a failure: its ToolMessage keeps `status: "success"` (an
`error` status would make the live translator append a `failed` step, which wins over `denied` in
the reducer), and `turn.failed` never counts it. `b4_content_parts` is unchanged.

The `task` ToolMessage additionally carries:

```ts
interface PersistedSubagent {
  name: string
  routeId: string
  description?: string
  depth: number
  checkpointNs: string      // the child's LangGraph namespace, e.g. "tools:<task id>"
  outcome: "done" | "failed" | "suspended"
  error?: string
}
```

under `additional_kwargs.b4_subagent`. The bridge already holds the namespace in its config.

### 2.2 One `b4:turn` record in checkpoint metadata when a run ends

Written through the saver wrapper that writes `b4:checkpoint-routes` today
(`packages/cli/src/lib/runtime/checkpoint-route-provenance.ts`), on the head checkpoint, when the
runtime computes the terminal status (the `terminalStatus` call sites in the AG-UI handler and the
Agent Protocol run paths):

```ts
interface PersistedTurnEnd {
  status: "done" | "failed" | "stopped"
  error?: string            // the RUN_ERROR message for failed
  endedAt: string           // ISO
}
```

Awaiting needs no stamp: the parked interrupt is already in the head checkpoint's pending writes.
Turn start is the `ts` of the checkpoint that added the user message. LangGraph does not merge
`config.metadata` into loop checkpoints, which is why the stamp goes through the saver wrapper.

### 2.3 One saver method, `listNamespaces(threadId)`

On the SQLite and Postgres checkpointers (`SELECT DISTINCT checkpoint_ns` for the thread), added to
both conformance suites. Subagent children already checkpoint under `tools:<task id>` because the
child graph is compiled with the checkpointer omitted, not disabled, and LangGraph inherits the
parent's; verified on 2026-10-04 against the navlog example's database (13 child namespaces, each
with `metadata.parents[""]` pointing at the parent checkpoint). The comment claiming children have no
checkpointer is corrected. No DDL change on either backend.

Checkpoints are never pruned, so these facts last as long as the thread.

## 3. `turnsFromState` in `@b4run/ag-ui/view`

```ts
export function turnsFromState(input: ThreadStateForTurns): TurnsFromStateResult

interface ThreadStateForTurns {
  threadId: string
  status: "idle" | "busy" | "interrupted"
  root: CheckpointHistory               // oldest first
  children: Record<string, CheckpointHistory>   // keyed by checkpoint namespace
  pendingInterrupts: PendingInterrupt[] // the /pending_interrupts shape
  now?: () => number                    // only for the busy head; defaults to Date.now
}

type CheckpointHistory = ReadonlyArray<{
  id: string
  ts: string
  metadata: Record<string, unknown>     // includes "b4:turn" when present
  values: { messages: PersistedMessage[]; todos?: PlanTodo[] }
}>

interface TurnsFromStateResult {
  turns: TurnsView
  warnings: string[]                    // one line per ignored stamp or unattached child namespace
}
```

`PersistedMessage` is the decoded LangChain message (role, id, content blocks, `tool_calls`,
`tool_call_id`, `status`, `additional_kwargs`), never the serialization envelope; decoding is the
caller's job.

The function does not reimplement the reducer. It **synthesises the AG-UI events the live stream
would have carried** and folds them through the unchanged `reduceTurns`:

| Stored fact | Synthesised events |
|---|---|
| User message | `RUN_STARTED { threadId, runId: <message id> }`; clock = that checkpoint's `ts` |
| Assistant message | `REASONING_START/MESSAGE_*/END` for thinking blocks (id `rsn:<message id>`), `TEXT_MESSAGE_*` for text, `TOOL_CALL_START/ARGS/END` per tool call |
| ToolMessage | `CUSTOM b4.step` `completed` (or `denied`) from the stamp, then `TOOL_CALL_RESULT`; for `failed`, the result first and the `failed` step after (the live order) |
| `task` ToolMessage | `SUBAGENT_STARTED { subagentRunId: <task call id>, name, description, parentToolCallId }`, the child namespace's own synthesised events tagged `subagentRunId`, then `SUBAGENT_FINISHED` or `SUBAGENT_ERROR` from `b4_subagent.outcome` |
| `todos` changed between consecutive checkpoints | `ACTIVITY_SNAPSHOT` `b4.plan` |
| End of turn | `RUN_FINISHED` with the `b4:turn` status; `RUN_FINISHED { outcome: interrupt }` built from `pendingInterrupts` when the head is parked; `RUN_ERROR` for `failed` |

The clock passed to `reduceTurns` is driven by the stamped `startedAt`/`settledAt` for steps and
checkpoint `ts` for everything else, so durations restore.

Shape checks: every stamp is validated; a stamp that fails (or is absent) is ignored and named in
`warnings`. A child namespace whose `task` message is missing is attached by matching the task id in
the namespace against the parent checkpoint's writes; if that fails the namespace is dropped with a
warning. The function never throws.

Reasoning spans and messages get derived ids, stable per restore; nothing correlates them with live
ids across a reload. `TurnView.runId` on a restored turn is the opening user message's id.

## 4. `GET /threads/:id/turns`

One handler in `packages/cli/src/lib/dev/runtime-fetch-core.ts` next to `/state`.

Reads, in one pass: the thread row (status), the root namespace history and every child namespace
from `listNamespaces`, decoded once with the checkpointer's own deserializer, and the parked
interrupts parsed from the head checkpoint (the same parse `/pending_interrupts` uses). Calls
`turnsFromState`. Responds:

```json
{ "threadId": "…", "status": "idle", "turns": { "threadId": "…", "turns": [ … ] }, "warnings": [], "truncated": false }
```

- 404 when neither the thread row nor any checkpoint exists (as `/state`).
- Gate: the one `/pending_interrupts` enforces (route identity when a thread-access policy is
  installed); 403 without body detail. A parked gate's payload is never exposed more widely than
  today.
- `busy` threads return the last written checkpoint; the client keeps `/threads/:id/runs/stream`
  for the live tail. `/turns` never blocks on a run.
- A fixed cap of 2000 decoded checkpoints across all namespaces; when hit, the newest turns are
  returned with `truncated: true`. `?since=<checkpoint id>` is reserved, not built.
- Both storage backends serve it identically.

`/state` keeps its shape with one breaking fix: `created_at` is the head checkpoint's `ts`.

## 5. Error handling

| Situation | Behaviour |
|---|---|
| Stamp missing or malformed | Ignored; `warnings[]` names it; the step still has its call, result and error status |
| Child namespace without a `task` message | Attached via the parent's writes; else dropped with a warning |
| Thread busy | Snapshot of the last checkpoint; status says `busy` |
| Oversized thread | Cap, newest turns, `truncated: true` |
| Serialization drift | One server-side decode path with its own unit test |
| Gate mismatch / unknown thread | 403 / 404 without body detail |

## 6. Testing

- `packages/langchain`: the converter always builds a ToolMessage with a complete `b4_step`
  (display and none, success, thrown, gated with each decision); the bridge returns a ToolMessage
  with `b4_step` and `b4_subagent` including the child namespace; stamped times are the call's own.
- `packages/cli`: the saver wrapper writes `b4:turn` for done, failed and stopped runs; `/turns`
  handler tests for 404, the gate, a parked thread, a thread with a subagent child namespace, the
  cap, and `/state.created_at`.
- Storage: `listNamespaces` in both checkpointer conformance suites; the restore fixture also runs
  against Postgres.
- `packages/ag-ui`: the live-versus-restored fixture — record a run's events and reduce; restore the
  same thread's checkpoints through `turnsFromState` and reduce; the two `TurnsView`s are deep-equal
  apart from `runId` and derived reasoning ids. Unit tests per synthesised event family and for each
  warning path. The fixture is the conformance material for cacheplane/b4run#930.
- Harness lanes run unchanged; the generated-app journeys do not move until 2b-adopt.

## 7. Rollout and breaking surface

One branch, three PRs in order, each green on its own: (1) stamps — langchain converter and
bridge, CLI saver wrapper, storage `listNamespaces`; (2) `turnsFromState` and its fixtures;
(3) the endpoint, the `/state` fix and docs.

One fixed-group `patch` changeset with a `**Breaking:**` lead across `@b4run/langchain`,
`@b4run/cli`, `@b4run/ag-ui`, `@b4run/sqlite-storage`, `@b4run/postgres-storage`: the `task`
result is a ToolMessage; every ToolMessage carries `b4_step`; `/state.created_at` is the checkpoint
time; threads from earlier releases do not restore through `/turns`. An upgrading entry says the
same.

Docs and pins that move: the Agent Protocol endpoint table and its check-docs pins; the AG-UI page's
sentences on `task` persistence and on restoring a thread; the `./view` export table
(`turnsFromState`, `ThreadStateForTurns`, `TurnsFromStateResult`); the activity spec's restore
paragraphs (§4.1, §6.1, §10); the reattach spec's note on mixing `/state` with an attach gains
`/turns`. No release-pinned smoke script references `/state`.

## 8. Out of scope

- Adoption by the navlog example, template, harness and docs recipes (2b-adopt).
- A durable CopilotKit runner (cacheplane/b4run#928) — it may later serve `connect` from `/turns`.
- `b4.step` as an activity profile (cacheplane/b4run#929).
- Incremental `?since=` reads.
- Correlating restored ids with live ids across a reload.
