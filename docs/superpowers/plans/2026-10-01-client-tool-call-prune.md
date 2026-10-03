# Prune Settled Client Tool Call Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `client_tool_calls` table growing forever by adding `prune({ before })` to every `ClientToolCallStore`, sweeping opportunistically at AG-UI turn settle, and shipping `b4 client-tools prune`.

**Architecture:** The store contract gains one deletion method whose predicate lives in SQL (SQLite, Postgres) or a JS filter (SDK memory store). The CLI runtime computes the cutoff from `max(clientToolRetentionMs, clientToolTtlMs)`, calls it from the AG-UI handler at most once an hour per store without ever failing a turn (the `recordEpisode` pattern), and exposes the same cutoff logic through a new `b4 client-tools prune` command that opens the store via the existing `resolveClientToolCallStore`.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), vitest, `node:sqlite`, `pg` via Testcontainers (gated), commander, pnpm workspace, Biome.

**Spec:** `docs/superpowers/specs/2026-10-01-client-tool-call-prune-design.md`

**Conventions that bite here:**
- Node 24 (`nvm use 24`) and run everything from the repo root.
- `src/` imports siblings with `.js`; `test/` imports with `.ts` (except where the existing test file already uses `.js`, follow it).
- Never run bare `biome check --write`; use `pnpm lint` / `pnpm lint:fix`.
- Build before running CLI tests that read `dist/` of sibling packages: `pnpm build` once after Task 1, and again after any `src/` change in `sdk`, `core`, `sqlite-storage` or `postgres-storage`.
- Any docs content change reds `source-validate` until `pnpm --dir apps/web seo:lastmod` is run after the content commit (Task 10).

---

## File map

| File | Responsibility |
|---|---|
| `packages/sdk/src/client-tool-calls.ts` | Contract (add `prune`) + memory store implementation |
| `packages/sqlite-storage/src/client-tool-calls/types.ts` | Structural copy of the contract (add `prune`) |
| `packages/sqlite-storage/src/client-tool-calls/store.ts` | SQLite `DELETE` |
| `packages/postgres-storage/src/client-tool-calls.ts` | Structural copy of the contract + Postgres `DELETE ... RETURNING` |
| `packages/core/src/types.ts` | `server.agui.clientToolRetentionMs` on `B4Config` |
| `packages/cli/src/lib/dev/client-tool-runtime.ts` | `DEFAULT_CLIENT_TOOL_RETENTION_MS`, `resolveClientToolRetentionMs`, `clientToolPruneCutoff`, `pruneClientToolCalls` (throttled sweep), `prune` in `STORE_METHODS`, `retentionMs` on `ClientToolRuntime` |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | Resolve `retentionMs` at boot |
| `packages/cli/src/lib/dev/agui-handler.ts` | Call the sweep after the settle-time void |
| `packages/cli/src/commands/client-tools.ts` | `b4 client-tools prune` |
| `packages/cli/src/index.ts` | Register the command |
| Tests | `packages/sdk/test/client-tool-calls.test.ts`, `packages/sqlite-storage/test/client-tool-calls.test.ts`, `packages/postgres-storage/test/client-tool-calls.test.ts`, `packages/cli/test/agui-client-tools.test.ts`, `packages/cli/test/client-tools-command.test.ts` |
| Docs | `apps/web/content/docs/configuration.mdx`, `apps/web/content/docs/ag-ui.mdx`, `apps/web/content/docs/cli.mdx`, `apps/web/app/seo/lastmod.generated.json` |
| Release | `.changeset/client-tool-call-prune.md` |

---

### Task 1: SDK contract and memory store

**Files:**
- Modify: `packages/sdk/src/client-tool-calls.ts`
- Test: `packages/sdk/test/client-tool-calls.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe("createMemoryClientToolCallStore", ...)` block in `packages/sdk/test/client-tool-calls.test.ts` (the file already defines `call(over)` with `threadId: "t1"`, `toolCallId: "call_1"`, `issuedAt: "2026-09-30T00:00:00.000Z"`, `expiresAt: "2026-09-30T00:10:00.000Z"`):

```ts
  describe("prune", () => {
    const BEFORE = "2026-09-30T12:00:00.000Z"

    it("deletes answered and voided rows settled before the cutoff and keeps later ones", async () => {
      const store = createMemoryClientToolCallStore()
      await store.issue(call({ toolCallId: "old_answered", answeredAt: "2026-09-30T01:00:00.000Z", result: "ok" }))
      await store.issue(call({ toolCallId: "new_answered", answeredAt: "2026-09-30T12:00:00.000Z", result: "ok" }))
      await store.issue(call({ toolCallId: "old_voided", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(call({ toolCallId: "new_voided", voidedAt: "2026-09-30T13:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect((await store.listForThread("t1")).map((row) => row.toolCallId)).toEqual([
        "new_answered",
        "new_voided",
      ])
    })

    it("a void is the settle time: an old answer with a recent void is kept", async () => {
      const store = createMemoryClientToolCallStore()
      await store.issue(
        call({
          toolCallId: "answered_then_voided",
          answeredAt: "2026-09-30T01:00:00.000Z",
          result: "ok",
          voidedAt: "2026-09-30T13:00:00.000Z",
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.get("t1", "answered_then_voided")).toBeDefined()
    })

    it("deletes outstanding rows expired before the cutoff and keeps unexpired or never-expiring ones", async () => {
      const store = createMemoryClientToolCallStore()
      await store.issue(call({ toolCallId: "expired_old", expiresAt: "2026-09-30T00:10:00.000Z" }))
      await store.issue(call({ toolCallId: "expires_at_cutoff", expiresAt: BEFORE }))
      await store.issue(call({ toolCallId: "expires_later", expiresAt: "2026-09-30T13:00:00.000Z" }))
      await store.issue(call({ toolCallId: "never_expires", expiresAt: null }))
      expect(await store.prune({ before: BEFORE })).toBe(1)
      expect((await store.listOutstanding("t1")).map((row) => row.toolCallId)).toEqual([
        "expires_at_cutoff",
        "expires_later",
        "never_expires",
      ])
    })

    it("sweeps every thread and is idempotent", async () => {
      const store = createMemoryClientToolCallStore()
      await store.issue(call({ threadId: "t1", toolCallId: "a", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(call({ threadId: "t2", toolCallId: "b", voidedAt: "2026-09-30T01:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.listForThread("t1")).toEqual([])
      expect(await store.listForThread("t2")).toEqual([])
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/sdk exec vitest run test/client-tool-calls.test.ts`
Expected: FAIL with `store.prune is not a function` (and a TypeScript error if typechecked).

- [ ] **Step 3: Add `prune` to the interface**

In `packages/sdk/src/client-tool-calls.ts`, inside `export interface ClientToolCallStore`, after the `voidOutstanding(...)` member, add:

```ts
  /**
   * Deletes rows that can no longer affect a turn: answered or voided rows
   * whose settle time (`voidedAt`, else `answeredAt`) is before `before`, and
   * outstanding rows whose `expiresAt` is before `before`. Outstanding rows
   * with no expiry, or an expiry at or after `before`, are kept. Returns how
   * many rows were deleted. `before` is an ISO-8601 string compared as text.
   */
  prune(options: { readonly before: string }): Promise<number>
```

- [ ] **Step 4: Implement it in the memory store**

Add, above `createMemoryClientToolCallStore`:

```ts
/** Whether `prune({ before })` may delete this row. Exported for the CLI's tests. */
export function isClientToolCallPrunable(row: ClientToolCallRecord, before: string): boolean {
  if (row.voidedAt !== null) return row.voidedAt < before
  if (row.answeredAt !== null) return row.answeredAt < before
  return row.expiresAt !== null && row.expiresAt < before
}
```

Then add to the returned object in `createMemoryClientToolCallStore`, after `voidOutstanding`:

```ts
    async prune({ before }) {
      let count = 0
      for (const [threadId, rows] of threads) {
        for (const [id, row] of rows) {
          if (!isClientToolCallPrunable(row, before)) continue
          rows.delete(id)
          count += 1
        }
        if (rows.size === 0) threads.delete(threadId)
      }
      return count
    },
```

- [ ] **Step 5: Export the predicate from the SDK index**

In `packages/sdk/src/index.ts`, find the export block from `"./client-tool-calls.js"` (around line 26–30; it already exports `createMemoryClientToolCallStore` and `CLIENT_TOOL_RECORDER_KEY`) and add `isClientToolCallPrunable` to the value exports.

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm --filter @b4run/sdk exec vitest run test/client-tool-calls.test.ts && pnpm --filter @b4run/sdk typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/client-tool-calls.ts packages/sdk/src/index.ts packages/sdk/test/client-tool-calls.test.ts
git commit -m "feat(sdk): ClientToolCallStore.prune deletes settled and expired client tool call records

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: SQLite store

**Files:**
- Modify: `packages/sqlite-storage/src/client-tool-calls/types.ts`
- Modify: `packages/sqlite-storage/src/client-tool-calls/store.ts`
- Test: `packages/sqlite-storage/test/client-tool-calls.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("createClientToolCallStore", ...)` block of `packages/sqlite-storage/test/client-tool-calls.test.ts` (which defines `newStore()` and `call(overrides)` with `threadId: "t-1"`, `toolCallId: "call-1"`, `expiresAt: null`):

```ts
  describe("prune", () => {
    const BEFORE = "2026-09-30T12:00:00.000Z"

    it("deletes answered and voided rows settled before the cutoff and keeps later ones", async () => {
      const store = newStore()
      await store.issue(call({ toolCallId: "old_answered", answeredAt: "2026-09-30T01:00:00.000Z", result: "ok" }))
      await store.issue(call({ toolCallId: "new_answered", answeredAt: BEFORE, result: "ok" }))
      await store.issue(call({ toolCallId: "old_voided", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(call({ toolCallId: "new_voided", voidedAt: "2026-09-30T13:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect((await store.listForThread("t-1")).map((row) => row.toolCallId).sort()).toEqual([
        "new_answered",
        "new_voided",
      ])
    })

    it("a void is the settle time: an old answer with a recent void is kept", async () => {
      const store = newStore()
      await store.issue(
        call({
          toolCallId: "answered_then_voided",
          answeredAt: "2026-09-30T01:00:00.000Z",
          result: "ok",
          voidedAt: "2026-09-30T13:00:00.000Z",
        }),
      )
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.get("t-1", "answered_then_voided")).toBeDefined()
    })

    it("deletes outstanding rows expired before the cutoff and keeps unexpired or never-expiring ones", async () => {
      const store = newStore()
      await store.issue(call({ toolCallId: "expired_old", expiresAt: "2026-09-30T00:10:00.000Z" }))
      await store.issue(call({ toolCallId: "expires_at_cutoff", expiresAt: BEFORE }))
      await store.issue(call({ toolCallId: "expires_later", expiresAt: "2026-09-30T13:00:00.000Z" }))
      await store.issue(call({ toolCallId: "never_expires", expiresAt: null }))
      expect(await store.prune({ before: BEFORE })).toBe(1)
      expect((await store.listOutstanding("t-1")).map((row) => row.toolCallId).sort()).toEqual([
        "expires_at_cutoff",
        "expires_later",
        "never_expires",
      ])
    })

    it("sweeps every thread and is idempotent", async () => {
      const store = newStore()
      await store.issue(call({ threadId: "t-1", toolCallId: "a", voidedAt: "2026-09-30T01:00:00.000Z" }))
      await store.issue(call({ threadId: "t-2", toolCallId: "b", voidedAt: "2026-09-30T01:00:00.000Z" }))
      expect(await store.prune({ before: BEFORE })).toBe(2)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect(await store.listForThread("t-1")).toEqual([])
      expect(await store.listForThread("t-2")).toEqual([])
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/sqlite-storage exec vitest run test/client-tool-calls.test.ts`
Expected: FAIL with `store.prune is not a function`.

- [ ] **Step 3: Add `prune` to the structural contract**

In `packages/sqlite-storage/src/client-tool-calls/types.ts`, inside `export interface ClientToolCallStore`, after `voidOutstanding(...)`, add the same member as Task 1 Step 3:

```ts
  /**
   * Deletes rows that can no longer affect a turn: answered or voided rows
   * whose settle time (`voidedAt`, else `answeredAt`) is before `before`, and
   * outstanding rows whose `expiresAt` is before `before`. Outstanding rows
   * with no expiry, or an expiry at or after `before`, are kept. Returns how
   * many rows were deleted. `before` is an ISO-8601 string compared as text.
   */
  prune(options: { readonly before: string }): Promise<number>
```

- [ ] **Step 4: Implement the DELETE**

In `packages/sqlite-storage/src/client-tool-calls/store.ts`, add to the returned object after `voidOutstanding`:

```ts
    async prune({ before }) {
      // The settle time is voided_at when set, else answered_at; an
      // outstanding row goes only once its expiry is behind the cutoff. All
      // three timestamps are ISO-8601 text, so `<` is chronological.
      return changeCount(
        db
          .prepare(
            `DELETE FROM client_tool_calls
             WHERE (voided_at IS NOT NULL AND voided_at < ?)
                OR (voided_at IS NULL AND answered_at IS NOT NULL AND answered_at < ?)
                OR (voided_at IS NULL AND answered_at IS NULL
                    AND expires_at IS NOT NULL AND expires_at < ?)`,
          )
          .run(before, before, before).changes,
      )
    },
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @b4run/sqlite-storage exec vitest run test/client-tool-calls.test.ts && pnpm --filter @b4run/sqlite-storage typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite-storage/src/client-tool-calls packages/sqlite-storage/test/client-tool-calls.test.ts
git commit -m "feat(sqlite-storage): prune settled and expired client tool call rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Postgres store

**Files:**
- Modify: `packages/postgres-storage/src/client-tool-calls.ts`
- Test: `packages/postgres-storage/test/client-tool-calls.test.ts` (gated: `B4_TEST_PGSTORAGE=1`, Testcontainers `postgres:16`)
- Test: `packages/postgres-storage/test/client-tool-calls-ddl.test.ts` (ungated: statement shape via recording pool)

- [ ] **Step 1: Write the gated behavioural test**

Append inside the `describe.skipIf(!enabled)(...)` block of `packages/postgres-storage/test/client-tool-calls.test.ts` (which defines `withStore(fn)` and `call(over)` with `threadId: "t-1"`, `toolCallId: "c-1"`, `expiresAt: null`):

```ts
  test("prune deletes settled and expired rows before the cutoff and keeps the rest, across threads", async () => {
    await withStore(async (store) => {
      const BEFORE = "2026-09-18T12:00:00.000Z"
      await store.issue(call({ toolCallId: "old_answered", answeredAt: "2026-09-18T10:30:00.000Z", result: "ok" }))
      await store.issue(call({ toolCallId: "new_answered", answeredAt: BEFORE, result: "ok" }))
      await store.issue(call({ toolCallId: "old_voided", voidedAt: "2026-09-18T10:30:00.000Z" }))
      await store.issue(
        call({
          toolCallId: "answered_then_voided",
          answeredAt: "2026-09-18T10:30:00.000Z",
          result: "ok",
          voidedAt: "2026-09-18T13:00:00.000Z",
        }),
      )
      await store.issue(call({ toolCallId: "expired_old", expiresAt: "2026-09-18T10:10:00.000Z" }))
      await store.issue(call({ toolCallId: "expires_at_cutoff", expiresAt: BEFORE }))
      await store.issue(call({ toolCallId: "never_expires", expiresAt: null }))
      await store.issue(call({ threadId: "t-2", toolCallId: "other_thread", voidedAt: "2026-09-18T10:30:00.000Z" }))

      expect(await store.prune({ before: BEFORE })).toBe(4)
      expect(await store.prune({ before: BEFORE })).toBe(0)
      expect((await store.listForThread("t-1")).map((row) => row.toolCallId).sort()).toEqual([
        "answered_then_voided",
        "expires_at_cutoff",
        "never_expires",
        "new_answered",
      ])
      expect(await store.listForThread("t-2")).toEqual([])
    })
  }, 60_000)
```

- [ ] **Step 2: Write the ungated statement-shape test**

Append a new `describe` to `packages/postgres-storage/test/client-tool-calls-ddl.test.ts` (which defines `recordingPool()` returning `{ pool, sql }` and `normalize(sql)`):

```ts
describe("createPostgresClientToolCallStore prune", () => {
  it("is one DELETE whose predicate carries the settle-time and expiry rules", async () => {
    const { pool, sql } = recordingPool()
    const store = createPostgresClientToolCallStore({ pool, assumeMigrated: true })
    expect(await store.prune({ before: "2026-09-18T12:00:00.000Z" })).toBe(0)
    const statement = sql.find((text) => /DELETE FROM/i.test(text))
    expect(statement).toBeDefined()
    expect(normalize(statement ?? "")).toBe(
      "DELETE FROM public.b4_client_tool_calls " +
        'WHERE (voided_at IS NOT NULL AND voided_at COLLATE "C" < $1) ' +
        'OR (voided_at IS NULL AND answered_at IS NOT NULL AND answered_at COLLATE "C" < $1) ' +
        'OR (voided_at IS NULL AND answered_at IS NULL AND expires_at IS NOT NULL AND expires_at COLLATE "C" < $1) ' +
        "RETURNING tool_call_id",
    )
  })
})
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `pnpm --filter @b4run/postgres-storage exec vitest run test/client-tool-calls-ddl.test.ts`
Expected: FAIL with `store.prune is not a function`. (The gated file skips without `B4_TEST_PGSTORAGE=1`; run it under Docker in Step 6 if Docker is available.)

- [ ] **Step 4: Add `prune` to the structural contract**

In `packages/postgres-storage/src/client-tool-calls.ts`, inside `export interface ClientToolCallStore`, after `voidOutstanding(...)`, add the same member as Task 1 Step 3:

```ts
  /**
   * Deletes rows that can no longer affect a turn: answered or voided rows
   * whose settle time (`voidedAt`, else `answeredAt`) is before `before`, and
   * outstanding rows whose `expiresAt` is before `before`. Outstanding rows
   * with no expiry, or an expiry at or after `before`, are kept. Returns how
   * many rows were deleted. `before` is an ISO-8601 string compared as text.
   */
  prune(options: { readonly before: string }): Promise<number>
```

- [ ] **Step 5: Implement the DELETE**

Add to the returned object of `createPostgresClientToolCallStore`, after `voidOutstanding`:

```ts
    async prune({ before }) {
      await ready()
      // The settle time is voided_at when set, else answered_at; an
      // outstanding row goes only once its expiry is behind the cutoff.
      // COLLATE "C" makes the ISO-8601 comparison byte-wise, so it is
      // chronological whatever the database locale. The count comes from
      // RETURNING because `SqlPool` exposes `rows` alone.
      const res = await pool.query<{ tool_call_id: string }>(
        `DELETE FROM ${table}
         WHERE (voided_at IS NOT NULL AND voided_at COLLATE "C" < $1)
            OR (voided_at IS NULL AND answered_at IS NOT NULL AND answered_at COLLATE "C" < $1)
            OR (voided_at IS NULL AND answered_at IS NULL AND expires_at IS NOT NULL AND expires_at COLLATE "C" < $1)
         RETURNING tool_call_id`,
        [before],
      )
      return res.rows.length
    },
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @b4run/postgres-storage exec vitest run test/client-tool-calls-ddl.test.ts && pnpm --filter @b4run/postgres-storage typecheck`
Expected: PASS, typecheck clean.

If Docker is running, also: `B4_TEST_PGSTORAGE=1 pnpm --filter @b4run/postgres-storage exec vitest run test/client-tool-calls.test.ts`
Expected: PASS (first run pulls `postgres:16`). If Docker is unavailable, say so in the task report; CI's `postgres-storage-docker` lane runs it.

- [ ] **Step 7: Commit**

```bash
git add packages/postgres-storage/src/client-tool-calls.ts packages/postgres-storage/test/client-tool-calls.test.ts packages/postgres-storage/test/client-tool-calls-ddl.test.ts
git commit -m "feat(postgres-storage): prune settled and expired client tool call rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Config key, retention resolver, cutoff, store shape check

**Files:**
- Modify: `packages/core/src/types.ts` (around line 281, inside `server.agui`)
- Modify: `packages/cli/src/lib/dev/client-tool-runtime.ts`
- Test: `packages/cli/test/agui-client-tools.test.ts` (the `describe("client tool boot settings and request bounds", ...)` block near line 1440)

- [ ] **Step 0: Rebuild workspace packages**

The CLI tests import `@b4run/sdk` and `@b4run/sqlite-storage` from `dist/`. Run: `pnpm build`
Expected: succeeds.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/agui-client-tools.test.ts`, extend the import from `"../src/lib/dev/client-tool-runtime.ts"` to also import `DEFAULT_CLIENT_TOOL_RETENTION_MS`, `resolveClientToolRetentionMs` and `clientToolPruneCutoff`. Then add to the `describe("client tool boot settings and request bounds", ...)` block:

```ts
  it("clientToolRetentionMs defaults to 7 days, and a mistyped value fails the boot", () => {
    expect(resolveClientToolRetentionMs(undefined)).toBe(DEFAULT_CLIENT_TOOL_RETENTION_MS)
    expect(DEFAULT_CLIENT_TOOL_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(resolveClientToolRetentionMs(1)).toBe(1)
    expect(resolveClientToolRetentionMs(MAX_CLIENT_TOOL_TTL_MS)).toBe(MAX_CLIENT_TOOL_TTL_MS)
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "604800000", null]) {
      expect(() => resolveClientToolRetentionMs(bad)).toThrow(ClientToolConfigError)
    }
    expect(() => resolveClientToolRetentionMs(MAX_CLIENT_TOOL_TTL_MS + 1)).toThrow(
      ClientToolConfigError,
    )
  })

  it("the prune cutoff is now minus the larger of retention and TTL", () => {
    const now = new Date("2026-10-01T12:00:00.000Z")
    expect(clientToolPruneCutoff(now, { ttlMs: 600_000, retentionMs: 3_600_000 })).toBe(
      "2026-10-01T11:00:00.000Z",
    )
    // A TTL longer than the retention wins: a row is never pruned while its call could still live.
    expect(clientToolPruneCutoff(now, { ttlMs: 7_200_000, retentionMs: 3_600_000 })).toBe(
      "2026-10-01T10:00:00.000Z",
    )
  })

  it("a configured store must also implement prune", () => {
    const store = createMemoryClientToolCallStore()
    const { prune: _omitted, ...withoutPrune } = store
    expect(() => validateClientToolStore(withoutPrune)).toThrow(/missing prune/)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/cli exec vitest run test/agui-client-tools.test.ts -t "boot settings"`
Expected: FAIL (`resolveClientToolRetentionMs` is not exported / `missing prune` not thrown).

- [ ] **Step 3: Add the config key to `B4Config`**

In `packages/core/src/types.ts`, directly after the `clientToolTtlMs?: number` member (around line 281), add:

```ts
      /**
       * How long, in milliseconds, a settled client tool call record (answered
       * or voided) or an expired outstanding one is kept before the runtime
       * deletes it. Default `604800000` (7 days). The effective window is never
       * shorter than `clientToolTtlMs`. Must be a positive integer no greater
       * than one year (`31536000000`); anything else fails the boot.
       */
      readonly clientToolRetentionMs?: number
```

- [ ] **Step 4: Add the resolver, cutoff and runtime field**

In `packages/cli/src/lib/dev/client-tool-runtime.ts`:

After the `MAX_CLIENT_TOOL_TTL_MS` constant add:

```ts
/** How long a settled or expired client tool call record is kept by default: 7 days. */
export const DEFAULT_CLIENT_TOOL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
```

Change `ClientToolRuntime` to:

```ts
export interface ClientToolRuntime {
  /** `undefined` when none resolved: client tool runs are then refused with a 503. */
  readonly store?: ClientToolCallStore
  readonly ttlMs: number
  /** `server.agui.clientToolRetentionMs`, resolved. See {@link clientToolPruneCutoff}. */
  readonly retentionMs: number
}
```

Refactor the TTL validator so both settings share it. Replace the body of `resolveClientToolTtlMs` with a call to a shared helper, and add the retention resolver:

```ts
export function resolveClientToolTtlMs(value: unknown): number {
  return resolvePositiveMs("server.agui.clientToolTtlMs", value, DEFAULT_CLIENT_TOOL_TTL_MS)
}

/**
 * `server.agui.clientToolRetentionMs`, validated the same way as the TTL: a
 * mistyped value fails the boot rather than reading as configured.
 */
export function resolveClientToolRetentionMs(value: unknown): number {
  return resolvePositiveMs(
    "server.agui.clientToolRetentionMs",
    value,
    DEFAULT_CLIENT_TOOL_RETENTION_MS,
  )
}

function resolvePositiveMs(key: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_CLIENT_TOOL_TTL_MS
  ) {
    throw new ClientToolConfigError(
      `${key} must be a positive integer number of milliseconds no greater than ${MAX_CLIENT_TOOL_TTL_MS}; received ${describe(value)}.`,
    )
  }
  return value
}

/**
 * The `before` a prune uses at `now`: `now - max(retentionMs, ttlMs)`. The
 * TTL floor means a record is never deleted while the call it belongs to
 * could still be answered.
 */
export function clientToolPruneCutoff(
  now: Date,
  runtime: Pick<ClientToolRuntime, "ttlMs" | "retentionMs">,
): string {
  return new Date(now.getTime() - Math.max(runtime.retentionMs, runtime.ttlMs)).toISOString()
}
```

Keep the existing `resolveClientToolTtlMs` predicate exactly (check the existing function body: it tests `typeof value !== "number"`, `!Number.isSafeInteger(value)`, `value <= 0`, `value > MAX_CLIENT_TOOL_TTL_MS`; copy whatever it has into `resolvePositiveMs` so the existing TTL test keeps passing).

Add `"prune"` to `STORE_METHODS`:

```ts
const STORE_METHODS = [
  "issue",
  "get",
  "listForThread",
  "listOutstanding",
  "answer",
  "voidOutstanding",
  "prune",
] as const
```

- [ ] **Step 5: Fix every `ClientToolRuntime` literal**

Two sites construct one:
- `packages/cli/src/lib/dev/runtime-fetch-core.ts` around line 620–636: add `const clientToolRetentionMs = resolveClientToolRetentionMs(aguiConfig?.clientToolRetentionMs)` after the TTL line, import `resolveClientToolRetentionMs` from `./client-tool-runtime.js` beside `resolveClientToolTtlMs`, and set `retentionMs: clientToolRetentionMs` in the `clientTools` literal.
- `packages/cli/src/lib/dev/agui-handler.ts` line 366: change the default to `clientTools: clientToolRuntime = { ttlMs: DEFAULT_CLIENT_TOOL_TTL_MS, retentionMs: DEFAULT_CLIENT_TOOL_RETENTION_MS }` and add `DEFAULT_CLIENT_TOOL_RETENTION_MS` to the import from `./client-tool-runtime.js`.

Then: `grep -rn "ttlMs:" packages/cli/src packages/cli/test --include='*.ts' | grep -iv grant` and fix any other `ClientToolRuntime` literal the typechecker reports.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @b4run/core build && pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli exec vitest run test/agui-client-tools.test.ts`
Expected: typecheck clean (the new required field surfaces every literal), all tests PASS including the existing TTL test.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/cli/src/lib/dev/client-tool-runtime.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/test/agui-client-tools.test.ts
git commit -m "feat(cli): server.agui.clientToolRetentionMs and the client tool prune cutoff

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Throttled sweep helper

**Files:**
- Modify: `packages/cli/src/lib/dev/client-tool-runtime.ts`
- Test: `packages/cli/test/agui-client-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `pruneClientToolCalls`, `CLIENT_TOOL_PRUNE_INTERVAL_MS` and `__resetClientToolPruneThrottleForTests` to the import from `"../src/lib/dev/client-tool-runtime.ts"`. Add a new describe block:

```ts
describe("pruneClientToolCalls (opportunistic sweep)", () => {
  const runtime = { ttlMs: 600_000, retentionMs: 3_600_000 }
  const settled = (toolCallId: string, voidedAt: string): ClientToolCallRecord => ({
    threadId: "t-sweep",
    toolCallId,
    interruptId: `client-${toolCallId}`,
    toolName: "openPanel",
    runId: "r1",
    routeId: "/park#agent",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    answeredAt: null,
    result: null,
    voidedAt,
  })

  afterEach(() => __resetClientToolPruneThrottleForTests())

  it("deletes rows settled before the cutoff and keeps outstanding ones", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(settled("old", "2026-10-01T00:00:00.000Z"))
    await store.issue({ ...settled("live", "x"), voidedAt: null })
    const now = new Date("2026-10-01T12:00:00.000Z")
    expect(await pruneClientToolCalls(store, runtime, now)).toBe(1)
    expect((await store.listForThread("t-sweep")).map((r) => r.toolCallId)).toEqual(["live"])
  })

  it("runs at most once per interval per store", async () => {
    const store = createMemoryClientToolCallStore()
    let calls = 0
    const counting: ClientToolCallStore = {
      ...store,
      prune: async (options) => {
        calls += 1
        return store.prune(options)
      },
    }
    const t0 = new Date("2026-10-01T12:00:00.000Z")
    expect(await pruneClientToolCalls(counting, runtime, t0)).toBe(0)
    expect(
      await pruneClientToolCalls(counting, runtime, new Date(t0.getTime() + CLIENT_TOOL_PRUNE_INTERVAL_MS - 1)),
    ).toBeUndefined()
    expect(
      await pruneClientToolCalls(counting, runtime, new Date(t0.getTime() + CLIENT_TOOL_PRUNE_INTERVAL_MS)),
    ).toBe(0)
    expect(calls).toBe(2)
  })

  it("never throws: a failing store is warned about and the sweep reports undefined", async () => {
    const store = createMemoryClientToolCallStore()
    const failing: ClientToolCallStore = {
      ...store,
      prune: async () => {
        throw new Error("disk full")
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(pruneClientToolCalls(failing, runtime, new Date())).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not prune client tool calls"), expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })
})
```

Add `vi` and `ClientToolCallRecord` to the imports at the top of the test file (`import { afterEach, describe, expect, it, vi } from "vitest"`; `type ClientToolCallRecord` from `@b4run/sdk`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/cli exec vitest run test/agui-client-tools.test.ts -t "opportunistic sweep"`
Expected: FAIL (`pruneClientToolCalls` not exported).

- [ ] **Step 3: Implement the sweep**

Append to `packages/cli/src/lib/dev/client-tool-runtime.ts`:

```ts
/** Least time between two opportunistic sweeps of the same store: one hour. */
export const CLIENT_TOOL_PRUNE_INTERVAL_MS = 60 * 60 * 1000

/** Last sweep per store (ms since epoch). Per process; a WeakMap so a store is never retained by it. */
let lastSweepAt = new WeakMap<ClientToolCallStore, number>()

/** Test seam: forget every store's last sweep time. */
export function __resetClientToolPruneThrottleForTests(): void {
  lastSweepAt = new WeakMap()
}

/**
 * Opportunistic retention for client tool call records, run by the AG-UI
 * handler once a turn has settled (the `recordEpisode` pattern). Global, not
 * per thread, so threads that never return are swept too. At most once per
 * {@link CLIENT_TOOL_PRUNE_INTERVAL_MS} per store; a call inside the interval
 * returns `undefined` without touching the store. Never throws: a store
 * failure is warned about and the turn is unaffected.
 *
 * Returns the number of rows deleted, or `undefined` when nothing ran.
 */
export async function pruneClientToolCalls(
  store: ClientToolCallStore,
  runtime: Pick<ClientToolRuntime, "ttlMs" | "retentionMs">,
  now: Date,
): Promise<number | undefined> {
  const last = lastSweepAt.get(store)
  if (last !== undefined && now.getTime() - last < CLIENT_TOOL_PRUNE_INTERVAL_MS) return undefined
  lastSweepAt.set(store, now.getTime())
  try {
    return await store.prune({ before: clientToolPruneCutoff(now, runtime) })
  } catch (error) {
    console.warn("B4: could not prune client tool calls.", error)
    return undefined
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli exec vitest run test/agui-client-tools.test.ts -t "opportunistic sweep"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/client-tool-runtime.ts packages/cli/test/agui-client-tools.test.ts
git commit -m "feat(cli): throttled opportunistic prune of client tool call records

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Wire the sweep into the AG-UI handler

**Files:**
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (the `voidClientRecordsIfSettled` closure near line 1148, and the `client-tool-runtime.js` import block near line 48)
- Test: `packages/cli/test/agui-client-tools.test.ts` (the `describe("settling an AG-UI turn", ...)` block near line 1330)

- [ ] **Step 1: Write the failing end-to-end test**

Read the existing test `"a turn that settles without parking leaves no outstanding client tool record"` in `describe("settling an AG-UI turn", ...)` to see how `parkedRun` builds a fixture app with a store and runs a turn (it returns `{ first, store, threadId, ... }`). Add a sibling test in the same block:

```ts
  it("a settled turn sweeps old settled records from every thread", async () => {
    __resetClientToolPruneThrottleForTests()
    const t = await parkedRun([], {
      fixtures: [{ match: { userMessage: "hello" }, response: { content: "Hi." } }],
    })
    expect(t.first.status).toBe(200)
    // An old voided record on an unrelated thread: well past the 7-day default.
    await t.store.issue({
      threadId: "t-abandoned-long-ago",
      toolCallId: "call_old",
      interruptId: "client-call_old",
      toolName: "openPanel",
      runId: "run-old",
      routeId: "/park#agent",
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:10:00.000Z",
      answeredAt: null,
      result: null,
      voidedAt: "2020-01-01T00:10:00.000Z",
    })
    // A fresh outstanding record on the same old thread must survive.
    await t.store.issue({
      threadId: "t-abandoned-long-ago",
      toolCallId: "call_live",
      interruptId: "client-call_live",
      toolName: "openPanel",
      runId: "run-live",
      routeId: "/park#agent",
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      answeredAt: null,
      result: null,
      voidedAt: null,
    })
    __resetClientToolPruneThrottleForTests()
    const second = await t.run("hello")
    expect(second.status).toBe(200)
    expect((await t.store.listForThread("t-abandoned-long-ago")).map((r) => r.toolCallId)).toEqual([
      "call_live",
    ])
  })
```

If `parkedRun`'s return shape has no `run(message)` helper, use whatever the existing settle test uses to send a second turn (read that test and reuse its exact calls; the first turn already settled, so the sweep fires on it only if the throttle is clear, which is why the reset precedes each turn).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/cli exec vitest run test/agui-client-tools.test.ts -t "sweeps old settled records"`
Expected: FAIL: `call_old` still present.

- [ ] **Step 3: Call the sweep after the settle-time void**

In `packages/cli/src/lib/dev/agui-handler.ts`, add `pruneClientToolCalls` to the import from `./client-tool-runtime.js`, then change the closure:

```ts
    const voidClientRecordsIfSettled = async (): Promise<void> => {
      if (!sawInterrupt && clientToolStore) {
        await voidSettledClientToolCalls(clientToolStore, checkpointer, threadId)
        // Opportunistic retention, throttled per store and never allowed to
        // fail the turn (see pruneClientToolCalls).
        await pruneClientToolCalls(clientToolStore, clientToolRuntime, new Date())
      }
    }
```

- [ ] **Step 4: Run the whole file and typecheck**

Run: `pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli exec vitest run test/agui-client-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/agui-handler.ts packages/cli/test/agui-client-tools.test.ts
git commit -m "feat(cli): sweep client tool call records when an AG-UI turn settles

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `b4 client-tools prune` command

**Files:**
- Create: `packages/cli/src/commands/client-tools.ts`
- Modify: `packages/cli/src/index.ts` (imports at lines 24–38, registrations at 68–83)
- Test: `packages/cli/test/client-tools-command.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/client-tools-command.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClientToolCallRecord } from "@b4run/sdk"
import { createClientToolCallStore } from "@b4run/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"
import { runClientToolsCommand } from "../src/commands/client-tools.ts"
import { CliError } from "../src/lib/output.ts"

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function makeApp(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b4-client-tools-cmd-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), '{ "name": "client-tools-temp-app", "type": "module" }\n')
  if (config !== undefined) await writeFile(join(root, "b4.config.ts"), config)
  return root
}

function io() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: { stdout: (m: string) => out.push(m), stderr: (m: string) => err.push(m) },
  }
}

const row = (over: Partial<ClientToolCallRecord>): ClientToolCallRecord => ({
  threadId: "t",
  toolCallId: "c",
  interruptId: "client-c",
  toolName: "openPanel",
  runId: "r",
  routeId: "/chat#agent",
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  answeredAt: null,
  result: null,
  voidedAt: null,
  ...over,
})

async function seededStore(appRoot: string) {
  const path = join(appRoot, ".b4/client-tool-calls.sqlite")
  await mkdir(join(appRoot, ".b4"), { recursive: true })
  const store = createClientToolCallStore({ path })
  // Voided 30 days ago: past the 7-day default, inside a 60-day override.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  await store.issue(row({ toolCallId: "old", voidedAt: thirtyDaysAgo }))
  // Voided just now: kept by every window.
  await store.issue(row({ toolCallId: "recent", voidedAt: new Date().toISOString() }))
  // Outstanding, never expires: kept by every window.
  await store.issue(row({ toolCallId: "live" }))
  return store
}

describe("b4 client-tools prune", () => {
  it("says so and exits cleanly when the app has no client tool store", async () => {
    const appRoot = await makeApp("export default {}\n")
    const { io: cio, out } = io()
    await runClientToolsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toMatch(/no client tool store/)
  })

  it("prunes with the default window and reports the count", async () => {
    const appRoot = await makeApp('export default { server: { agui: { clientTools: ["/chat"] } } }\n')
    const store = await seededStore(appRoot)
    const { io: cio, out } = io()
    await runClientToolsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toBe("pruned: 1")
    expect((await store.listForThread("t")).map((r) => r.toolCallId).sort()).toEqual(["live", "recent"])
  })

  it("honours server.agui.clientToolRetentionMs from the config", async () => {
    const sixtyDays = 60 * 24 * 60 * 60 * 1000
    const appRoot = await makeApp(
      `export default { server: { agui: { clientTools: ["/chat"], clientToolRetentionMs: ${sixtyDays} } } }\n`,
    )
    const store = await seededStore(appRoot)
    const { io: cio, out } = io()
    await runClientToolsCommand(["prune"], { cwd: appRoot }, cio)
    expect(out.join("\n")).toBe("pruned: 0")
    expect((await store.listForThread("t")).length).toBe(3)
  })

  it("--retention <ms> overrides the window for one pass", async () => {
    const appRoot = await makeApp('export default { server: { agui: { clientTools: ["/chat"] } } }\n')
    await seededStore(appRoot)
    const { io: cio, out } = io()
    await runClientToolsCommand(["prune", "--retention", String(60 * 24 * 60 * 60 * 1000)], { cwd: appRoot }, cio)
    expect(out.join("\n")).toBe("pruned: 0")
  })

  it("rejects an invalid --retention, a missing value, an unknown flag and an unknown subcommand", async () => {
    const appRoot = await makeApp('export default { server: { agui: { clientTools: ["/chat"] } } }\n')
    const { io: cio } = io()
    for (const argv of [
      ["prune", "--retention", "0"],
      ["prune", "--retention", "1.5"],
      ["prune", "--retention", "abc"],
      ["prune", "--retention"],
      ["prune", "--bogus"],
      ["sweep"],
      [],
    ]) {
      await expect(runClientToolsCommand(argv, { cwd: appRoot }, cio)).rejects.toBeInstanceOf(CliError)
    }
  })

  it("fails on a mistyped clientToolRetentionMs in the config, like the server boot does", async () => {
    const appRoot = await makeApp(
      'export default { server: { agui: { clientTools: ["/chat"], clientToolRetentionMs: "7d" } } }\n',
    )
    const { io: cio } = io()
    await expect(runClientToolsCommand(["prune"], { cwd: appRoot }, cio)).rejects.toThrow(/clientToolRetentionMs/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/cli exec vitest run test/client-tools-command.test.ts`
Expected: FAIL: cannot resolve `../src/commands/client-tools.ts`.

- [ ] **Step 3: Create the command**

Create `packages/cli/src/commands/client-tools.ts`:

```ts
/**
 * `b4 client-tools prune` — delete settled and expired client tool call
 * records by hand (cacheplane/b4run#880 follow-up). The runtime sweeps the
 * same store opportunistically when an AG-UI turn settles; this is the
 * operator's handle for cron or a one-off.
 *
 * Lives beside `b4 memory prune`, not under `b4 threads`: `threads` talks to
 * a running server by URL, while this opens the app's local store.
 */
import { resolve } from "node:path"
import type { Command } from "commander"
import {
  clientToolPruneCutoff,
  MAX_CLIENT_TOOL_TTL_MS,
  resolveClientToolRetentionMs,
  resolveClientToolTtlMs,
} from "../lib/dev/client-tool-runtime.js"
import { loadOptionalB4Config } from "../lib/node-config.js"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"
import { resolveClientToolCallStore } from "../lib/runtime/execute-route.js"

interface ClientToolsOptions {
  readonly cwd?: string
}

const USAGE = [
  "b4 client-tools <subcommand> [args]",
  "  subcommands: prune [--retention <ms>]",
].join("\n")

export function registerClientToolsCommand(program: Command, io: CommandIo): void {
  program
    .command("client-tools [subcommand] [args...]")
    .description("Manage the records behind client-provided AG-UI tools")
    .option("--cwd <path>", "Path to the B4.run app root")
    // The subcommand owns `--retention`; without this commander would claim it.
    .passThroughOptions()
    .addHelpText("after", `\n${USAGE}`)
    .action(async (subcommand: string | undefined, args: string[], options: ClientToolsOptions) => {
      const argv = subcommand ? [subcommand, ...args] : []
      await runClientToolsCommand(argv, options, io)
    })
}

export async function runClientToolsCommand(
  argv: readonly string[],
  options: ClientToolsOptions,
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
  const usage = "Usage: b4 client-tools prune [--retention <ms>]"
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

  // The same validators the server boot runs, so a mistyped config fails here
  // too instead of silently pruning with the default.
  const agui = (await loadOptionalB4Config(appRoot))?.server?.agui
  const ttlMs = resolveClientToolTtlMs(agui?.clientToolTtlMs)
  const retentionMs = retentionOverride ?? resolveClientToolRetentionMs(agui?.clientToolRetentionMs)

  const store = await resolveClientToolCallStore(appRoot)
  if (!store) {
    writeLine(io.stdout, "no client tool store for this app; nothing to prune")
    return
  }
  const deleted = await store.prune({ before: clientToolPruneCutoff(new Date(), { ttlMs, retentionMs }) })
  writeLine(io.stdout, `pruned: ${deleted}`)
}
```

Check `loadOptionalB4Config`'s return type in `packages/cli/src/lib/node-config.ts` (it returns the config or `undefined` when there is no `b4.config.ts`); adjust the optional chaining if it returns something else. If `ClientToolConfigError` thrown by the resolvers should become a `CliError`, leave it: it is an `Error` with a clear message and the CLI's top-level handler prints it; the test only asserts the message mentions `clientToolRetentionMs`.

- [ ] **Step 4: Register the command**

In `packages/cli/src/index.ts` add `import { registerClientToolsCommand } from "./commands/client-tools.js"` beside the other command imports (alphabetical: after `check`, before `dev`), and `registerClientToolsCommand(program, io)` after `registerCheckCommand(program, io)`.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli exec vitest run test/client-tools-command.test.ts && pnpm lint`
Expected: PASS, clean. If Biome complains about import order, run `pnpm lint:fix` (never bare `biome check --write`).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/client-tools.ts packages/cli/src/index.ts packages/cli/test/client-tools-command.test.ts
git commit -m "feat(cli): b4 client-tools prune

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Changeset

**Files:**
- Create: `.changeset/client-tool-call-prune.md`

- [ ] **Step 1: Write it**

```md
---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

Client tool call records are now pruned. Every `ClientToolCallStore` gains `prune({ before })`, which deletes answered or voided records settled before `before` and outstanding records whose `expiresAt` is before `before`, and keeps every outstanding record that is unexpired or has no expiry. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement it; a store set in `server.agui.clientToolStore` must implement it too, or the boot fails naming the missing method.

The runtime sweeps the store when an AG-UI turn settles, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `server.agui.clientToolRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot), never shorter than `clientToolTtlMs`. `b4 client-tools prune [--retention <ms>]` runs the same pass by hand.
```

- [ ] **Step 2: Verify the changeset check accepts it**

Run: `node scripts/check-changesets.mjs`
Expected: exit 0 (it may need the base branch; if it complains about a missing merge base, note it and move on, CI runs it against `main`).

- [ ] **Step 3: Commit**

```bash
git add .changeset/client-tool-call-prune.md
git commit -m "chore: changeset for client tool call pruning

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Docs

**Files:**
- Modify: `apps/web/content/docs/configuration.mdx` (type block ~line 578–583; prose ~line 650–668)
- Modify: `apps/web/content/docs/ag-ui.mdx` (abandonment bullets ~line 183–189; Storage section ~line 278–287)
- Modify: `apps/web/content/docs/cli.mdx` (new section before `## \`b4 threads\`` at ~line 362)

- [ ] **Step 1: configuration.mdx**

In the `agui?: {` type block add `clientToolRetentionMs?: number` after `clientToolTtlMs?: number`.

After the paragraph ending "A configured store missing any of the store methods fails the boot." add:

```md
Settled records are not kept forever. When an AG-UI turn settles, the runtime
deletes answered or voided records older than `clientToolRetentionMs`, and
outstanding records whose expiry is older than it, at most once an hour per
store. The default is `604800000` (7 days); it must be a positive integer of at
most one year, anything else fails the boot, and the window is never shorter
than `clientToolTtlMs`. A record that is outstanding and unexpired is never
deleted. [`b4 client-tools prune`](/docs/cli#b4-client-tools) runs the same
pass by hand, and a store you supply must implement `prune` as well.
```

- [ ] **Step 2: ag-ui.mdx**

Replace the bullet

```md
- the call has expired. The default lifetime is 10 minutes; set
  `server.agui.clientToolTtlMs` to change it. Expiry is checked when the
  thread is next used, not by a background sweep.
```

with

```md
- the call has expired. The default lifetime is 10 minutes; set
  `server.agui.clientToolTtlMs` to change it. Expiry is checked when the
  thread is next used; no timer abandons a call.
```

At the end of the `### Storage` section (after "A deployment with more than one instance needs a shared store for the same reason.") add:

```md
Records do not accumulate. Once a turn settles, the runtime deletes records
answered, voided or expired longer ago than
[`server.agui.clientToolRetentionMs`](/docs/configuration#serveragui) (7 days
by default, never less than the TTL), at most once an hour per store.
`b4 client-tools prune` does the same on demand. An outstanding, unexpired
record is never deleted.
```

- [ ] **Step 3: cli.mdx**

Insert before `## \`b4 threads\``:

````md
## `b4 client-tools`

`b4 client-tools` manages the records behind
[client-provided tools](/docs/ag-ui#client-provided-tools) on the AG-UI endpoint.

```
b4 client-tools prune
b4 client-tools prune --retention <ms>
```

`prune` deletes records that can no longer affect a turn: answered or voided
calls settled longer ago than the retention window, and outstanding calls
whose expiry is older than it. An outstanding, unexpired call is never
deleted. The window is
[`server.agui.clientToolRetentionMs`](/docs/configuration#serveragui) (7 days
by default) and never shorter than `clientToolTtlMs`; `--retention <ms>`
overrides it for one pass. The runtime runs the same pass on its own when a
turn settles, at most once an hour, so this is for cron or a one-off. It
prints `pruned: <n>`, or says so when the app has no client tool store.

Flags:
- `--retention <ms>`: retention window for this pass, a positive integer of at
  most one year.
- `--cwd <path>`: operate on a different app root.

````

- [ ] **Step 4: Run the docs checks**

Run: `node scripts/check-docs.mjs && pnpm --dir apps/web typecheck`
Expected: clean. (The web suite's lastmod gate is handled in Task 10.)

- [ ] **Step 5: Commit the content**

```bash
git add apps/web/content/docs/configuration.mdx apps/web/content/docs/ag-ui.mdx apps/web/content/docs/cli.mdx
git commit -m "docs: client tool call retention and b4 client-tools prune

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: SEO lastmod manifest

**Files:**
- Modify: `apps/web/app/seo/lastmod.generated.json` (generated)

- [ ] **Step 1: Regenerate after the content commit**

Run: `pnpm --dir apps/web seo:lastmod && git -C . diff --stat apps/web/app/seo/lastmod.generated.json`
Expected: only the `/docs/configuration`, `/docs/ag-ui` and `/docs/cli` entries change.

- [ ] **Step 2: Verify the gate**

Run: `pnpm --dir apps/web seo:lastmod:routes`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod for client tool docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Full local validation

- [ ] **Step 1: Build, lint, typecheck, test**

Run from the repo root: `pnpm build && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green. If `pnpm test` is too slow for the environment, at minimum run the five test files touched plus `pnpm --filter @b4run/cli test`.

- [ ] **Step 2: Docs gates**

Run: `node scripts/check-docs.mjs && pnpm --dir apps/web test`
Expected: clean, including `generate-lastmod.test.ts`.

- [ ] **Step 3: Fix anything red, commit the fix with a message naming the gate it satisfies.**

---

## Self-review against the spec

- Store contract (spec §1): Tasks 1–3, plus `STORE_METHODS` in Task 4.
- Retention config and cutoff (§2): Task 4.
- Opportunistic sweep (§3): Tasks 5–6. The test seam is `__resetClientToolPruneThrottleForTests` plus the exported `pruneClientToolCalls` itself (the spec's `__pruneClientToolCallsForTests` alias is unnecessary because the function lives in a pure module, not the handler).
- CLI verb (§4): Task 7.
- Tests (§5): each store in Tasks 1–3; handler/sweep in Tasks 5–6; config and shape check in Task 4; CLI in Task 7.
- Docs and release (§6): Tasks 8–10.
- Names used consistently: `prune({ before })`, `clientToolRetentionMs`, `DEFAULT_CLIENT_TOOL_RETENTION_MS`, `resolveClientToolRetentionMs`, `clientToolPruneCutoff`, `pruneClientToolCalls`, `CLIENT_TOOL_PRUNE_INTERVAL_MS`, `__resetClientToolPruneThrottleForTests`, `runClientToolsCommand`, `registerClientToolsCommand`, `isClientToolCallPrunable`.
