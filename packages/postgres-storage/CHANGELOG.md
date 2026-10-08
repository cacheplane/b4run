# @dawn-ai/postgres-storage

## 0.13.2

### Patch Changes

- 1180d4c: **Breaking:** every tool call now returns a `ToolMessage` whose `additional_kwargs.b4_step` is complete (`status`, `startedAt`, `settledAt`, the gate `decision`, and the display's icon, label and sources), display or not; the `task` tool returns a `ToolMessage` (not a string) carrying `b4_step` and `b4_subagent` with the child's checkpoint namespace; a thrown tool's error message is built by the converter with a `failed` step, and a branded denial persists as a `denied` step (with `decision: "deny"`) on a `success` ToolMessage — not a failure, so a denied `returnDirect` call still ends the run with the denial as its result. Raw `GET /threads/:id/state` readers see the new keys. Permission gates report `once | always | deny` into the tool context (`onGateDecision`). The runtime stamps `b4:turn` (`done | failed | stopped`, `error`, `endedAt`) on the head checkpoint's metadata when a run ends (never on a parked head, only on a head the turn wrote), and both checkpointers gain `listNamespaces(threadId)`.

  `@b4run/ag-ui/view` gains `turnsFromState(input)`: rebuild a thread's `TurnsView` from its checkpoint history and parked interrupts by synthesising the AG-UI events the live stream would have carried and folding them through the unchanged `reduceTurns`; output carries `warnings` for ignored stamps. `GET /threads/:id/turns` serves it in the next release. Threads written before these stamps do not restore.

- 2c33a3f: `GET /agui/:routeId` now reports a `multimodal` section for an `agent()` route: `input.image`, `input.pdf`, `input.audio` and `input.video` come from the route model's LangChain profile with the provider's converter limits — the same judgment that keeps or drops each part at run time — and `image`/`pdf` describe the inline `data` source (URL support varies by provider and is reported by the dropped-parts warning). `input.file` and `output` are always `false`. The section is omitted for a raw runnable, a chain/graph/workflow route, or a provider package that is missing or cannot be read; the rest of the document is unaffected. `@b4run/langchain` exports `readModelProfile`, which reads a model's profile off its provider class without constructing it.

  Client-provided tool results may carry content parts. A `role: "tool"` answer's parts are stored as sent and replayed to the model under the tool-result rules; the UI gets every part on `TOOL_CALL_RESULT`. A call closed by the abandon path replays the stored result as its text and logs a warning. The 64 KiB result cap is measured on text/JSON with inline media bytes excluded.

  - `ClientToolCallRecord.result` and `ClientToolCallStore.answer`'s `result` widen from `string` to `B4MessageContent` (`@b4run/sdk`); `ClientToolResumeValue.clientToolResult` widens the same way (`@b4run/core`). A custom store must keep and return parts.
  - `@b4run/sdk` exports `encodeClientToolResult`/`decodeClientToolResult`: a part list is kept in the existing text column as a self-describing JSON envelope. Text results, including rows written before this release, are stored and read back unchanged; no migration. A rollback to an earlier release reads a stored part-list result as its JSON envelope text; resume or abandon such calls before downgrading. The SQLite and Postgres stores use the codec and gained a direct `@b4run/sdk` dependency.
  - The dropped-parts warning again ends by pointing at `GET /agui/<route>` for what the route accepts.

- 61e5922: Approval grant records are now pruned. Every `InterruptGrantStore` gains `prune({ before })`, which deletes records whose `voidedAt` is before `before` and nothing else. `voidOutstanding` now also voids consumed grants whose prompt the thread moved past (every unvoided row of the thread not in the keep list), so a consumed grant is voided once its resumed turn completes and ages out from there; a consumed grant whose resume never completed, and an outstanding grant however old, are never deleted: in both cases the prompt is still parked, and a parked prompt with no grant row resumes without a grant under `approvals.grants: "optional"`. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement both; a custom store must match.

  `approvals.grantStore` is now shape-checked at boot while grants are on: a store missing any method, `prune` included, fails the boot naming the missing methods. A custom store written before this release must add `prune`.

  The runtime sweeps the store wherever it voids superseded grants, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `approvals.grantRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot). `b4 approvals prune [--retention <ms>]` runs the same pass by hand.

- b61e133: Client tool call records are now pruned. Every `ClientToolCallStore` gains `prune({ before })`, which deletes answered or voided records settled before `before` and outstanding records whose `expiresAt` is before `before`, and keeps every outstanding record that is unexpired or has no expiry. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement it; a store set in `server.agui.clientToolStore` must implement it too, or the boot fails naming the missing method.

  The runtime sweeps the store when an AG-UI turn settles, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `server.agui.clientToolRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot), never shorter than `clientToolTtlMs`. `b4 client-tools prune [--retention <ms>]` runs the same pass by hand.

- fd0c456: A consumed approval grant records who answered it. `InterruptGrantRecord` gains `consumedBy`, the `id` of the principal `src/auth.ts` resolved for the resuming request, or `null` for an anonymous answer. It's for audit only: grants stay caller-unbound, and no check reads it. `consume()` takes an optional `by`. The SQLite and Postgres grant stores add the `consumed_by` column in a new version-2 migration, and rows written before it read as `null`. A custom `InterruptGrantStore` must store and return the new field.
- 91726d5: The tool-call record behind client-provided tools now covers every tool call on an AG-UI run where the store is resolved (a route listed in `server.agui.clientTools`, `server.agui.clientToolStore` set, or the default `.b4/client-tool-calls.sqlite` still present from an earlier opt-in), on every route. A server tool call is recorded as identity only — thread, route, run, tool name, issued and settled times; no result text — and is never answerable. A `role: "tool"` message is consumed only when it names an open client call this server issued; one naming a server call, a closed call, or nothing is history. `RUN_FINISHED`'s `pendingToolCallIds` is now read from the record, scoped to the calls this run left parked.

  - `ClientToolCallRecord` gains `kind` (`"client" | "server"`) and `settledAt`; `ClientToolCallStore` gains `settle`; `ClientToolRecorder` gains `issue` and `settle`. An operator-supplied `clientToolStore` must implement `settle` or the boot fails naming it. The SQLite and Postgres stores append migration 2 (`kind`, `settled_at`); existing rows read as `client`.
  - The client-tool-call prune now also deletes server rows settled before the window (`server.agui.clientToolRetentionMs`); open rows of either kind are never deleted.
  - `B4ToolDefinition` gains an optional `clientTool: true` marker, set only by the client-tool stub. `@b4run/ag-ui`'s `pendingToolCallIds` option may return a Promise; a rejection ends the run as `RUN_ERROR`.

  Behavior changes on an app with a store:

  - Every server tool call on every AG-UI route is written to the store before it runs and settled after; a write failure fails that tool call. With the store unavailable, server tool calls on AG-UI runs fail until it is back. Apps with no store are unchanged.
  - Rolling upgrades on a shared Postgres store: a replica on the previous version has no `kind` filter and reads new server rows as open client rows (it may void them). Nothing becomes answerable, but finish the rollout before mixing traffic.

- bbd4a0c: Tool-call record rows now say where they were issued from. `routeId` is the route that issued the call — for a subagent's tool calls, the child route's key rather than the parent's — and a new required `parentToolCallId` (`null` at the root) names the `task` call that launched the subagent. The SQLite and Postgres stores append migration 3 (`parent_tool_call_id`, nullable); rows that predate it read `null`. `ClientToolRecorder.issue` takes an optional `origin` (`ToolCallOrigin`) the writer supplies; the runtime resolves a missing origin to the run's route with no parent.

  Breaking for custom stores and recorder fakes: `ClientToolCallRecord.parentToolCallId` is required, and a store must persist it. Breaking for custom `SubagentResolver`s in `@b4run/langchain`: `ResolvedSubagentGraph.routeKey` (`<routeId>#<mode>`) is required, and a subagent stack entry without `routeKey` is ignored. Client rows are unchanged: they are only ever issued by the root route.

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
- Updated dependencies [bcfc8b8]
- Updated dependencies [936b7bf]
- Updated dependencies [936b7bf]
- Updated dependencies [91726d5]
- Updated dependencies [bbd4a0c]
- Updated dependencies [9547137]
- Updated dependencies [18bc4fd]
- Updated dependencies [bbc7871]
  - @b4run/sdk@0.13.2
  - @b4run/permissions@0.13.2

## 0.13.1

### Patch Changes

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

- Updated dependencies [3b1be6e]
  - @b4run/permissions@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [3b489a5]
  - @b4run/permissions@0.13.0

## 0.12.0

### Patch Changes

- @b4run/permissions@0.12.0

## 0.11.2

### Patch Changes

- @b4run/permissions@0.11.2

## 0.11.1

### Patch Changes

- @b4run/permissions@0.11.1

## 0.11.0

### Patch Changes

- a30db23: LangChain dependencies move to their current releases: `@langchain/core` 1.2.12, `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/openai` 1.5.13, `@langchain/anthropic` 1.5.11, `@langchain/google-genai` 2.3.2, `@langchain/xai` 1.4.13 and `@langchain/openrouter` 0.4.13, with the peer ranges raised to match. The lockfile is deduplicated so that every workspace package resolves the same single copy of `@langchain/langgraph` and `@langchain/core`.
  - @b4run/permissions@0.11.0

## 0.10.0

### Patch Changes

- @b4run/permissions@0.10.0

## 0.9.0

### Patch Changes

- @b4run/permissions@0.9.0

## 0.8.36

### Patch Changes

- @b4run/permissions@0.8.36

## 0.8.35

### Patch Changes

- abec88d: Fix the first request to a freshly provisioned schema failing with `23505` on `pg_namespace_nspname_index`. The checkpointer, threads store and permissions store each take an advisory lock keyed on schema, table prefix and component, deliberately so they version independently. The schema is the one object all three share, so creating it under those three different locks left them racing on `CREATE SCHEMA IF NOT EXISTS`, which is no more concurrency-safe than `CREATE TABLE IF NOT EXISTS`: the loser raised a duplicate-key error instead of a no-op, and the partly-created schema meant only a second run succeeded.

  Schema creation now takes a lock keyed on the schema alone, in its own short transaction, so the shared DDL is serialized while the per-component migrations still run independently. This is the cold start after a deploy to a new environment, which is what `B4_PG_SCHEMA` exists for.

- 03be72b: Namespace generated Postgres stores per deployment environment. The `hono` and `vercel` targets' `stores.mjs` now reads `B4_PG_SCHEMA` and `B4_PG_TABLE_PREFIX` per request, each a lowercase identifier or a `$NAME` reference to another variable, so `B4_PG_SCHEMA=$VERCEL_ENV` keeps a Vercel project's preview and production deployments in separate schemas of one database. Unset bindings keep `public.b4_*`. A bad value fails the request by name instead of falling back to `public`. Behavior change in `@b4run/postgres-storage`: `schema` and `tablePrefix` must now be lowercase. A mixed-case value previously passed validation and was folded to lowercase by unquoted DDL, so it never named the tables it appeared to, and its advisory-lock key differed from the lowercase spelling of the same tables. Such a value now throws at construction. Pass the lowercase spelling the database was already using. The enforced pattern is exported as `IDENTIFIER_PATTERN`.
- 0429cec: Let the `vercel` target's generated stores reach a plain Postgres without a WebSocket proxy, and document `B4_PG_WS_PROXY`.

  - The Vercel `stores.mjs` now selects a driver per request: `@neondatabase/serverless` for a `*.neon.tech` host or when `B4_PG_WS_PROXY` is set, and a pooled `pg` connection (through the new `createPostgresPool` export of `@b4run/postgres-storage/node`) for every other host, so the built bundle runs against a local database with no proxy. `B4_PG_DRIVER=neon|pg` overrides the detection; `pg` is refused on the `hono` target.
  - `B4_PG_WS_PROXY` accepts `host:port`, `ws://host:port`, or `wss://host:port` (the last keeps TLS on) on both targets, and any other scheme, path, or query is rejected with a message naming the variable and the accepted forms instead of failing inside the driver.
  - `normalizeWsProxy` and `selectPostgresDriver` are exported from `@b4run/cli/fetch` for hand-composed store factories.
  - @b4run/permissions@0.8.35

## 0.8.34

### Patch Changes

- @b4run/permissions@0.8.34

## 0.8.33

### Patch Changes

- @b4run/permissions@0.8.33

## 0.8.32

### Patch Changes

- @b4run/permissions@0.8.32

## 0.8.31

### Patch Changes

- @b4run/permissions@0.8.31

## 0.8.30

### Patch Changes

- @b4run/permissions@0.8.30

## 0.8.29

### Patch Changes

- @b4run/permissions@0.8.29

## 0.8.28

### Patch Changes

- @b4run/permissions@0.8.28

## 0.8.27

### Patch Changes

- @b4run/permissions@0.8.27

## 0.8.26

### Patch Changes

- @dawn-ai/permissions@0.8.26

## 0.8.25

### Patch Changes

- @dawn-ai/permissions@0.8.25

## 0.8.24

### Patch Changes

- @dawn-ai/permissions@0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- Updated dependencies [7e62bb1]
  - @dawn-ai/permissions@0.8.23

## 0.8.22

### Patch Changes

- a530e70: Documentation only: this package gains a canonical API reference on dawnai.org
  and a concise npm entrypoint. No runtime behavior changed. (`dawn docs` also
  now discovers every registered detailed API page.)
- 3c68800: Say which Vercel runtime the `/node` entry works on. The README listed "Vercel
  functions" among the hosts where `pg` opens a raw TCP connection, which is true
  of Vercel's Node.js runtime and false of its Edge runtime — the latter has no
  raw TCP socket, exactly like workerd, and needs the injected
  `@neondatabase/serverless` pool instead. The configuration docs carried the same
  unqualified claim in a _Works_ column and now also record that nothing here has
  been run on Vercel: it is inference from the driver, not a measurement.
- Updated dependencies [bedad77]
  - @dawn-ai/permissions@0.8.22

## 0.8.21

### Patch Changes

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

- c2c19da: **Breaking (shipped as a patch): `pool` is now required on
  `@dawn-ai/postgres-storage`'s main entry, and `connectionString` has moved to
  `@dawn-ai/postgres-storage/node`.**

  In `0.8.19` the main entry accepted either, and built its own `pg` pool from a
  `connectionString` when you passed one. It no longer does: the main entry
  imports `pg` for _types only_, so it links on a runtime where a raw TCP driver
  cannot be bundled at all — which is what makes Cloudflare Workers possible.
  `connectionString` is no longer part of the main entry's option type, so passing
  it there is a type error, and the factory throws at construction naming the
  missing pool and pointing at the `/node` subpath. It does not fail silently or
  later.

  Two ways to migrate, both mechanical:

  ```ts
  // 1. Change the import. Same three factories, connectionString still works,
  //    the store still builds and owns its pool.
  import {
    createPostgresPermissionsStore,
    createPostgresThreadsStore,
    postgresCheckpointer,
  } from "@dawn-ai/postgres-storage/node";

  // 2. Or build the pool yourself and keep the main entry — which is what you
  //    want anyway if you are sharing one pool across all three stores.
  import { Pool } from "pg";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // Do not skip this. See below.
  pool.on("error", (error) => {
    console.error("postgres pool client error (connection dropped):", error);
  });
  postgresCheckpointer({ pool });
  ```

  **If you take option 2, attach an `'error'` listener to the pool you build.**
  `0.8.19` shipped that listener as a fix, and it attached it to the pool it built
  for you; now that you own the pool, you own its error handling, and these stores
  deliberately do not attach one to a pool you passed in — `pg` puts that
  responsibility on the pool owner, and attaching one silently would mask it.
  `pg` emits `'error'` on the **pool** when an **idle** client fails, and an
  EventEmitter `'error'` with no listener is an uncaught exception that ends the
  process. Idle connections are dropped as a matter of course (server restart,
  failover, `idle_session_timeout`), so a pool without one turns a routine
  Postgres blip into an outage. The `/node` entry in option 1 still attaches it to
  pools it builds.

  The `/node` entry is the same three factories with the `connectionString`
  convenience layered on, and it re-exports everything the main entry does, so
  option 1 is usually a one-line change. Pool ownership is unchanged in both
  shapes: a pool the store built is ended by `close()`, an injected pool is left
  alone (`ownsPool`, default `false`).

  This is a breaking change against a published version, and it is going out as a
  **patch** deliberately: the packages are in a fixed `0.x` group, where a minor
  bump would move the entire group to `1.0.0`.

- c2c19da: **`@dawn-ai/postgres-storage` runs on Cloudflare Workers.** That was an open
  question when the package shipped in `0.8.19`, and its README said so: workerd
  provides no raw TCP socket, so `pg` is unusable there.

  What changed is the main entry's typing. The pool is now structural —
  `SqlPool = { query, connect, end }` — which both `pg.Pool` and a
  `@neondatabase/serverless` WebSocket `Pool` satisfy with no driver abstraction in
  between. Injecting the latter runs the full contract, transactions included. The
  narrowness is itself the guard: `neon()`'s transaction-incapable HTTP query
  function fails to satisfy `SqlPool` at compile time, correctly, because the
  checkpointer needs real `BEGIN`/`COMMIT`. `dawn build`'s `hono` target generates
  that wiring for you. Hyperdrive should also work but is untested — it needs a
  Cloudflare account.

  Three separate pieces of evidence back this, and they are worth keeping apart:

  - **A throwaway spike** ran this package's built `dist` inside real workerd
    against `postgres:16-alpine` plus a `wsproxy`. It is the only thing that has
    checked the driver's transaction semantics there: `BEGIN`/`COMMIT`/`ROLLBACK`
    are genuine session transactions, `pg_advisory_xact_lock` really blocks a
    second session, and eight concurrent cold-start migrations converged. The spike
    was not retained; its findings are recorded in
    `docs/superpowers/specs/2026-08-05-edge-targets-design.md`.
  - **The package's own suite** is the standing regression guard for the migration
    behavior — concurrent cold starts against a virgin database, for all three
    stores — but it runs on Node with `pg` and Testcontainers, gated on
    `DAWN_TEST_PGSTORAGE`, not inside workerd.
  - **The gated `edge-workerd` CI lane** is what runs continuously inside workerd,
    and it asserts at the application level rather than the SQL level: four
    sequential AG-UI turns each carrying the model's reply, identical event shapes
    across turns, `/healthz`, and out-of-band `psql` checks that the thread,
    checkpoint, and pending-write rows are really in Postgres. It exercises the
    stores through the runtime; it does not assert on transactions, the advisory
    lock, or concurrent cold starts.

  One rule that lane settled the hard way: on workerd, **build the pool and the
  stores per request**. A connection is bound to the I/O context of the request
  that opened it, so a module-scope pool hands the next request a dead socket and
  hangs rather than erroring. `assumeMigrated` exists for exactly that lifetime —
  it lets a per-request store skip the migration pass that a module-scope boolean
  has already completed for the isolate.

  Correcting one line of `0.8.19`'s entry while it is fresh: migrations are
  memoized **on the store instance**, not per process. That distinction did not
  matter when a process built its stores once; it is the whole reason
  `assumeMigrated` had to exist once stores are per request.

  - @dawn-ai/permissions@0.8.21

## 0.8.20

### Patch Changes

- 99ca088: Republish with the `pg` pool `'error'` handler.

  **`@dawn-ai/postgres-storage@0.8.19` does not contain that fix, despite its changelog
  entry saying so.** 0.8.19 was the package's first release, so it had to be published
  by hand to create the name on npm before OIDC trusted publishing could take over — and
  that tarball was built from a release branch that had not yet absorbed the fix. npm does
  not allow a published version to be replaced, and the automated release skips any
  version already on the registry, so 0.8.19 shipped and stayed the pre-fix build.

  This release is the first one whose published artifact actually carries it. Anyone on
  `@dawn-ai/postgres-storage@0.8.19` should upgrade: without the listener, `pg` raises an
  unhandled `'error'` when an idle client is dropped — a server restart, failover,
  `idle_session_timeout` — and an EventEmitter `'error'` with no listener terminates the
  process. See the 0.8.19 entry for the full description of the fix itself.

  - @dawn-ai/permissions@0.8.20

## 0.8.19

### Patch Changes

- 4102312: Handle `pg` pool errors instead of crashing the process.

  Both Postgres-backed packages created their `pg` `Pool` with no `'error'` listener.
  `pg` emits that event on the **pool** when an **idle** client fails, and an
  EventEmitter `'error'` with no listener is an uncaught exception — so the process
  exits. Idle connections are dropped as a matter of course: a server restart, a
  failover, `idle_session_timeout`, a container stopping. Any of those took the whole
  app down instead of the pool quietly replacing one connection.

  This surfaced as a CI flake — the `pgvector-docker` lane failing _after_ all 50 tests
  passed, because stopping the test container terminates idle clients with `57P01` — but
  the flake was the symptom. The same defect applied in production, and most sharply in
  `@dawn-ai/postgres-storage`, whose checkpointer, threads and permissions stores hold
  durable agent state for exactly the long-running and edge deployments where connection
  drops are routine.

  Pools these packages own now log a warning and carry on; `pg` has already discarded the
  broken client, and the next query transparently opens a new one. A caller-supplied
  `pool` is left untouched — its owner controls its lifecycle and error handling. In
  `@dawn-ai/postgres-storage` the three stores now share one `resolvePool` helper, so the
  rule cannot drift between them.

  Both packages gained a test that terminates a live idle connection with
  `pg_terminate_backend` and asserts no uncaught exception, that the drop was logged, and
  that the store still serves the next query. Both fail without the fix.

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

  - @dawn-ai/permissions@0.8.19
