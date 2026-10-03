# Tool-call record: an explicit recording gate, and the `task` call

**Status:** approved design, 2026-10-03. Follow-up to the record generalization
(`2026-10-02-tool-call-record-generalization-design.md`, shipped as cacheplane/b4run#909), closing
the two items its final review left open.

## Problem

#909 records every model tool call on an AG-UI run "where the store is resolved". Two edges of
that rule were documented rather than designed:

1. **The leftover file keeps recording on.** The node fallback opens
   `.b4/client-tool-calls.sqlite` whenever the file exists, so that calls parked before an app
   removed its `server.agui.clientTools` opt-in can still be closed. But a resolved store also
   switches on server-row recording, and with it the new exposure: two store writes per server
   tool call, and a store write failure failing the call. An app that tried client tools once and
   then turned them off keeps paying both, on every AG-UI route, with nothing in its config saying
   so — and because every run writes rows, the file never stops existing.
2. **The `task` call has no row.** The parent's `task` tool, which launches a subagent, is routed
   through the subagent bridge instead of the tool converter, so the record covers "every call
   except `task`". The subagent's own tool calls *are* recorded (the child config inherits the
   recorder). Once cacheplane/b4run#914 removes `task` from the activity ledger, its
   `TOOL_CALL_*` frames reach the AG-UI wire like any other tool's, and "every tool-call id on
   the wire has a row" holds only if `task` is recorded.

## Decisions

Settled with the maintainer during design, 2026-10-03, after a read-only research pass over the
bridge, the resume path and #914:

1. **Explicit intent only.** Server rows are recorded only when some route is listed in
   `server.agui.clientTools` or `server.agui.clientToolStore` is configured. A leftover default
   file still resolves a store, but that store serves client parks only.
2. **Record the `task` call** as an ordinary server row, with the same park discipline as the
   converter; never on the bridge's random fallback id.

## 1. The recording gate

### Resolution

`ClientToolRuntime` gains `recordsServerCalls: boolean`, resolved at boot in the runtime fetch
core next to the store and the TTL:

```
recordsServerCalls = anyRouteOptsInToClientTools(config) || config.server?.agui?.clientToolStore !== undefined
```

It is computed from config alone. The node fallback's "the file exists" path never turns it on,
and it is independent of whether a store actually resolved.

### The recorder

The AG-UI handler keeps building the per-run recorder whenever a store resolved: `has` and
`record` are what close and resume client parks, and a thread parked before the opt-in was removed
must still be answerable. It adds `issue` and `settle` **only when `recordsServerCalls` is true**.

`ClientToolRecorder` in `@b4run/sdk` makes those two methods optional:

```ts
/** Absent when the runtime does not record server calls; a writer that finds them absent records nothing. */
issue?(call: { readonly toolCallId: string; readonly toolName: string }): Promise<void>
settle?(toolCallId: string): Promise<void>
```

The converter already treats their absence as "record nothing" (`readRecorder` requires both to
be functions). The bridge (§2) uses the same reader.

### The boot warning

When a store resolved but `recordsServerCalls` is false — which can only be the leftover-file
case — boot logs one `console.warn`:

> `B4: <appRoot>/.b4/client-tool-calls.sqlite exists but no route is listed in
> server.agui.clientTools and no server.agui.clientToolStore is set. It is kept so calls parked
> before the opt-in was removed can still be closed; server tool calls are not recorded. Delete
> the file to drop it.`

It is logged once per boot, where the existing "names routes but no store" warning lives.

### Consequences

| Config | Store | Server rows |
|---|---|---|
| route in `clientTools` | default file or configured | recorded |
| `clientToolStore` set, no route opted in | configured | recorded |
| neither, file left over | default file (client parks only) | **not** recorded, warning at boot |
| neither, no file | none | not recorded |

Docs and the changeset drop "or the default `.b4/client-tool-calls.sqlite` still exists" from the
scope sentence and state the rule as the table does.

## 2. Recording the `task` call

### One helper, two callers

The issue/settle discipline the converter carries inline moves into one helper in
`@b4run/langchain` (its own module, `tool-call-recording.ts`):

```ts
recordToolCall<T>(
  config: unknown,
  call: { readonly toolCallId: string; readonly toolName: string },
  body: () => Promise<T>,
): Promise<T>
```

- Reads the recorder off `config.configurable[CLIENT_TOOL_RECORDER_KEY]`; when there is no
  recorder with both `issue` and `settle`, or `toolCallId` is empty, returns `body()` untouched.
- Otherwise `await recorder.issue(call)` first (a failure propagates: a call the server cannot
  account for must not run), then `body()`, then `settle` in `finally` **unless** the body threw a
  `GraphInterrupt` (a park is not completion; the resumed re-execution issues a no-op on the key
  and settles when the body really returns or throws). A settle failure is `console.warn`ed and
  swallowed, as today.

The converter becomes a caller of it, with its `clientTool` marker check kept in front of the
call. Its behavior is unchanged and its existing recorder tests move to the helper.

### The bridge

`convertSubagentTaskToLangChain`'s `func` becomes the second caller. The body it hands the helper
covers the depth check, the resolver and `graph.invoke`, so:

| Path | Row |
|---|---|
| depth exceeded, resolver refused (string returns) | issued and settled, like any refused tool |
| resolver throws | issued and settled |
| resolver's delegation-approval `interrupt()` | issued, **open** across the park |
| child parks (`GraphInterrupt` rethrown) | issued, **open** across the park |
| abort | issued and settled |
| `subagent_failed: …` | issued and settled |
| success | issued and settled |

The bridge records only when `readCallId` found a provider id. Its `task-<uuid>` fallback is
never recorded: it is drawn afresh on every re-execution, so a row keyed on it would be orphaned
on each child park and, being unsettled, never pruned. The helper's empty-id rule handles this
once the bridge passes `""` in that case.

The row is an ordinary server row — `toolName: "task"`, the parent route key and the AG-UI run id,
`interruptId: ""` — so a `role: "tool"` message carrying a task id is dropped as a server row,
the same outcome as "no row" today, and consistent with every other tool once #914 lands.

### What this does not do

Child tool calls keep recording against the parent thread with the parent route key and the
AG-UI run id, exactly as #909 left them. The record still has no column linking a child's rows to
the `task` that launched them, and a child-route call is indistinguishable from a root call of
the parent route. Adding a parent-call column is a separate design; noted, not done.

## 3. Edge cases

- **No provider id in the bridge:** nothing recorded; the subagent still runs under the uuid
  call id as today.
- **Nested subagents:** each `task` at each depth is its own row under the same rule; a depth-2
  park propagates through both bridges as `GraphInterrupt`, leaving both rows open.
- **Recorder present without `issue`/`settle`** (gate off): converter and bridge record nothing;
  the client stub is unaffected (it uses `has`/`record`).
- **Operator-supplied recorder objects:** none exist — the recorder is built by the handler —
  so making the methods optional changes no public contract beyond the type.
- **`b4 client-tools prune` and the settle-time sweep:** unchanged; an open `task` row survives a
  park like any open server row.

## 4. Testing

- **CLI** (`agui-client-tools.test.ts`): a leftover-file app (store resolved, no opt-in, no
  configured store) runs a server tool and records nothing, and boot logs the warning; a
  configured store with no route opted in records; an opted-in route records (existing). The
  recorder the handler builds is asserted to carry `issue`/`settle` only when the gate is on
  (unit level, on the object, not by side effect).
- **LangChain** (`tool-call-recording.test.ts`): the helper's ordering, throw, abort,
  `GraphInterrupt`, empty id, no recorder, recorder without `issue`/`settle`, issue failure,
  settle failure — the converter's current recorder tests, moved. `subagent-tool-bridge.test.ts`:
  issue-then-settle on success; open across a child `GraphInterrupt`; open across the resolver's
  approval interrupt; settled on depth refusal; settled on `subagent_failed`; nothing recorded
  without a provider id.
- **SDK**: the recorder type change compiles against the existing fakes (they already define
  both methods).

## 5. Docs and release

- `apps/web/content/docs/ag-ui.mdx` "The tool-call record": the scope sentence becomes the gate
  rule; the `task` exception sentence goes; a line on the boot warning.
- `apps/web/content/docs/configuration.mdx`: the `clientToolStore` paragraph states that setting
  it, or listing a route, is what turns server-row recording on.
- The #909 spec gets a short note at §2 "Subagents" and §5 "Store present, route not opted in"
  pointing here.
- One patch changeset: `@b4run/sdk`, `@b4run/langchain`, `@b4run/cli`.

## 6. Out of scope

- A parent-call column on child rows (see §2 "What this does not do").
- Any change to pruning, the TTL, or the `b4 client-tools` command.
- Recording on non-AG-UI transports.
