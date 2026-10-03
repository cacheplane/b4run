---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/langchain": patch
"@b4run/ag-ui": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

The tool-call record behind client-provided tools now covers every tool call on an AG-UI run where the store is resolved (a route listed in `server.agui.clientTools`, `server.agui.clientToolStore` set, or the default `.b4/client-tool-calls.sqlite` still present from an earlier opt-in), on every route. A server tool call is recorded as identity only — thread, route, run, tool name, issued and settled times; no result text — and is never answerable. A `role: "tool"` message is consumed only when it names an open client call this server issued; one naming a server call, a closed call, or nothing is history. `RUN_FINISHED`'s `pendingToolCallIds` is now read from the record, scoped to the calls this run left parked.

- `ClientToolCallRecord` gains `kind` (`"client" | "server"`) and `settledAt`; `ClientToolCallStore` gains `settle` and `prune`; `ClientToolRecorder` gains `issue` and `settle`. An operator-supplied `clientToolStore` must implement the new methods or the boot fails naming them. The SQLite and Postgres stores append migration 2 (`kind`, `settled_at`); existing rows read as `client`.
- New `server.agui.toolCallRetentionMs` (default 7 days, never shorter than `clientToolTtlMs`): closed rows older than this are pruned on the thread's next AG-UI run. Open rows are never pruned; there is no background sweep.
- `B4ToolDefinition` gains an optional `clientTool: true` marker, set only by the client-tool stub. `@b4run/ag-ui`'s `pendingToolCallIds` option may return a Promise; a rejection ends the run as `RUN_ERROR`.

Behavior changes on an app with a store:

- Every server tool call on every AG-UI route is written to the store before it runs and settled after; a write failure fails that tool call. With the store unavailable, server tool calls on AG-UI runs fail until it is back. Apps with no store are unchanged.
- Rolling upgrades on a shared Postgres store: a replica on the previous version has no `kind` filter and reads new server rows as open client rows (it may void them). Nothing becomes answerable, but finish the rollout before mixing traffic.
