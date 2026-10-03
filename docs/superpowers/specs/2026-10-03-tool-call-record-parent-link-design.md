# Tool-call record: the issuing route and the parent `task` link

**Status:** approved design, 2026-10-03. Third and last follow-up in the tool-call record series:
generalization (cacheplane/b4run#909), the recording gate and the `task` call (#916), and now
attribution for subagent calls. Backwards compatibility is **not** a goal of this design: the
record's types and column meanings change where a cleaner contract results. The frozen-migration
rule still holds (migration 1 shipped in v0.13.1), so the schema change is an appended migration.

## Problem

A subagent's tool calls are recorded (the child graph inherits the parent's recorder), but every
row they produce says it was issued by the **parent** route, and nothing links them to the `task`
call that launched the subagent. So for a thread that used subagents the record cannot answer
"which route made this call" or "which calls belong to this `task`", and a child-route call is
indistinguishable from a root call of the parent route. The per-run recorder closes over the
AG-UI run's route key and writes it into every server row, which is where the mis-attribution
comes from.

## Decisions

Settled with the maintainer during design, 2026-10-03:

1. **Attribution columns only.** No read surface is added; the columns exist so the record is
   correct and so a later lister, inspector view or wire reconciliation has something to read.
2. **One meaning per column, no hedges.** `route_id` becomes the route that *issued* the call;
   `run_id` stays the owning AG-UI run; a nullable `parent_tool_call_id` links a child's rows to
   the nearest enclosing `task`. No separate child-route column.

## 1. Column meanings after this change

| Column | Meaning | Root row | Child row |
|---|---|---|---|
| `route_id` | the route that **issued** the call, as a route key (`<id>#<mode>`) | the AG-UI run's route key (unchanged) | the child route's key, e.g. `/parent/subagents/researcher#agent` |
| `run_id` | the AG-UI run that **owns** the thread turn | the run id | the same run id |
| `parent_tool_call_id` | the nearest enclosing `task` call's provider tool-call id | `null` | the `task` that launched this subagent (at any depth: the immediate parent) |

Depth is a walk up `parent_tool_call_id`, not a column. The link is written even when the parent
`task` ran under the bridge's random fallback id and therefore has no row of its own: siblings
still group, and the record is identity only. Client rows are unchanged: they are only ever
issued by the root route (child routes receive no client-tool stubs), so for them `route_id` is
still the route that answers the park. That invariant is stated in the handler and pinned by a
test.

## 2. Schema

Migration `version: 3` in both stores, appended:

```sql
ALTER TABLE client_tool_calls ADD COLUMN parent_tool_call_id TEXT;
```

(Postgres: `ADD COLUMN IF NOT EXISTS parent_tool_call_id text`, qualified as the others.) No
default, no CHECK. Every INSERT names all fourteen columns. Rows that predate the migration read
back `null`, which is also correct for every root row.

The `ClientToolCallRecord` type gains `readonly parentToolCallId: string | null` — required, not
optional. The three structural mirrors (SDK, SQLite, Postgres) change together, as before.

## 3. Writers decide origin

Today the handler's recorder closes over the run's route key and stamps it into every server
row. After this change the **writer** supplies the origin, and the recorder only supplies what
it alone knows (thread, run, timestamps).

### The recorder contract

```ts
issue?(call: {
  readonly toolCallId: string
  readonly toolName: string
  /** The route that issued the call, as a route key. */
  readonly routeId: string
  /** The nearest enclosing `task` call's provider id; `null` at the root. */
  readonly parentToolCallId: string | null
}): Promise<void>
```

`settle`, `has` and `record` are unchanged. `record` (client rows) keeps writing the run's route
key and `parentToolCallId: null`, because client rows are root-issued by construction.

### Where the writer gets it

The subagent bridge already stacks `{ callId, name, routeId }` entries into
`config.metadata.b4.subagent_stack` for each nested subagent, and LangGraph carries that config
into the child graph. Two changes:

- The stack entry's `routeId` becomes the child route's **key**, not its bare id.
  `ResolvedSubagentGraph` gains `routeKey`, set by `prepareChild` in the CLI with the same helper
  the runtime registry uses (`createRouteAssistantId`), so the bridge never guesses a mode. The
  stack entry keeps `routeId` for the stream events (unchanged on the wire) and adds `routeKey`.
- A small reader in `@b4run/langchain`'s `tool-call-recording.ts`, `readCallOrigin(config)`,
  returns `{ routeId: <top stack entry's routeKey>, parentToolCallId: <top entry's callId> }`
  when the stack is non-empty, and `undefined` at the root. `recordToolCall` takes the origin as
  part of its `call` argument; both callers pass what they know:
  - the converter passes `readCallOrigin(liveConfig)` — at the root that is `undefined`, and the
    recorder fills in the run's route key with `parentToolCallId: null`; inside a subagent it is
    the child's route key and the launching `task`'s id;
  - the bridge, recording the `task` call itself, passes the origin of the **calling** context
    (the stack *before* it pushes its own entry): at the root `undefined`; for a nested `task`,
    the enclosing subagent's route key and the outer `task`'s id.

So `recordToolCall`'s call shape is `{ toolCallId, toolName, origin?: { routeId, parentToolCallId } }`,
and the per-run recorder's `issue` receives a resolved origin: `call.origin ?? { routeId: runRouteKey, parentToolCallId: null }`.
That resolution lives in the recorder (the handler), the only place that knows the run's route
key; the helper passes `origin` through untouched.

### The fallback-id case

When the parent `task` ran without a provider id, its stack entry's `callId` is `task-<uuid>`.
Children still record it as their `parentToolCallId`; the link dangles (no `task` row), and the
record still groups the siblings. Nothing special-cases the prefix.

## 4. What does not change

- `pendingToolCallIds`, the park and resume logic, the foreign-park check and the abandon close
  read client rows only, and client rows are root-issued, so their `routeId` comparisons are
  unaffected. The handler gains a comment stating the invariant where it compares them.
- Pruning: `parent_tool_call_id` plays no part; the sweep predicate is unchanged.
- The wire: nothing new is emitted. The stream's `b4.subagent` events keep `route_id` as the bare
  id.
- The `b4 client-tools prune` command: unchanged.

## 5. Edge cases

- **Nested depth:** each child's rows link to the immediate enclosing `task`; the outer `task`
  row links to its own enclosing one, or `null` at the root.
- **A child route that is also served as a root route elsewhere:** its key is the same string in
  both roles; `parent_tool_call_id` (null vs set) tells them apart, which is the point of having
  both columns.
- **Replay:** `issue` is idempotent on `(thread_id, tool_call_id)`; a re-execution carries the
  same stack, so the origin is the same and the no-op is exact.
- **A row without an origin on a run with no recorder:** nothing is recorded, as today.

## 6. Testing

- **Stores** (memory, SQLite, Postgres on the gated lane): `parentToolCallId` round-trips; the
  14-column INSERT; migration 3 over a version-2 database reads old rows as `null`; DDL pin tests
  for the appended version in Postgres.
- **LangChain:** `readCallOrigin` on an empty stack, a one-level stack, a nested stack (top entry
  wins); the converter inside a child config records the child's route key and the `task` id;
  the bridge records a nested `task` with the enclosing origin and the root `task` with none;
  a child under a fallback-id `task` records the dangling link.
- **CLI:** an AG-UI run that dispatches a subagent leaves rows whose `routeId` is the child key
  and whose `parentToolCallId` is the `task` call's provider id, while the `task` row itself has
  the run's route key and `null`; client rows still carry the run's route key; the foreign-park
  check still passes for a client park on a thread that also has child rows.
- **Fixture fallout:** every test that builds a `ClientToolCallRecord` literal gains
  `parentToolCallId: null` (required field); recorder fakes' `issue` accept the new shape.

## 7. Docs and release

- `apps/web/content/docs/ag-ui.mdx` "The tool-call record": one sentence on what a child row
  records (its own route, and the `task` that launched it).
- `api/sdk.mdx`: the `ClientToolCallRecord` row mentions the parent link.
- One patch changeset: `@b4run/sdk`, `@b4run/langchain`, `@b4run/cli`, `@b4run/sqlite-storage`,
  `@b4run/postgres-storage`. `@b4run/core` is not touched.
  It states the `route_id` meaning change for child rows and the required `parentToolCallId`
  field as breaking for custom stores and recorder fakes.

## 8. Out of scope

- Any read surface (lister, inspector view, wire reconciliation).
- A depth column.
- Recording the `task` fallback id or making the bridge's fallback stable.
