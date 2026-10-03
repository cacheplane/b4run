# Tool-Call Record Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every model tool call (server and client kind) in the retained tool-call record on runs where the store is resolved, prune settled rows per thread, and derive `pendingToolCallIds` from the record.

**Architecture:** The `client_tool_calls` table gains `kind` and `settled_at` via an appended migration; the store gains `settle` and `prune`. The LangChain tool converter issues and settles a server row around every tool execution when a recorder is in the run config; the client stub stays the only writer of client rows (skipped by the converter through a `clientTool` marker). The AG-UI handler injects the recorder whenever a store exists, prunes under the run slot, and reads outstanding client rows for `pendingToolCallIds`.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, `node:sqlite`, `pg`, LangChain `DynamicStructuredTool`, pnpm workspace with Turbo. Node 24 (`nvm use 24`). Run every command from the repo root. Never run bare `biome check --write`; use `pnpm lint` / `pnpm lint:fix`.

**Spec:** `docs/superpowers/specs/2026-10-02-tool-call-record-generalization-design.md`.

**Conventions that bite here:**
- `src/` imports use `.js`; `test/` imports use `.ts` (or `.js` where the file already does — follow the file).
- `exactOptionalPropertyTypes` is on: never assign `undefined` to an optional field; use a conditional spread.
- The storage packages declare the store types **structurally** (their own copies in `packages/sqlite-storage/src/client-tool-calls/types.ts` and `packages/postgres-storage/src/client-tool-calls.ts`). Every SDK type change is mirrored into both, member for member.
- Shipped migrations are frozen: add `version: 2`, never edit `version: 1`.
- Run a package's tests with `pnpm --filter <pkg> test -- <file>` (vitest). Build before any test that imports from another package's `dist/` (`pnpm build`, or `pnpm --filter <pkg>... build`).

---

## File map

| File | Change |
|---|---|
| `docs/superpowers/specs/2026-10-02-tool-call-record-generalization-design.md` | One sentence in §4 corrected (prune runs under the run slot, after it is taken). |
| `packages/sdk/src/client-tool-calls.ts` | `kind`, `settledAt` on the record; `settle`, `prune` on the store; `issue`, `settle` on the recorder; memory store implements them. |
| `packages/sdk/test/client-tool-calls.test.ts` | New cases for the above. |
| `packages/sqlite-storage/src/client-tool-calls/schema.ts` | Migration `version: 2`. |
| `packages/sqlite-storage/src/client-tool-calls/types.ts` | Structural mirror of the SDK types. |
| `packages/sqlite-storage/src/client-tool-calls/store.ts` | 13-column row, `settle`, `prune`, `listOutstanding` on `kind = 'client'`. |
| `packages/sqlite-storage/test/client-tool-calls.test.ts` | New cases incl. v1→v2 backfill. |
| `packages/postgres-storage/src/schema.ts` | Migration `version: 2`. |
| `packages/postgres-storage/src/client-tool-calls.ts` | Mirror types, 13-column row, `settle`, `prune`, `listOutstanding` on `kind = 'client'`. |
| `packages/postgres-storage/test/client-tool-calls-ddl.test.ts` | Pin v2; DEFAULT rule scoped; 13 columns. |
| `packages/postgres-storage/test/client-tool-calls.test.ts` | New cases (gated lane). |
| `packages/core/src/capabilities/types.ts` | `clientTool?: true` on `B4ToolDefinition`. |
| `packages/core/src/capabilities/client-tools.ts` | Stub sets `clientTool: true`. |
| `packages/core/test/capabilities/client-tools.test.ts` | Marker test. |
| `packages/langchain/src/tool-converter.ts` | Recorder read; issue/settle around `tool.run`; skip on marker. |
| `packages/langchain/test/tool-converter.test.ts` | Recorder cases. |
| `packages/ag-ui/src/outbound.ts` | `pendingToolCallIds` may return a Promise. |
| `packages/ag-ui/test/outbound.test.ts` | Async case. |
| `packages/cli/src/lib/dev/client-tool-runtime.ts` | `retentionMs`, `resolveToolCallRetentionMs`, store shape check grows. |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | Wire `retentionMs`. |
| `packages/core/src/types.ts` | `server.agui.toolCallRetentionMs` on `B4Config`. |
| `packages/cli/src/lib/dev/client-tool-turn.ts` | `partial` loses `pendingToolCallIds`; doc comment states the record invariant. |
| `packages/cli/test/client-tool-turn.test.ts` | Updated `partial` shape; classification cases. |
| `packages/cli/src/lib/dev/agui-handler.ts` | Recorder for every run with a store; `issue`/`settle`; prune under the slot; record-derived pending ids; normalizer callback removed; `kind` filters. |
| `packages/cli/test/client-tool-park-visibility.test.ts` | Normalizer signature. |
| `packages/cli/test/agui-client-tools.test.ts` | Retention config, server rows recorded, prune, record-derived pending ids. |
| `apps/web/content/docs/ag-ui.mdx`, `apps/web/content/docs/configuration.mdx` | Docs. |
| `apps/web/app/seo/lastmod.generated.json` | Regenerated after the docs commit. |
| `.changeset/tool-call-record-generalization.md` | Patch changeset, seven packages. |

---

### Task 1: Correct the spec's prune ordering sentence

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-tool-call-record-generalization-design.md`

The handler runs `resolveClientToolTurn` under the resume claim, **before** it takes the run slot (`runRegistry.begin`). The spec's §4 says prune runs "before the turn resolver reads the record"; the accurate statement is that it runs under the run slot immediately after the slot is taken.

- [ ] **Step 1: Replace the sentence**

Find in §4:

```
The AG-UI handler calls `store.prune({ threadId, before: now − retentionMs })` once per run on
that thread, inside the run slot and **before** the turn resolver reads the record, so a resume
never races a delete.
```

Replace with:

```
The AG-UI handler calls `store.prune({ threadId, before: now − retentionMs })` once per run on
that thread, under the run slot, immediately after the slot is taken and before any record read
that happens under it (the client-park recheck, the recorder, the abandon close). The turn
resolver runs earlier, under the resume claim; that is safe because prune deletes only non-open
rows, and the only non-open rows a resume depends on are answered client rows whose results the
resolver has already copied into its decision. A row answered more than the retention window ago
and never resumed (a crash between answer and resume, then an idle thread) is pruned, and the
next run abandons its park with the fixed abandoned result instead of the stored one — accepted.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-10-02-tool-call-record-generalization-design.md
git commit -m "docs: prune runs under the run slot, after it is taken

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: SDK record, store and recorder contracts, memory store

**Files:**
- Modify: `packages/sdk/src/client-tool-calls.ts`
- Test: `packages/sdk/test/client-tool-calls.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/test/client-tool-calls.test.ts` (the `call()` helper at the top of the file gains `kind: "client"` and `settledAt: null` — add both lines to its returned object, after `routeId`):

```ts
function serverCall(over: Partial<ClientToolCallRecord> = {}): ClientToolCallRecord {
  return {
    threadId: "t1",
    toolCallId: "call_s1",
    kind: "server",
    interruptId: "",
    toolName: "readFile",
    runId: "r1",
    routeId: "/park#agent",
    issuedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: null,
    answeredAt: null,
    result: null,
    voidedAt: null,
    settledAt: null,
    ...over,
  }
}

describe("createMemoryClientToolCallStore — server rows", () => {
  it("settles a server row once; a second settle reports already_settled and keeps the first time", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(serverCall())
    expect(await store.settle({ threadId: "t1", toolCallId: "call_s1", at: "2026-09-30T00:00:01.000Z" })).toBe("settled")
    expect(await store.settle({ threadId: "t1", toolCallId: "call_s1", at: "2026-09-30T00:00:02.000Z" })).toBe("already_settled")
    expect((await store.get("t1", "call_s1"))?.settledAt).toBe("2026-09-30T00:00:01.000Z")
  })

  it("settle reports missing for an unknown id and for a client row", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    expect(await store.settle({ threadId: "t1", toolCallId: "nope", at: "2026-09-30T00:00:01.000Z" })).toBe("missing")
    expect(await store.settle({ threadId: "t1", toolCallId: "call_1", at: "2026-09-30T00:00:01.000Z" })).toBe("missing")
    expect((await store.get("t1", "call_1"))?.settledAt).toBeNull()
  })

  it("listOutstanding returns open client rows only; listForThread returns both kinds", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call())
    await store.issue(serverCall())
    expect((await store.listOutstanding("t1")).map((r) => r.toolCallId)).toEqual(["call_1"])
    expect((await store.listForThread("t1")).map((r) => r.toolCallId).sort()).toEqual(["call_1", "call_s1"])
  })

  it("answer and voidOutstanding never touch a server row", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(serverCall())
    expect((await store.answer({ threadId: "t1", toolCallId: "call_s1", result: "x", at: "2026-09-30T00:00:01.000Z" })).outcome).toBe("missing")
    expect(await store.voidOutstanding({ threadId: "t1", at: "2026-09-30T00:00:01.000Z" })).toBe(0)
    expect((await store.get("t1", "call_s1"))?.voidedAt).toBeNull()
  })
})

describe("createMemoryClientToolCallStore — prune", () => {
  const T0 = "2026-09-01T00:00:00.000Z"
  const T1 = "2026-09-20T00:00:00.000Z"
  const BEFORE = "2026-09-10T00:00:00.000Z"

  it("deletes only non-open rows whose terminal timestamp is older than `before`", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call({ toolCallId: "old_answered", answeredAt: T0, result: "r" }))
    await store.issue(call({ toolCallId: "old_voided", voidedAt: T0 }))
    await store.issue(serverCall({ toolCallId: "old_settled", settledAt: T0 }))
    await store.issue(call({ toolCallId: "new_answered", answeredAt: T1, result: "r" }))
    await store.issue(serverCall({ toolCallId: "new_settled", settledAt: T1 }))
    await store.issue(call({ toolCallId: "open_client", issuedAt: "2020-01-01T00:00:00.000Z" }))
    await store.issue(serverCall({ toolCallId: "open_server", issuedAt: "2020-01-01T00:00:00.000Z" }))
    expect(await store.prune({ threadId: "t1", before: BEFORE })).toBe(3)
    expect((await store.listForThread("t1")).map((r) => r.toolCallId).sort()).toEqual([
      "new_answered",
      "new_settled",
      "open_client",
      "open_server",
    ])
  })

  it("prunes one thread only and returns 0 when nothing qualifies", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(call({ threadId: "t2", toolCallId: "x", voidedAt: T0 }))
    expect(await store.prune({ threadId: "t1", before: BEFORE })).toBe(0)
    expect(await store.get("t2", "x")).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/sdk test -- test/client-tool-calls.test.ts`
Expected: FAIL — type errors on `kind`/`settledAt`, `store.settle is not a function`.

- [ ] **Step 3: Implement**

In `packages/sdk/src/client-tool-calls.ts`:

Replace the file header comment's first paragraph with:

```ts
/**
 * The retained record of tool calls (cacheplane/b4run#743, generalized by the
 * 2026-10-02 design). Two kinds of row share one table:
 *
 * - `client`: a client-provided tool call that parked the turn. The row is how
 *   the server knows, later, that a `role: "tool"` message answers a call it
 *   issued and is still waiting on. Only an OPEN client row (neither answered
 *   nor voided) is ever answerable.
 * - `server`: one of the server's own tool calls, recorded for identity only
 *   (issued, then settled when the tool returns or throws). Never answerable;
 *   a tool message naming it is history.
 *
 * It is bookkeeping the client never sees; it carries no credential.
 * ...
```

(Keep the rest of the header: the keying paragraph and the edge-safety note.)

Change the record type:

```ts
export type ToolCallRecordKind = "client" | "server"

export interface ClientToolCallRecord {
  readonly threadId: string
  /** The provider's tool-call id — what the client echoes back as `toolCallId`. */
  readonly toolCallId: string
  /** `client`: a parked client tool call. `server`: one of the server's own tool calls, identity only. */
  readonly kind: ToolCallRecordKind
  /** The park this call's result answers (`client-${toolCallId}`); `""` on a server row. */
  readonly interruptId: string
  /** The un-prefixed name the client registered, or the server tool's name. */
  readonly toolName: string
  readonly runId: string
  /** ...unchanged doc... */
  readonly routeId: string
  readonly issuedAt: string
  /** ISO time after which a client call is abandoned; `null` means no expiry. Always `null` on a server row. */
  readonly expiresAt: string | null
  /** Client rows only. */
  readonly answeredAt: string | null
  /** The client's result text, set together with `answeredAt`. Client rows only. */
  readonly result: string | null
  /** Client rows only. */
  readonly voidedAt: string | null
  /** Server rows only: when the tool returned or threw. */
  readonly settledAt: string | null
}
```

Add after `ClientToolCallAnswer`:

```ts
export type ClientToolCallSettle = "settled" | "already_settled" | "missing"
```

In `ClientToolCallStore`, update the `listOutstanding` doc to "Open CLIENT rows — neither answered nor voided — in issue order. Server rows are never listed here." and the `answer`/`voidOutstanding` docs to add "Client rows only; a server row is `missing` / never voided." Then add:

```ts
  /**
   * Stamps `settledAt` on a server row. Idempotent: a second call reports
   * `already_settled` and keeps the first timestamp. A client row, or an
   * unknown id, is `missing`.
   */
  settle(options: {
    readonly threadId: string
    readonly toolCallId: string
    readonly at: string
  }): Promise<ClientToolCallSettle>
  /**
   * Deletes the thread's NON-open rows whose terminal timestamp (`answeredAt`,
   * `voidedAt` or `settledAt`, whichever is set) is older than `before`
   * (ISO-8601, compared as instants). Open rows are never eligible, however
   * old. Returns how many rows were deleted. A delete path is acceptable here,
   * unlike for interrupt grants: a closed tool-call row carries no authority.
   */
  prune(options: { readonly threadId: string; readonly before: string }): Promise<number>
```

In `ClientToolRecorder`, add after `record`:

```ts
  /** Writes a server row for one of the server's own tool calls, before it runs. Idempotent on the id. */
  issue(call: { readonly toolCallId: string; readonly toolName: string }): Promise<void>
  /** Stamps the server row once the tool returned or threw. Idempotent. */
  settle(toolCallId: string): Promise<void>
```

In `createMemoryClientToolCallStore`, add a helper above the return and the two methods:

```ts
  const isOpen = (row: ClientToolCallRecord) =>
    row.kind === "client"
      ? row.answeredAt === null && row.voidedAt === null
      : row.settledAt === null
  const terminalAt = (row: ClientToolCallRecord): string | null =>
    row.kind === "client" ? (row.voidedAt ?? row.answeredAt) : row.settledAt
```

Change `listOutstanding` to filter `row.kind === "client" && isOpen(row)`. Change `answer` to return `{ outcome: "missing" }` when `row.kind !== "client"`. Change `voidOutstanding`'s skip to `if (row.kind !== "client" || row.answeredAt !== null || row.voidedAt !== null) continue`. Add:

```ts
    async settle({ threadId, toolCallId, at }) {
      const rows = threads.get(threadId)
      const row = rows?.get(toolCallId)
      if (!rows || !row || row.kind !== "server") return "missing"
      if (row.settledAt !== null) return "already_settled"
      rows.set(toolCallId, { ...row, settledAt: at })
      return "settled"
    },
    async prune({ threadId, before }) {
      const rows = threads.get(threadId)
      if (!rows) return 0
      const cutoff = Date.parse(before)
      if (Number.isNaN(cutoff)) throw new Error("prune: `before` is not a valid ISO-8601 instant")
      let count = 0
      for (const [id, row] of rows) {
        if (isOpen(row)) continue
        const at = terminalAt(row)
        if (at === null) continue
        const t = Date.parse(at)
        if (Number.isNaN(t) || t >= cutoff) continue
        rows.delete(id)
        count += 1
      }
      return count
    },
```

Export the new types from `packages/sdk/src/index.ts`: add `ClientToolCallSettle` and `ToolCallRecordKind` to the `export type { ... } from "./client-tool-calls.js"` list.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @b4run/sdk test -- test/client-tool-calls.test.ts`
Expected: PASS (all, including the pre-existing cases; the `call()` helper now carries `kind`/`settledAt`).

- [ ] **Step 5: Typecheck the SDK and commit**

Run: `pnpm --filter @b4run/sdk typecheck`
Expected: clean. (Other packages will now fail to typecheck until Tasks 3–5 mirror the shape; that is expected.)

```bash
git add packages/sdk
git commit -m "feat(sdk): tool-call record carries a kind and a settle; store gains settle and prune

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: SQLite store

**Files:**
- Modify: `packages/sqlite-storage/src/client-tool-calls/schema.ts`
- Modify: `packages/sqlite-storage/src/client-tool-calls/types.ts`
- Modify: `packages/sqlite-storage/src/client-tool-calls/store.ts`
- Test: `packages/sqlite-storage/test/client-tool-calls.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/sqlite-storage/test/client-tool-calls.test.ts`, add `kind: "client"` (after `toolCallId`) and `settledAt: null` (last) to the `call()` helper's object. Add imports at the top:

```ts
import { DatabaseSync } from "node:sqlite"
import { CLIENT_TOOL_CALLS_MIGRATIONS } from "../src/client-tool-calls/schema.js"
import { runMigrations } from "../src/internal/migrate.js"
```

Append inside the `describe("createClientToolCallStore", ...)` block:

```ts
  function serverCall(overrides: Partial<ClientToolCallRecord> = {}): ClientToolCallRecord {
    return call({
      toolCallId: "call-s1",
      kind: "server",
      interruptId: "",
      toolName: "readFile",
      expiresAt: null,
      ...overrides,
    })
  }

  it("round-trips kind and settledAt", async () => {
    const store = newStore()
    await store.issue(serverCall({ settledAt: "2026-09-30T00:00:05.000Z" }))
    const row = await store.get("t-1", "call-s1")
    expect(row?.kind).toBe("server")
    expect(row?.settledAt).toBe("2026-09-30T00:00:05.000Z")
    expect((await store.get("t-1", "call-s1"))?.interruptId).toBe("")
  })

  it("settles a server row once, keeps the first time, and reports missing for a client row", async () => {
    const store = newStore()
    await store.issue(serverCall())
    await store.issue(call())
    expect(await store.settle({ threadId: "t-1", toolCallId: "call-s1", at: "2026-09-30T00:00:01.000Z" })).toBe("settled")
    expect(await store.settle({ threadId: "t-1", toolCallId: "call-s1", at: "2026-09-30T00:00:02.000Z" })).toBe("already_settled")
    expect((await store.get("t-1", "call-s1"))?.settledAt).toBe("2026-09-30T00:00:01.000Z")
    expect(await store.settle({ threadId: "t-1", toolCallId: "call-1", at: "2026-09-30T00:00:01.000Z" })).toBe("missing")
    expect(await store.settle({ threadId: "t-1", toolCallId: "nope", at: "2026-09-30T00:00:01.000Z" })).toBe("missing")
  })

  it("listOutstanding is open client rows only; answer and void skip server rows", async () => {
    const store = newStore()
    await store.issue(call())
    await store.issue(serverCall())
    expect((await store.listOutstanding("t-1")).map((r) => r.toolCallId)).toEqual(["call-1"])
    expect((await store.answer({ threadId: "t-1", toolCallId: "call-s1", result: "x", at: "2026-09-30T00:00:01.000Z" })).outcome).toBe("missing")
    expect(await store.voidOutstanding({ threadId: "t-1", at: "2026-09-30T00:00:01.000Z" })).toBe(1)
    expect((await store.get("t-1", "call-s1"))?.voidedAt).toBeNull()
  })

  it("prune deletes only non-open rows older than `before`, on this thread, and counts them", async () => {
    const store = newStore()
    const OLD = "2026-09-01T00:00:00.000Z"
    const NEW = "2026-09-20T00:00:00.000Z"
    await store.issue(call({ toolCallId: "old_answered", answeredAt: OLD, result: "r" }))
    await store.issue(call({ toolCallId: "old_voided", voidedAt: OLD }))
    await store.issue(serverCall({ toolCallId: "old_settled", settledAt: OLD }))
    await store.issue(call({ toolCallId: "new_answered", answeredAt: NEW, result: "r" }))
    await store.issue(serverCall({ toolCallId: "new_settled", settledAt: NEW }))
    await store.issue(call({ toolCallId: "open_client", issuedAt: "2020-01-01T00:00:00.000Z" }))
    await store.issue(serverCall({ toolCallId: "open_server", issuedAt: "2020-01-01T00:00:00.000Z" }))
    await store.issue(call({ threadId: "t-2", toolCallId: "other_thread", voidedAt: OLD }))
    expect(await store.prune({ threadId: "t-1", before: "2026-09-10T00:00:00.000Z" })).toBe(3)
    expect((await store.listForThread("t-1")).map((r) => r.toolCallId).sort()).toEqual([
      "new_answered",
      "new_settled",
      "open_client",
      "open_server",
    ])
    expect(await store.get("t-2", "other_thread")).toBeDefined()
  })

  it("migration 2 backfills a version-1 row as kind=client with no settledAt", async () => {
    const path = storePath()
    const v1 = new DatabaseSync(path)
    runMigrations(v1, CLIENT_TOOL_CALLS_MIGRATIONS.filter((m) => m.version === 1))
    v1.prepare(
      `INSERT INTO client_tool_calls(thread_id, tool_call_id, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("t-1", "legacy", "client-legacy", "openPanel", "r0", "/park#agent", "2026-09-29T00:00:00.000Z", null, null, null, null)
    v1.close()
    const store = newStore()
    const row = await store.get("t-1", "legacy")
    expect(row?.kind).toBe("client")
    expect(row?.settledAt).toBeNull()
    expect((await store.listOutstanding("t-1")).map((r) => r.toolCallId)).toEqual(["legacy"])
  })

  it("every INSERT names all thirteen columns (no default is load-bearing)", async () => {
    const store = newStore()
    await store.issue(serverCall())
    const db = new DatabaseSync(storePath())
    const row = db.prepare("SELECT kind, settled_at FROM client_tool_calls WHERE tool_call_id = ?").get("call-s1") as { kind: string; settled_at: string | null }
    db.close()
    expect(row).toEqual({ kind: "server", settled_at: null })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/sqlite-storage test -- test/client-tool-calls.test.ts`
Expected: FAIL (type errors on `kind`; `settle`/`prune` missing).

- [ ] **Step 3: Append migration 2**

In `packages/sqlite-storage/src/client-tool-calls/schema.ts`, append to the array:

```ts
  {
    // `kind` is NOT NULL and so needs a DEFAULT for SQLite's ADD COLUMN to
    // backfill the version-1 rows (all client calls). That default exists for
    // the backfill only: every INSERT names `kind`, so it is never load-bearing.
    version: 2,
    up: `
      ALTER TABLE client_tool_calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'client';
      ALTER TABLE client_tool_calls ADD COLUMN settled_at TEXT;
    `,
  },
```

Update the header comment's second rule to: "no column default is load-bearing: every INSERT names every column (migration 2's `DEFAULT 'client'` exists only to backfill rows that predate `kind`)."

- [ ] **Step 4: Mirror the SDK types**

In `packages/sqlite-storage/src/client-tool-calls/types.ts`, make `ClientToolCallRecord`, `ClientToolCallStore` member-for-member identical to the SDK's new shape from Task 2 (add `kind`, `settledAt`, `ClientToolCallSettle`, `settle`, `prune`, the doc updates). Add `export type ToolCallRecordKind = "client" | "server"` and `export type ClientToolCallSettle = "settled" | "already_settled" | "missing"`.

- [ ] **Step 5: Implement in the store**

In `packages/sqlite-storage/src/client-tool-calls/store.ts`:

```ts
interface ClientToolCallRow {
  thread_id: string
  tool_call_id: string
  kind: string
  interrupt_id: string
  tool_name: string
  run_id: string
  route_id: string
  issued_at: string
  expires_at: string | null
  answered_at: string | null
  result: string | null
  voided_at: string | null
  settled_at: string | null
}

const SELECT_COLUMNS =
  "thread_id, tool_call_id, kind, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at, settled_at"

function rowToRecord(row: ClientToolCallRow): ClientToolCallRecord {
  return {
    threadId: row.thread_id,
    toolCallId: row.tool_call_id,
    kind: row.kind === "server" ? "server" : "client",
    interruptId: row.interrupt_id,
    toolName: row.tool_name,
    runId: row.run_id,
    routeId: row.route_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    answeredAt: row.answered_at,
    result: row.result,
    voidedAt: row.voided_at,
    settledAt: row.settled_at,
  }
}
```

`issue`: 13 placeholders, bind `record.kind` after `record.toolCallId` and `record.settledAt` last.

`listOutstanding`: `WHERE thread_id = ? AND kind = 'client' AND answered_at IS NULL AND voided_at IS NULL`.

`answer`: add `AND kind = 'client'` to the UPDATE's WHERE; after the re-read, `if (!record || record.kind !== "client") return { outcome: "missing" }`.

`voidOutstanding`: add `AND kind = 'client'` to the WHERE.

Add:

```ts
    async settle({ threadId, toolCallId, at }) {
      const changes = changeCount(
        db
          .prepare(
            `UPDATE client_tool_calls SET settled_at = ?
             WHERE thread_id = ? AND tool_call_id = ? AND kind = 'server' AND settled_at IS NULL`,
          )
          .run(at, threadId, toolCallId).changes,
      )
      if (changes > 0) return "settled"
      const record = readRow(threadId, toolCallId)
      return record?.kind === "server" ? "already_settled" : "missing"
    },

    async prune({ threadId, before }) {
      if (Number.isNaN(Date.parse(before))) {
        throw new Error("prune: `before` is not a valid ISO-8601 instant")
      }
      // ISO-8601 UTC strings compare chronologically as text. Terminal
      // timestamp per kind: voided_at or answered_at for a client row,
      // settled_at for a server row. An open row has none and never matches.
      return changeCount(
        db
          .prepare(
            `DELETE FROM client_tool_calls
             WHERE thread_id = ?
               AND COALESCE(
                 CASE WHEN kind = 'client' THEN COALESCE(voided_at, answered_at) ELSE settled_at END,
                 ''
               ) <> ''
               AND CASE WHEN kind = 'client' THEN COALESCE(voided_at, answered_at) ELSE settled_at END < ?`,
          )
          .run(threadId, before).changes,
      )
    },
```

Note: timestamps are always written as `Date#toISOString()` output (UTC, fixed width), so text `<` is chronological. Document that above `prune` in the store's doc comment.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @b4run/sqlite-storage test -- test/client-tool-calls.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm --filter @b4run/sqlite-storage typecheck`
Expected: clean.

```bash
git add packages/sqlite-storage
git commit -m "feat(sqlite-storage): tool-call record migration 2 (kind, settled_at), settle and prune

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Postgres store

**Files:**
- Modify: `packages/postgres-storage/src/schema.ts`
- Modify: `packages/postgres-storage/src/client-tool-calls.ts`
- Test: `packages/postgres-storage/test/client-tool-calls-ddl.test.ts`
- Test: `packages/postgres-storage/test/client-tool-calls.test.ts`

- [ ] **Step 1: Update the DDL pin test (fails first)**

In `packages/postgres-storage/test/client-tool-calls-ddl.test.ts`:

Add after the "pins migration 1's SQL exactly" case:

```ts
  it("pins migration 2's SQL exactly", () => {
    const migration = CLIENT_TOOL_CALLS_MIGRATIONS.find((m) => m.version === 2)
    expect(migration).toBeDefined()
    expect(normalize(migration?.up(NAMING) ?? "")).toBe(
      "ALTER TABLE public.b4_client_tool_calls ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'client'; " +
        "ALTER TABLE public.b4_client_tool_calls ADD COLUMN IF NOT EXISTS settled_at text;",
    )
  })
```

Replace the "declares no column DEFAULT anywhere" case with:

```ts
  it("declares no column DEFAULT except migration 2's backfill of `kind`", () => {
    for (const migration of CLIENT_TOOL_CALLS_MIGRATIONS) {
      const sql = migration.up(NAMING)
      if (migration.version === 2) {
        // The one permitted DEFAULT: SQLite's ADD COLUMN needs it to backfill
        // version-1 rows, and the Postgres statement matches for symmetry.
        // Every INSERT still names `kind` (pinned below).
        expect(sql.match(/\bDEFAULT\b/gi)).toHaveLength(1)
        expect(sql).toMatch(/kind text NOT NULL DEFAULT 'client'/)
        continue
      }
      expect(sql).not.toMatch(/\bDEFAULT\b/i)
    }
  })
```

In "names all eleven columns in every INSERT": rename to "names all thirteen columns in every INSERT", add `kind: "client"` and `settledAt: null` to the issued record, change the expected column list to `["thread_id", "tool_call_id", "interrupt_id", "tool_name", "run_id", "route_id", "issued_at", "expires_at", "answered_at", "result", "voided_at", "kind", "settled_at"]` (Postgres appends new columns last, so migration order puts `kind` and `settled_at` at the end), and `toHaveLength(13)`. Any other test in that file constructing a record gets `kind: "client"` and `settledAt: null` too.

Run: `pnpm --filter @b4run/postgres-storage test -- test/client-tool-calls-ddl.test.ts`
Expected: FAIL.

- [ ] **Step 2: Append migration 2**

In `packages/postgres-storage/src/schema.ts`, append to `CLIENT_TOOL_CALLS_MIGRATIONS`:

```ts
  {
    // `kind` is NOT NULL, so the ADD COLUMN carries a DEFAULT to backfill the
    // version-1 rows (all client calls). The default exists for the backfill
    // only; every INSERT names `kind`, pinned by the DDL test.
    version: 2,
    up: (naming) => `
      ALTER TABLE ${qualify(naming, "client_tool_calls")} ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'client';
      ALTER TABLE ${qualify(naming, "client_tool_calls")} ADD COLUMN IF NOT EXISTS settled_at text;
    `,
  },
```

Update the constant's doc comment rule 2 to say "No column default is load-bearing: migration 2's `DEFAULT 'client'` only backfills rows that predate `kind`; every INSERT names all thirteen columns."

- [ ] **Step 3: Mirror types and implement**

In `packages/postgres-storage/src/client-tool-calls.ts`: mirror the SDK types exactly as in Task 3 Step 4 (`kind`, `settledAt`, `ToolCallRecordKind`, `ClientToolCallSettle`, `settle`, `prune`). Update `COLUMNS` to the 13-column list in migration order (`thread_id, tool_call_id, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at, kind, settled_at`) — the order the DDL test in Step 1 pins. `CallRow` gains `kind: string` and `settled_at: string | null`; `rowToRecord` maps `kind: row.kind === "server" ? "server" : "client"` and `settledAt: row.settled_at ?? null`. `issue` binds 13 values (`record.kind`, `record.settledAt` last).

`listOutstanding`: `WHERE thread_id = $1 AND kind = 'client' AND answered_at IS NULL AND voided_at IS NULL`.
`answer`: add `AND kind = 'client'`; after the re-read, `if (!existing || existing.kind !== "client") return { outcome: "missing" }`.
`voidOutstanding`: add `AND kind = 'client'`.

Add:

```ts
    async settle({ threadId, toolCallId, at }) {
      await ready()
      const updated = await pool.query<{ tool_call_id: string }>(
        `UPDATE ${table} SET settled_at = $1
         WHERE thread_id = $2 AND tool_call_id = $3 AND kind = 'server' AND settled_at IS NULL
         RETURNING tool_call_id`,
        [at, threadId, toolCallId],
      )
      if (updated.rows.length > 0) return "settled"
      const existing = await selectOne(threadId, toolCallId)
      return existing?.kind === "server" ? "already_settled" : "missing"
    },

    async prune({ threadId, before }) {
      if (Number.isNaN(Date.parse(before))) {
        throw new Error("prune: `before` is not a valid ISO-8601 instant")
      }
      await ready()
      // Terminal timestamp per kind; an open row has none and never matches.
      // ISO-8601 UTC text compares chronologically under COLLATE "C".
      const res = await pool.query<{ tool_call_id: string }>(
        `DELETE FROM ${table}
         WHERE thread_id = $1
           AND (CASE WHEN kind = 'client' THEN COALESCE(voided_at, answered_at) ELSE settled_at END) IS NOT NULL
           AND (CASE WHEN kind = 'client' THEN COALESCE(voided_at, answered_at) ELSE settled_at END) COLLATE "C" < $2
         RETURNING tool_call_id`,
        [threadId, before],
      )
      return res.rows.length
    },
```

- [ ] **Step 4: Gated store tests**

In `packages/postgres-storage/test/client-tool-calls.test.ts`, add `kind: "client"` and `settledAt: null` to `call()`. Append, inside the gated `describe`, using its `withStore` helper:

```ts
  test("settles a server row once and prunes only non-open rows older than before", async () => {
    await withStore(async (store) => {
      const server = (id: string, settledAt: string | null) =>
        call({ toolCallId: id, kind: "server", interruptId: "", toolName: "readFile", settledAt })
      await store.issue(server("s-open", null))
      await store.issue(server("s-old", "2026-09-01T00:00:00.000Z"))
      await store.issue(call({ toolCallId: "c-old", voidedAt: "2026-09-01T00:00:00.000Z" }))
      await store.issue(call({ toolCallId: "c-open" }))
      expect(await store.settle({ threadId: "t-1", toolCallId: "s-open", at: AT })).toBe("settled")
      expect(await store.settle({ threadId: "t-1", toolCallId: "s-open", at: AT })).toBe("already_settled")
      expect(await store.settle({ threadId: "t-1", toolCallId: "c-open", at: AT })).toBe("missing")
      expect((await store.listOutstanding("t-1")).map((r) => r.toolCallId)).toEqual(["c-open"])
      expect(await store.prune({ threadId: "t-1", before: "2026-09-10T00:00:00.000Z" })).toBe(2)
      expect((await store.listForThread("t-1")).map((r) => r.toolCallId).sort()).toEqual(["c-open", "s-open"])
    })
  })

  test("migration 2 backfills version-1 rows as client", async () => {
    const prefix = freshPrefix()
    const v1 = createPostgresClientToolCallStore({ connectionString: url, tablePrefix: prefix })
    // Apply only version 1 by hand, then insert an eleven-column row.
    const { Pool } = await import("pg")
    const pool = new Pool({ connectionString: url })
    try {
      await pool.query(CLIENT_TOOL_CALLS_MIGRATIONS[0]!.up({ schema: "public", prefix }))
      await pool.query(
        `INSERT INTO public.${prefix}_client_tool_calls (thread_id, tool_call_id, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at)
         VALUES ('t-1', 'legacy', 'client-legacy', 'pick', 'r0', '/park#agent', '2026-09-18T00:00:00.000Z', NULL, NULL, NULL, NULL)`,
      )
    } finally {
      await pool.end()
    }
    try {
      const row = await v1.get("t-1", "legacy")
      expect(row?.kind).toBe("client")
      expect(row?.settledAt).toBeNull()
    } finally {
      await v1.close()
    }
  })
```

Add `import { CLIENT_TOOL_CALLS_MIGRATIONS } from "../src/schema.js"` at the top. (The store's `ready()` runs `runMigrations`, which sees version 1 already recorded? It does **not** — applying the DDL by hand records nothing in the migrations table. Use `CREATE TABLE IF NOT EXISTS` semantics: version 1 re-applied is a no-op, version 2 adds the columns with the backfill. That is exactly the path under test.)

- [ ] **Step 5: Run**

Run: `pnpm --filter @b4run/postgres-storage test -- test/client-tool-calls-ddl.test.ts`
Expected: PASS.

Run (needs Docker): `B4_TEST_PGSTORAGE=1 pnpm --filter @b4run/postgres-storage test -- test/client-tool-calls.test.ts`
Expected: PASS. If Docker is unavailable locally, state that in the task report; the gated `postgres-storage-docker` CI lane runs it.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @b4run/postgres-storage typecheck`

```bash
git add packages/postgres-storage
git commit -m "feat(postgres-storage): tool-call record migration 2 (kind, settled_at), settle and prune

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Core — the `clientTool` marker

**Files:**
- Modify: `packages/core/src/capabilities/types.ts` (the `B4ToolDefinition` interface, after `returnDirect`)
- Modify: `packages/core/src/capabilities/client-tools.ts` (`createClientToolStub` return object)
- Test: `packages/core/test/capabilities/client-tools.test.ts`

- [ ] **Step 1: Write the failing test**

In the `describe("client tool stub", ...)` block, next to "names the stub client_<name> …":

```ts
  it("marks itself as a client tool so the backend converter does not record it as a server call", () => {
    const stub = createClientToolStub(
      { name: "openPanel", description: "d", parameters: { type: "object", properties: {} } },
      undefined,
    )
    expect(stub.clientTool).toBe(true)
  })
```

Run: `pnpm --filter @b4run/core test -- test/capabilities/client-tools.test.ts`
Expected: FAIL (`clientTool` not on the type / undefined).

- [ ] **Step 2: Implement**

In `packages/core/src/capabilities/types.ts`, inside `B4ToolDefinition` after `returnDirect`:

```ts
  /**
   * Set by `createClientToolStub` only. The tool is the server-side stub of a
   * client-provided tool: it writes its own (client-kind) row in the tool-call
   * record before it parks, so a backend adapter must NOT issue a server-kind
   * row for it. Never set this on an authored or capability tool.
   */
  readonly clientTool?: true
```

In `createClientToolStub`'s returned object, add `clientTool: true,` after `schema: definition.parameters,`.

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `pnpm --filter @b4run/core test -- test/capabilities/client-tools.test.ts` → PASS.
Run: `pnpm --filter @b4run/core typecheck` → clean.

```bash
git add packages/core
git commit -m "feat(core): client tool stubs carry a clientTool marker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: LangChain converter records server calls

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts`
- Test: `packages/langchain/test/tool-converter.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/langchain/test/tool-converter.test.ts`:

```ts
import { CLIENT_TOOL_RECORDER_KEY } from "@b4run/sdk"

describe("convertToolToLangChain — the tool-call record", () => {
  function recorder() {
    const log: string[] = []
    return {
      log,
      recorder: {
        has: async () => false,
        record: async () => {},
        issue: async (call: { toolCallId: string; toolName: string }) => {
          log.push(`issue:${call.toolName}:${call.toolCallId}`)
        },
        settle: async (toolCallId: string) => {
          log.push(`settle:${toolCallId}`)
        },
      },
    }
  }
  const call = { args: {}, id: "call_1", name: "probe", type: "tool_call" as const }
  const configWith = (rec: unknown) => ({ configurable: { [CLIENT_TOOL_RECORDER_KEY]: rec } })

  it("issues before the tool body and settles after it returns", async () => {
    const { log, recorder: rec } = recorder()
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => {
        log.push("run")
        return "ok"
      },
    })
    await tool.invoke(call, configWith(rec))
    expect(log).toEqual(["issue:probe:call_1", "run", "settle:call_1"])
  })

  it("settles when the tool throws, and the error still propagates", async () => {
    const { log, recorder: rec } = recorder()
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => {
        throw new Error("boom")
      },
    })
    await expect(tool.invoke(call, configWith(rec))).rejects.toThrow("boom")
    expect(log).toEqual(["issue:probe:call_1", "settle:call_1"])
  })

  it("settles when the call is aborted mid-run", async () => {
    const { log, recorder: rec } = recorder()
    const controller = new AbortController()
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")))
          controller.abort()
        }),
    })
    await expect(
      tool.invoke(call, { ...configWith(rec), signal: controller.signal }),
    ).rejects.toThrow("aborted")
    expect(log).toEqual(["issue:probe:call_1", "settle:call_1"])
  })

  it("skips a tool carrying the clientTool marker", async () => {
    const { log, recorder: rec } = recorder()
    const tool = convertToolToLangChain({
      name: "client_openPanel",
      schema: { type: "object", properties: {} },
      clientTool: true,
      run: async () => "ok",
    })
    await tool.invoke({ ...call, name: "client_openPanel" }, configWith(rec))
    expect(log).toEqual([])
  })

  it("does nothing with no recorder, and nothing without a provider tool-call id", async () => {
    const { log, recorder: rec } = recorder()
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => "ok",
    })
    await tool.invoke(call, { configurable: {} })
    await tool.invoke({}, configWith(rec))
    expect(log).toEqual([])
  })

  it("an issue failure fails the call before the tool body runs", async () => {
    const { log, recorder: rec } = recorder()
    rec.issue = async () => {
      throw new Error("store down")
    }
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => {
        log.push("run")
        return "ok"
      },
    })
    await expect(tool.invoke(call, configWith(rec))).rejects.toThrow("store down")
    expect(log).toEqual([])
  })

  it("a settle failure is warned and swallowed; the result stands", async () => {
    const { recorder: rec } = recorder()
    rec.settle = async () => {
      throw new Error("store down")
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const tool = convertToolToLangChain({
        name: "probe",
        schema: { type: "object", properties: {} },
        run: async () => "ok",
      })
      const result = await tool.invoke(call, configWith(rec))
      expect(result).toBeDefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not settle tool call"),
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })
})
```

Note: `tool.invoke(toolCall, config)` is how LangGraph's ToolNode drives the tool; the `id` on the tool call is what `extractToolCallId` reads first (`config.toolCall.id`). The existing "tool-call id in the run context" tests use the same call shape.

Run: `pnpm --filter @b4run/langchain test -- test/tool-converter.test.ts`
Expected: FAIL (no `issue` calls; `clientTool` not on the structural type).

- [ ] **Step 2: Implement**

In `packages/langchain/src/tool-converter.ts`:

Add the import (the package already depends on `@b4run/sdk`):

```ts
import { CLIENT_TOOL_RECORDER_KEY, type ClientToolRecorder } from "@b4run/sdk"
```

On the local `B4ToolDefinition` interface, after `returnDirect`:

```ts
  /** The server-side stub of a client-provided tool; it records itself. Never issued as a server call. */
  readonly clientTool?: true
```

Add a reader next to `extractToolCallId`:

```ts
/**
 * The per-run tool-call recorder the runtime injected, if any. Present only on
 * runs where the tool-call record's store resolved (an AG-UI route opted into
 * client tools, or an operator-configured store): without one, nothing is
 * recorded and the tool runs exactly as before.
 */
function readRecorder(config: unknown): ClientToolRecorder | undefined {
  if (typeof config !== "object" || config === null) return undefined
  const configurable = (config as { configurable?: Record<string, unknown> }).configurable
  const candidate = configurable?.[CLIENT_TOOL_RECORDER_KEY]
  return candidate &&
    typeof (candidate as ClientToolRecorder).issue === "function" &&
    typeof (candidate as ClientToolRecorder).settle === "function"
    ? (candidate as ClientToolRecorder)
    : undefined
}
```

In `func`, after `const toolCallId = extractToolCallId(liveConfig)`, wrap the body from `const rawResult = await tool.run(...)` through the transformer loop and `return convertedResult` like so:

```ts
      // Server-kind row in the tool-call record: issued before the body runs
      // (a call the server cannot account for must not run — an issue failure
      // is the tool's error), settled in `finally` so a throw, a refusal
      // returned as text and an abort all close it. The client stub records
      // its own client-kind row and is skipped via its marker.
      const recorder = tool.clientTool === true || toolCallId === "" ? undefined : readRecorder(liveConfig)
      if (recorder) await recorder.issue({ toolCallId, toolName: tool.name })
      try {
        const rawResult = await tool.run(input, { ...existing context object... })
        ...existing body unchanged through the transformer loop...
        return convertedResult
      } finally {
        if (recorder) {
          try {
            await recorder.settle(toolCallId)
          } catch (error) {
            // The tool already ran; an unsettled server row is never answerable
            // and only delays pruning.
            console.warn(`B4: could not settle tool call ${toolCallId} for ${tool.name}.`, error)
          }
        }
      }
```

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `pnpm --filter @b4run/langchain test -- test/tool-converter.test.ts test/tool-converter-runtime.test.ts` → PASS.
Run: `pnpm --filter @b4run/langchain typecheck` → clean.

```bash
git add packages/langchain
git commit -m "feat(langchain): record every server tool call through the run's recorder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: AG-UI — `pendingToolCallIds` may be asynchronous

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts`
- Test: `packages/ag-ui/test/outbound.test.ts`

- [ ] **Step 1: Write the failing test**

Next to the existing "a success that leaves client calls parked names them in pendingToolCallIds" test (around line 806), add a sibling using the same harness shape as that test:

```ts
  test("pendingToolCallIds may be read asynchronously (the runtime reads them from its record)", async () => {
    const events = await collect(
      toAguiEvents(from([{ type: "done", data: null }]), { threadId: "t", runId: "r" }, {
        pendingToolCallIds: async () => ["call_a"],
      }),
    )
    expect(events.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "success", pendingToolCallIds: ["call_a"] },
    })
  })
```

(Use the file's own `collect`/`from` helpers; copy the exact `ctx` shape the neighbouring test passes.)

Run: `pnpm --filter @b4run/ag-ui test -- test/outbound.test.ts`
Expected: FAIL — type error, and the outcome has no `pendingToolCallIds` (a Promise has no `length`).

- [ ] **Step 2: Implement**

In `packages/ag-ui/src/outbound.ts`:

```ts
  readonly pendingToolCallIds?: () => readonly string[] | Promise<readonly string[]>
```

Make `successOutcome` async and await its callers:

```ts
  async function successOutcome(): Promise<NonNullable<RunFinishedEvent["outcome"]>> {
    const pending = (await options.pendingToolCallIds?.()) ?? []
    return pending.length > 0
      ? { type: "success", pendingToolCallIds: [...pending] }
      : { type: "success" }
  }
```

Every call site `successOutcome()` inside the async generator becomes `await successOutcome()` (grep the file; it is called where the `done` chunk and the end-of-stream build `RUN_FINISHED`).

- [ ] **Step 3: Run the ag-ui suite, typecheck, commit**

Run: `pnpm --filter @b4run/ag-ui test` → PASS (conformance tests included).
Run: `pnpm --filter @b4run/ag-ui typecheck` → clean.

```bash
git add packages/ag-ui
git commit -m "feat(ag-ui): pendingToolCallIds may be supplied asynchronously

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: CLI runtime settings — retention and the store shape check

**Files:**
- Modify: `packages/cli/src/lib/dev/client-tool-runtime.ts`
- Modify: `packages/core/src/types.ts` (the `server.agui` block)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (around line 618–636)
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (the `clientTools` default, line ~366)
- Test: `packages/cli/test/agui-client-tools.test.ts` ("client tool boot settings and request bounds")

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/agui-client-tools.test.ts`, extend the import from `client-tool-runtime.ts` with `DEFAULT_TOOL_CALL_RETENTION_MS`, `MAX_TOOL_CALL_RETENTION_MS`, `resolveToolCallRetentionMs`. Add to the "client tool boot settings and request bounds" describe:

```ts
  it("toolCallRetentionMs defaults to 7 days, and a mistyped value fails the boot", () => {
    expect(resolveToolCallRetentionMs(undefined)).toBe(DEFAULT_TOOL_CALL_RETENTION_MS)
    expect(DEFAULT_TOOL_CALL_RETENTION_MS).toBe(604_800_000)
    expect(resolveToolCallRetentionMs(1)).toBe(1)
    expect(resolveToolCallRetentionMs(MAX_TOOL_CALL_RETENTION_MS)).toBe(MAX_TOOL_CALL_RETENTION_MS)
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) {
      expect(() => resolveToolCallRetentionMs(bad)).toThrow(ClientToolConfigError)
    }
    expect(() => resolveToolCallRetentionMs(MAX_TOOL_CALL_RETENTION_MS + 1)).toThrow(ClientToolConfigError)
  })

  it("clientToolStore must also carry settle and prune", () => {
    const store = createMemoryClientToolCallStore()
    const { settle: _s, prune: _p, ...legacy } = store
    expect(() => validateClientToolStore(legacy)).toThrow(/missing settle, prune/)
  })
```

Run: `pnpm --filter @b4run/cli test -- test/agui-client-tools.test.ts -t "boot settings"`
Expected: FAIL.

- [ ] **Step 2: Implement the runtime settings**

In `packages/cli/src/lib/dev/client-tool-runtime.ts`:

```ts
/** How long a closed tool-call row is kept before the per-thread prune deletes it: 7 days. */
export const DEFAULT_TOOL_CALL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Upper bound on `server.agui.toolCallRetentionMs`: one year. */
export const MAX_TOOL_CALL_RETENTION_MS = 365 * 24 * 60 * 60 * 1000

export interface ClientToolRuntime {
  readonly store?: ClientToolCallStore
  readonly ttlMs: number
  /** Closed rows older than this are pruned on the thread's next run. */
  readonly retentionMs: number
}

/** `server.agui.toolCallRetentionMs`, validated exactly like the TTL. */
export function resolveToolCallRetentionMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TOOL_CALL_RETENTION_MS
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TOOL_CALL_RETENTION_MS
  ) {
    throw new ClientToolConfigError(
      `server.agui.toolCallRetentionMs must be a positive integer number of milliseconds no greater than ${MAX_TOOL_CALL_RETENTION_MS}; received ${describe(value)}.`,
    )
  }
  return value
}
```

Add `"settle"` and `"prune"` to `STORE_METHODS` (after `"voidOutstanding"`).

In `packages/core/src/types.ts`, in `server.agui` after `clientToolTtlMs`:

```ts
      /**
       * How long, in milliseconds, a closed tool-call record (answered, voided
       * or settled) is kept before the thread's next run prunes it. Default
       * `604800000` (7 days). Must be a positive integer no greater than one
       * year; anything else fails the boot. Open rows are never pruned.
       */
      readonly toolCallRetentionMs?: number
```

In `packages/cli/src/lib/dev/runtime-fetch-core.ts`, next to `resolveClientToolTtlMs`:

```ts
  const toolCallRetentionMs = resolveToolCallRetentionMs(aguiConfig?.toolCallRetentionMs)
  ...
  const clientTools: ClientToolRuntime = {
    ...(clientToolStore ? { store: clientToolStore } : {}),
    ttlMs: clientToolTtlMs,
    retentionMs: toolCallRetentionMs,
  }
```

(Import `resolveToolCallRetentionMs` alongside the TTL resolver.)

In `packages/cli/src/lib/dev/agui-handler.ts` line ~366, the default becomes:

```ts
    clientTools: clientToolRuntime = {
      ttlMs: DEFAULT_CLIENT_TOOL_TTL_MS,
      retentionMs: DEFAULT_TOOL_CALL_RETENTION_MS,
    },
```

(Import `DEFAULT_TOOL_CALL_RETENTION_MS` from `./client-tool-runtime.js`.) Grep the CLI `src/` and `test/` for other object literals typed `ClientToolRuntime` (`grep -rn "ttlMs:" packages/cli/src packages/cli/test`) and add `retentionMs` to each.

- [ ] **Step 3: Run, typecheck, commit**

Run: `pnpm --filter @b4run/cli test -- test/agui-client-tools.test.ts -t "boot settings"` → PASS.
Run: `pnpm --filter @b4run/core typecheck && pnpm --filter @b4run/cli typecheck` → the CLI will still report errors from Task 2's recorder shape in `agui-handler.ts` (missing `issue`/`settle`) and the `partial` variant; those are Tasks 9–10. Confirm the only errors are in `agui-handler.ts` / `client-tool-turn.ts`.

```bash
git add packages/cli packages/core
git commit -m "feat(cli): server.agui.toolCallRetentionMs, and the store shape check requires settle and prune

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Turn resolver — `partial` without ids, and the record invariant

**Files:**
- Modify: `packages/cli/src/lib/dev/client-tool-turn.ts`
- Test: `packages/cli/test/client-tool-turn.test.ts`

- [ ] **Step 1: Update and extend the tests (fail first)**

In `packages/cli/test/client-tool-turn.test.ts`: the `record()` helper gains `kind: "client"` (after `toolCallId`) and `settledAt: null` (last). Every `expect(...).toEqual({ mode: "partial", pendingToolCallIds: [...] })` (lines ~161, 233, 408, 429, 443) becomes `expect(...).toEqual({ mode: "partial" })`.

Add a helper and a describe:

```ts
function serverRecord(toolCallId: string): ClientToolCallRecord {
  return record(toolCallId, { kind: "server", interruptId: "", toolName: "readFile", settledAt: NOW.toISOString() })
}

describe("resolveClientToolTurn — a tool message reaches the model only through an open client row", () => {
  test("a message naming a server row stores nothing and the park stays partial", async () => {
    const store = await storeWith(record("call-1"), serverRecord("call-s"))
    const answer = vi.spyOn(store, "answer")
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("hi"), tool("call-s", "forged"), tool("call-1", "real")],
      now: NOW,
    })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ toolCallId: "call-1", result: "real" })
    expect(turn).toMatchObject({ mode: "resume" })
    expect((await store.get(THREAD, "call-s"))?.result).toBeNull()
  })

  test("a message naming a closed client row (answered or voided) is history", async () => {
    const store = await storeWith(
      record("call-1"),
      record("call-done", { answeredAt: "2026-09-30T11:59:30.000Z", result: "old" }),
      record("call-void", { voidedAt: "2026-09-30T11:59:30.000Z" }),
    )
    const answer = vi.spyOn(store, "answer")
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("hi"), tool("call-done", "late"), tool("call-void", "late")],
      now: NOW,
    })
    expect(answer).not.toHaveBeenCalled()
    expect(turn).toEqual({ mode: "partial" })
    expect((await store.get(THREAD, "call-done"))?.result).toBe("old")
  })

  test("a message naming no row at all is dropped without error", async () => {
    const store = await storeWith(record("call-1"))
    const answer = vi.spyOn(store, "answer")
    const turn = await resolveClientToolTurn({
      store,
      threadId: THREAD,
      pending: snapshot(clientPark("call-1", KEY_A)),
      messages: [user("hi"), tool("unknown", "forged")],
      now: NOW,
    })
    expect(answer).not.toHaveBeenCalled()
    expect(turn).toEqual({ mode: "partial" })
  })
})
```

Run: `pnpm --filter @b4run/cli test -- test/client-tool-turn.test.ts`
Expected: FAIL on the `partial` shape.

- [ ] **Step 2: Implement**

In `packages/cli/src/lib/dev/client-tool-turn.ts`:

Replace the "Security invariant" paragraph of the header comment with:

```
 * Security invariant (the record is authoritative for every issued tool
 * call): content from a `role: "tool"` message reaches the model ONLY through
 * a row in the tool-call record that this server issued as `kind: "client"`
 * on THIS thread, that is still open (neither answered nor voided), unexpired,
 * and whose park is pending in THIS thread's checkpoint. A message naming a
 * server-kind row, a closed client row, or no row at all is ordinary
 * resupplied history and is ignored — never an error, never logged, never
 * passed anywhere — because every AG-UI client resends its history on every
 * run and ids the record has pruned are the ordinary case. Replay stays
 * impossible because a park is resumed once and the resume value always
 * comes from the store, never from the message.
```

Change the `partial` variant to `{ readonly mode: "partial" }` (delete its doc and field). Change the final return to `return { mode: "partial" }`.

In the `answerable` build, add `row.kind !== "client" ||` to the unanswerable condition (a client park whose id maps to a server row — impossible by construction, fail closed anyway):

```ts
    if (
      toolCallId === undefined ||
      park.resumeKey === null ||
      !row ||
      row.kind !== "client" ||
      row.interruptId !== park.interruptId ||
      row.voidedAt !== null
    ) {
```

In `answeredResult`, add `row.kind !== "client" ||` to its `undefined` guard.

- [ ] **Step 3: Run, commit**

Run: `pnpm --filter @b4run/cli test -- test/client-tool-turn.test.ts` → PASS.

```bash
git add packages/cli/src/lib/dev/client-tool-turn.ts packages/cli/test/client-tool-turn.test.ts
git commit -m "refactor(cli): the turn resolver states the record invariant; partial carries no ids

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: AG-UI handler — recorder on every run with a store, prune, record-derived pending ids

**Files:**
- Modify: `packages/cli/src/lib/dev/agui-handler.ts`
- Test: `packages/cli/test/client-tool-park-visibility.test.ts`
- Test: `packages/cli/test/agui-client-tools.test.ts`

- [ ] **Step 1: Update the normalizer tests (fail first)**

In `packages/cli/test/client-tool-park-visibility.test.ts`, the two tests under "client tool park through toAguiEvents" pass a third argument `(id) => parked.push(id)` to `__normalizeB4StreamForTests`. Remove that argument and the `parked` array; pass `{ pendingToolCallIds: () => ["call_1"] }` directly (the ids now come from the handler's record read, which this unit does not exercise). The assertions on `TOOL_CALL_START` names and the `RUN_FINISHED` outcome stay as they are.

- [ ] **Step 2: Write the failing handler tests**

Append to `packages/cli/test/agui-client-tools.test.ts`:

```ts
describe("the tool-call record covers every tool call on a run with a store", () => {
  it("a server tool call on an opted-in app is recorded as a settled server row", async () => {
    const store = createMemoryClientToolCallStore()
    const aimock = await withModel([
      { match: { userMessage: "hello", hasToolResult: true }, response: { content: "Done." } },
      { match: { userMessage: "hello" }, response: { toolCalls: [DEPLOY_CALL] } },
    ])
    const appRoot = await fixtureApp({
      store,
      config: `export default { server: { agui: { clientTools: ["/park"], clientToolStore: globalThis.${STORE_KEY} } } }\n`,
    })
    const handler = await createHandler(appRoot)
    const threadId = `thread-${crypto.randomUUID()}`
    const first = await run(
      handler,
      aguiRequest(threadId, "run-1", [USER_HELLO], { route: "/plain#agent", tools: [] }),
    )
    expect(first.status).toBe(200)
    const rows = await store.listForThread(threadId)
    const server = rows.find((row) => row.toolCallId === "call_deploy")
    expect(server).toMatchObject({ kind: "server", toolName: "deployProd", routeId: "/plain#agent", runId: "run-1" })
    expect(server?.settledAt).not.toBeNull()
    expect(await store.listOutstanding(threadId)).toEqual([])
    void aimock
  })

  it("an app with no store records nothing and runs unchanged", async () => {
    const aimock = await withModel([
      { match: { userMessage: "hello", hasToolResult: true }, response: { content: "Done." } },
      { match: { userMessage: "hello" }, response: { toolCalls: [DEPLOY_CALL] } },
    ])
    const appRoot = await fixtureApp({ config: "export default {}\n" })
    const handler = await createHandler(appRoot)
    const threadId = `thread-${crypto.randomUUID()}`
    const first = await run(handler, aguiRequest(threadId, "run-1", [USER_HELLO], { route: "/plain#agent", tools: [] }))
    expect(first.status).toBe(200)
    expect(await resolveClientToolCallStore(appRoot)).toBeUndefined()
    void aimock
  })

  it("pendingToolCallIds on a parking turn come from the record", async () => {
    const t = await parkedRun([CALL_A, CALL_B])
    expect(finished(t.first.events)?.outcome).toEqual({ type: "success", pendingToolCallIds: ["call_a", "call_b"] })
    expect((await t.store.listOutstanding(t.threadId)).map((r) => r.toolCallId)).toEqual(["call_a", "call_b"])
  })

  it("a partial answer reports the still-open rows from the record", async () => {
    const t = await parkedRun([CALL_A, CALL_B])
    const second = await run(
      t.handler,
      aguiRequest(t.threadId, "run-2", [USER_HELLO, assistantCalls(["call_a", "call_b"]), toolResult("m3", "call_a", "A")]),
    )
    expect(finished(second.events)?.outcome).toEqual({ type: "success", pendingToolCallIds: ["call_b"] })
  })

  it("each run prunes the thread's closed rows older than the retention window, never open ones", async () => {
    const store = createMemoryClientToolCallStore()
    const t = await parkedRun([CALL_A], { store })
    const stale = (toolCallId: string, over: Partial<ClientToolCallRecord>) =>
      store.issue({
        threadId: t.threadId,
        toolCallId,
        kind: "server",
        interruptId: "",
        toolName: "readFile",
        runId: "run-0",
        routeId: "/park#agent",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        answeredAt: null,
        result: null,
        voidedAt: null,
        settledAt: null,
        ...over,
      })
    await stale("old_settled", { settledAt: "2026-01-01T00:00:01.000Z" })
    await stale("old_open", {})
    const second = await run(
      t.handler,
      aguiRequest(t.threadId, "run-2", [USER_HELLO, assistantCalls(["call_a"]), toolResult("m3", "call_a", "A")]),
    )
    expect(second.status).toBe(200)
    const ids = (await store.listForThread(t.threadId)).map((r) => r.toolCallId)
    expect(ids).not.toContain("old_settled")
    expect(ids).toContain("old_open")
  })

  it("a prune failure is logged and the run continues", async () => {
    const inner = createMemoryClientToolCallStore()
    const store: ClientToolCallStore = {
      ...inner,
      prune: async () => {
        throw new Error("prune down")
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const t = await parkedRun([CALL_A], { store })
      expect(t.first.status).toBe(200)
      expect(finished(t.first.events)?.outcome).toMatchObject({ type: "success" })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not prune"), expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })
})
```

Add `import type { ClientToolCallRecord } from "@b4run/sdk"` and `vi` to the vitest import. The `/mixed` route gates `deployProd` behind approval, so these tests use a new fixture route whose tool runs without one: add to `fixtureApp`'s `files` map `"src/app/plain/index.ts": PARK_ROUTE` and `"src/app/plain/tools/deployProd.ts": DEPLOY_TOOL` (`PARK_ROUTE` is an agent with no approve list; a route-local `tools/` directory is auto-discovered).

Run: `pnpm --filter @b4run/cli test -- test/agui-client-tools.test.ts -t "covers every tool call"`
Expected: FAIL.

- [ ] **Step 3: Implement in the handler**

In `packages/cli/src/lib/dev/agui-handler.ts`:

**(a) Recorder for every run with a store.** Replace the `clientToolRecorder` construction's condition and add the two methods:

```ts
    const clientToolRecorder: ClientToolRecorder | undefined = clientToolStore
      ? {
          has: async (toolCallId) => {
            const row = await clientToolStore.get(threadId, toolCallId)
            if (!row || row.kind !== "client" || row.voidedAt !== null) return false
            return row.answeredAt === null || resumingToolCallIds.has(toolCallId)
          },
          record: async (call) => {
            ...unchanged, but the issued record gains `kind: "client"` and `settledAt: null`...
          },
          // Server-kind rows: identity only, written by the backend converter
          // around every server tool call. Idempotent on the key, so the
          // replay of a resumed tool node is a no-op.
          issue: async (call) => {
            await clientToolStore.issue({
              threadId,
              toolCallId: call.toolCallId,
              kind: "server",
              interruptId: "",
              toolName: call.toolName,
              runId: input.runId,
              routeId: routeKey,
              issuedAt: new Date().toISOString(),
              expiresAt: null,
              answeredAt: null,
              result: null,
              voidedAt: null,
              settledAt: null,
            })
          },
          settle: async (toolCallId) => {
            await clientToolStore.settle({ threadId, toolCallId, at: new Date().toISOString() })
          },
        }
      : undefined
```

Keep the existing comments on `has`/`record`. The `runClientTools.length > 0 &&` part of the old condition goes away: that is decision B.

**(b) Prune under the run slot.** Immediately after `releaseRunBeforeStream = run.release` (line ~1017):

```ts
    // Housekeeping for the tool-call record, under the slot so no successor
    // run on this thread interleaves: closed rows older than the retention
    // window go. Open rows are never eligible, so a parked call survives
    // until the TTL abandons it. A failure here never fails the run.
    if (clientToolStore) {
      try {
        await clientToolStore.prune({
          threadId,
          before: new Date(Date.now() - clientToolRuntime.retentionMs).toISOString(),
        })
      } catch (error) {
        console.warn(`B4: could not prune the tool-call record for ${threadId}.`, error)
      }
    }
```

**(c) Record-derived `pendingToolCallIds`.** Delete `const parkedClientCallIds = new Set<string>()` and the third argument to `normalizeB4Stream(...)`. Replace the `pendingToolCallIds` option with:

```ts
                // The client-tool parks this turn left open, from the record:
                // asked when RUN_FINISHED is built, after every raw chunk has
                // been consumed, so `sawInterrupt` is final. A turn that did
                // not park has nothing pending (any stray row is voided right
                // after, in the finally).
                pendingToolCallIds: async () =>
                  sawInterrupt && clientToolStore
                    ? (await clientToolStore.listOutstanding(threadId)).map((row) => row.toolCallId)
                    : [],
```

Change `normalizeB4Stream`'s signature to drop `onClientToolPark` and the `if (raw.type === "interrupt") {...}` block that called it; update its doc comment's last sentences accordingly ("`observeInterrupts` sits upstream and still sees it, so the turn is still recorded as parked; the parked ids are read from the record when the run finishes").

**(d) Partial responses read the record.** Add a helper near `clientToolPartialResponse`:

```ts
/** The thread's open client-kind rows, by provider tool-call id, in issue order. */
async function outstandingClientCallIds(
  store: ClientToolRuntime["store"],
  threadId: string,
): Promise<readonly string[]> {
  if (!store) return []
  return (await store.listOutstanding(threadId)).map((row) => row.toolCallId)
}
```

The two `clientToolPartialResponse(...)` call sites pass `await outstandingClientCallIds(clientToolRuntime.store, threadId)` instead of `[]` / `clientTurn.pendingToolCallIds`.

**(e) `kind` filters where records are matched to parks.** In the `foreignClientPark` computation and in `closeAbandonedClientParks`'s `recordedRoutes`, add `row.kind === "client" &&` to the filter predicates.

- [ ] **Step 4: Run the CLI client-tool suites**

Run: `pnpm build` (the CLI tests load `@b4run/testing`'s `dist/`), then
`pnpm --filter @b4run/cli test -- test/agui-client-tools.test.ts test/client-tool-park-visibility.test.ts test/client-tool-abandon.test.ts test/client-tool-turn.test.ts test/client-tools-route-prep.test.ts test/client-tool-definitions.test.ts`
Expected: PASS. Pre-existing tests that assert `pendingToolCallIds` on the first run (`["call_a"]`, `["call_b"]` at lines ~296/374) keep passing because the record lists the same ids in issue order.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm --filter @b4run/cli typecheck && pnpm lint`

```bash
git add packages/cli
git commit -m "feat(cli): record every tool call on a run with a store, prune per thread, derive pendingToolCallIds from the record

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Docs, lastmod, changeset

**Files:**
- Modify: `apps/web/content/docs/ag-ui.mdx`
- Modify: `apps/web/content/docs/configuration.mdx`
- Regenerate: `apps/web/app/seo/lastmod.generated.json`
- Create: `.changeset/tool-call-record-generalization.md`

- [ ] **Step 1: ag-ui.mdx**

After the "### Abandoned calls" section, add:

```md
### The tool-call record

On an app where the store is resolved — some route is listed in
`server.agui.clientTools`, or `server.agui.clientToolStore` is set — every
tool call the model makes on an AG-UI run is recorded, not only client ones.
A server tool's row is identity only: thread, route, run, tool name, when it
was issued and when it returned or threw. No result text is stored; the
checkpoint holds the tool message. The record is what makes the rule above a
guarantee rather than a habit: a `role: "tool"` message is used only when it
names an open client call this server issued on this thread; one naming a
server call, an already-closed call, or nothing the server knows is history.

Closed rows are pruned per thread: on each run, rows closed more than
`server.agui.toolCallRetentionMs` ago (7 days by default) are deleted. Open
rows are never pruned. There is no background sweep, so a thread that is
never run again keeps its closed rows. An app with no store records nothing.
```

In "The round trip" item 1, change "The server records the call (thread, route, tool-call id, expiry)" to "The server records the call in the tool-call record (thread, route, tool-call id, expiry)". In the chunk table row for `done`, leave the wording; it still holds.

- [ ] **Step 2: configuration.mdx**

In the `server.agui` type block (line ~578), add `toolCallRetentionMs?: number` after `clientToolTtlMs?: number`. After the `clientToolTtlMs` paragraph (line ~654), add:

```md
`toolCallRetentionMs` is how long a closed tool-call record (a client call
answered or abandoned, or a server tool call that ran) is kept before the
thread's next run prunes it — `604800000` (7 days) by default; the same
bounds and boot-failure rule as `clientToolTtlMs`. With a store resolved,
every tool call on an AG-UI run is recorded, server tools included (identity
only, no result text); see
[The tool-call record](/docs/ag-ui#the-tool-call-record).
```

- [ ] **Step 3: Changeset**

Create `.changeset/tool-call-record-generalization.md`:

```md
---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/langchain": patch
"@b4run/ag-ui": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

The tool-call record behind client-provided tools now covers every tool call on an AG-UI run where the store is resolved (a route listed in `server.agui.clientTools`, or `server.agui.clientToolStore` set). A server tool call is recorded as identity only — thread, route, run, tool name, issued and settled times; no result text — and is never answerable. A `role: "tool"` message is consumed only when it names an open client call this server issued; one naming a server call, a closed call, or nothing is history. `RUN_FINISHED`'s `pendingToolCallIds` is now read from the record.

- `ClientToolCallRecord` gains `kind` (`"client" | "server"`) and `settledAt`; `ClientToolCallStore` gains `settle` and `prune`; `ClientToolRecorder` gains `issue` and `settle`. An operator-supplied `clientToolStore` must implement the new methods or the boot fails naming them. The SQLite and Postgres stores append migration 2 (`kind`, `settled_at`); existing rows read as `client`.
- New `server.agui.toolCallRetentionMs` (default 7 days): closed rows older than this are pruned on the thread's next run. Open rows are never pruned; there is no background sweep.
- `B4ToolDefinition` gains an optional `clientTool: true` marker, set only by the client-tool stub. `@b4run/ag-ui`'s `pendingToolCallIds` option may return a Promise.

An app with no store records nothing and is unchanged.
```

- [ ] **Step 4: Check docs, commit content, regenerate lastmod, commit again**

Run: `node scripts/check-docs.mjs` → no findings.

```bash
git add apps/web/content/docs/ag-ui.mdx apps/web/content/docs/configuration.mdx .changeset/tool-call-record-generalization.md
git commit -m "docs: the tool-call record covers every tool call; toolCallRetentionMs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod for the AG-UI and configuration docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Run: `pnpm --dir apps/web seo:lastmod:check` → passes.

---

### Task 12: Full verification

- [ ] **Step 1: Run the source gates in CI order**

```bash
pnpm lint && pnpm build && pnpm typecheck && pnpm test
```

Expected: all green. If a generated-app harness or scaffold test pins the `ClientToolCallStore` method list or the `pendingToolCallIds` callback shape, fix the pin in the same commit and say so.

- [ ] **Step 2: Docs and changeset checks**

```bash
node scripts/check-docs.mjs && node scripts/check-changesets.mjs
```

- [ ] **Step 3: Commit any fix-ups, then open the PR**

PR title: `feat: the tool-call record covers every tool call (follow-up to #880)`. Body: link the spec, list the behavior changes from the changeset, note the gated Postgres lane covers the migration-2 backfill test, and end with the attribution line.

---

## Self-review

**Spec coverage.** §1 record shape and store methods → Tasks 2–4. §2 recorder contract, converter writer, failure policy, marker, subagents (same converter, nothing extra) → Tasks 5–6, 10(a). §3 resolver invariant and classification → Task 9; record-derived pending ids on live and partial paths, normalizer callback removed, `kind` filters → Task 10(c)(d)(e); ag-ui async option → Task 7. §4 retention setting, prune under the slot, failure logged → Tasks 8, 10(b), plus the spec correction in Task 1. §5 edge cases: store absent/present, replay idempotence (PK), cancel (`finally`), empty id, operator store check, server-row message dropped → covered by Tasks 6, 8, 9, 10 tests. §6 testing → each task. §7 docs and changeset → Task 11. §8 exclusions → nothing added.

**Type consistency.** `kind: ToolCallRecordKind`, `settledAt`, `settle({ threadId, toolCallId, at }) → ClientToolCallSettle`, `prune({ threadId, before }) → number`, recorder `issue({ toolCallId, toolName })` / `settle(toolCallId)`, `ClientToolRuntime.retentionMs`, `resolveToolCallRetentionMs`, `DEFAULT_TOOL_CALL_RETENTION_MS`, `MAX_TOOL_CALL_RETENTION_MS`, `clientTool?: true`, `outstandingClientCallIds(store, threadId)` — used with the same names and shapes across tasks.

**Known caution for the implementer.** Postgres appends `kind` and `settled_at` after `voided_at`, and Task 4's `COLUMNS` constant and DDL pin both use that order. SQLite's `SELECT_COLUMNS` places `kind` third; that is only a projection and INSERT order, both explicit, so the two stores need not agree.
