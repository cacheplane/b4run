# Generalizing the tool-call record to every tool call

**Status:** approved design, 2026-10-02. Follow-up to the client-provided tools design
(`2026-09-18-client-provided-tools-design.md`, shipped as cacheplane/b4run#880) — its §7 and
open question 7 are the brief for this document.

## Problem

#880 introduced a retained record of tool calls so that an AG-UI client's `role: "tool"` message
is consumed only when it answers a call the server issued and is still waiting on. The record is
scoped to client-provided tool calls: the stub writes a row before it parks, and nothing records
the server's own tool calls.

§7 of the original spec established that this scoping leaves no live forgery hole, because every
tool message that matches no outstanding record is dropped. But it also noted that the dropping
is an incidental property of the message filters rather than a guarantee anchored in server
state, and that generalizing the record would (a) give every tool call one server-side identity,
(b) make "is this a real call" answerable for any id, not only client ones, and (c) let the
`pendingToolCallIds` outcome and the resume logic rely on a single source instead of an in-memory
set plus checkpoint parks.

Two smaller gaps ride along. Settled rows are never deleted, which matters once server calls are
recorded. And `pendingToolCallIds` (added by #888) is collected by the stream normalizer into a
set that lives only for the turn, with the partial response computing the same ids a different
way from checkpoint parks.

## Decisions

Settled with the maintainer during design, 2026-10-02:

1. **Scope B.** Every model tool call is recorded on a run where the store is resolved — an app
   with an AG-UI route opted into client tools, or an operator-configured store. An app that
   never opts in has no store, no recorder and no change in behavior, on any transport.
2. **Identity only for server rows.** No result text: the checkpoint holds the tool message, and
   server outputs are large enough that offloading exists.
3. **Pruning is folded in** as a per-thread lazy sweep with a configurable retention window.
   *(Superseded at merge by #898's global throttled sweep; see the note at §4.)*
4. **`pendingToolCallIds` becomes record-derived**, on both the live and partial paths.
5. **The writer for server rows is the LangChain tool converter**, where the tool executes.

## 1. The record and the store contract

### Shape

The table keeps its name (`client_tool_calls`) and primary key `(thread_id, tool_call_id)`. One
appended migration in each of `@b4run/sqlite-storage` and `@b4run/postgres-storage` adds:

| column       | type            | meaning |
|--------------|-----------------|---------|
| `kind`       | text NOT NULL   | `client` or `server`. Added as `NOT NULL DEFAULT 'client'` because SQLite's `ADD COLUMN` needs a default to backfill existing rows; that default exists only for the backfill — every INSERT still names `kind`, pinned by the DDL tests, so it is never load-bearing. Postgres uses the same statement for symmetry. |
| `settled_at` | text (nullable) | Server rows only: when the tool returned or threw. |

Shipped migrations stay frozen; this is `version: 2` in both stores. The DDL pin tests in each
store are updated for the new version.

`ClientToolCallRecord` in `@b4run/sdk` gains `kind: "client" | "server"` and
`settledAt: string | null`. The type and store names keep their `ClientToolCall` prefix: renaming
them is churn across five packages for no behavioral gain, and the doc comment states that the
record now covers both kinds.

Column discipline per kind:

- A **client** row is written as today: `interruptId = client-<toolCallId>`, `expiresAt` from the
  TTL, `answeredAt`/`result`/`voidedAt` through its lifecycle, `settledAt` always `null`.
- A **server** row has `interruptId = ""` (there is no park), `expiresAt`, `answeredAt`, `result`
  and `voidedAt` always `null`, and `settledAt` stamped when the call finishes.

A row is **open** when it is a client row with `answeredAt` and `voidedAt` both `null`, or a
server row with `settledAt` `null`. Only an open client row is ever answerable.

### Store methods

`ClientToolCallStore` gains:

- `settle({ threadId, toolCallId, at }): Promise<"settled" | "already_settled" | "missing">` —
  stamps `settledAt` on a server row. Idempotent: a second call reports `already_settled` and
  leaves the first timestamp. A client row reports `missing` (it is not a server row).
- `prune({ threadId, before }): Promise<number>` — deletes the thread's non-open rows whose
  terminal timestamp (`answeredAt`, `voidedAt` or `settledAt`, whichever is set) is older than
  `before`. Returns the count. Open rows are never eligible, however old.

Unchanged in signature, clarified in meaning:

- `issue` stays idempotent on the key. That is what keeps LangGraph's re-execution of a tool node
  from producing a duplicate server row, exactly as it keeps the replayed client stub from
  producing an orphan.
- `listOutstanding` is defined as **open client rows**, so every existing reader keeps its
  meaning without a filter.
- `listForThread` returns both kinds.
- `answer` and `voidOutstanding` apply to client rows only; a server row reports `missing` from
  `answer` and is never voided.

All three stores (memory in `@b4run/sdk`, SQLite, Postgres) implement the two new methods. The
operator-store shape check (`validateClientToolStore` in the CLI's client-tool runtime) adds
`settle` and `prune` to its required method list, so a store that predates this change fails the
boot loudly rather than failing the first prune.

### Why a delete path is acceptable here

`interrupt_grants` deliberately has no DELETE, and its SQLite store pins that: a voided grant row
is the evidence that single-use was enforced. A tool-call row is different in kind. Once closed it
carries no authority — a pruned client row cannot be answered (the message would name no row and
be dropped), and a server row was never answerable. The record is bookkeeping for the open set;
retaining closed rows forever buys nothing.

## 2. Writers

### The recorder contract

`ClientToolRecorder` in `@b4run/sdk` grows from two methods to four:

- `has(toolCallId)` and `record({ toolCallId, interruptId, toolName })` — unchanged, used by the
  client stub, write a client row.
- `issue({ toolCallId, toolName })` — writes a server row.
- `settle(toolCallId)` — stamps the server row.

The per-run recorder built in the AG-UI handler implements all four over the one store, closing
over the thread, run and route ids as it does now. It is still injected only when the store
resolved, under the same `config.configurable` key.

### The converter

`convertToolToLangChain` in `@b4run/langchain` reads the recorder from the live run config under
`CLIENT_TOOL_RECORDER_KEY`. When a recorder is present **and** the extracted tool-call id is
non-empty:

1. `await recorder.issue({ toolCallId, toolName: tool.name })` before `tool.run`.
2. `tool.run` and the existing offload/transformer work, inside `try`.
3. `await recorder.settle(toolCallId)` in `finally`, so a thrown error, a permission refusal
   returned as text, and a cancel that unwinds the call all settle the row.

When no recorder is present the converter does nothing, which is every run on an app without a
store and every non-AG-UI transport. When the tool-call id is empty (the tool was invoked outside
a model tool call) nothing is recorded: there is no identity to record.

Failure policy: a store failure in `issue` fails the tool call — a call the server cannot account
for must not run, and the error reaches the model as the tool's error the way any thrown tool
error does. A failure in `settle` is logged via `console.warn` and swallowed: the tool already
ran, an unsettled server row is never answerable, and the only cost is a row that pruning skips.

### The client stub stays the client writer

`B4ToolDefinition` gains an optional `clientTool?: true` marker, set by `createClientToolStub`.
The converter skips a definition carrying it, so the stub remains the only writer of client rows
and its gate-once ordering (`has` → gate → `record` → `interrupt`) and its throw on a missing
recorder are untouched. The marker, not the `client_` name prefix, is the test: a server tool
whose name happens to start with the prefix is a server tool.

### Subagents

Subagent tool calls run through the same converter under the parent thread id in the run config
and are recorded against it. That is the thread any tool message would name, so it is the right
key; no subagent-specific handling is added. The parent's `task` call itself — the orchestration
tool that launches a subagent — is routed through the subagent bridge, not the converter, and is
**not** recorded. A tool message naming its id is dropped as "no row", the same outcome as if it
were recorded as a server row, so nothing is lost; recording it is left out of scope.

A permission park is not completion: a tool whose gate parks by throwing `GraphInterrupt` is
issued but **not** settled. The resumed re-execution issues again (a no-op on the key) and
settles when the tool really returns or throws.

## 3. Readers

### The turn resolver

`resolveClientToolTurn` keeps its decision table. The one change is how it classifies each
`role: "tool"` message against the record:

- names an **open client row** on this thread (and the park checks already in place pass) → the
  result is stored as that call's answer, as today;
- names a **server row**, or a **closed client row** → history, dropped;
- names **no row** → dropped, with no error and no log. Every AG-UI client resends its history on
  every run, and an id the record has never seen (or has pruned) is the ordinary case.

Observable behavior is identical to #880. What the change adds is that the invariant is now stated
in server state and tested as such: **content from a tool message reaches the model only through
a store row the server issued as client-kind and left open.** The resolver's doc comment states
this as the security invariant, replacing the current wording that rests on the message filters.

The handler's message filters (`newestUserMessage` collapse, the tool-message drops in the
AG-UI handler and the agent adapter) are **not** relaxed by this work. §7 rule 1 of the original
spec still holds: the record being authoritative is the precondition for ever relaxing them, not
a reason to do so now.

### `pendingToolCallIds` from the record

The success outcome's `pendingToolCallIds` is the thread's open client rows, by provider tool-call
id, in issue order (`listOutstanding`).

- **Live turn:** read after the route stream has ended and before the run slot is released. The
  stub writes its row before `interrupt()`, so by the time the stream finishes every park this
  turn raised has a row; and because the read is inside the run slot, a concurrent abandon on the
  same thread cannot void rows in between.
- **Partial response:** the same read replaces the ids derived from checkpoint parks.

Each read is scoped to what the request owns, so a stray row (a void that failed earlier) or a
row from a run still in flight is never offered to the client as answerable: the live turn keeps
rows issued by this run (by `runId`); the partial response intersects with the snapshot's client
parks; the no-op path (a trailing tool message that answers nothing, reached only when no client
park is pending) reports nothing pending.

The stream normalizer's `onClientToolPark` callback and the handler's in-memory `parkedClientCallIds`
set are deleted. The abandon and resume paths continue to read the checkpoint parks, because they
need resume keys the record does not hold; the record is the source of *which calls are pending*,
the checkpoint the source of *how to resume them*.

Where the handler matches records to checkpoint parks (the foreign-park check and the abandon
close's issuing-route lookup) it considers `kind: "client"` rows only. The replay-only stub
rebuild reads checkpoint parks, not records, and is unchanged.

## 4. Pruning

> **Reconciled 2026-10-02 after cacheplane/b4run#898 landed on main.** #898 shipped its own
> client-tool-call prune while this design was being implemented: a global
> `prune({ before })` (all threads; `before` compared as ISO text), `server.agui.clientToolRetentionMs`
> (default 7 days, never shorter than the TTL via `clientToolPruneCutoff`), an hourly throttled sweep
> run when an AG-UI turn settles, and `b4 client-tools prune`. That design wins. This section's
> original per-thread `prune({ threadId, before })`, `toolCallRetentionMs` and per-run prune under
> the run slot were **dropped at merge**; the only pruning change this work keeps is that #898's
> sweep also deletes **settled server rows** (`settledAt < before`) and never an unsettled one. The
> TTL floor #898 already applies covers the resumed-replay re-read discussed below. The text that
> follows is the pre-merge design, kept for the record.


A new setting, `server.agui.toolCallRetentionMs`, resolved at boot next to `clientToolTtlMs` with
the same validation shape: absent → 7 days (`604_800_000`); otherwise a positive safe integer no
greater than one year, or the boot fails with a `ClientToolConfigError`. `ClientToolRuntime`
carries it as `retentionMs`.

The AG-UI handler calls `store.prune({ threadId, before: now − retentionMs })` once per run on
that thread, under the run slot, immediately after the slot is taken and before any record read
that happens under it (the client-park recheck, the recorder, the abandon close). The turn
resolver runs earlier, under the resume claim; that is safe because prune deletes only non-open
rows, and the only non-open rows a resume depends on are answered client rows whose results the
resolver has already copied into its decision. A row answered more than the retention window ago
and never resumed (a crash between answer and resume, then an idle thread) is pruned, and the
next run abandons its park with the fixed abandoned result instead of the stored one — accepted.

One more reader runs after prune: the resumed replay of a client stub re-reads its row through the
recorder's `has`. So the cutoff is never shorter than the client-call TTL
(`before = now − max(retentionMs, ttlMs)`): a row answered while its park is still resumable
survives until the replay has re-read it, whatever the operator set retention to. Only non-open rows are eligible, so an outstanding client call survives
until the TTL abandons it; the abandon voids it, and the next run on the thread may prune it. A
prune failure is logged and the run continues: retention is housekeeping.

No global sweep, no scheduler, no CLI command. A thread that is never run again keeps its closed
rows; that is accepted, and the docs say so.

## 5. Errors and edge cases

- **Store absent, route opted in:** unchanged from #880 — runs that carry client tools are refused
  `503 client_tool_store_unavailable`; runs without client tools proceed with no recorder.
- **Store present, route not opted in:** the recorder is still injected, so server rows are
  recorded. This is the point of scope B: the record covers every call on an app that can
  receive tool messages.
- **Resume replay:** the tool node re-executes; the converter calls `issue` again and the key
  makes it a no-op; `settle` stamps once.
- **Cancel mid-tool:** the abort unwinds `tool.run`, `finally` settles the row.
- **Tool invoked with no provider id:** not recorded.
- **Operator store without `settle`/`prune`:** boot fails naming the missing methods.
- **A tool message naming a server row:** dropped as history; nothing is stored, nothing is
  logged, the run is otherwise unaffected.

## 6. Testing

- **Stores** (memory, SQLite, Postgres on the gated `postgres-storage-docker` lane): `kind` and
  `settledAt` round-trip; `settle` idempotence and its three outcomes; `listOutstanding` returns
  open client rows only; `prune` deletes only non-open rows older than `before` and returns the
  count; migration `version: 2` applied over a `version: 1` database backfills `kind = client`.
  The DDL pin tests in both stores are regenerated for the appended version.
- **Converter** (`@b4run/langchain`): issue-then-settle on return, on throw, and on an aborted
  signal; the client-marker skip; the no-recorder no-op; the empty-id no-op; `issue` failure
  surfaces as the tool's error; `settle` failure is warned and swallowed.
- **Client stub** (`@b4run/core`): sets the marker; its existing tests are unchanged.
- **Turn resolver** (`@b4run/cli`): a message naming a server row, a closed client row, and an
  unknown id each store nothing; the existing answer path is unchanged.
- **Handler** (`@b4run/cli`): `pendingToolCallIds` on the live path equals the record's open
  client rows; the partial response reads the record; prune runs under the run slot on every run
  and its failure does not fail the run; the retention setting is validated at boot.
- **Runtime config**: `toolCallRetentionMs` default, bounds, and the boot error message.

## 7. Docs and release

- The AG-UI docs page documents the record's new scope (every tool call on an opted-in app, server
  rows as identity only), `server.agui.toolCallRetentionMs`, and the per-thread prune semantics.
- The `ClientToolCallStore` doc comments in `@b4run/sdk` and the storage packages' migration
  constants document the appended migration.
- One patch changeset covering `@b4run/sdk`, `@b4run/core`, `@b4run/langchain`, `@b4run/ag-ui`,
  `@b4run/cli`, `@b4run/sqlite-storage` and `@b4run/postgres-storage`.

## 8. Out of scope

- Relaxing the AG-UI message filters (§7 rule 1 of the original spec).
- Recording tool calls on Agent Protocol only apps or on runs with no resolved store (scope B).
- Storing server tool results in the record.
- A global prune sweep or a CLI prune command.
- Renaming `ClientToolCallStore` / `client_tool_calls`.
