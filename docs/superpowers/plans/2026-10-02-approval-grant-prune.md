# Prune Settled Approval Grant Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `interrupt_grants` table growing forever by adding `prune({ before })` to every `InterruptGrantStore`, sweeping settled rows where the runtime already voids grants, and shipping `b4 approvals prune`.

**Architecture:** Mirrors cacheplane/b4run#898 (client tool call pruning, merged as `b61e133fc`) with one deliberate difference: only settled rows (consumed or voided) are deleted, never outstanding ones, because a parked prompt with no grant row resumes ungated under `approvals.grants: "optional"`. The sweep rides `voidSupersededGrants`, the single helper behind all six runtime void sites. A configured `approvals.grantStore` is shape-checked at boot.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), vitest, `node:sqlite`, `pg` via Testcontainers (gated), commander, pnpm workspace, Biome.

**Spec:** `docs/superpowers/specs/2026-10-02-approval-grant-prune-design.md`
**Reference implementation to copy shapes from:** `git show b61e133fc` (the #898 squash) — in particular `packages/cli/src/lib/dev/client-tool-runtime.ts` (`resolvePositiveMs`, `pruneClientToolCalls`, WeakMap throttle), `packages/cli/src/commands/client-tools.ts`, `packages/cli/test/client-tools-command.test.ts`, `packages/cli/test/client-tools-command-parsing.test.ts`.

**Conventions that bite here:**
- Node 24 (`nvm use 24`), run everything from the repo root (this worktree).
- `src/` imports siblings with `.js`; `test/` with `.ts` unless the existing test file already uses `.js` (follow the file).
- Never bare `biome check --write`; `pnpm --filter <pkg> lint` / `lint:fix`, or Biome scoped to the files you changed.
- `pnpm build` once before the CLI tasks (they consume `dist/` of sdk/core/sqlite-storage); rebuild a package after changing its `src/`.
- Every new `B4Config` key must be added to the inventory pin in `scripts/check-docs.mjs` (around line 3113) AND to the `configuration.mdx` type block, or check-docs reds.
- Any new `@b4run/sdk` barrel export needs a row in `apps/web/content/docs/api/sdk.mdx`; keep helpers module-local.
- Docs content change → commit → `pnpm --dir apps/web seo:lastmod` → commit the manifest.
- `writeLine` in `packages/cli/src/lib/output.ts` appends `\n`; CLI tests strip it before exact assertions.

---

## File map

| File | Responsibility |
|---|---|
| `packages/sdk/src/interrupt-grants.ts` | Contract (add `prune`) + memory store implementation |
| `packages/sqlite-storage/src/interrupt-grants/types.ts` | Structural copy of the contract |
| `packages/sqlite-storage/src/interrupt-grants/store.ts` | SQLite `DELETE` |
| `packages/postgres-storage/src/interrupt-grants.ts` | Structural copy + Postgres `DELETE ... RETURNING` |
| `packages/core/src/types.ts` | `approvals.grantRetentionMs` |
| `packages/cli/src/lib/dev/client-tool-runtime.ts` | Export `resolvePositiveMs` with an error-factory parameter |
| `packages/cli/src/lib/dev/approval-grants.ts` | `ApprovalGrantConfigError`, `DEFAULT_APPROVAL_GRANT_RETENTION_MS`, `resolveApprovalGrantRetentionMs`, `validateInterruptGrantStore`, `pruneSettledGrants` + throttle, `retentionMs` on `ApprovalGrantRuntime`, `voidSupersededGrants` sweep hook |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | Boot resolution + five call sites |
| `packages/cli/src/lib/dev/agui-handler.ts` | One call site |
| `packages/cli/src/commands/approvals.ts` | `b4 approvals prune` |
| `packages/cli/src/index.ts` | Register the command |
| Tests | `packages/sdk/test/interrupt-grants.test.ts`, `packages/sqlite-storage/test/interrupt-grants.test.ts`, `packages/postgres-storage/test/interrupt-grants.test.ts`, `packages/postgres-storage/test/interrupt-grants-ddl.test.ts`, `packages/cli/test/approval-grant-prune.test.ts` (new), `packages/cli/test/approvals-command.test.ts` (new), `packages/cli/test/approvals-command-parsing.test.ts` (new) |
| Docs | `apps/web/content/docs/configuration.mdx`, `apps/web/content/docs/approval-grants.mdx`, `apps/web/content/docs/cli.mdx`, `scripts/check-docs.mjs`, `apps/web/app/seo/lastmod.generated.json` |
| Release | `.changeset/approval-grant-prune.md` |

---

### Task 1: SDK contract and memory store

**Files:**
- Modify: `packages/sdk/src/interrupt-grants.ts`
- Test: `packages/sdk/test/interrupt-grants.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe("createMemoryInterruptGrantStore", ...)` (the file defines `grant(over)` with `threadId: "t1"`, `interruptId: "i1"`, `expiresAt: null`):

```ts
  describe("prune", () => {
    const BEFORE = "2026-09-30T12:00:00.000Z"

    it("deletes consumed and voided rows settled before the cutoff and keeps later ones", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(grant({ interruptId: "old_consumed", consumedAt: "2026-09-30T01:00:00.000Z", consumedDecision: "once" }))
      await store.issue(grant({ interruptId: "new_consumed", consumedAt: BEFORE, consumedDecision: "once" }))
      await store.issue(grant({ interruptId: "old_voided", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(grant({ interruptId: "new_voided", voidedAt: "2026-09-30T13:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect((await store.listForThread("t1")).map((row) => row.interruptId).sort()).toEqual([
        "new_consumed",
        "new_voided",
      ])
    })

    it("a void is the settle time: an old consume with a recent void is kept", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(
        grant({
          interruptId: "consumed_then_voided",
          consumedAt: "2026-09-30T01:00:00.000Z",
          consumedDecision: "once",
          voidedAt: "2026-09-30T13:00:00.000Z",
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.get("t1", "consumed_then_voided")).toBeDefined()
    })

    it("never deletes an outstanding row, expired or not", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(grant({ interruptId: "expired_long_ago", expiresAt: "2020-01-01T00:00:00.000Z" }))
      await store.issue(grant({ interruptId: "never_expires", expiresAt: null }))
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect((await store.listForThread("t1")).map((row) => row.interruptId).sort()).toEqual([
        "expired_long_ago",
        "never_expires",
      ])
    })

    it("sweeps every thread and is idempotent", async () => {
      const store = createMemoryInterruptGrantStore()
      await store.issue(grant({ threadId: "t1", interruptId: "a", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(grant({ threadId: "t2", interruptId: "b", voidedAt: "2026-09-30T01:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.listForThread("t1")).toEqual([])
      expect(await store.listForThread("t2")).toEqual([])
    })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/sdk exec vitest run test/interrupt-grants.test.ts`
Expected: FAIL, `store.prune is not a function`.

- [ ] **Step 3: Add `prune` to the interface**

In `export interface InterruptGrantStore`, after `voidOutstanding(...)`:

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

- [ ] **Step 4: Implement in the memory store**

Above `createMemoryInterruptGrantStore` add (module-local, NOT exported):

```ts
/** The memory store's `prune` predicate; the SQL stores carry the same rule in their DELETE. */
function isSettledBefore(row: InterruptGrantRecord, before: string): boolean {
  if (row.voidedAt !== null) return row.voidedAt < before
  if (row.consumedAt !== null) return row.consumedAt < before
  return false
}
```

In the returned object, after `voidOutstanding`:

```ts
    async prune({ before }) {
      let count = 0
      for (const [threadId, rows] of threads) {
        for (const [interruptId, row] of rows) {
          if (!isSettledBefore(row, before)) continue
          rows.delete(interruptId)
          count += 1
        }
        if (rows.size === 0) threads.delete(threadId)
      }
      return count
    },
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @b4run/sdk exec vitest run test/interrupt-grants.test.ts && pnpm --filter @b4run/sdk typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/interrupt-grants.ts packages/sdk/test/interrupt-grants.test.ts
git commit -m "feat(sdk): InterruptGrantStore.prune deletes settled approval grant records

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: SQLite store

**Files:**
- Modify: `packages/sqlite-storage/src/interrupt-grants/types.ts`, `packages/sqlite-storage/src/interrupt-grants/store.ts`
- Test: `packages/sqlite-storage/test/interrupt-grants.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe("createInterruptGrantStore", ...)` (defines `newStore()` and `record(overrides)` with `threadId: "t-1"`, `interruptId: "int-1"`, `expiresAt: null`):

```ts
  describe("prune", () => {
    const BEFORE = "2026-09-30T12:00:00.000Z"

    it("deletes consumed and voided rows settled before the cutoff and keeps later ones", async () => {
      const store = newStore()
      await store.issue(record({ interruptId: "old_consumed", consumedAt: "2026-09-30T01:00:00.000Z", consumedDecision: "once" }))
      await store.issue(record({ interruptId: "new_consumed", consumedAt: BEFORE, consumedDecision: "once" }))
      await store.issue(record({ interruptId: "old_voided", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(record({ interruptId: "new_voided", voidedAt: "2026-09-30T13:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect((await store.listForThread("t-1")).map((row) => row.interruptId).sort()).toEqual([
        "new_consumed",
        "new_voided",
      ])
    })

    it("a void is the settle time: an old consume with a recent void is kept", async () => {
      const store = newStore()
      await store.issue(
        record({
          interruptId: "consumed_then_voided",
          consumedAt: "2026-09-30T01:00:00.000Z",
          consumedDecision: "once",
          voidedAt: "2026-09-30T13:00:00.000Z",
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.get("t-1", "consumed_then_voided")).toBeDefined()
    })

    it("never deletes an outstanding row, expired or not", async () => {
      const store = newStore()
      await store.issue(record({ interruptId: "expired_long_ago", expiresAt: "2020-01-01T00:00:00.000Z" }))
      await store.issue(record({ interruptId: "never_expires", expiresAt: null }))
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect((await store.listForThread("t-1")).length).toBe(2)
    })

    it("sweeps every thread and is idempotent", async () => {
      const store = newStore()
      await store.issue(record({ threadId: "t-1", interruptId: "a", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(record({ threadId: "t-2", interruptId: "b", voidedAt: "2026-09-30T01:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.listForThread("t-1")).toEqual([])
      expect(await store.listForThread("t-2")).toEqual([])
    })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/sqlite-storage exec vitest run test/interrupt-grants.test.ts`
Expected: FAIL, `store.prune is not a function`.

- [ ] **Step 3: Add `prune` to `types.ts`** — the identical member and doc comment from Task 1 Step 3, after `voidOutstanding`.

- [ ] **Step 4: Implement the DELETE**

In `store.ts`, check how the file counts `changes` (grep `changes` in it; it either has a `changeCount` helper like the client-tool-calls store or inlines `Number(...)`; follow the file). Add after `voidOutstanding`:

```ts
    async prune({ before }) {
      // Settled rows only: the settle time is voided_at when set, else
      // consumed_at. Outstanding rows are never deleted — a parked prompt
      // with no row resumes ungated under approvals.grants "optional".
      const changes = db
        .prepare(
          `DELETE FROM interrupt_grants
           WHERE (voided_at IS NOT NULL AND voided_at < ?)
              OR (voided_at IS NULL AND consumed_at IS NOT NULL AND consumed_at < ?)`,
        )
        .run(before, before).changes
      return typeof changes === "bigint" ? Number(changes) : changes
    },
```

(Use the file's existing count helper instead of the inline ternary if it has one.)

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @b4run/sqlite-storage exec vitest run test/interrupt-grants.test.ts && pnpm --filter @b4run/sqlite-storage typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite-storage/src/interrupt-grants packages/sqlite-storage/test/interrupt-grants.test.ts
git commit -m "feat(sqlite-storage): prune settled approval grant rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Postgres store

**Files:**
- Modify: `packages/postgres-storage/src/interrupt-grants.ts`
- Test: `packages/postgres-storage/test/interrupt-grants.test.ts` (gated `B4_TEST_PGSTORAGE=1`), `packages/postgres-storage/test/interrupt-grants-ddl.test.ts`

- [ ] **Step 1: Gated behavioural test** — append inside the `describe.skipIf(!enabled)(...)` block (defines `withStore(fn)` and `grant(over)` with `threadId: "t-1"`, `interruptId: "i-1"`):

```ts
  test("prune deletes settled rows before the cutoff, keeps the rest, never touches outstanding rows", async () => {
    await withStore(async (store) => {
      const BEFORE = "2026-09-18T12:00:00.000Z"
      await store.issue(grant({ interruptId: "old_consumed", consumedAt: "2026-09-18T10:30:00.000Z", consumedDecision: "once" }))
      await store.issue(grant({ interruptId: "new_consumed", consumedAt: BEFORE, consumedDecision: "once" }))
      await store.issue(grant({ interruptId: "old_voided", voidedAt: "2026-09-18T10:30:00.000Z" }))
      await store.issue(
        grant({
          interruptId: "consumed_then_voided",
          consumedAt: "2026-09-18T10:30:00.000Z",
          consumedDecision: "once",
          voidedAt: "2026-09-18T13:00:00.000Z",
        }),
      )
      await store.issue(grant({ interruptId: "expired_long_ago", expiresAt: "2020-01-01T00:00:00.000Z" }))
      await store.issue(grant({ interruptId: "never_expires", expiresAt: null }))
      await store.issue(grant({ threadId: "t-2", interruptId: "other_thread", voidedAt: "2026-09-18T10:30:00.000Z" }))

      expect(await store.prune({ before: BEFORE })).toBe(3)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect((await store.listForThread("t-1")).map((row) => row.interruptId).sort()).toEqual([
        "consumed_then_voided",
        "expired_long_ago",
        "never_expires",
        "new_consumed",
      ])
      expect(await store.listForThread("t-2")).toEqual([])
    })
  }, 60_000)
```

- [ ] **Step 2: Ungated statement-shape test** — append to `interrupt-grants-ddl.test.ts` (defines `recordingPool()` and `normalize`):

```ts
describe("createPostgresInterruptGrantStore prune", () => {
  it("is one DELETE over settled rows only", async () => {
    const { pool, sql } = recordingPool()
    const store = createPostgresInterruptGrantStore({ pool, assumeMigrated: true })
    expect(await store.prune({ before: "2026-09-18T12:00:00.000Z" })).toBe(0)
    const statement = sql.find((text) => /DELETE FROM/i.test(text))
    expect(statement).toBeDefined()
    expect(normalize(statement ?? "")).toBe(
      "DELETE FROM public.b4_interrupt_grants " +
        'WHERE (voided_at IS NOT NULL AND voided_at COLLATE "C" < $1) ' +
        'OR (voided_at IS NULL AND consumed_at IS NOT NULL AND consumed_at COLLATE "C" < $1) ' +
        "RETURNING interrupt_id",
    )
  })
})
```

- [ ] **Step 3: Run the ddl test to verify failure** — `pnpm --filter @b4run/postgres-storage exec vitest run test/interrupt-grants-ddl.test.ts` → FAIL.

- [ ] **Step 4: Add `prune` to the structural interface** — identical member + doc comment from Task 1 Step 3.

- [ ] **Step 5: Implement**

After `voidOutstanding` in `createPostgresInterruptGrantStore`:

```ts
    async prune({ before }) {
      await ready()
      // Settled rows only (voided_at, else consumed_at, before the cutoff);
      // outstanding rows are never deleted — a parked prompt with no row
      // resumes ungated under approvals.grants "optional". COLLATE "C" makes
      // the ISO-8601 comparison byte-wise; the count comes from RETURNING
      // because `SqlPool` exposes `rows` alone.
      const res = await pool.query<{ interrupt_id: string }>(
        `DELETE FROM ${table}
         WHERE (voided_at IS NOT NULL AND voided_at COLLATE "C" < $1)
            OR (voided_at IS NULL AND consumed_at IS NOT NULL AND consumed_at COLLATE "C" < $1)
         RETURNING interrupt_id`,
        [before],
      )
      return res.rows.length
    },
```

- [ ] **Step 6: Run** — `pnpm --filter @b4run/postgres-storage exec vitest run test/interrupt-grants-ddl.test.ts && pnpm --filter @b4run/postgres-storage typecheck` → PASS. If `docker info` works: `B4_TEST_PGSTORAGE=1 pnpm --filter @b4run/postgres-storage exec vitest run test/interrupt-grants.test.ts` → PASS; otherwise report skipped.

- [ ] **Step 7: Commit**

```bash
git add packages/postgres-storage/src/interrupt-grants.ts packages/postgres-storage/test/interrupt-grants.test.ts packages/postgres-storage/test/interrupt-grants-ddl.test.ts
git commit -m "feat(postgres-storage): prune settled approval grant rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Config key, retention resolver, store shape check, runtime field

**Files:**
- Modify: `packages/core/src/types.ts` (the `approvals` block, after `grantTtlMs`)
- Modify: `packages/cli/src/lib/dev/client-tool-runtime.ts` (export `resolvePositiveMs` with an error factory)
- Modify: `packages/cli/src/lib/dev/approval-grants.ts`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (boot block ~line 585–612)
- Test: `packages/cli/test/approval-grant-prune.test.ts` (new)

- [ ] **Step 0:** `pnpm build` (CLI tests read sibling `dist/`).

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/approval-grant-prune.test.ts`:

```ts
import { createMemoryInterruptGrantStore, type InterruptGrantStore } from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import {
  ApprovalGrantConfigError,
  DEFAULT_APPROVAL_GRANT_RETENTION_MS,
  resolveApprovalGrantRetentionMs,
  validateInterruptGrantStore,
} from "../src/lib/dev/approval-grants.ts"
import { MAX_CLIENT_TOOL_TTL_MS } from "../src/lib/dev/client-tool-runtime.ts"

describe("approval grant retention settings", () => {
  it("grantRetentionMs defaults to 7 days, and a mistyped value fails the boot", () => {
    expect(resolveApprovalGrantRetentionMs(undefined)).toBe(DEFAULT_APPROVAL_GRANT_RETENTION_MS)
    expect(DEFAULT_APPROVAL_GRANT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(resolveApprovalGrantRetentionMs(1)).toBe(1)
    expect(resolveApprovalGrantRetentionMs(MAX_CLIENT_TOOL_TTL_MS)).toBe(MAX_CLIENT_TOOL_TTL_MS)
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "604800000", null]) {
      expect(() => resolveApprovalGrantRetentionMs(bad)).toThrow(ApprovalGrantConfigError)
    }
    expect(() => resolveApprovalGrantRetentionMs(MAX_CLIENT_TOOL_TTL_MS + 1)).toThrow(
      /approvals\.grantRetentionMs/,
    )
  })

  it("a configured grantStore must implement every method, prune included", () => {
    expect(validateInterruptGrantStore(undefined)).toBeUndefined()
    const store = createMemoryInterruptGrantStore()
    expect(validateInterruptGrantStore(store)).toBe(store)
    const { prune: _omitted, ...withoutPrune } = store
    expect(() => validateInterruptGrantStore(withoutPrune)).toThrow(/missing prune/)
    expect(() => validateInterruptGrantStore({ issue() {} })).toThrow(ApprovalGrantConfigError)
    expect(() => validateInterruptGrantStore("sqlite")).toThrow(/approvals\.grantStore/)
  })
})
```

- [ ] **Step 2: Run** — `pnpm --filter @b4run/cli exec vitest run test/approval-grant-prune.test.ts` → FAIL (not exported).

- [ ] **Step 3: Config key** — in `packages/core/src/types.ts`, after the `grantTtlMs?: number` member of `approvals`:

```ts
    /**
     * How long, in milliseconds, a settled grant record (consumed or voided)
     * is kept before the runtime deletes it. Default `604800000` (7 days).
     * Outstanding grants are never deleted, however old. Must be a positive
     * integer no greater than one year (`31536000000`); anything else fails
     * the boot.
     */
    readonly grantRetentionMs?: number
```

Then `pnpm --filter @b4run/core build`.

- [ ] **Step 4: Generalise `resolvePositiveMs`** — in `client-tool-runtime.ts` change the private helper to an exported one taking an error factory, and update the two existing callers:

```ts
/**
 * A positive-integer-milliseconds config setting with a default: `undefined`
 * yields `fallback`; anything else that is not a positive safe integer of at
 * most {@link MAX_CLIENT_TOOL_TTL_MS} (one year) is handed to `fail`, whose
 * error the caller throws so each feature reports its own error class.
 */
export function resolvePositiveMs(
  key: string,
  value: unknown,
  fallback: number,
  fail: (message: string) => Error,
): number {
  if (value === undefined) return fallback
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_CLIENT_TOOL_TTL_MS
  ) {
    throw fail(
      `${key} must be a positive integer number of milliseconds no greater than ${MAX_CLIENT_TOOL_TTL_MS}; received ${describe(value)}.`,
    )
  }
  return value
}
```

Callers: `resolveClientToolTtlMs` and `resolveClientToolRetentionMs` pass `(message) => new ClientToolConfigError(message)`. Existing tests must stay green.

- [ ] **Step 5: Approval-grant side** — in `approval-grants.ts` add (imports: `MAX_CLIENT_TOOL_TTL_MS` is not needed; import `resolvePositiveMs` from `./client-tool-runtime.js`):

```ts
/** An `approvals` setting that cannot be honored as written. */
export class ApprovalGrantConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApprovalGrantConfigError"
  }
}

/** How long a settled grant record is kept by default: 7 days. */
export const DEFAULT_APPROVAL_GRANT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** `approvals.grantRetentionMs`, validated; a mistyped value fails the boot. */
export function resolveApprovalGrantRetentionMs(value: unknown): number {
  return resolvePositiveMs(
    "approvals.grantRetentionMs",
    value,
    DEFAULT_APPROVAL_GRANT_RETENTION_MS,
    (message) => new ApprovalGrantConfigError(message),
  )
}

const GRANT_STORE_METHODS = [
  "issue",
  "get",
  "listForThread",
  "consume",
  "voidOutstanding",
  "prune",
] as const

/** `approvals.grantStore`, shape-checked: absent, or an object with every store method. */
export function validateInterruptGrantStore(value: unknown): InterruptGrantStore | undefined {
  if (value === undefined) return undefined
  const missing =
    typeof value === "object" && value !== null
      ? GRANT_STORE_METHODS.filter(
          (method) => typeof (value as Record<string, unknown>)[method] !== "function",
        )
      : [...GRANT_STORE_METHODS]
  if (missing.length > 0) {
    throw new ApprovalGrantConfigError(
      `approvals.grantStore must be an InterruptGrantStore; missing ${missing.join(", ")}.`,
    )
  }
  return value as InterruptGrantStore
}
```

Add `readonly retentionMs: number` to `ApprovalGrantRuntime` (required).

- [ ] **Step 6: Boot wiring** — in `runtime-fetch-core.ts`, the block that builds `interruptGrantStore` / `approvalGrants`: validate the config store before the fallback, resolve retention, and set it:

```ts
  const interruptGrantStore: InterruptGrantStore | undefined =
    approvalGrantMode === "off"
      ? undefined
      : (validateInterruptGrantStore(approvalConfig?.grantStore) ??
        (await fallbacks?.resolveInterruptGrantStore?.(options.appRoot)))
  const approvalGrantRetentionMs = resolveApprovalGrantRetentionMs(approvalConfig?.grantRetentionMs)
  ...
  const approvalGrants: ApprovalGrantRuntime = {
    mode: approvalGrantMode,
    retentionMs: approvalGrantRetentionMs,
    ...(interruptGrantStore ? { store: interruptGrantStore } : {}),
    ...(approvalConfig?.grantTtlMs !== undefined ? { ttlMs: approvalConfig.grantTtlMs } : {}),
  }
```

Import the two new functions from `./approval-grants.js`. Then `pnpm --filter @b4run/cli typecheck` and fix every other `ApprovalGrantRuntime` literal the compiler reports (grep `mode: "off"`/`mode: "optional"`/`mode: "required"` in `packages/cli/src` and `packages/cli/test`; tests that build the runtime literal need `retentionMs: DEFAULT_APPROVAL_GRANT_RETENTION_MS`).

- [ ] **Step 7: Run** — `pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli exec vitest run test/approval-grant-prune.test.ts test/agui-client-tools.test.ts test/approval-grants-endpoint.test.ts test/approval-grants-agent-route.test.ts` → PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/types.ts packages/cli/src/lib/dev/client-tool-runtime.ts packages/cli/src/lib/dev/approval-grants.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/approval-grant-prune.test.ts
git commit -m "feat(cli): approvals.grantRetentionMs and a boot shape check for approvals.grantStore

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Add any test files you had to touch for the new required field.)

---

### Task 5: Throttled sweep inside `voidSupersededGrants` + call sites

**Files:**
- Modify: `packages/cli/src/lib/dev/approval-grants.ts`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (five `voidSupersededGrants({` sites), `packages/cli/src/lib/dev/agui-handler.ts` (one)
- Test: `packages/cli/test/approval-grant-prune.test.ts`

- [ ] **Step 1: Write the failing tests** — add to the test file (extend the import to include `APPROVAL_GRANT_PRUNE_INTERVAL_MS`, `__resetApprovalGrantPruneThrottleForTests`, `pruneSettledGrants`, `voidSupersededGrants`; import `afterEach`, `vi`, `type InterruptGrantRecord`):

```ts
describe("pruneSettledGrants (opportunistic sweep)", () => {
  const row = (over: Partial<InterruptGrantRecord>): InterruptGrantRecord => ({
    threadId: "t-sweep",
    interruptId: "i",
    checkpointNs: "",
    tokenHash: "0".repeat(64),
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    consumedAt: null,
    consumedDecision: null,
    voidedAt: null,
    ...over,
  })
  afterEach(() => __resetApprovalGrantPruneThrottleForTests())

  it("deletes settled rows older than the window and keeps outstanding ones, expired or not", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(row({ interruptId: "old", voidedAt: "2026-10-01T00:00:00.000Z" }))
    await store.issue(row({ interruptId: "expired", expiresAt: "2026-10-01T00:01:00.000Z" }))
    await store.issue(row({ interruptId: "live" }))
    const now = new Date("2026-10-01T12:00:00.000Z")
    expect(await pruneSettledGrants(store, 3_600_000, now)).toBe(1)
    expect((await store.listForThread("t-sweep")).map((r) => r.interruptId).sort()).toEqual(["expired", "live"])
  })

  it("runs at most once per interval per store", async () => {
    const store = createMemoryInterruptGrantStore()
    let calls = 0
    const counting: InterruptGrantStore = {
      ...store,
      prune: async (options) => {
        calls += 1
        return store.prune(options)
      },
    }
    const t0 = new Date("2026-10-01T12:00:00.000Z")
    expect(await pruneSettledGrants(counting, 3_600_000, t0)).toBe(0)
    expect(await pruneSettledGrants(counting, 3_600_000, new Date(t0.getTime() + APPROVAL_GRANT_PRUNE_INTERVAL_MS - 1))).toBeUndefined()
    expect(await pruneSettledGrants(counting, 3_600_000, new Date(t0.getTime() + APPROVAL_GRANT_PRUNE_INTERVAL_MS))).toBe(0)
    expect(calls).toBe(2)
  })

  it("never throws: a failing store is warned about once and reports undefined", async () => {
    const store = createMemoryInterruptGrantStore()
    const failing: InterruptGrantStore = {
      ...store,
      prune: async () => {
        throw new Error("disk full")
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(pruneSettledGrants(failing, 3_600_000, new Date())).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not prune settled approval grants"), expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })

  it("rides voidSupersededGrants: the void count is returned and the sweep runs after it", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(row({ threadId: "t-other", interruptId: "old", voidedAt: "2020-01-01T00:00:00.000Z" }))
    await store.issue(row({ threadId: "t-now", interruptId: "pending" }))
    await store.issue(row({ threadId: "t-now", interruptId: "moved_past" }))
    const voided = await voidSupersededGrants({
      store,
      threadId: "t-now",
      stillPending: ["pending"],
      retentionMs: 3_600_000,
    })
    expect(voided).toBe(1)
    expect(await store.get("t-other", "old")).toBeUndefined()
    expect((await store.get("t-now", "moved_past"))?.voidedAt).not.toBeNull()
    expect((await store.get("t-now", "pending"))?.voidedAt).toBeNull()
  })
})
```

- [ ] **Step 2: Run** → FAIL (not exported).

- [ ] **Step 3: Implement** — in `approval-grants.ts`:

```ts
/** Least time between two opportunistic sweeps of the same grant store: one hour. */
export const APPROVAL_GRANT_PRUNE_INTERVAL_MS = 60 * 60 * 1000

let lastGrantSweepAt = new WeakMap<InterruptGrantStore, number>()

/** Test seam: forget every store's last sweep time. */
export function __resetApprovalGrantPruneThrottleForTests(): void {
  lastGrantSweepAt = new WeakMap()
}

/**
 * Opportunistic retention for settled grant records, run by
 * {@link voidSupersededGrants} wherever the runtime asserts "the thread moved
 * on". Global, not per thread, so threads that never return are swept too. At
 * most once per {@link APPROVAL_GRANT_PRUNE_INTERVAL_MS} per store; the sweep
 * time is recorded before the call, so a failed sweep is not retried until the
 * interval elapses either, which bounds the warning to once an hour. Never
 * throws. Returns the rows deleted, or `undefined` when nothing ran.
 */
export async function pruneSettledGrants(
  store: InterruptGrantStore,
  retentionMs: number,
  now: Date,
): Promise<number | undefined> {
  const last = lastGrantSweepAt.get(store)
  if (last !== undefined && now.getTime() - last < APPROVAL_GRANT_PRUNE_INTERVAL_MS) return undefined
  lastGrantSweepAt.set(store, now.getTime())
  try {
    return await store.prune({ before: new Date(now.getTime() - retentionMs).toISOString() })
  } catch (error) {
    console.warn("B4: could not prune settled approval grants.", error)
    return undefined
  }
}
```

Change `voidSupersededGrants`: add `readonly retentionMs?: number` to its args; compute `const now = new Date((args.now ?? Date.now)())` once; after the try/catch (so a failed void still sweeps), `await pruneSettledGrants(args.store, args.retentionMs ?? DEFAULT_APPROVAL_GRANT_RETENTION_MS, now)`; keep returning the void count (0 on failure). Update its doc comment with one sentence: "Also runs the hourly settled-grant sweep, so retention rides the same moment."

- [ ] **Step 4: Call sites** — in each of the six `voidSupersededGrants({ ... })` literals (five in `runtime-fetch-core.ts`, one in `agui-handler.ts`) add `retentionMs: approvalGrants.retentionMs,` after `stillPending,`. Verify with `grep -n "voidSupersededGrants({" -A5 packages/cli/src/lib/dev/*.ts | grep -c retentionMs` → 6.

- [ ] **Step 5: Run** — `pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli exec vitest run test/approval-grant-prune.test.ts test/approval-grants-endpoint.test.ts test/approval-grants-agent-route.test.ts test/agui-client-tools.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/dev/approval-grants.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/test/approval-grant-prune.test.ts
git commit -m "feat(cli): sweep settled approval grants where the runtime voids superseded ones

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Boot-level tests for the config key

**Files:**
- Test: `packages/cli/test/approval-grant-prune.test.ts`

- [ ] **Step 1:** Read `packages/cli/test/approval-grants-endpoint.test.ts` to see how it boots a fixture app with `approvals: { grants: "optional", grantStore: globalThis.<key> }` (a config string + `createRuntimeFetchHandler`/equivalent) and parks + resumes an approval so that `voidSupersededGrants` runs. Reuse its helpers by copying the minimal fixture into this test file (do not import private helpers across test files unless the repo already does that).

- [ ] **Step 2:** Add two tests:
  (a) a config with `approvals: { grants: "optional", grantRetentionMs: 0 }` makes the boot reject with `ApprovalGrantConfigError` whose message contains `approvals.grantRetentionMs`.
  (b) a config with `approvals: { grants: "optional", grantStore: globalThis.<key>, grantRetentionMs: 1 }` where the memory store is pre-seeded with a row on thread `t-elsewhere` voided two minutes ago: after a turn on another thread that reaches `voidSupersededGrants` (a settled turn after a parked-and-resumed approval, as the endpoint test does), `store.get("t-elsewhere", ...)` is `undefined`. Call `__resetApprovalGrantPruneThrottleForTests()` before the turn. If driving a real approval park is disproportionate, assert instead through `voidSupersededGrants` being reached with the boot-resolved `retentionMs` by booting the handler and checking that a row voided two minutes ago survives with the default config but not with `grantRetentionMs: 1` — the key point is that the boot value, not the default, reaches the sweep. Explain in the task report which shape you used.

- [ ] **Step 3:** `pnpm --filter @b4run/cli exec vitest run test/approval-grant-prune.test.ts` → PASS. Commit: `test(cli): server boot reads approvals.grantRetentionMs`.

---

### Task 7: `b4 approvals prune` command + tests

**Files:**
- Create: `packages/cli/src/commands/approvals.ts`, `packages/cli/test/approvals-command.test.ts`, `packages/cli/test/approvals-command-parsing.test.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1:** Read `packages/cli/src/commands/client-tools.ts`, `packages/cli/test/client-tools-command.test.ts`, `packages/cli/test/client-tools-command-parsing.test.ts` (all from #898) and `resolveInterruptGrantStore` in `packages/cli/src/lib/runtime/execute-route.ts`.

- [ ] **Step 2: Tests first.** `approvals-command.test.ts` mirrors the client-tools one with `createInterruptGrantStore` from `@b4run/sqlite-storage` seeded at `<app>/.b4/interrupt-grants.sqlite` with: `old` voided 30 days ago, `recent` voided now, `live` outstanding with `expiresAt: "2020-01-01T00:00:00.000Z"` (expired, must survive). Cases: no store (config `export default {}` and no file) prints `no approval grant store for this app; nothing to prune`; default window (config `approvals: { grants: "optional" }`) → `pruned: 1`, survivors `["live","recent"]`; config `grantRetentionMs: 60 days` → `pruned: 0`; `--retention <60 days>` → `pruned: 0`; the file exists but `grants` is omitted (off) → still prunes (the file is opened because it exists); invalid argv list rejects with `CliError`; mistyped `grantRetentionMs: "7d"` rejects with `/grantRetentionMs/`; configured store without `prune` (memory store spread minus `prune`, passed via `globalThis`) rejects with `/missing prune/`. Strip the trailing newline in the io helper.
  `approvals-command-parsing.test.ts` mirrors the client-tools parsing test: `["approvals","--cwd",dir,"prune","--retention","1"]` → `pruned: 1` for a row voided 2 minutes ago (no TTL floor here, so `--retention 1` prunes anything settled); `--help` lists `prune [--retention <ms>]`.

- [ ] **Step 3: Implement** `packages/cli/src/commands/approvals.ts`:

```ts
/**
 * `b4 approvals prune` — delete settled approval grant records by hand
 * (cacheplane/b4run#902). The runtime sweeps the same store hourly wherever
 * it voids superseded grants; this is the operator's handle for cron or a
 * one-off. Outstanding grants are never deleted, however old.
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { createInterruptGrantStore } from "@b4run/sqlite-storage"
import type { Command } from "commander"
import {
  resolveApprovalGrantRetentionMs,
  validateInterruptGrantStore,
} from "../lib/dev/approval-grants.js"
import { MAX_CLIENT_TOOL_TTL_MS } from "../lib/dev/client-tool-runtime.js"
import { loadOptionalB4Config } from "../lib/node-config.js"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"
import { resolveInterruptGrantStore } from "../lib/runtime/execute-route.js"

interface ApprovalsOptions {
  readonly cwd?: string
}

const USAGE = ["b4 approvals <subcommand> [args]", "  subcommands: prune [--retention <ms>]"].join("\n")

export function registerApprovalsCommand(program: Command, io: CommandIo): void {
  program
    .command("approvals [subcommand] [args...]")
    .description("Manage the records behind human-in-the-loop approval grants")
    .option("--cwd <path>", "Path to the B4.run app root")
    .passThroughOptions()
    .addHelpText("after", `\n${USAGE}`)
    .action(async (subcommand: string | undefined, args: string[], options: ApprovalsOptions) => {
      const argv = subcommand ? [subcommand, ...args] : []
      await runApprovalsCommand(argv, options, io)
    })
}

export async function runApprovalsCommand(
  argv: readonly string[],
  options: ApprovalsOptions,
  io: CommandIo,
): Promise<void> {
  const subcommand = argv[0]
  if (!subcommand) throw new CliError(`Missing subcommand.\n${USAGE}`, 1)
  const appRoot = options.cwd ? resolve(options.cwd) : process.cwd()
  switch (subcommand) {
    case "prune":
      await runPrune(appRoot, argv.slice(1), io)
      return
    default:
      throw new CliError(`Unknown subcommand: "${subcommand}".\n${USAGE}`, 1)
  }
}

async function runPrune(appRoot: string, args: readonly string[], io: CommandIo): Promise<void> {
  const usage = "Usage: b4 approvals prune [--retention <ms>]"
  let retentionOverride: number | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--retention") {
      const raw = args[++i]
      if (raw === undefined) throw new CliError(`Missing value for --retention.\n${usage}`, 1)
      const parsed = Number(raw)
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_CLIENT_TOOL_TTL_MS) {
        throw new CliError(
          `Invalid --retention value: "${raw}" (expected a positive integer number of milliseconds no greater than ${MAX_CLIENT_TOOL_TTL_MS}).\n${usage}`,
          1,
        )
      }
      retentionOverride = parsed
    } else {
      throw new CliError(`Unknown argument: "${arg}".\n${usage}`, 1)
    }
  }

  // The same validators the boot runs, so a mistyped config or a store
  // missing a method fails here too instead of silently defaulting.
  const approvals = (await loadOptionalB4Config(appRoot))?.approvals
  const configured = validateInterruptGrantStore(approvals?.grantStore)
  const retentionMs = retentionOverride ?? resolveApprovalGrantRetentionMs(approvals?.grantRetentionMs)

  // Grants may have been switched off after rows were written: an existing
  // default file is still opened, as the client tool store resolver does.
  const defaultPath = resolve(appRoot, ".b4/interrupt-grants.sqlite")
  const store =
    configured ??
    (await resolveInterruptGrantStore(appRoot)) ??
    (existsSync(defaultPath) ? createInterruptGrantStore({ path: defaultPath }) : undefined)
  if (!store) {
    writeLine(io.stdout, "no approval grant store for this app; nothing to prune")
    return
  }
  const deleted = await store.prune({ before: new Date(Date.now() - retentionMs).toISOString() })
  writeLine(io.stdout, `pruned: ${deleted}`)
}
```

Check `@b4run/sqlite-storage` is already a dependency of `@b4run/cli` (it is: `execute-route.ts` imports `createInterruptGrantStore` from it; import from the same specifier that file uses).

- [ ] **Step 4:** Register in `packages/cli/src/index.ts`: import `registerApprovalsCommand` from `./commands/approvals.js` and call `registerApprovalsCommand(program, io)` directly after `registerAddCommand(program, io)`.

- [ ] **Step 5:** `pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli exec vitest run test/approvals-command.test.ts test/approvals-command-parsing.test.ts && pnpm --filter @b4run/cli lint` → PASS, 0 errors.

- [ ] **Step 6: Commit** — `feat(cli): b4 approvals prune`.

---

### Task 8: Changeset

Create `.changeset/approval-grant-prune.md`:

```md
---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

Approval grant records are now pruned. Every `InterruptGrantStore` gains `prune({ before })`, which deletes consumed or voided records whose settle time (`voidedAt`, else `consumedAt`) is before `before`. Outstanding grants are never deleted, however old: a parked prompt with no grant row resumes without a grant under `approvals.grants: "optional"`, so an expired grant keeps its row until the thread moves past it. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement it.

`approvals.grantStore` is now shape-checked at boot: a store missing any method, `prune` included, fails the boot naming the missing methods. A custom store written before this release must add `prune`.

The runtime sweeps the store wherever it voids superseded grants, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `approvals.grantRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot). `b4 approvals prune [--retention <ms>]` runs the same pass by hand.
```

`node scripts/check-changesets.mjs` → pass. Commit: `chore: changeset for approval grant pruning`.

---

### Task 9: Docs + check-docs pin

- [ ] `scripts/check-docs.mjs`: add `"approvals.grantRetentionMs",` between `"approvals.grantStore",` and `"approvals.grantTtlMs",` (keep the list sorted; check the order the check prints if it complains).
- [ ] `apps/web/content/docs/configuration.mdx`: in the `approvals?: {` type block add `grantRetentionMs?: number` after `grantTtlMs?: number`. After the paragraph that starts "`grantTtlMs` is omitted by default" add:

```md
`grantRetentionMs` is how long a settled grant record (consumed or voided) is
kept before the runtime deletes it: `604800000` (7 days) by default, a
positive integer of at most one year, anything else fails the boot. The
sweep runs wherever the runtime voids superseded grants, at most once an hour
per store. Outstanding grants are never deleted, however old, because a parked
prompt with no grant row resumes ungated under `"optional"`.
[`b4 approvals prune`](/docs/cli#b4-approvals) runs the same pass by hand. A
`grantStore` you supply is checked at boot and must implement every store
method, `prune` included.
```

- [ ] `apps/web/content/docs/approval-grants.mdx`, end of "## Where consumption is recorded" (before "## Two limitations worth stating plainly"):

```md
Settled rows do not accumulate. Once a grant is consumed, or voided because
the thread moved past its prompt, the runtime deletes the row after
[`approvals.grantRetentionMs`](/docs/configuration#approvals) (7 days by
default), sweeping at most once an hour wherever it voids superseded grants;
`b4 approvals prune` does the same on demand. An outstanding grant is never
deleted, even after `grantTtlMs` has passed: under `"optional"` a parked prompt
with no row resumes without a grant, so deleting it would weaken exactly the
prompt it protects. An expired grant keeps answering `409 grant_expired` until
the thread moves on and the row is voided.
```

- [ ] `apps/web/content/docs/cli.mdx`: line 3 "sixteen commands" → "seventeen commands" and add `approvals` after `add` in the alphabetical list. Insert a new section directly after the `## \`b4 add\`` section (before `## \`b4 docs\``):

````md
## `b4 approvals`

`b4 approvals` manages the records behind
[approval grants](/docs/approval-grants).

```
b4 approvals prune
b4 approvals prune --retention <ms>
```

`prune` deletes settled grant records: grants consumed, or voided because the
thread moved past the prompt, longer ago than the retention window. An
outstanding grant is never deleted, however old. The window is
[`approvals.grantRetentionMs`](/docs/configuration#approvals) (7 days by
default); `--retention <ms>` overrides it for one pass. The runtime runs the
same pass on its own, at most once an hour, so this is for cron or a one-off.
It prints `pruned: <n>`, or says so when the app has no grant store.

Flags:
- `--retention <ms>`: retention window for this pass, a positive integer of at
  most one year.
- `--cwd <path>`: operate on a different app root. Give it before the
  subcommand (`b4 approvals --cwd app prune`), as with `b4 memory`.
````

- [ ] Verify the anchor `#approvals` exists in configuration.mdx (`### \`approvals\`` heading → slug `approvals`). Run `node scripts/check-docs.mjs && pnpm --dir apps/web typecheck`. Commit: `docs: approval grant retention and b4 approvals prune`.
- [ ] Then `pnpm --dir apps/web seo:lastmod`; only `/docs/configuration`, `/docs/approval-grants`, `/docs/cli` change; `pnpm --dir apps/web seo:lastmod:routes` → 0. Commit: `chore(web): regenerate SEO lastmod for approval grant docs`.

---

### Task 10: Full validation

`pnpm build && pnpm lint && pnpm typecheck && pnpm test && node scripts/check-docs.mjs && node scripts/check-changesets.mjs && pnpm --dir apps/web seo:lastmod:routes` → all green. Fix anything red; commit the fix naming the gate.

---

## Self-review against the spec

- §1 store contract → Tasks 1–3. §2 config + shape check → Task 4. §3 sweep → Task 5 (+6 for boot wiring). §4 CLI → Task 7. §5 tests → Tasks 1–7. §6 docs/release → Tasks 8–9.
- Names used consistently: `prune({ before })`, `grantRetentionMs`, `DEFAULT_APPROVAL_GRANT_RETENTION_MS`, `resolveApprovalGrantRetentionMs`, `validateInterruptGrantStore`, `ApprovalGrantConfigError`, `pruneSettledGrants`, `APPROVAL_GRANT_PRUNE_INTERVAL_MS`, `__resetApprovalGrantPruneThrottleForTests`, `resolvePositiveMs(key, value, fallback, fail)`, `runApprovalsCommand`, `registerApprovalsCommand`.
