# Client-Provided Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A route that names itself in `server.agui.clientTools` can receive tools from an AG-UI client, the model can call them, the client executes them, and the result reaches the model in the same conversation. Closes cacheplane/b4run#743.

**Architecture:** Model A over a retained server-side record, per `docs/superpowers/specs/2026-09-18-client-provided-tools-design.md` (PR #744, §12 settled 2026-09-30). Each client tool becomes a per-run stub tool `client_<name>` whose `run` gates on the `clientTool` permission key, records the call, and parks with `interrupt()`. The park is never shown to the client: it sees tool-call frames (under its own name) and a normal `RUN_FINISHED`. On the next AG-UI run, the handler matches `role: "tool"` messages against the record *before* the newest-user-message collapse and resumes the parked tasks internally. The client's message array is never trusted beyond "this string answers this call the server issued and is still waiting on".

**Tech Stack:** TypeScript (NodeNext ESM), pnpm + turbo, vitest, LangGraph `interrupt()` / `Command({ resume })`, langchain `createAgent` (nodes `model_request`, `tools`; one `Send` task per tool call), `node:sqlite`, `pg`.

---

## Two corrections to the spec, applied by this plan

These were found while planning and must be recorded in the spec's §3 table in Task 14.

1. **An already-answered result is history, not a replay.** Spec §3 says a result for an answered call returns `409 client_tool_result_replayed`. An AG-UI client resends its *entire* history on every run, so every turn after the first answered call would carry that tool message again and be rejected. This plan treats an answered (or voided) record's tool message as ordinary resupplied history and ignores it. Replay is still impossible: a park is resumed exactly once, and an answered record is never fed to the graph again.
2. **Abandonment closes the calls in the checkpoint, then runs the new message.** Spec §3 says a new user message voids the call and "resumes it with an error result". But a resume discards the client's input (`toAgentInput`), so the new user message would be lost. Instead, the abandoned calls are closed by writing an error `ToolMessage` for each through the compiled graph's `updateState(..., "tools")`, which clears the park; the new user message then runs as an ordinary turn. `createAgent`'s router computes pending tool calls from the ToolMessages present (`langchain/dist/agents/ReactAgent.js:447`), so closed calls are not re-dispatched. Task 11 verifies this with a spike test before anything relies on it.

## Constants and names used throughout

| Name | Value | Where |
|---|---|---|
| Model-visible prefix | `client_` | `CLIENT_TOOL_PREFIX` in `packages/core/src/capabilities/client-tools.ts` |
| Permission key | `clientTool` | exact-match in `packages/permissions/src/pattern-matching.ts` |
| Interrupt envelope type | `"client-tool-call"` | `CLIENT_TOOL_CALL_TYPE` in core |
| Interrupt id | `client-${toolCallId}` | stable across LangGraph's re-execution of the node |
| Recorder configurable key | `__b4ClientToolRecorder` | `CLIENT_TOOL_RECORDER_KEY` in `@b4run/sdk` |
| Max tools per envelope | 32 | `client_tool_budget_exceeded` |
| Name pattern | `/^[a-zA-Z0-9_-]{1,64}$/`, not starting `client_` | `invalid_client_tool_name` |
| Max description | 1024 chars | `client_tool_too_large` |
| Max `JSON.stringify(parameters)` | 8192 chars | `client_tool_too_large` |
| Max parameters depth | 8 (= `MAX_ZOD_DEPTH`) | `client_tool_too_deep` |
| Max total serialized block | 32768 chars | `client_tool_budget_exceeded` |
| Duplicate name | — | `duplicate_client_tool` |
| Default TTL | 600000 ms (10 min) | `server.agui.clientToolTtlMs` |
| Abandoned-call tool result | `"The client did not return a result for this tool call."` | `ABANDONED_CLIENT_TOOL_RESULT` |

## File map

**New**
- `packages/sdk/src/client-tool-calls.ts`: record/store types, `CLIENT_TOOL_RECORDER_KEY`, `ClientToolRecorder`, `createMemoryClientToolCallStore`.
- `packages/sdk/test/client-tool-calls.test.ts`
- `packages/sqlite-storage/src/client-tool-calls/{index,schema,store,types}.ts`
- `packages/sqlite-storage/test/client-tool-calls.test.ts`
- `packages/postgres-storage/src/client-tool-calls.ts`
- `packages/postgres-storage/test/client-tool-calls-ddl.test.ts`, `client-tool-calls.test.ts`
- `packages/core/src/capabilities/client-tools.ts`: prefix, envelope type, `gateClientToolOp`, `createClientToolStub`.
- `packages/core/test/capabilities/client-tools.test.ts`
- `packages/cli/src/lib/dev/client-tool-definitions.ts`: envelope validation of `tools` into `ClientToolDefinition[]`.
- `packages/cli/test/client-tool-definitions.test.ts`
- `packages/cli/src/lib/dev/client-tool-turn.ts`: split pending parks, match tool messages, and decide none / resume / partial / abandon.
- `packages/cli/test/client-tool-turn.test.ts`
- `packages/cli/src/lib/dev/client-tool-abandon.ts`: close abandoned calls through `updateState`.
- `packages/cli/test/client-tool-abandon.test.ts`
- `packages/cli/test/agui-client-tools.test.ts`: end to end through `createRuntimeFetchHandler` + aimock.
- `.changeset/client-provided-tools.md`

**Modified**
- `packages/sdk/src/index.ts` (exports)
- `packages/sqlite-storage/src/index.ts`, `packages/postgres-storage/src/{index,node,schema}.ts` (exports, migrations)
- `packages/permissions/src/pattern-matching.ts` (`clientTool` exact match)
- `packages/core/src/capabilities/types.ts` (`toolCallId` on the tool run context), `packages/core/src/index.ts` (exports), `packages/core/src/types.ts` (`server.agui.clientToolTtlMs`)
- `packages/langchain/src/tool-converter.ts` (pass `toolCallId` into `run`)
- `packages/cli/src/lib/runtime/execute-route-core.ts` (inject stubs, `client_` reservation, `bypassCache`, widened `RouteResumePayload`)
- `packages/cli/src/lib/runtime/execute-route.ts` (`resolveClientToolCallStore` fallback)
- `packages/cli/src/lib/dev/agui-handler.ts` (validate tools, intercept tool messages, filter park, un-prefix frames, void on settle)
- `packages/cli/src/lib/dev/runtime-fetch-core.ts` (filter client parks from `pending_interrupts`, attach `state`, `/resume`; boot-resolve store; pass TTL)
- `apps/web/content/docs/ag-ui.mdx`, `configuration.mdx`, `permissions.mdx`, `approval-grants.mdx`; `scripts/check-docs.mjs` (`expectedB4ConfigSchemaPaths`); `apps/web/app/seo/lastmod.generated.json`
- `docs/superpowers/specs/2026-09-18-client-provided-tools-design.md` (§3 corrections)

Work on branch `blove/client-provided-tools-impl`. Always run commands from the repo root; run `pnpm build` before any test that imports another package's `dist/`.

---

### Task 1: SDK record types and the in-memory store

**Files:**
- Create: `packages/sdk/src/client-tool-calls.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/client-tool-calls.test.ts`

The store is the single source of truth for "is this call outstanding". Its primary key is `(threadId, toolCallId)`. The provider's tool-call id is stable across LangGraph's re-execution of an interrupted node, so a replayed `issue` must be a no-op rather than an error, unlike `InterruptGrantStore.issue`, which rejects duplicates. The module must stay WebCrypto/edge-safe: no `node:` imports.

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/test/client-tool-calls.test.ts
import { describe, expect, it } from "vitest"
import { type ClientToolCallRecord, createMemoryClientToolCallStore } from "../src/index.ts"

function call(over: Partial<ClientToolCallRecord> = {}): ClientToolCallRecord {
  return {
    threadId: "t1",
    toolCallId: "call_1",
    interruptId: "client-call_1",
    toolName: "openPanel",
    runId: "r1",
    issuedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-09-30T00:10:00.000Z",
    answeredAt: null,
    result: null,
    voidedAt: null,
    ...over,
  }
}

describe("createMemoryClientToolCallStore", () => {
  it("issues once and treats a replayed issue as a no-op", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    await store.issue(call({ runId: "r2" }))
    expect((await store.get("t1", "call_1"))?.runId).toBe("r1")
  })

  it("answers exactly once and keeps the result", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    const first = await store.answer({ threadId: "t1", toolCallId: "call_1", result: "ok", at: "2026-09-30T00:01:00.000Z" })
    expect(first.outcome).toBe("answered")
    const second = await store.answer({ threadId: "t1", toolCallId: "call_1", result: "again", at: "2026-09-30T00:02:00.000Z" })
    expect(second.outcome).toBe("already_answered")
    expect((await store.get("t1", "call_1"))?.result).toBe("ok")
  })

  it("does not answer across threads, or a voided or missing call", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    expect((await store.answer({ threadId: "t2", toolCallId: "call_1", result: "x", at: "2026-09-30T00:01:00.000Z" })).outcome).toBe("missing")
    await store.voidOutstanding({ threadId: "t1", at: "2026-09-30T00:01:00.000Z" })
    expect((await store.answer({ threadId: "t1", toolCallId: "call_1", result: "x", at: "2026-09-30T00:02:00.000Z" })).outcome).toBe("voided")
  })

  it("lists only outstanding calls and voids only those named", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    await store.issue(call({ toolCallId: "call_2", interruptId: "client-call_2" }))
    await store.issue(call({ toolCallId: "call_3", interruptId: "client-call_3" }))
    await store.answer({ threadId: "t1", toolCallId: "call_3", result: "done", at: "2026-09-30T00:01:00.000Z" })
    expect((await store.listOutstanding("t1")).map((r) => r.toolCallId)).toEqual(["call_1", "call_2"])
    expect(await store.voidOutstanding({ threadId: "t1", toolCallIds: ["call_2"], at: "2026-09-30T00:02:00.000Z" })).toBe(1)
    expect((await store.listOutstanding("t1")).map((r) => r.toolCallId)).toEqual(["call_1"])
  })

  it("lists answered-but-unconsumed calls for the resume", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    await store.answer({ threadId: "t1", toolCallId: "call_1", result: "ok", at: "2026-09-30T00:01:00.000Z" })
    expect((await store.listForThread("t1")).map((r) => [r.toolCallId, r.result])).toEqual([["call_1", "ok"]])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @b4run/sdk exec vitest run test/client-tool-calls.test.ts`
Expected: FAIL with an import error (`createMemoryClientToolCallStore` is not exported).

- [ ] **Step 3: Write the implementation**

```ts
// packages/sdk/src/client-tool-calls.ts
/**
 * The retained record behind client-provided tools (cacheplane/b4run#743).
 *
 * A client tool call parks the turn; this record is how the server knows,
 * later, that a `role: "tool"` message answers a call it issued and is still
 * waiting on. It is bookkeeping the client never sees. It carries no
 * credential.
 *
 * Keyed on `(threadId, toolCallId)`. The provider's tool-call id is stable
 * across LangGraph's re-execution of an interrupted tool node, which re-runs
 * the stub and therefore the `issue` call, so a replayed `issue` is a no-op
 * rather than an orphan row.
 *
 * Edge-safe: no Node built-ins, because `@b4run/sdk`'s main entry is loaded
 * by the edge targets.
 */

/** `config.configurable` key the adapter injects the per-run recorder under. */
export const CLIENT_TOOL_RECORDER_KEY = "__b4ClientToolRecorder"

export interface ClientToolCallRecord {
  readonly threadId: string
  /** The provider's tool-call id: what the client echoes back as `toolCallId`. */
  readonly toolCallId: string
  /** The park this call's result answers (`client-${toolCallId}`). */
  readonly interruptId: string
  /** The un-prefixed name the client registered. For auditing. */
  readonly toolName: string
  readonly runId: string
  readonly issuedAt: string
  /** ISO time after which the call is abandoned; `null` means no expiry. */
  readonly expiresAt: string | null
  readonly answeredAt: string | null
  /** The client's result text, set together with `answeredAt`. */
  readonly result: string | null
  readonly voidedAt: string | null
}

export type ClientToolCallAnswer =
  | { readonly outcome: "answered"; readonly record: ClientToolCallRecord }
  | { readonly outcome: "already_answered"; readonly record: ClientToolCallRecord }
  | { readonly outcome: "voided"; readonly record: ClientToolCallRecord }
  | { readonly outcome: "missing" }

export interface ClientToolCallStore {
  /** Idempotent: a row with the same `(threadId, toolCallId)` is left untouched. */
  issue(record: ClientToolCallRecord): Promise<void>
  get(threadId: string, toolCallId: string): Promise<ClientToolCallRecord | undefined>
  /** Every row for the thread, in issue order. */
  listForThread(threadId: string): Promise<readonly ClientToolCallRecord[]>
  /** Rows neither answered nor voided, in issue order. */
  listOutstanding(threadId: string): Promise<readonly ClientToolCallRecord[]>
  /** Single-use: only a row neither answered nor voided can be answered. */
  answer(options: {
    readonly threadId: string
    readonly toolCallId: string
    readonly result: string
    readonly at: string
  }): Promise<ClientToolCallAnswer>
  /**
   * Voids outstanding rows: those named, or all of the thread's when
   * `toolCallIds` is omitted. Answered rows are never voided. Returns the
   * number voided.
   */
  voidOutstanding(options: {
    readonly threadId: string
    readonly toolCallIds?: readonly string[]
    readonly at: string
  }): Promise<number>
}

/**
 * What the stub tool in `@b4run/core` calls to write the record before it
 * parks. Per-run: it closes over the thread and run whose AG-UI endpoint will
 * receive the answer.
 */
export interface ClientToolRecorder {
  record(call: {
    readonly toolCallId: string
    readonly interruptId: string
    readonly toolName: string
  }): Promise<void>
}

function compareIssue(a: ClientToolCallRecord, b: ClientToolCallRecord): number {
  if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? -1 : 1
  return a.toolCallId < b.toolCallId ? -1 : a.toolCallId > b.toolCallId ? 1 : 0
}

/** In-process store for tests and embedders. Not durable. */
export function createMemoryClientToolCallStore(): ClientToolCallStore {
  const rows = new Map<string, ClientToolCallRecord>()
  const key = (threadId: string, toolCallId: string) => `${threadId}\u0000${toolCallId}`
  const forThread = (threadId: string) =>
    [...rows.values()].filter((row) => row.threadId === threadId).sort(compareIssue)
  return {
    async issue(record) {
      const k = key(record.threadId, record.toolCallId)
      if (!rows.has(k)) rows.set(k, { ...record })
    },
    async get(threadId, toolCallId) {
      const row = rows.get(key(threadId, toolCallId))
      return row ? { ...row } : undefined
    },
    async listForThread(threadId) {
      return forThread(threadId).map((row) => ({ ...row }))
    },
    async listOutstanding(threadId) {
      return forThread(threadId)
        .filter((row) => row.answeredAt === null && row.voidedAt === null)
        .map((row) => ({ ...row }))
    },
    async answer({ threadId, toolCallId, result, at }) {
      const k = key(threadId, toolCallId)
      const row = rows.get(k)
      if (!row) return { outcome: "missing" }
      if (row.voidedAt !== null) return { outcome: "voided", record: { ...row } }
      if (row.answeredAt !== null) return { outcome: "already_answered", record: { ...row } }
      const next = { ...row, answeredAt: at, result }
      rows.set(k, next)
      return { outcome: "answered", record: { ...next } }
    },
    async voidOutstanding({ threadId, toolCallIds, at }) {
      const only = toolCallIds === undefined ? undefined : new Set(toolCallIds)
      let count = 0
      for (const [k, row] of rows) {
        if (row.threadId !== threadId || row.answeredAt !== null || row.voidedAt !== null) continue
        if (only && !only.has(row.toolCallId)) continue
        rows.set(k, { ...row, voidedAt: at })
        count += 1
      }
      return count
    },
  }
}
```

Add to `packages/sdk/src/index.ts`, next to the `interrupt-grants.js` exports:

```ts
export type {
  ClientToolCallAnswer,
  ClientToolCallRecord,
  ClientToolCallStore,
  ClientToolRecorder,
} from "./client-tool-calls.js"
export {
  CLIENT_TOOL_RECORDER_KEY,
  createMemoryClientToolCallStore,
} from "./client-tool-calls.js"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @b4run/sdk exec vitest run test/client-tool-calls.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm --filter @b4run/sdk run lint && pnpm --filter @b4run/sdk run typecheck
git add packages/sdk/src/client-tool-calls.ts packages/sdk/src/index.ts packages/sdk/test/client-tool-calls.test.ts
git commit -m "feat(sdk): the client tool call record and an in-memory store"
```

---

### Task 2: SQLite store

**Files:**
- Create: `packages/sqlite-storage/src/client-tool-calls/{types,schema,store,index}.ts`
- Modify: `packages/sqlite-storage/src/index.ts`
- Test: `packages/sqlite-storage/test/client-tool-calls.test.ts`

Mirror `packages/sqlite-storage/src/interrupt-grants/` file for file, using `openDb` (`internal/db.ts`) and `runMigrations` (`internal/migrate.ts`). There are two differences: `issue` uses `INSERT ... ON CONFLICT(thread_id, tool_call_id) DO NOTHING`, and `answer` sets `result` too. As in `interrupt-grants/schema.ts:7-25`: no column defaults, every INSERT names every column, and migration 1 is frozen once shipped.

- [ ] **Step 1: Write the failing test.** Copy `packages/sqlite-storage/test/interrupt-grants.test.ts`'s scaffolding (tmpdir per test, a `record()` factory) and port the five cases from Task 1 against `createClientToolCallStore({ path })`. Add these two:

```ts
it("survives a reopen with the answer intact", async () => {
  const path = join(dir, "client-tool-calls.sqlite")
  const a = createClientToolCallStore({ path })
  await a.issue(call())
  await a.answer({ threadId: "t1", toolCallId: "call_1", result: "ok", at: "2026-09-30T00:01:00.000Z" })
  const b = createClientToolCallStore({ path })
  expect((await b.get("t1", "call_1"))?.result).toBe("ok")
})

it("voids every outstanding call when no ids are named", async () => {
  const store = createClientToolCallStore({ path: join(dir, "c.sqlite") })
  await store.issue(call())
  await store.issue(call({ toolCallId: "call_2", interruptId: "client-call_2" }))
  expect(await store.voidOutstanding({ threadId: "t1", at: "2026-09-30T00:01:00.000Z" })).toBe(2)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @b4run/sqlite-storage exec vitest run test/client-tool-calls.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** `schema.ts`:

```ts
import type { Migration } from "../internal/migrate.js"

/**
 * `client_tool_calls` (cacheplane/b4run#743). Two rules, as for
 * interrupt_grants: a shipped migration is frozen (change the shape by
 * APPENDING a version, never by editing one), and no column default is
 * load-bearing (every INSERT names every column).
 */
export const CLIENT_TOOL_CALLS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE client_tool_calls (
        thread_id    TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        interrupt_id TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        run_id       TEXT NOT NULL,
        issued_at    TEXT NOT NULL,
        expires_at   TEXT,
        answered_at  TEXT,
        result       TEXT,
        voided_at    TEXT,
        PRIMARY KEY (thread_id, tool_call_id)
      );
      CREATE INDEX idx_client_tool_calls_thread ON client_tool_calls(thread_id);
    `,
  },
]
```

`store.ts` SQL. The columns in order are `thread_id, tool_call_id, interrupt_id, tool_name, run_id, issued_at, expires_at, answered_at, result, voided_at`:
- issue: `INSERT INTO client_tool_calls(<10 columns>) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id, tool_call_id) DO NOTHING`
- get: `SELECT <cols> FROM client_tool_calls WHERE thread_id = ? AND tool_call_id = ?`
- listForThread: `... WHERE thread_id = ? ORDER BY issued_at, tool_call_id`
- listOutstanding: `... WHERE thread_id = ? AND answered_at IS NULL AND voided_at IS NULL ORDER BY issued_at, tool_call_id`
- answer: `UPDATE client_tool_calls SET answered_at = ?, result = ? WHERE thread_id = ? AND tool_call_id = ? AND answered_at IS NULL AND voided_at IS NULL`. If `changeCount(info) > 0`, re-read and return `answered`. Otherwise re-read and classify `missing` → `voided` → `already_answered`, voided first, as `interrupt-grants/store.ts:128-149` does.
- voidOutstanding: `UPDATE client_tool_calls SET voided_at = ? WHERE thread_id = ? AND answered_at IS NULL AND voided_at IS NULL`, plus `AND tool_call_id IN (<placeholders>)` when ids are named. If an empty id list is named, return `0` without executing, because an empty `IN ()` is a syntax error.

`types.ts` is a structural copy of the SDK types with the comment "Change one, change the other", as `interrupt-grants/types.ts:10-12` does. `index.ts`:

```ts
import { openDb } from "../internal/db.js"
import { runMigrations } from "../internal/migrate.js"
import { CLIENT_TOOL_CALLS_MIGRATIONS } from "./schema.js"
import { makeClientToolCallStore } from "./store.js"
import type { ClientToolCallStore } from "./types.js"

export interface ClientToolCallStoreOptions {
  readonly path: string
}

export function createClientToolCallStore(options: ClientToolCallStoreOptions): ClientToolCallStore {
  const db = openDb(options.path)
  runMigrations(db, CLIENT_TOOL_CALLS_MIGRATIONS)
  return makeClientToolCallStore(db)
}
```

In `packages/sqlite-storage/src/index.ts`, export `createClientToolCallStore` and `ClientToolCallStoreOptions`, and type-export `ClientToolCallAnswer`, `ClientToolCallRecord` and `ClientToolCallStore`.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @b4run/sqlite-storage exec vitest run test/client-tool-calls.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
pnpm --filter @b4run/sqlite-storage run lint && pnpm --filter @b4run/sqlite-storage run typecheck
git add packages/sqlite-storage
git commit -m "feat(sqlite-storage): the client tool call store"
```

---

### Task 3: Postgres store

**Files:**
- Create: `packages/postgres-storage/src/client-tool-calls.ts`
- Modify: `packages/postgres-storage/src/schema.ts` (append `CLIENT_TOOL_CALLS_MIGRATIONS`), `src/index.ts`, `src/node.ts`
- Test: `packages/postgres-storage/test/client-tool-calls-ddl.test.ts`, `test/client-tool-calls.test.ts`

Mirror `src/interrupt-grants.ts`:
- identifiers go through `assertIdentifier`/`qualify`;
- `ready()` is memoized and runs `runMigrations(pool, CLIENT_TOOL_CALLS_MIGRATIONS, { schema, prefix, component: "client_tool_calls" })`;
- `assumeMigrated` skips migrations;
- in `node.ts`, re-wrap with `poolFor` so an owned pool gets the `'error'` listener.

Differences:
- `issue`: `INSERT ... ON CONFLICT (thread_id, tool_call_id) DO NOTHING`
- `answer`: `UPDATE ... SET answered_at = $1, result = $2 WHERE thread_id = $3 AND tool_call_id = $4 AND answered_at IS NULL AND voided_at IS NULL RETURNING <cols>`. On zero rows, `selectOne` and classify. Up to 3 attempts, as `consume` does at `interrupt-grants.ts:256-287`.
- `voidOutstanding`: `... AND ($3::text[] IS NULL OR tool_call_id = ANY($3::text[])) RETURNING tool_call_id`, passing `null` when no ids are named, and a count of `rows.length`.
- `ORDER BY issued_at COLLATE "C", tool_call_id COLLATE "C"`

- [ ] **Step 1: Write the DDL test.** Copy `test/interrupt-grants-ddl.test.ts`. Pin migration 1 verbatim after whitespace normalization, with the frozen-migration comment, and keep:
  - `not.toMatch(/\bDEFAULT\b/i)` across all versions;
  - the INSERT names all 10 columns with 10 `$n` placeholders;
  - its own component lock and `client_tool_calls_migrations` table;
  - unsafe schema or prefix throws;
  - `assumeMigrated` issues no SQL.

  Pinned migration:

```ts
const EXPECTED_V1 = `CREATE TABLE IF NOT EXISTS public.b4_client_tool_calls ( thread_id text NOT NULL, tool_call_id text NOT NULL, interrupt_id text NOT NULL, tool_name text NOT NULL, run_id text NOT NULL, issued_at text NOT NULL, expires_at text, answered_at text, result text, voided_at text, PRIMARY KEY (thread_id, tool_call_id) ); CREATE INDEX IF NOT EXISTS b4_client_tool_calls_thread_idx ON public.b4_client_tool_calls (thread_id);`
```

- [ ] **Step 2: Write the Testcontainers test.** Copy `test/interrupt-grants.test.ts`'s gate (`B4_TEST_PGSTORAGE === "1"`, `postgres:16`, `freshPrefix()`) and port Task 1's cases. Add: 12 concurrent `answer` calls for one call yield exactly one `answered` and 11 `already_answered`.

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm --filter @b4run/postgres-storage exec vitest run test/client-tool-calls-ddl.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement** as described above, then run:

```bash
pnpm --filter @b4run/postgres-storage exec vitest run test/client-tool-calls-ddl.test.ts
B4_TEST_PGSTORAGE=1 pnpm --filter @b4run/postgres-storage exec vitest run test/client-tool-calls.test.ts
```

Expected: both PASS (the second needs Docker).

- [ ] **Step 5: Commit**

```bash
git add packages/postgres-storage
git commit -m "feat(postgres-storage): the client tool call store"
```

---

### Task 4: The `clientTool` permission key

**Files:**
- Modify: `packages/permissions/src/pattern-matching.ts:9-21`
- Test: `packages/permissions/test/pattern-matching.test.ts` (add cases)

`tool` and `subagent` match exactly; every other key matches by prefix. `clientTool` must match exactly. Otherwise an operator's `allow: clientTool:open` would also allow a caller-named `openEverything`.

- [ ] **Step 1: Write the failing test**

```ts
it("matches clientTool exactly, like tool", () => {
  const perms = { allow: { clientTool: ["open"] }, deny: {} }
  expect(matchPermission(perms, "clientTool", "open")).toBe("allow")
  expect(matchPermission(perms, "clientTool", "openEverything")).toBe("unknown")
})

it("never lets a tool:<name> allow answer for clientTool:<name>", () => {
  const perms = { allow: { tool: ["readFile"] }, deny: {} }
  expect(matchPermission(perms, "clientTool", "readFile")).toBe("unknown")
})
```

(Use the function the existing tests in that file already import. If it isn't `matchPermission`, use its real name.)

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @b4run/permissions exec vitest run test/pattern-matching.test.ts`
Expected: FAIL (`openEverything` matches by prefix).

- [ ] **Step 3: Implement.** In `pattern-matching.ts:20-21`:

```ts
const matches = (pattern: string) =>
  tool === "tool" || tool === "subagent" || tool === "clientTool"
    ? candidate === pattern
    : candidate.startsWith(pattern)
```

and add `clientTool` to the doc comment at :9-11 as an exact-match key, with the reason ("its candidates are caller-authored names").

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/permissions
git commit -m "feat(permissions): clientTool is an exact-match key"
```

---

### Task 5: Pass the provider's tool-call id into a tool's run

**Files:**
- Modify: `packages/core/src/capabilities/types.ts:331-360` (add `toolCallId?: string` to the run context)
- Modify: `packages/langchain/src/tool-converter.ts:22-37` (local context type) and `:83-88` (the `tool.run(...)` call)
- Test: `packages/langchain/test/tool-converter.test.ts` (add a case)

The stub keys its record and its interrupt id on the provider's tool-call id. `extractToolCallId(config)` (`tool-converter.ts:221-233`) already reads it, but only after `run`.

- [ ] **Step 1: Write the failing test**

```ts
it("passes the provider tool-call id into run", async () => {
  let seen: string | undefined
  const tool = convertToolToLangChain({
    name: "probe",
    schema: { type: "object", properties: {} },
    run: async (_input, ctx) => {
      seen = (ctx as { toolCallId?: string }).toolCallId
      return { result: "ok" }
    },
  })
  await tool.invoke({ args: {}, id: "call_abc", name: "probe", type: "tool_call" })
  expect(seen).toBe("call_abc")
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @b4run/langchain exec vitest run test/tool-converter.test.ts -t "provider tool-call id"`
Expected: FAIL (`seen` is `undefined`).

- [ ] **Step 3: Implement.** In `tool-converter.ts`, compute `const toolCallId = extractToolCallId(config)` *before* `tool.run`, and add it to the run context. Respect `exactOptionalPropertyTypes` by spreading it only when it is non-empty:

```ts
const toolCallId = extractToolCallId(config)
const rawResult = await tool.run(input, {
  ...(middlewareContext !== undefined ? { middleware: middlewareContext } : {}),
  signal,
  ...(threadId !== undefined ? { threadId } : {}),
  ...(params !== undefined ? { params } : {}),
  ...(toolCallId !== "" ? { toolCallId } : {}),
})
```

Reuse that same `toolCallId` for the existing post-run uses at :90, rather than calling `extractToolCallId` twice. Add `readonly toolCallId?: string` to the context in `packages/core/src/capabilities/types.ts` and in the local copy at `tool-converter.ts:22-37`, documented as "the provider's id for this call, stable across LangGraph's re-execution of an interrupted tool node".

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: PASS. Then run the full `@b4run/langchain` suite: `pnpm --filter @b4run/langchain run test`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capabilities/types.ts packages/langchain
git commit -m "feat(langchain): a tool's run receives the provider tool-call id"
```

---

### Task 6: The client tool stub and its gate (core)

**Files:**
- Create: `packages/core/src/capabilities/client-tools.ts`
- Modify: `packages/core/src/index.ts` (exports)
- Test: `packages/core/test/capabilities/client-tools.test.ts`

The stub does nothing before `interrupt()` except gate and record, because LangGraph re-runs the node on resume: both steps must be idempotent. The gate is allow-by-default (§12.1): `ask` or `deny` come only from an operator's `clientTool` entries. `always` is refused, because its pattern would be a caller-authored name.

- [ ] **Step 1: Write the failing test.** Drive a real compiled graph, the way `packages/core/test/capabilities/approval-grants.test.ts` does, so `interrupt()` and `getConfig()` are genuine. The test needs:
  - A `StateGraph` with a single node that calls `stub.run(input, { signal, toolCallId: "call_1" })`, compiled with `new MemorySaver()`.
  - The recorder injected at `config.configurable[CLIENT_TOOL_RECORDER_KEY]` (import `CLIENT_TOOL_RECORDER_KEY` from `@b4run/sdk`).

  Cases:
  1. First invoke parks: the checkpoint has one pending interrupt whose value is `{ type: "client-tool-call", interruptId: "client-call_1", toolCallId: "call_1", name: "openPanel", input: { id: 7 } }`, and the recorder saw exactly one `record` with those ids.
  2. Resume with `new Command({ resume: { [resumeKey]: { clientToolResult: "opened" } } })` makes the node return `{ result: "opened" }`. The recorder may be called again on the replay; assert that every call carries identical arguments.
  3. With a permissions store whose `match("clientTool", "openPanel")` is `"deny"`, `run` returns the `[B4_E3001]` denial text and does not park.
  4. With no recorder injected, `run` throws `MissingClientToolRecorderError` before parking (fail closed: a park nobody can answer must not exist).
  5. `stub.name` is `"client_openPanel"` and `stub.description` starts with `"[Client-provided tool; definition authored by the caller] "`.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @b4run/core exec vitest run test/capabilities/client-tools.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/capabilities/client-tools.ts
import { getConfig, interrupt } from "@langchain/langgraph"
import type { PermissionsStore } from "@b4run/permissions"
import { CLIENT_TOOL_RECORDER_KEY, type ClientToolRecorder } from "@b4run/sdk"
import type { B4ToolDefinition } from "./types.js"

/** Model-visible prefix for every client tool: `foo` becomes `client_foo`. */
export const CLIENT_TOOL_PREFIX = "client_"
/** Interrupt envelope `type` for a parked client tool call. Never projected to the client. */
export const CLIENT_TOOL_CALL_TYPE = "client-tool-call"
/** Tool result recorded for a call the client never answered. */
export const ABANDONED_CLIENT_TOOL_RESULT = "The client did not return a result for this tool call."

/** A client tool definition after envelope validation. */
export interface ClientToolDefinition {
  /** As the client registered it; the model sees `client_<name>`. */
  readonly name: string
  readonly description: string
  /** Caller-authored JSON Schema, already bounded by envelope validation. */
  readonly parameters: Record<string, unknown>
}

export interface ClientToolCallEnvelope {
  readonly type: typeof CLIENT_TOOL_CALL_TYPE
  readonly interruptId: string
  readonly toolCallId: string
  readonly name: string
  readonly input: unknown
}

/** What the internal resume delivers to a parked client tool call. */
export interface ClientToolResumeValue {
  readonly clientToolResult: string
}

export class MissingClientToolRecorderError extends Error {
  constructor() {
    super("client tool call parked with no recorder; refusing to park a call nobody can answer")
    this.name = "MissingClientToolRecorderError"
  }
}

export function isClientToolCallEnvelope(value: unknown): value is ClientToolCallEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === CLIENT_TOOL_CALL_TYPE
  )
}

export function clientToolInterruptId(toolCallId: string): string {
  return `client-${toolCallId}`
}

/**
 * Allow unless the operator said otherwise under the `clientTool` key.
 * Deliberately not `gateToolOp`: that matches `tool:<name>`, and a
 * caller-named tool must never inherit an approval granted to the server's
 * own tool of the same name.
 */
export async function gateClientToolOp(
  permissions: PermissionsStore | undefined,
  name: string,
): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }> {
  if (!permissions || permissions.mode === "bypass") return { allowed: true }
  const verdict = permissions.match("clientTool", name)
  if (verdict === "deny") {
    return { allowed: false, reason: `[B4_E3001] Permission denied: client tool ${name}` }
  }
  return { allowed: true }
}

function readRecorder(): ClientToolRecorder | undefined {
  const configurable = (getConfig()?.configurable ?? {}) as Record<string, unknown>
  const recorder = configurable[CLIENT_TOOL_RECORDER_KEY]
  return recorder && typeof (recorder as ClientToolRecorder).record === "function"
    ? (recorder as ClientToolRecorder)
    : undefined
}

/**
 * The stub tool for one client tool. Its body is the park: gate, record,
 * `interrupt()`. LangGraph re-executes it from the top on resume, so nothing
 * before `interrupt()` may have a non-idempotent effect; the record's
 * `(threadId, toolCallId)` key makes the second `record` a no-op.
 */
export function createClientToolStub(
  definition: ClientToolDefinition,
  permissions: PermissionsStore | undefined,
): B4ToolDefinition {
  return {
    name: `${CLIENT_TOOL_PREFIX}${definition.name}`,
    description: `[Client-provided tool; definition authored by the caller] ${definition.description}`,
    schema: definition.parameters,
    async run(input, context) {
      const gate = await gateClientToolOp(permissions, definition.name)
      if (!gate.allowed) return gate.reason
      const toolCallId = context.toolCallId
      if (!toolCallId) throw new Error("client tool call has no provider tool-call id")
      const recorder = readRecorder()
      if (!recorder) throw new MissingClientToolRecorderError()
      const interruptId = clientToolInterruptId(toolCallId)
      await recorder.record({ toolCallId, interruptId, toolName: definition.name })
      const envelope: ClientToolCallEnvelope = {
        type: CLIENT_TOOL_CALL_TYPE,
        interruptId,
        toolCallId,
        name: definition.name,
        input,
      }
      const resumed = interrupt(envelope) as ClientToolResumeValue
      return { result: resumed.clientToolResult }
    },
  }
}
```

Export from `packages/core/src/index.ts`: `CLIENT_TOOL_PREFIX`, `CLIENT_TOOL_CALL_TYPE`, `ABANDONED_CLIENT_TOOL_RESULT`, `createClientToolStub`, `gateClientToolOp`, `isClientToolCallEnvelope`, `clientToolInterruptId`, `MissingClientToolRecorderError`, and the types `ClientToolDefinition`, `ClientToolCallEnvelope`, `ClientToolResumeValue`.

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): the client tool stub parks, gated under clientTool and recorded first"
```

---

### Task 7: Validate client tool definitions from the envelope

**Files:**
- Create: `packages/cli/src/lib/dev/client-tool-definitions.ts`
- Test: `packages/cli/test/client-tool-definitions.test.ts`

This runs only when `validateRunEnvelope` has already accepted a non-empty `tools` for an opted-in route (§10). The bounds cap blast radius and context budget; they are not a security boundary (§4). The docs must say so.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { readClientToolDefinitions } from "../src/lib/dev/client-tool-definitions.ts"

const tool = (over: Record<string, unknown> = {}) => ({
  name: "openPanel",
  description: "Open a panel",
  parameters: { type: "object", properties: { id: { type: "number" } } },
  ...over,
})

describe("readClientToolDefinitions", () => {
  it("accepts well-formed tools", () => {
    const read = readClientToolDefinitions([tool()])
    expect(read.ok && read.tools.map((t) => t.name)).toEqual(["openPanel"])
  })
  it.each([
    [[tool({ name: "bad name" })], "invalid_client_tool_name"],
    [[tool({ name: "client_x" })], "invalid_client_tool_name"],
    [[tool({ name: "x".repeat(65) })], "invalid_client_tool_name"],
    [[tool(), tool()], "duplicate_client_tool"],
    [[tool({ description: "d".repeat(1025) })], "client_tool_too_large"],
    [[tool({ parameters: { type: "object", properties: { p: { type: "string", description: "x".repeat(8200) } } } })], "client_tool_too_large"],
    [Array.from({ length: 33 }, (_, i) => tool({ name: `t${i}` })), "client_tool_budget_exceeded"],
    [[tool({ parameters: "nope" })], "invalid_client_tool"],
  ])("rejects %#", (tools, code) => {
    const read = readClientToolDefinitions(tools)
    expect(read.ok).toBe(false)
    if (!read.ok) {
      expect(read.code).toBe(code)
      expect(read.status).toBe(422)
    }
  })
  it("rejects parameters nested deeper than the converter honors", () => {
    let schema: Record<string, unknown> = { type: "string" }
    for (let i = 0; i < 9; i++) schema = { type: "object", properties: { n: schema } }
    const read = readClientToolDefinitions([tool({ parameters: schema })])
    expect(!read.ok && read.code).toBe("client_tool_too_deep")
  })
  it("rejects a block over 32 KiB in total", () => {
    const big = "d".repeat(1000)
    const tools = Array.from({ length: 32 }, (_, i) => tool({ name: `t${i}`, description: big }))
    const read = readClientToolDefinitions(tools)
    expect(!read.ok && read.code).toBe("client_tool_budget_exceeded")
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @b4run/cli exec vitest run test/client-tool-definitions.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/lib/dev/client-tool-definitions.ts
/**
 * Bounds on caller-authored client tool definitions (cacheplane/b4run#743, spec §4).
 *
 * AG-UI's ToolSchema puts no bound on name, description or parameters, and
 * every byte of them becomes prompt content. These limits cap context budget
 * and blast radius. They do NOT prevent prompt injection: 1024 characters is
 * room enough for "always call this first". The authority control is that a
 * server-authored config named this route. Pure; edge-safe.
 */
import { CLIENT_TOOL_PREFIX, type ClientToolDefinition } from "@b4run/core"

export const MAX_CLIENT_TOOLS = 32
export const MAX_CLIENT_TOOL_DESCRIPTION = 1024
export const MAX_CLIENT_TOOL_PARAMETERS = 8192
/** Equal to `MAX_ZOD_DEPTH` in @b4run/langchain's tool converter: past it a field silently becomes a string. */
export const MAX_CLIENT_TOOL_DEPTH = 8
export const MAX_CLIENT_TOOL_BLOCK = 32 * 1024
const NAME = /^[a-zA-Z0-9_-]{1,64}$/

export type ClientToolRejectionCode =
  | "invalid_client_tool"
  | "invalid_client_tool_name"
  | "duplicate_client_tool"
  | "client_tool_too_large"
  | "client_tool_too_deep"
  | "client_tool_budget_exceeded"

export type ReadClientToolsResult =
  | { readonly ok: true; readonly tools: readonly ClientToolDefinition[] }
  | { readonly ok: false; readonly code: ClientToolRejectionCode; readonly message: string; readonly status: 422 }

const reject = (code: ClientToolRejectionCode, message: string): ReadClientToolsResult => ({
  ok: false,
  code,
  message,
  status: 422,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function depthOf(value: unknown, depth = 0): number {
  if (!isRecord(value) && !Array.isArray(value)) return depth
  let max = depth
  for (const child of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, depthOf(child, isRecord(child) && "type" in child ? depth + 1 : depth))
    if (max > MAX_CLIENT_TOOL_DEPTH + 1) return max
  }
  return max
}

export function readClientToolDefinitions(tools: unknown): ReadClientToolsResult {
  if (!Array.isArray(tools)) return reject("invalid_client_tool", "`tools` must be an array")
  if (tools.length > MAX_CLIENT_TOOLS)
    return reject("client_tool_budget_exceeded", `at most ${MAX_CLIENT_TOOLS} client tools per run`)
  const seen = new Set<string>()
  const out: ClientToolDefinition[] = []
  let block = 0
  for (const raw of tools) {
    if (!isRecord(raw) || typeof raw.name !== "string")
      return reject("invalid_client_tool", "each client tool needs a string `name`")
    const { name } = raw
    if (!NAME.test(name) || name.startsWith(CLIENT_TOOL_PREFIX))
      return reject("invalid_client_tool_name", `client tool name must match ${NAME} and not start with ${CLIENT_TOOL_PREFIX}`)
    if (seen.has(name)) return reject("duplicate_client_tool", `client tool "${name}" is listed twice`)
    seen.add(name)
    const description = raw.description === undefined ? "" : raw.description
    if (typeof description !== "string") return reject("invalid_client_tool", `client tool "${name}" description must be a string`)
    if (description.length > MAX_CLIENT_TOOL_DESCRIPTION)
      return reject("client_tool_too_large", `client tool "${name}" description exceeds ${MAX_CLIENT_TOOL_DESCRIPTION} characters`)
    const parameters = raw.parameters === undefined ? { type: "object", properties: {} } : raw.parameters
    if (!isRecord(parameters)) return reject("invalid_client_tool", `client tool "${name}" parameters must be a JSON Schema object`)
    const serialized = JSON.stringify(parameters)
    if (serialized.length > MAX_CLIENT_TOOL_PARAMETERS)
      return reject("client_tool_too_large", `client tool "${name}" parameters exceed ${MAX_CLIENT_TOOL_PARAMETERS} characters`)
    if (depthOf(parameters) > MAX_CLIENT_TOOL_DEPTH)
      return reject("client_tool_too_deep", `client tool "${name}" parameters nest deeper than ${MAX_CLIENT_TOOL_DEPTH}`)
    block += name.length + description.length + serialized.length
    if (block > MAX_CLIENT_TOOL_BLOCK)
      return reject("client_tool_budget_exceeded", `client tool definitions exceed ${MAX_CLIENT_TOOL_BLOCK} characters in total`)
    out.push({ name, description, parameters })
  }
  return { ok: true, tools: out }
}
```

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: PASS. If the depth case disagrees at exactly 8 or 9 levels, fix `depthOf` so that the test's 9 nested `object` levels are rejected and 8 are accepted. Add an 8-level acceptance case to pin the boundary.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/client-tool-definitions.ts packages/cli/test/client-tool-definitions.test.ts
git commit -m "feat(cli): bound caller-authored client tool definitions"
```

---

### Task 8: Inject the stubs into the route, and reserve the prefix

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts`
- Test: `packages/cli/test/client-tools-route-prep.test.ts` (new)

Four changes, at the anchors reported for this plan:
- `PrepareRouteExecutionOptions` (:395-414) gains `readonly clientTools?: readonly ClientToolDefinition[]`.
- After scoping (:1447-1465) and before the workspace re-wrap (:1568), append `options.clientTools.map((d) => ({ ...createClientToolStub(d, permissionsStore), filePath: \`<client:${d.name}>\`, scope: "route-local" as const }))`, and set `bypassCache = true` whenever `clientTools` is non-empty. Tools are not part of the graph cache key, so without this request N+1 gets request N's tools.
- Next to the `RESERVED_TOOL_NAMES` check (:1412-1424): any authored or capability tool whose name starts with `CLIENT_TOOL_PREFIX` is a route-prep failure, `Reserved tool name prefix: "client_" is reserved for client-provided tools (tool "<name>").`
- `streamResolvedRoute` (:503) gains `clientTools?` and `clientToolRecorder?: ClientToolRecorder`, forwarded to preparation and into the adapter config. In `packages/langchain/src/agent-adapter.ts` `prepareAgentCall` (:1277-1317), set `configurable[CLIENT_TOOL_RECORDER_KEY] = options.clientToolRecorder` *after* route params, exactly as the approval-grant minter is set, so a route param can never shadow it. Add `clientToolRecorder?: ClientToolRecorder` to `AgentOptions` (:1088-1160) next to `approvalGrantMinter`.
- `RouteResumePayload` (:328) widens to `Readonly<Record<string, "once" | "always" | "deny" | ClientToolResumeValue>>`. This is internal; `isB4ResumeBody` at the HTTP boundary does not change.

- [ ] **Step 1: Write the failing test.** Using the fixture-app helpers other runtime tests use (`mkdtemp` app with `src/app/park/index.ts` = `agent({ model: "gpt-5-mini", systemPrompt: "t" })`), call `prepareRouteExecution({ ..., clientTools: [{ name: "openPanel", description: "Open", parameters: { type: "object", properties: {} } }] })` and assert:
  1. the prepared tools include `client_openPanel`, and `bypassCache` is `true`;
  2. with an authored tool file `src/app/park/tools/client_x.ts`, preparation fails with a message containing `Reserved tool name prefix`;
  3. without `clientTools`, no `client_*` tool is present and `bypassCache` is not set by this code path.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm build && pnpm --filter @b4run/cli exec vitest run test/client-tools-route-prep.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the changes above.

- [ ] **Step 4: Run it and see it pass**, then run the whole CLI suite to catch widening fallout: `pnpm --filter @b4run/cli run typecheck && pnpm --filter @b4run/cli run test`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli packages/langchain
git commit -m "feat(cli): inject client tool stubs per run, and reserve the client_ prefix"
```

---

### Task 9: Keep the park invisible, and show the client its own tool names

**Files:**
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (`normalizeB4Stream` :162-214)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (`pending_interrupts` listing :3453-3471; durable attach `state` :3661-3678; `/resume` resolution :3853-3872)
- Test: `packages/cli/test/client-tool-park-visibility.test.ts` (new)

- **AG-UI stream.** `observeInterrupts` (:132-140) must still see the `interrupt` chunk so the turn records as parked. `normalizeB4Stream` must drop a client-tool-call interrupt, so `toAguiEvents` sees no pending interrupt and ends with an ordinary `RUN_FINISHED`. It must also rewrite `client_<name>` to `<name>` on `tool_call`, `tool_call_args` and `tool_result` chunks for this run's client tools only, because CopilotKit dispatches frontend tools by name. Give `normalizeB4Stream` a second parameter `clientToolNames: ReadonlySet<string>` (the un-prefixed names), and add these branches:

```ts
// in the default branch, before yielding:
if (chunk.type === "interrupt" && isClientToolCallEnvelope((chunk as { data?: unknown }).data)) break
```

```ts
// helper
const clientName = (name: string) =>
  name.startsWith(CLIENT_TOOL_PREFIX) && clientToolNames.has(name.slice(CLIENT_TOOL_PREFIX.length))
    ? name.slice(CLIENT_TOOL_PREFIX.length)
    : name
```

  Apply `clientName(...)` to `name` in the `tool_call` and `tool_result` cases. For `tool_call_args`, whose chunk carries `name` in `data` (see `packages/ag-ui/src/outbound.ts` and the #781 adapter), rewrite `data.name` the same way inside a new explicit `case "tool_call_args"`.
- **Pending interrupts and attach.** Filter out entries whose `value` satisfies `isClientToolCallEnvelope` in both places.
- **`/threads/:id/resume`.** Before `resolvePendingResume`, remove client-tool-call entries from `pending.interrupts`. If nothing is left, the existing `409 stale_interrupt` applies, so a client tool call can never be answered through the approval endpoint.

- [ ] **Step 1: Write the failing test.** Unit-test `normalizeB4Stream` by exporting it for tests (`export { normalizeB4Stream as __normalizeB4StreamForTests }`), feeding it:

```ts
[
  { type: "tool_call", id: "call_1", name: "client_openPanel", input: { id: 7 } },
  { type: "interrupt", data: { type: "client-tool-call", interruptId: "client-call_1", toolCallId: "call_1", name: "openPanel", input: { id: 7 } } },
  { type: "done", output: {} },
]
```

  with `clientToolNames = new Set(["openPanel"])`. Assert the output has a `tool_call` named `openPanel`, no `interrupt`, and a `done`. Add a second case where `client_other` is not in the set and keeps its name. For the endpoints, write the permission-park fixture exactly as `packages/cli/test/pending-interrupts-endpoint.test.ts` does, but with a checkpointer stub whose `getTuple` returns one `__interrupt__` pending write with a `client-tool-call` value (the `approval-grants-endpoint.test.ts:309-331` pattern). Assert that `GET /threads/:id/pending_interrupts` lists nothing, and `POST /threads/:id/resume` with `{ resume: [{ interruptId: "client-call_1", status: "resolved", payload: "once" }], route: "/noop#graph" }` returns `409` with `code: "stale_interrupt"`.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @b4run/cli exec vitest run test/client-tool-park-visibility.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as described.

- [ ] **Step 4: Run it and see it pass**, plus `test/pending-interrupts-endpoint.test.ts` and `test/agui-*.test.ts` for regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): client tool parks stay invisible, and frames carry the client's tool name"
```

---

### Task 10: Match tool messages against the record (pure decision)

**Files:**
- Create: `packages/cli/src/lib/dev/client-tool-turn.ts`
- Test: `packages/cli/test/client-tool-turn.test.ts`

A pure function over the pending snapshot, the store and the envelope's messages. It decides what the AG-UI handler does. It never trusts a `toolCallId` that is not an outstanding record on this thread.

Decision rules:
1. Split `pending.interrupts` into client parks (value is a client-tool-call envelope) and others.
2. No client parks: `{ mode: "none" }`.
3. Load `listOutstanding(threadId)`. Any outstanding record whose `expiresAt <= now` is **expired**.
4. For each `role: "tool"` message in the envelope whose `toolCallId` names an outstanding, unexpired record: `answer(...)`. `already_answered`, `voided` or `missing` outcomes are history and are ignored (correction 1).
5. Re-list. If every client park's record is answered (`answeredAt !== null` and `voidedAt === null`), return `{ mode: "resume", resume: { [resumeKey]: { clientToolResult: result } }, others }`. The handler must still resolve `others` (permission parks in the same superstep) with the envelope's `resume`, and merge the two maps.
6. Otherwise, if the envelope's **last** message is `role: "user"`, or any outstanding record is expired: `{ mode: "abandon", toolCallIds: <every unanswered client park's toolCallId>, answered: <answered ones> }` (correction 2).
7. Otherwise (some answered this run, some still outstanding, last message is a tool message): `{ mode: "partial" }`. The handler finishes the run immediately without touching the graph.

- [ ] **Step 1: Write the failing test.** Using `createMemoryClientToolCallStore` from `@b4run/sdk` and hand-built snapshots (`{ interrupts: [{ interruptId: "client-call_1", resumeKey: "a".repeat(32), aliases: [], value: { type: "client-tool-call", interruptId: "client-call_1", toolCallId: "call_1", name: "openPanel", input: {} } }], malformed: false }`), cover:
  - no client parks → `none`;
  - one park and a matching tool message → `resume` with `{ ["a".repeat(32)]: { clientToolResult: "opened" } }`, and the record is answered;
  - the same envelope sent again after the resume (record answered, park gone) → `none`, and no error: history is ignored;
  - two parks, one answered by a tool message that is the envelope's last message → `partial`; a second envelope answering the other → `resume` carrying both results;
  - a tool message whose `toolCallId` belongs to another thread → ignored, and a last-message user → `abandon`;
  - an expired outstanding record with a tool message answering it → `abandon` (the late result is not trusted);
  - a permission park alongside a client park, client answered → `resume` with the permission park in `others`.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @b4run/cli exec vitest run test/client-tool-turn.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `resolveClientToolTurn(options: { store: ClientToolCallStore; threadId: string; pending: PendingInterruptSnapshot; messages: readonly B4Message[]; now: Date })` returning:

```ts
export type ClientToolTurn =
  | { readonly mode: "none" }
  | { readonly mode: "partial" }
  | {
      readonly mode: "resume"
      readonly resume: Readonly<Record<string, ClientToolResumeValue>>
      readonly others: readonly PendingInterrupt[]
    }
  | {
      readonly mode: "abandon"
      readonly abandonedToolCallIds: readonly string[]
      readonly answered: Readonly<Record<string, string>>
    }
```

  following the rules above. Key the resume map by each park's `resumeKey`. A client park whose `resumeKey` is `null` is malformed: return `{ mode: "abandon", ... }` for it rather than resuming. The record's `answeredAt` is written with `now.toISOString()`.

- [ ] **Step 4: Run it and see it pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/client-tool-turn.ts packages/cli/test/client-tool-turn.test.ts
git commit -m "feat(cli): match client tool results against the retained record"
```

---

### Task 11: Close abandoned calls in the checkpoint (spike first)

**Files:**
- Create: `packages/cli/src/lib/dev/client-tool-abandon.ts`
- Test: `packages/cli/test/client-tool-abandon.test.ts`

- [ ] **Step 1: Write the spike test first. It decides whether correction 2 holds.** Build a real agent route graph through `materializeResolvedRouteGraph` (exported from `@b4run/cli/runtime`) for a fixture `agent()` route with one client tool, with aimock scripting `callsTool("client_openPanel", { id: 7 })` and then `.replies("Sorry, that did not work.")`. Stream the first turn until it parks. Then:

```ts
await graph.updateState(
  { configurable: { thread_id: threadId } },
  { messages: [new ToolMessage({ content: ABANDONED_CLIENT_TOOL_RESULT, tool_call_id: toolCallId, name: "client_openPanel" })] },
  "tools",
)
const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: "" } })
```

  Assert:
  - `parsePendingInterrupts(tuple).interrupts` is empty;
  - a following ordinary turn with a new user message runs, and the model request it sends contains the `ToolMessage` with `ABANDONED_CLIENT_TOOL_RESULT` followed by the new user message.

  If the park is still pending after `updateState`, stop and report back. The fallback is to resume the parks with `{ clientToolResult: ABANDONED_CLIENT_TOOL_RESULT }` (letting the model answer the failed call), then run the new user message as a second turn in the same request. That changes Task 12 and needs a decision.

- [ ] **Step 2: Run the spike.**

Run: `pnpm build && pnpm --filter @b4run/cli exec vitest run test/client-tool-abandon.test.ts`
Expected before implementation: FAIL (module not found). Once `closeAbandonedClientToolCalls` exists, the park-cleared assertion is the one that proves the approach.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/lib/dev/client-tool-abandon.ts
import { ABANDONED_CLIENT_TOOL_RESULT, CLIENT_TOOL_PREFIX } from "@b4run/core"
import { ToolMessage } from "@langchain/core/messages"

interface UpdatableGraph {
  updateState(config: unknown, values: unknown, asNode?: string): Promise<unknown>
}

/**
 * Closes parked client tool calls the client will never answer by recording
 * an error result for each, as if the `tools` node had run. createAgent
 * computes pending tool calls from the ToolMessages present, so a closed call
 * is not re-dispatched, and the thread is free for an ordinary turn. A resume
 * would discard the new user message instead (spec §3, correction 2).
 */
export async function closeAbandonedClientToolCalls(options: {
  readonly graph: UpdatableGraph
  readonly threadId: string
  readonly calls: ReadonlyArray<{ readonly toolCallId: string; readonly toolName: string }>
  readonly answered: Readonly<Record<string, string>>
}): Promise<void> {
  const messages = options.calls.map(
    (call) =>
      new ToolMessage({
        content: options.answered[call.toolCallId] ?? ABANDONED_CLIENT_TOOL_RESULT,
        tool_call_id: call.toolCallId,
        name: `${CLIENT_TOOL_PREFIX}${call.toolName}`,
      }),
  )
  await options.graph.updateState({ configurable: { thread_id: options.threadId } }, { messages }, "tools")
}
```

  A call answered before abandonment keeps its real result: `answered` carries it, so a partially answered batch closes with the results the client did send.

- [ ] **Step 4: Run the spike and see it pass.**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/dev/client-tool-abandon.ts packages/cli/test/client-tool-abandon.test.ts
git commit -m "feat(cli): close abandoned client tool calls in the checkpoint"
```

---

### Task 12: Wire it into the AG-UI handler

**Files:**
- Modify: `packages/cli/src/lib/dev/agui-handler.ts`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (boot-resolve the store; pass it and the TTL into the handler)
- Modify: `packages/cli/src/lib/runtime/execute-route.ts` (a `resolveClientToolCallStore` node fallback, next to `resolveInterruptGrantStore` at :293-307, defaulting to `createClientToolCallStore({ path: pureJoin(appRoot, ".b4/client-tool-calls.sqlite") })`; register it in `nodeBootFallbacks` :376-398, and make it optional on `RuntimeBootFallbacks` at `execute-route-core.ts:163-176`)
- Modify: `packages/core/src/types.ts` (`server.agui.clientToolTtlMs?: number`; `server.agui.clientToolStore?: ClientToolCallStore`)
- Test: `packages/cli/test/agui-client-tools.test.ts`

In `handleAgUiFetchRequest` (line numbers from the plan's research, verify before editing):
1. **After `validateRunEnvelope` (:304-317):** when `policy.clientTools` and `tools` is non-empty, `readClientToolDefinitions(parsedJson.tools)`. On rejection, return `422` with `{ code }` and `B4_E5401`, the same shape as the envelope rejection. Keep `clientTools` for later.
2. **When client tools are in play but no store is resolved:** return `503`, `client_tool_store_unavailable`. Never park a call nobody can answer.
3. **After `resolvePendingResume` is computed (:445-453):** run `resolveClientToolTurn` first, then act on its mode:
   - `none`: the existing path, unchanged.
   - `partial`: respond with an AG-UI stream of `RUN_STARTED` + `RUN_FINISHED` built from `toAguiEvents` over a one-chunk iterable `[{ type: "done", data: null }]`. Don't touch the graph; release claims as the other early returns do.
   - `resume`: re-run `resolvePendingResume(b4Input.resume, { interrupts: others, malformed: false })` for the non-client parks. If it fails, return its error. If it succeeds, the effective `resume` passed to `streamRoute` is `{ ...othersResume, ...clientResume }`.
   - `abandon`: materialize the route graph (the same helper `/threads/:id/state` uses: `materializeResolvedRouteGraph` with this request's `clientTools`), call `closeAbandonedClientToolCalls`, then `store.voidOutstanding({ threadId, toolCallIds: abandonedToolCallIds, at })`, re-read the pending snapshot, and continue as an ordinary turn with the newest user message.
4. **The `resuming` flag (:345) used by the thread-access gate:** a request that will resume a client park is a resume. Compute `resuming = b4Input.resume !== undefined || lastMessageIsTool`, where `lastMessageIsTool` is whether the envelope's last message is `role: "tool"`. That makes the claim at :426-436 apply.
5. **Pass into `streamRoute` (:600-628):** `clientTools` and `clientToolRecorder`, a per-request recorder that calls `store.issue({ threadId, toolCallId, interruptId, toolName, runId: input.runId, issuedAt: now, expiresAt: now + ttl, answeredAt: null, result: null, voidedAt: null })`. Pass `new Set(clientTools.map((t) => t.name))` into `normalizeB4Stream`.
6. **Settle (:683-691):** pass `voidGrants` too, fixing the gap the research found. Also, when the turn settles without parking, `store.voidOutstanding({ threadId, at })`: nothing is outstanding once the graph has moved on.

- [ ] **Step 1: Write the end-to-end test.** Use `createRuntimeFetchHandler` + aimock, as `pending-interrupts-endpoint.test.ts` does. The fixture app's `b4.config.ts` is `export default { server: { agui: { clientTools: ["/park"] } } }`, the route is `agent({ model: "gpt-5-mini", systemPrompt: "t" })`, and there are no authored tools. Send AG-UI requests to `/agui/${encodeURIComponent("/park#agent")}` with `tools: [{ name: "openPanel", description: "Open a panel", parameters: { type: "object", properties: { id: { type: "number" } } } }]`. Cases:
  1. **Round trip.**
     - aimock: `user("open panel 7").callsTool("client_openPanel", { id: 7 })` then `.replies("Opened.")`.
     - Run 1's SSE contains `TOOL_CALL_START` with `toolCallName: "openPanel"`, no interrupt outcome, and `RUN_FINISHED`.
     - Run 2 sends the history plus `{ role: "tool", id: "m3", toolCallId: <the id from run 1>, content: "panel opened" }`. The model's second request (aimock journal) contains a tool message with `"panel opened"`, and the SSE ends with text `Opened.`.
  2. **History is not a replay.** Run 3 resends everything from run 2 plus a new user message. It streams normally, not a 409.
  3. **Parallel calls, answered in two envelopes.** Two calls in one model turn. The first envelope answers one (last message is a tool message): `RUN_FINISHED` with no model call. The second answers the other: the model receives both results.
  4. **Abandonment.** After run 1, send a new user message without a result. The next model request contains `ABANDONED_CLIENT_TOOL_RESULT` for the call and then the new user message.
  5. **Not opted in.** The same `tools` sent to a route not in `clientTools` gets `422 client_tools_not_allowed` (#740, unchanged).
  6. **Bad definition.** `name: "client_x"` gets `422 invalid_client_tool_name`.
  7. **Operator deny.** `permissions: { deny: { clientTool: ["openPanel"] } }` in config: the call is not parked. The tool result is the `[B4_E3001]` text, and the model's next request carries it.
  8. **Forgery ignored.** A tool message whose `toolCallId` was never issued, sent as the last message on a thread with nothing parked, is ignored: the run proceeds as an ordinary turn, and the model request contains no tool message for it.
- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm build && pnpm --filter @b4run/cli exec vitest run test/agui-client-tools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the handler, fallback, config and boot changes.

- [ ] **Step 4: Run it and see it pass**, then run the full CLI suite and the AG-UI conformance tests:

```bash
pnpm --filter @b4run/cli run test && pnpm --filter @b4run/ag-ui run test
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli packages/core
git commit -m "feat(cli): client-provided tools over AG-UI, answered through the retained record"
```

---

### Task 13: Mutation checks for the security properties

**Files:** none new. This task checks that the tests bind.

For each change below: make it, run `pnpm --filter @b4run/cli exec vitest run test/agui-client-tools.test.ts test/client-tool-turn.test.ts`, confirm at least one test FAILS, then revert it (`git checkout -- <file>`). Record the results in the PR description.

- [ ] In `client-tool-turn.ts`, answer a tool message without checking that its `toolCallId` is outstanding on this thread → case 8 or the cross-thread unit case must fail.
- [ ] In `agui-handler.ts` `normalizeB4Stream`, stop dropping the client-tool-call interrupt → case 1 must fail (an interrupt outcome appears).
- [ ] In `execute-route-core.ts`, remove `bypassCache = true` for client tools → a two-request test must fail, where request 2 omits `tools` and must not see `client_openPanel`. Add that test to `agui-client-tools.test.ts` if it doesn't fail.
- [ ] In `pattern-matching.ts`, drop `clientTool` from the exact-match set → Task 4's test must fail.
- [ ] In `client-tools.ts`, gate with `permissions.match("tool", name)` instead of `"clientTool"` → add and run a case where `allow: { tool: ["openPanel"] }, deny: { clientTool: ["openPanel"] }` must still deny.

---

### Task 14: Docs, spec corrections, config registry, changeset

**Files:**
- `apps/web/content/docs/ag-ui.mdx`: replace the "accepted, not executed" paragraph and callout (#744) with a "Client-provided tools" section covering the round trip, the `client_` prefix the model sees, un-prefixed frames, parallel answers, abandonment (next user message or `clientToolTtlMs`), and a **Threat model** subsection stating plainly that the bounds do not stop prompt injection, that the authority is the server-authored opt-in, and that a caller's definitions become prompt content.
- `apps/web/content/docs/configuration.mdx`: under `server.agui`, remove the "does not yet execute" callout and document `clientTools` (now executes), `clientToolTtlMs` (default 600000) and `clientToolStore`.
- `apps/web/content/docs/permissions.mdx`: the `clientTool` key. It matches exactly, never inherits `tool:<name>`, is allow by default, and `always` is not offered.
- `apps/web/content/docs/approval-grants.mdx`: under the `"required"` mode, state that grants cover permission parks only, so a client tool park is never grant-protected (spec §6 blind spot).
- `docs/superpowers/specs/2026-09-18-client-provided-tools-design.md`: in §3's failure table, apply corrections 1 and 2 and mark them "revised during implementation".
- `scripts/check-docs.mjs`: add `server.agui.clientToolTtlMs` and `server.agui.clientToolStore` to `expectedB4ConfigSchemaPaths`, next to the `server.agui.*` entries.
- `.changeset/client-provided-tools.md`: **patch** bumps (AGENTS.md: the fixed group takes patch bumps on 0.x) for `@b4run/sdk`, `@b4run/core`, `@b4run/langchain`, `@b4run/permissions`, `@b4run/cli`, `@b4run/sqlite-storage`, `@b4run/postgres-storage`.

- [ ] **Step 1: Write the docs and changeset.**
- [ ] **Step 2: Check them**

```bash
node scripts/check-docs.mjs
git add -A apps/web/content docs/superpowers/specs scripts/check-docs.mjs .changeset && git commit -m "docs: client-provided tools, the clientTool key, and the grants blind spot"
pnpm --dir apps/web seo:lastmod && git add apps/web/app/seo/lastmod.generated.json && git commit -m "chore(web): regenerate SEO lastmod for the client-tools docs"
pnpm --dir apps/web seo:lastmod:routes
```

Expected: `Docs completeness check passed.`, and `seo:lastmod:routes` exits 0.

---

### Task 15: Full verification and PR

- [ ] **Step 1: Run the repo gates** from the repo root, each on its own so an exit code isn't hidden by a pipe:

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:release-integrity
node scripts/check-docs.mjs
B4_TEST_PGSTORAGE=1 pnpm --filter @b4run/postgres-storage run test
```

- [ ] **Step 2: Open the PR** against `main`, titled `feat: client-provided tools over AG-UI (Model A over a retained record)`, closing #743 and referencing #744. The body must state: the two spec corrections, the mutation results from Task 13, and that capability advertisement (§9) and generalizing the record to every tool call (§7) are follow-ups.

---

## Self-review

- **Spec coverage.**
  - §1 halt mechanism: Tasks 5 and 6.
  - §2 record: Tasks 1–3, plus the issue in Task 12.
  - §2 invisibility: Task 9.
  - §3 interception and translation: Tasks 10 and 12. Corrections: Tasks 10, 11 and 14.
  - §4 bounds and namespacing: Tasks 6 (prefix, labeled description) and 7.
  - §5 shadowing: prefix in Task 6, reservation in Task 8, duplicate and prefix rejection in Task 7.
  - §6 permission gate: Tasks 4 and 6. `always` refused because the stub never offers a decision. Blind spot documented in Task 14.
  - §7 filters untouched: Task 12 intercepts before the collapse. Task 13 mutations guard it.
  - §8 no grants: the stub never calls `mintGrantForPark`.
  - §10 not-opted-in unchanged: Task 12, case 5.
  - §12 decisions: allow default (Task 6), void + TTL (Tasks 10–12), prefix, bounds (Task 7), one or several envelopes (Task 10), record scoped to client calls (Tasks 1–3).
  - §9 advertisement: deferred, per §12.4.
- **Placeholders.** Code-bearing steps show code. Where the plan points at existing code by line number, it names the function and the line from the research. Line numbers drift, so each such task says to verify before editing.
- **Type consistency.** These names are used identically across tasks: `ClientToolCallRecord`, `ClientToolCallStore`, `ClientToolRecorder`, `CLIENT_TOOL_RECORDER_KEY`, `ClientToolDefinition`, `ClientToolResumeValue { clientToolResult }`, `CLIENT_TOOL_PREFIX`, `CLIENT_TOOL_CALL_TYPE`, `isClientToolCallEnvelope`, `clientToolInterruptId`, `ABANDONED_CLIENT_TOOL_RESULT`, `readClientToolDefinitions`, `resolveClientToolTurn`, and `closeAbandonedClientToolCalls`.
