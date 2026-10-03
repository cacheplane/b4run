# Prune settled client tool call records

**Date:** 2026-10-01
**Status:** Approved
**Follow-up to:** cacheplane/b4run#880 (client-provided AG-UI tools)

## Problem

Every client tool call writes a row to the `ClientToolCallStore` keyed on
`(threadId, toolCallId)`. Rows are answered (`answeredAt`) or voided
(`voidedAt`) by the AG-UI handler, and outstanding rows past `expiresAt` are
voided when their thread is next used, but nothing ever deletes a row. The
table grows without bound in every app that opts in to `clientTools`.

The approval-grant store has the same gap and no prune; memory episodes are
the existing pattern that prunes (`store.prune` called lazily after every
write, never allowed to fail the run, plus `b4 memory prune`). This design
follows the episodes pattern.

## Decisions

| Choice | Decision |
|---|---|
| Trigger | Both an opportunistic sweep in the AG-UI handler and a CLI verb. |
| What is deleted | Settled rows (answered or voided) whose settle time is before the cutoff, and outstanding rows whose `expiresAt` is before the cutoff. Outstanding rows that are unexpired, or have no expiry, are never deleted. |
| Retention window | `server.agui.clientToolRetentionMs`, default 7 days (`604800000`), effective window `max(retentionMs, ttlMs)`. |
| Contract | `prune` is a required method on `ClientToolCallStore`; a custom store missing it fails the boot. |

### Why expired-outstanding rows may go

The resolver (`resolveClientToolTurn`) treats a park whose row is missing as
"unanswerable" and abandons the turn, and a park whose row is expired as
"expired" and abandons the turn. Both close the park with the abandoned
result and fall back to the park envelope's tool name. Deleting an expired
row therefore changes only the abandon reason, and only for a thread that
did not return for the whole retention window. Keeping them would leave one
row per abandoned call forever on threads that never come back.

### Why `max(retentionMs, ttlMs)`

`clientToolTtlMs` may be up to one year. A retention shorter than the TTL
could delete a settled row while a replayed `role: "tool"` message for the
same call is still plausible; the clamp keeps the store's `already_answered`
and `voided` outcomes meaningful for as long as the call could have lived.

## Design

### 1. Store contract

Add to `ClientToolCallStore` in all three declarations, which deliberately
duplicate the shape (`packages/sdk/src/client-tool-calls.ts`,
`packages/sqlite-storage/src/client-tool-calls/types.ts`,
`packages/postgres-storage/src/client-tool-calls.ts`):

```ts
/**
 * Deletes rows that can no longer affect a turn: answered or voided rows
 * whose settle time (`voidedAt`, else `answeredAt`) is before `before`, and
 * outstanding rows whose `expiresAt` is before `before`. Outstanding rows
 * with no expiry, or an expiry at or after `before`, are kept. Returns how
 * many rows were deleted.
 */
prune(options: { readonly before: string }): Promise<number>
```

`before` is an ISO-8601 string compared as text, like every other timestamp
in these stores. The store knows nothing about the retention window; callers
compute `before`.

- **Memory store (sdk):** filter in JS over every thread; drop empty thread
  maps.
- **SQLite:** one `DELETE ... WHERE (voided_at IS NOT NULL AND voided_at < ?)
  OR (voided_at IS NULL AND answered_at IS NOT NULL AND answered_at < ?) OR
  (voided_at IS NULL AND answered_at IS NULL AND expires_at IS NOT NULL AND
  expires_at < ?)`, count from `changes`.
- **Postgres:** the same predicate with `COLLATE "C"` text comparison, count
  from `RETURNING tool_call_id` (the `SqlPool` seam exposes `rows` only).

`validateClientToolStore` (`packages/cli/src/lib/dev/client-tool-runtime.ts`)
adds `prune` to `STORE_METHODS`.

### 2. Retention config

`B4Config.server.agui.clientToolRetentionMs?: number` in
`packages/core/src/types.ts`. Resolved by a new
`resolveClientToolRetentionMs(value)` next to `resolveClientToolTtlMs`:
`undefined` yields `DEFAULT_CLIENT_TOOL_RETENTION_MS` (7 days); anything that
is not a positive safe integer of at most `MAX_CLIENT_TOOL_TTL_MS` (one year)
throws `ClientToolConfigError`, failing the boot. `ClientToolRuntime` gains
`readonly retentionMs: number`; the fetch core sets it where it sets `ttlMs`.

A helper `clientToolPruneCutoff(now, { ttlMs, retentionMs })` returns the
ISO string `now - max(retentionMs, ttlMs)`, shared by the sweep and the CLI.

### 3. Opportunistic sweep

New `pruneClientToolCalls(store, runtime, now)` in
`packages/cli/src/lib/dev/client-tool-runtime.ts` (or a sibling module):

- Throttled per store: a module-level `WeakMap<ClientToolCallStore, number>`
  records the last sweep time; a call within one hour
  (`CLIENT_TOOL_PRUNE_INTERVAL_MS`) is a no-op returning `undefined`.
- Otherwise calls `store.prune({ before: cutoff })` and returns the count.
- Never throws: a store error is `console.warn`ed once per call, like
  `voidSettledClientToolCalls`.
- Global, not per thread, so threads that never return are swept too. The
  store contract makes a concurrent sweep from another instance harmless
  (deletes are idempotent).

The AG-UI handler calls it right after `voidSettledClientToolCalls` inside
the existing settle path (the `voidClientRecordsIfSettled` closure), so the
sweep runs only when a turn has settled and a store exists. Exported for tests
as `__pruneClientToolCallsForTests` with a reset seam for the throttle map.

### 4. CLI verb

`b4 client-tools prune [--retention <ms>] [--cwd <path>]`, a new
`packages/cli/src/commands/client-tools.ts` registered beside `memory` and
`threads` in `packages/cli/src/index.ts`, using `passThroughOptions()` the way
`memory` does.

- Opens the store via the existing `resolveClientToolCallStore(appRoot)`.
  When it returns `undefined`, prints `no client tool store for this app;
  nothing to prune` and exits 0.
- Default window: `max(clientToolRetentionMs, clientToolTtlMs)` from the
  app's `b4.config.ts`, resolved through the same validators as the server.
  `--retention <ms>` overrides the retention half (still clamped by the TTL);
  a non-positive, non-integer or over-one-year value is a `CliError` exit 1.
- Prints `pruned: N`.
- Unknown subcommand or argument: `CliError` with the usage text, exit 1.

`b4 threads` is not the home for this: it is a remote SSE client addressed
by `--url`, while this verb opens the local store like `b4 memory prune`.

### 5. Tests

**Per store** (`packages/sdk/test/client-tool-calls.test.ts`,
`packages/sqlite-storage/test/client-tool-calls.test.ts`,
`packages/postgres-storage/test/client-tool-calls.test.ts`, the last behind
`B4_TEST_PGSTORAGE=1` like its siblings):

- answered before cutoff deleted; answered at or after cutoff kept
- voided before cutoff deleted; voided row with an old `answeredAt` but a
  recent `voidedAt` kept (void is the settle time)
- outstanding with `expiresAt` before cutoff deleted; with `expiresAt` at or
  after cutoff kept; with `expiresAt: null` kept
- return value equals rows removed; a second identical call returns 0
- rows on other threads are swept too (global)

**Handler / sweep** (`packages/cli/test/agui-client-tools.test.ts` or a new
`client-tool-prune.test.ts`): a settled turn deletes an old settled row and
keeps an outstanding one; a second settle within the hour does not call
`prune`; a `prune` that throws leaves the turn's response intact and warns.

**Config** (`packages/cli/test/client-tool-runtime.test.ts` or wherever
`resolveClientToolTtlMs` is tested): default, valid value, each invalid
shape fails; `validateClientToolStore` rejects a store missing `prune`.

**CLI** (`packages/cli/test/client-tools-command.test.ts`): no store prints
the no-op line; default window from config prunes an old row and keeps a
recent one; `--retention` override; invalid `--retention`; unknown
subcommand.

### 6. Docs and release

- Changeset: `patch` for `@b4run/sdk`, `@b4run/core`, `@b4run/cli`,
  `@b4run/sqlite-storage`, `@b4run/postgres-storage` (fixed group).
- `apps/web/content/docs/configuration.mdx`: add `clientToolRetentionMs` to
  the `server.agui` type block and a paragraph after the `clientToolStore`
  one; note that a configured store must also implement `prune`.
- `apps/web/content/docs/ag-ui.mdx`: in the abandonment section, replace
  "Expiry is checked when the thread is next used, not by a background
  sweep" with a sentence that expiry is still checked on next use and that
  settled and expired records are deleted after the retention window, by a
  sweep at the end of a turn or by `b4 client-tools prune`.
- `apps/web/content/docs/cli.mdx`: a `## b4 client-tools` section.
- Commit the content change, then `pnpm --dir apps/web seo:lastmod` and
  commit the manifest.

## Out of scope

- Pruning approval grants (`InterruptGrantStore`); same gap, separate change.
- A background timer. The sweep piggybacks on turns, as episodes do.
- Pruning LangGraph checkpoints for threads that never return.
