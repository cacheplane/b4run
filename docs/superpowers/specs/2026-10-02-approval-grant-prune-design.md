# Prune settled approval grant records

**Date:** 2026-10-02
**Status:** Approved
**Issue:** cacheplane/b4run#902 (follow-up to #898, client tool call pruning)

## Problem

Every parked approval under `approvals.grants: "optional" | "required"` writes
one row to the `InterruptGrantStore`. Rows are consumed (`consumedAt`) on
resume or voided (`voidedAt`) by `voidSupersededGrants` when the thread moves
past the prompt, but nothing ever deletes them. The `interrupt_grants` table
grows without bound.

## Decisions

| Choice | Decision |
|---|---|
| Trigger | Opportunistic sweep inside `voidSupersededGrants` (the one helper behind every runtime void) plus `b4 approvals prune`. |
| What is deleted | Consumed or voided rows whose settle time (`voidedAt`, else `consumedAt`) is before the cutoff. **Outstanding rows are never deleted, expired or not.** |
| Retention window | `approvals.grantRetentionMs`, default 7 days (`604800000`), validated like `clientToolRetentionMs`. No TTL floor. |
| Contract | `prune` is required on `InterruptGrantStore`; a configured `approvals.grantStore` is shape-checked at boot (all methods, including `prune`) and a missing method fails the boot. |

### Why outstanding rows are kept, unlike #898

`checkGrants` treats a parked prompt with **no grant row** as one that predates
grants: under `"required"` it refuses with `409 grant_unavailable`, but under
`"optional"` it resumes **with no grant required**. That rule is load-bearing
(it is how an app turns grants on without breaking already-parked prompts).
Deleting an expired outstanding row while its prompt is still parked would
therefore turn a refused approval (`409 grant_expired`) into one anyone can
resume. Client tool calls had no such path: a missing row and an expired row
both abandoned the turn. So grants prune settled rows only. An expired
outstanding row stays until the thread moves on and `voidOutstanding` stamps
it, after which it is settled and ages out. `grantTtlMs` is off by default,
so most apps never hold expired outstanding rows anyway.

### Why no TTL floor

A settled row is terminal: once consumed or voided it can never be consumed
again, and a replayed resume against it is refused whether the row exists
(`already_consumed` / `stale_interrupt`) or not (the interrupt is no longer
pending, so the resume fails the pending check first). The TTL cannot make it
answerable, so the cutoff is simply `now - retentionMs`. What is lost after
the window is the `already_consumed` response body carrying the recorded
decision; a week-old double submit gets the generic refusal instead.

## Design

### 1. Store contract

Add to `InterruptGrantStore` in all three declarations
(`packages/sdk/src/interrupt-grants.ts`,
`packages/sqlite-storage/src/interrupt-grants/types.ts`,
`packages/postgres-storage/src/interrupt-grants.ts`):

```ts
/**
 * Deletes settled rows — consumed or voided — whose settle time (`voidedAt`,
 * else `consumedAt`) is before `before`. Outstanding rows are never deleted,
 * whatever `expiresAt` says: a parked prompt with no row would resume
 * ungated under `approvals.grants: "optional"`. Returns how many rows were
 * deleted. `before` is an ISO-8601 string compared as text.
 */
prune(options: { readonly before: string }): Promise<number>
```

- Memory store (sdk): JS filter over every thread; drop empty thread maps.
- SQLite: `DELETE FROM interrupt_grants WHERE (voided_at IS NOT NULL AND
  voided_at < ?) OR (voided_at IS NULL AND consumed_at IS NOT NULL AND
  consumed_at < ?)`, count from `changes`.
- Postgres: same predicate with `COLLATE "C"`, count from `RETURNING
  interrupt_id`.

### 2. Retention config and boot shape check

- `B4Config.approvals.grantRetentionMs?: number` in `packages/core/src/types.ts`.
- `resolveApprovalGrantRetentionMs(value)` in
  `packages/cli/src/lib/dev/approval-grants.ts`: `undefined` →
  `DEFAULT_APPROVAL_GRANT_RETENTION_MS` (7 days); otherwise a positive safe
  integer of at most `MAX_CLIENT_TOOL_TTL_MS` (one year), else
  `ApprovalGrantConfigError` and the boot fails. It reuses the shared
  `resolvePositiveMs` from `client-tool-runtime.ts`, which gains an error
  factory parameter so each feature throws its own error class.
- `validateInterruptGrantStore(value)` in the same file: `undefined` passes
  through; otherwise every method in `issue, get, listForThread, consume,
  voidOutstanding, prune` must be a function, else `ApprovalGrantConfigError`
  naming the missing ones (same shape as `validateClientToolStore`).
- `ApprovalGrantRuntime` gains `readonly retentionMs: number`. The fetch core
  resolves both at boot where it builds `approvalGrants`. `grantTtlMs` stays
  as it is today (unvalidated, optional); validating it is out of scope.

### 3. Opportunistic sweep

`pruneSettledGrants(store, retentionMs, now)` in `approval-grants.ts`:
throttled to once per `APPROVAL_GRANT_PRUNE_INTERVAL_MS` (one hour) per store
via a module-level `WeakMap`, timestamp recorded before the call (so a failing
store is not retried, and the warning is bounded to once an hour), never
throws (`console.warn("B4: could not prune settled approval grants.", error)`),
returns the deleted count or `undefined` when skipped or failed. Reset seam
`__resetApprovalGrantPruneThrottleForTests`.

`voidSupersededGrants` gains `readonly retentionMs?: number` and, after a
successful or failed void, calls `pruneSettledGrants(store, args.retentionMs
?? DEFAULT_APPROVAL_GRANT_RETENTION_MS, now)`. The six existing call sites
(five in `runtime-fetch-core.ts`, one in `agui-handler.ts`) pass
`retentionMs: approvalGrants.retentionMs`. Because the sweep rides the void,
it runs exactly where the runtime already asserts "the thread moved on", with
no new handler logic.

### 4. CLI verb

`b4 approvals prune [--retention <ms>] [--cwd <path>]` in a new
`packages/cli/src/commands/approvals.ts`, modelled on `client-tools.ts`:

- Loads the config, validates `approvals.grantStore` with
  `validateInterruptGrantStore` (so a bad custom store fails like the boot),
  resolves `retentionMs` (override or config, validated).
- Store: the validated config store, else the existing
  `resolveInterruptGrantStore(appRoot)`, else the default SQLite file
  `<appRoot>/.b4/interrupt-grants.sqlite` if it exists (grants may have been
  turned off after rows were written). None → prints
  `no approval grant store for this app; nothing to prune`, exit 0.
- `store.prune({ before: new Date(Date.now() - retentionMs).toISOString() })`,
  prints `pruned: N`.
- `--retention` must be a positive safe integer of at most one year; missing
  value, unknown argument, unknown or missing subcommand → `CliError`, exit 1.
- Registered in `packages/cli/src/index.ts` alphabetically (after `add`).

### 5. Tests

- Per store: consumed-old deleted; voided-old deleted; consumed-recent kept;
  consumed-old-then-voided-recent kept (void is the settle time); outstanding
  with `expiresAt` far in the past kept; outstanding with `expiresAt: null`
  kept; cross-thread; idempotent (second call returns 0). Postgres: gated
  behavioural test plus an ungated statement-shape pin.
- Sweep: via `voidSupersededGrants` with a memory store: deletes an old voided
  row on another thread and keeps an expired outstanding row; second call
  within the hour does not call `prune`; a throwing `prune` warns and the
  void's count is still returned.
- Boot: `resolveApprovalGrantRetentionMs` default and rejections;
  `validateInterruptGrantStore` rejects a store missing `prune`; a fixture app
  with `approvals: { grants: "optional", grantRetentionMs: 0 }` fails the boot;
  a fixture app with `grantRetentionMs: 1` and a memory grant store prunes a
  row voided two minutes ago after a turn that voids grants.
- CLI: no store; default window from config; config `grantRetentionMs`
  honoured; `--retention` override; invalid inputs; mistyped config key;
  configured store missing `prune` → `/missing prune/`; commander-level parse
  test (`approvals --cwd <dir> prune --retention 1`, and `--help` lists the
  usage).

### 6. Docs and release

- Changeset: `patch` for `@b4run/sdk`, `@b4run/core`, `@b4run/cli`,
  `@b4run/sqlite-storage`, `@b4run/postgres-storage`; states the custom-store
  contract break.
- `configuration.mdx`: `grantRetentionMs?: number` in the `approvals` type
  block; a paragraph after the `grantTtlMs`/`grantStore` one; note that a
  supplied store must implement `prune` and is checked at boot.
- `approval-grants.mdx`, "Where consumption is recorded": a retention
  paragraph that says settled rows are deleted after the window, outstanding
  rows never are, and why (the `"optional"` rule).
- `cli.mdx`: "seventeen commands" with `approvals` in the alphabetical list;
  a `## b4 approvals` section before `## b4 build`-adjacent position (keep the
  file's existing section order: insert after `## b4 add`).
- `scripts/check-docs.mjs`: add `approvals.grantRetentionMs` to the config
  path inventory.
- Commit content, then regenerate `apps/web/app/seo/lastmod.generated.json`.

## Out of scope

- Validating `approvals.grantTtlMs` at boot.
- Deleting expired outstanding grant rows (see "Why outstanding rows are kept").
- Pruning LangGraph checkpoints.
