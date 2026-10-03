# Tool-Call Record: Issuing Route and Parent `task` Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tool-call record row names the route that issued it and, for a subagent's calls, the `task` call that launched the subagent.

**Architecture:** A required `parentToolCallId: string | null` joins the record (migration 3 in SQLite and Postgres). Writers supply the call's origin: the subagent bridge puts the child route **key** into the subagent stack it already carries in the run config; a `readCallOrigin` reader in `@b4run/langchain` turns the top stack entry into `{ routeId, parentToolCallId }`; `recordToolCall` passes that `origin` through to the recorder's `issue`; the AG-UI handler's recorder resolves a missing origin to the run's route key with a null parent. Client rows are root-issued by construction and unchanged.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, `node:sqlite`, `pg`, LangChain/LangGraph, pnpm + Turbo, Node 24. Run from the repo root. Never bare `biome check --write`; format touched files only with `npx biome format --config-path ../config-biome/biome.json --write <files>` from inside the package.

**Spec:** `docs/superpowers/specs/2026-10-03-tool-call-record-parent-link-design.md`. **Branch:** `blove/tool-call-record-parent-link` (cut from main after #916).

**Contract note (resolves a wording difference in spec §3):** the recorder's `issue` receives `{ toolCallId, toolName, origin?: ToolCallOrigin }` where `ToolCallOrigin = { routeId: string; parentToolCallId: string }`; the recorder (the handler) resolves `origin ?? { routeId: <run route key>, parentToolCallId: null }` before writing the row. The spec's list of "resolved fields" is what the row ends up holding.

**Conventions that bite:** `src/` imports use `.js`, tests use `.ts` or whatever the file already does; `exactOptionalPropertyTypes` is on (conditional spreads, never `{ x: undefined }`); 2-space, no semicolons; shipped migrations are frozen (append `version: 3`); the three store type declarations (SDK, `packages/sqlite-storage/src/client-tool-calls/types.ts`, the types block in `packages/postgres-storage/src/client-tool-calls.ts`) are structural mirrors and change together; build sibling dists before cross-package tests (`pnpm build`, or per-package `pnpm --filter <pkg> build`).

---

## File map

| File | Change |
|---|---|
| `packages/sdk/src/client-tool-calls.ts` | `parentToolCallId` on the record; `ToolCallOrigin`; `issue` takes `origin?`; memory store stores the field. |
| `packages/sdk/src/index.ts` | export `ToolCallOrigin`. |
| `packages/sdk/test/client-tool-calls.test.ts` | round-trip; fixture field. |
| `packages/sqlite-storage/src/client-tool-calls/{schema,types,store}.ts` | migration 3; mirror; 14 columns. |
| `packages/sqlite-storage/test/client-tool-calls.test.ts` | round-trip; v2→v3 reads null; fixture field. |
| `packages/postgres-storage/src/{schema,client-tool-calls}.ts` | migration 3; mirror; 14 columns. |
| `packages/postgres-storage/test/client-tool-calls{,-ddl}.test.ts` | pin v3; 14-column INSERT; round-trip (gated). |
| `packages/langchain/src/tool-call-recording.ts` | `readCallOrigin`; `recordToolCall` passes `origin` through. |
| `packages/langchain/src/tool-converter.ts` | passes `origin: readCallOrigin(liveConfig)`. |
| `packages/langchain/src/subagent-tool-bridge.ts` | `ResolvedSubagentGraph.routeKey`; stack entry gains `routeKey`; the `task` row's origin is the enclosing one. |
| `packages/langchain/test/{tool-call-recording,tool-converter,subagent-tool-bridge,agent-adapter-client-tool-recorder}.test.ts` | new cases; fake recorder shapes. |
| `packages/cli/src/lib/runtime/execute-route-core.ts` | `prepareChild` returns `routeKey` via `createRouteAssistantId`. |
| `packages/cli/src/lib/dev/agui-handler.ts` | recorder resolves origin; client-row invariant comment. |
| `packages/cli/test/*.test.ts` | record literals gain `parentToolCallId: null`; fake recorders; one end-to-end subagent test in `agui-client-tools.test.ts`. |
| `apps/web/content/docs/ag-ui.mdx`, `apps/web/content/docs/api/sdk.mdx` | one sentence each. |
| `.changeset/tool-call-record-parent-link.md` | patch: sdk, langchain, cli, sqlite-storage, postgres-storage. |
| `apps/web/app/seo/lastmod.generated.json` | regenerated after the docs commit. |

---

### Task 1: SDK — the field, the origin type, the recorder contract, the memory store

**Files:**
- Modify: `packages/sdk/src/client-tool-calls.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/client-tool-calls.test.ts`

- [ ] **Step 1: Failing tests**

In the test file's `call()` and `serverCall()` helpers add `parentToolCallId: null` (last, before the spread). Append:

```ts
describe("createMemoryClientToolCallStore — origin", () => {
  it("stores the issuing route and the parent task link, null at the root", async () => {
    const store = createMemoryClientToolCallStore()
    await store.issue(serverCall({ toolCallId: "root", routeId: "/chat#agent" }))
    await store.issue(
      serverCall({
        toolCallId: "child",
        routeId: "/chat/subagents/researcher#agent",
        parentToolCallId: "call_task_1",
      }),
    )
    expect((await store.get("t1", "root"))?.parentToolCallId).toBeNull()
    expect(await store.get("t1", "child")).toMatchObject({
      routeId: "/chat/subagents/researcher#agent",
      parentToolCallId: "call_task_1",
    })
  })
})
```

Run: `pnpm --filter @b4run/sdk test` → FAIL (type error: `parentToolCallId` unknown).

- [ ] **Step 2: Implement**

In `ClientToolCallRecord`, change the `routeId` doc and add the field:

```ts
  /**
   * The route that ISSUED the call, as a route key (`<routeId>#<mode>`): the
   * AG-UI run's route for a root call, the child route for a subagent's call.
   * Client rows are only ever issued by the root route, so for them this is
   * also the route that may answer or resume the park.
   */
  readonly routeId: string
  ...
  /**
   * The nearest enclosing `task` call's provider tool-call id — the call that
   * launched the subagent this row was issued from; `null` for a root call.
   * May name a row that does not exist when that `task` ran under the bridge's
   * random fallback id; siblings still group.
   */
  readonly parentToolCallId: string | null
```

Add, after `ClientToolCallSettle`:

```ts
/** Where a server call was issued from, when not at the root: supplied by the writer. */
export interface ToolCallOrigin {
  /** The issuing route's key (`<routeId>#<mode>`). */
  readonly routeId: string
  /** The enclosing `task` call's provider id. */
  readonly parentToolCallId: string
}
```

Change the recorder's `issue`:

```ts
  /**
   * Writes a server row for one of the server's own tool calls, before it
   * runs. Idempotent on the id. `origin` is where the call was issued from
   * when inside a subagent; absent at the root, and the recorder then uses the
   * run's route key with no parent. Absent when the runtime does not record
   * server calls (no route opted into client tools and no configured store);
   * a writer that finds it absent records nothing.
   */
  issue?(call: {
    readonly toolCallId: string
    readonly toolName: string
    readonly origin?: ToolCallOrigin
  }): Promise<void>
```

The memory store needs no logic change: `issue` stores the whole record. Export `ToolCallOrigin` from `packages/sdk/src/index.ts` in the client-tool-calls type export list.

- [ ] **Step 3: Verify, commit**

`pnpm --filter @b4run/sdk test && pnpm --filter @b4run/sdk typecheck && pnpm --filter @b4run/sdk lint` → green. Format touched files.

```bash
git add packages/sdk
git commit -m "feat(sdk): tool-call rows name their issuing route and parent task call

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: SQLite — migration 3 and the 14-column row

**Files:**
- Modify: `packages/sqlite-storage/src/client-tool-calls/schema.ts`, `types.ts`, `store.ts`
- Test: `packages/sqlite-storage/test/client-tool-calls.test.ts`

- [ ] **Step 1: Failing tests**

Add `parentToolCallId: null` to the `call()` helper. Append inside the main describe:

```ts
  it("round-trips the parent task link", async () => {
    const store = newStore()
    await store.issue(serverCall({ toolCallId: "child", parentToolCallId: "call_task_1" }))
    await store.issue(serverCall({ toolCallId: "root" }))
    expect((await store.get("t-1", "child"))?.parentToolCallId).toBe("call_task_1")
    expect((await store.get("t-1", "root"))?.parentToolCallId).toBeNull()
  })

  it("migration 3 reads a version-2 row's parent link as null", async () => {
    const path = storePath()
    const v2 = new DatabaseSync(path)
    runMigrations(v2, CLIENT_TOOL_CALLS_MIGRATIONS.filter((m) => m.version <= 2))
    v2.prepare(
      `INSERT INTO client_tool_calls(thread_id, tool_call_id, kind, interrupt_id, tool_name, run_id, route_id, issued_at, expires_at, answered_at, result, voided_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("t-1", "legacy", "server", "", "readFile", "r0", "/park#agent", "2026-10-01T00:00:00.000Z", null, null, null, null, "2026-10-01T00:00:01.000Z")
    v2.close()
    const store = newStore()
    expect((await store.get("t-1", "legacy"))?.parentToolCallId).toBeNull()
  })
```

(`DatabaseSync`, `runMigrations`, `CLIENT_TOOL_CALLS_MIGRATIONS` are already imported by the migration-2 backfill test.) Rename the test "persists kind explicitly rather than relying on the backfill default" body's expectation to also select `parent_tool_call_id` and expect `null`, or leave it; and update any test asserting "thirteen columns" wording to fourteen.

Run from `packages/sqlite-storage`: `npx vitest run test/client-tool-calls.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`schema.ts`: append

```ts
  {
    // The parent `task` link for a subagent's calls; null at the root and for
    // every row that predates it. No default and no CHECK: nullable is the rule.
    version: 3,
    up: "ALTER TABLE client_tool_calls ADD COLUMN parent_tool_call_id TEXT;",
  },
```

and update the header's frozen-rule wording to "versions 1–3 are frozen; every INSERT names all fourteen columns".

`types.ts`: mirror Task 1 exactly (`routeId` doc, `parentToolCallId`, `ToolCallOrigin` exported). The store type does not reference `ToolCallOrigin` (it is a recorder concern), but mirror it anyway so the file stays a faithful copy of the SDK block.

`store.ts`: `ClientToolCallRow` gains `parent_tool_call_id: string | null`; `SELECT_COLUMNS` appends `, parent_tool_call_id`; `rowToRecord` adds `parentToolCallId: row.parent_tool_call_id`; `issue` binds 14 values with `record.parentToolCallId` last.

- [ ] **Step 3: Verify, commit**

`npx vitest run test/client-tool-calls.test.ts` → PASS. `pnpm --filter @b4run/sqlite-storage typecheck && pnpm --filter @b4run/sqlite-storage lint` → clean.

```bash
git add packages/sqlite-storage
git commit -m "feat(sqlite-storage): tool-call record migration 3 (parent_tool_call_id)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Postgres — migration 3 and the 14-column row

**Files:**
- Modify: `packages/postgres-storage/src/schema.ts`, `packages/postgres-storage/src/client-tool-calls.ts`
- Test: `packages/postgres-storage/test/client-tool-calls-ddl.test.ts`, `packages/postgres-storage/test/client-tool-calls.test.ts`

- [ ] **Step 1: DDL pin first (fails)**

Add after "pins migration 2's SQL exactly":

```ts
  it("pins migration 3's SQL exactly", () => {
    const migration = CLIENT_TOOL_CALLS_MIGRATIONS.find((m) => m.version === 3)
    expect(migration).toBeDefined()
    expect(normalize(migration?.up(NAMING) ?? "")).toBe(
      "ALTER TABLE public.b4_client_tool_calls ADD COLUMN IF NOT EXISTS parent_tool_call_id text;",
    )
  })
```

Rename "names all thirteen columns in every INSERT" to fourteen; the issued record gains `parentToolCallId: null`; the expected list appends `"parent_tool_call_id"` after `"settled_at"`; `toHaveLength(14)`. Every record literal in the DDL file gains `parentToolCallId: null`. The "declares no column DEFAULT except migration 2's backfill" loop keeps working (migration 3 has none).

Run: `pnpm --filter @b4run/postgres-storage test -- test/client-tool-calls-ddl.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`schema.ts`: append to `CLIENT_TOOL_CALLS_MIGRATIONS`:

```ts
  {
    // The parent `task` link for a subagent's calls; null at the root and for
    // every row that predates it. Nullable, no default, no CHECK.
    version: 3,
    up: (naming) => `
      ALTER TABLE ${qualify(naming, "client_tool_calls")} ADD COLUMN IF NOT EXISTS parent_tool_call_id text;
    `,
  },
```

Update the constant's doc (versions 1–3 frozen; fourteen columns).

`client-tool-calls.ts`: mirror Task 1's types; `COLUMNS` appends `, parent_tool_call_id` (last, migration order); `CallRow` gains `parent_tool_call_id: string | null`; `rowToRecord` adds `parentToolCallId: row.parent_tool_call_id ?? null`; `issue` binds `$14` = `record.parentToolCallId`.

- [ ] **Step 3: Gated test**

In `test/client-tool-calls.test.ts` add `parentToolCallId: null` to `call()` and append inside the gated describe:

```ts
  test("round-trips the parent task link and reads a pre-migration row as null", async () => {
    await withStore(async (store) => {
      await store.issue(
        call({ toolCallId: "child", kind: "server", interruptId: "", parentToolCallId: "call_task_1" }),
      )
      expect((await store.get("t-1", "child"))?.parentToolCallId).toBe("call_task_1")
      await store.issue(call({ toolCallId: "root", kind: "server", interruptId: "" }))
      expect((await store.get("t-1", "root"))?.parentToolCallId).toBeNull()
    })
  })
```

(The v1→v2 backfill test already proves the migration path; a v2→v3 Postgres row reads `null` by the column's nullability — no extra test.)

- [ ] **Step 4: Verify, commit**

`pnpm --filter @b4run/postgres-storage test` (ungated) → PASS; `B4_TEST_PGSTORAGE=1 npx vitest run test/client-tool-calls.test.ts test/client-tool-calls-ddl.test.ts` from `packages/postgres-storage` if Docker is up (say so if not); `typecheck`, `lint` clean.

```bash
git add packages/postgres-storage
git commit -m "feat(postgres-storage): tool-call record migration 3 (parent_tool_call_id)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: LangChain — `readCallOrigin`, origin pass-through, the bridge's route key

**Files:**
- Modify: `packages/langchain/src/tool-call-recording.ts`
- Modify: `packages/langchain/src/tool-converter.ts` (line ~96: the `recorded` object)
- Modify: `packages/langchain/src/subagent-tool-bridge.ts` (`ResolvedSubagentGraph`, `B4SubagentStackEntry`, `isSubagentStackEntry`, the stack entry and the `recordToolCall` call in `func`)
- Test: `packages/langchain/test/tool-call-recording.test.ts`, `tool-converter.test.ts`, `subagent-tool-bridge.test.ts`, `agent-adapter-client-tool-recorder.test.ts`

- [ ] **Step 1: Failing tests**

`tool-call-recording.test.ts` — add `import { readCallOrigin } from "../src/tool-call-recording.ts"` (same import line as `recordToolCall`) and append:

```ts
describe("readCallOrigin", () => {
  const entry = (callId: string, routeKey: string) => ({
    callId,
    name: "researcher",
    routeId: routeKey.replace(/#.*$/, ""),
    routeKey,
  })

  it("is undefined at the root (no stack, empty stack, no metadata)", () => {
    expect(readCallOrigin(undefined)).toBeUndefined()
    expect(readCallOrigin({ metadata: {} })).toBeUndefined()
    expect(readCallOrigin({ metadata: { b4: { subagent_stack: [] } } })).toBeUndefined()
  })

  it("names the top stack entry's route key and task call id", () => {
    const config = {
      metadata: {
        b4: {
          subagent_stack: [
            entry("call_task_outer", "/chat/subagents/planner#agent"),
            entry("call_task_inner", "/chat/subagents/planner/subagents/researcher#agent"),
          ],
        },
      },
    }
    expect(readCallOrigin(config)).toEqual({
      routeId: "/chat/subagents/planner/subagents/researcher#agent",
      parentToolCallId: "call_task_inner",
    })
  })

  it("ignores an entry without a route key", () => {
    const config = { metadata: { b4: { subagent_stack: [{ callId: "x", name: "n", routeId: "/r" }] } } }
    expect(readCallOrigin(config)).toBeUndefined()
  })
})

describe("recordToolCall — origin", () => {
  it("passes the origin through to issue untouched, and omits it when absent", async () => {
    const issued: unknown[] = []
    const rec = {
      has: async () => false,
      record: async () => {},
      issue: async (call: unknown) => {
        issued.push(call)
      },
      settle: async () => {},
    }
    const config = { configurable: { [CLIENT_TOOL_RECORDER_KEY]: rec } }
    const origin = { routeId: "/chat/subagents/researcher#agent", parentToolCallId: "call_task_1" }
    await recordToolCall(config, { toolCallId: "c1", toolName: "readFile", origin }, async () => "ok")
    await recordToolCall(config, { toolCallId: "c2", toolName: "readFile" }, async () => "ok")
    expect(issued).toEqual([
      { toolCallId: "c1", toolName: "readFile", origin },
      { toolCallId: "c2", toolName: "readFile" },
    ])
  })
})
```

`tool-converter.test.ts` — in the "the tool-call record" describe, make the fake `issue` push the whole call (`log.push(JSON.stringify(call))` is fine, or keep the string log and add one new test):

```ts
  it("inside a subagent, records the child's route key and the launching task", async () => {
    const issued: unknown[] = []
    const rec = {
      has: vi.fn(async () => false),
      record: vi.fn(async () => {}),
      issue: async (c: unknown) => {
        issued.push(c)
      },
      settle: async () => {},
    }
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => "ok",
    })
    await tool.invoke(call, {
      ...configWith(rec),
      metadata: {
        b4: {
          subagent_stack: [
            { callId: "call_task_1", name: "researcher", routeId: "/chat/subagents/researcher", routeKey: "/chat/subagents/researcher#agent" },
          ],
        },
      },
    })
    expect(issued).toEqual([
      {
        toolCallId: "call_1",
        toolName: "probe",
        origin: { routeId: "/chat/subagents/researcher#agent", parentToolCallId: "call_task_1" },
      },
    ])
  })
```

`subagent-tool-bridge.test.ts` — the `allowedChild` helper's child gains `routeKey: \`${routeId}#agent\``; in the first existing test that inspects `childConfig.metadata.b4.subagent_stack`, extend the expected entry with `routeKey: "/parent/subagents/researcher#agent"`. In the "the tool-call record" describe, change the fake `issue` to push the whole call object and add:

```ts
  it("records a root task with no origin, and a nested task with the enclosing subagent's origin", async () => {
    const issued: unknown[] = []
    const rec = {
      has: vi.fn(async () => false),
      record: vi.fn(async () => {}),
      issue: async (c: unknown) => {
        issued.push(c)
      },
      settle: async () => {},
    }
    const child = { invoke: vi.fn(async () => childResult("Done.")) }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    await tool.func(INPUT, undefined, withRecorder(rec))
    await tool.func(INPUT, undefined, withRecorder(rec, {
      toolCall: { id: "call_task_2" },
      metadata: {
        b4: {
          subagent_depth: 1,
          subagent_stack: [
            { callId: "call_task_1", name: "planner", routeId: "/parent/subagents/planner", routeKey: "/parent/subagents/planner#agent" },
          ],
        },
      },
    }))
    expect(issued).toEqual([
      { toolCallId: "call_task_1", toolName: "task" },
      {
        toolCallId: "call_task_2",
        toolName: "task",
        origin: { routeId: "/parent/subagents/planner#agent", parentToolCallId: "call_task_1" },
      },
    ])
  })
```

(`withRecorder`'s default `toolCall.id` is `"call_task_1"`; the second call overrides it. If `withRecorder`'s spread puts `extra` after `toolCall`, that override works; check the helper.)

`agent-adapter-client-tool-recorder.test.ts` — its fake recorder's `issue` signature, if typed, accepts the new call shape (an untyped `async () => {}` needs nothing).

Run from `packages/langchain`: `npx vitest run test/tool-call-recording.test.ts test/tool-converter.test.ts test/subagent-tool-bridge.test.ts` → the new cases FAIL.

- [ ] **Step 2: Implement**

`tool-call-recording.ts`:

```ts
import { CLIENT_TOOL_RECORDER_KEY, type ClientToolRecorder, type ToolCallOrigin } from "@b4run/sdk"
...
/**
 * Where the current tool call is being issued from, read off the subagent
 * stack the bridge carries in `config.metadata.b4.subagent_stack`: the top
 * entry's route key and the `task` call that launched it. `undefined` at the
 * root, and for a stack entry written before route keys were stacked.
 */
export function readCallOrigin(config: unknown): ToolCallOrigin | undefined {
  if (typeof config !== "object" || config === null) return undefined
  const b4 = (config as { metadata?: { b4?: unknown } }).metadata?.b4
  if (typeof b4 !== "object" || b4 === null) return undefined
  const stack = (b4 as { subagent_stack?: unknown }).subagent_stack
  if (!Array.isArray(stack) || stack.length === 0) return undefined
  const top = stack[stack.length - 1] as { callId?: unknown; routeKey?: unknown }
  if (typeof top.callId !== "string" || typeof top.routeKey !== "string") return undefined
  return { routeId: top.routeKey, parentToolCallId: top.callId }
}

export async function recordToolCall<T>(
  config: unknown,
  call: { readonly toolCallId: string; readonly toolName: string; readonly origin?: ToolCallOrigin },
  body: () => Promise<T>,
): Promise<T> {
  ...unchanged: `await recorder.issue(call)` already forwards `origin` when present...
}
```

(`issue(call)` forwards the object as given; a caller that omits `origin` yields no `origin` key, satisfying `exactOptionalPropertyTypes`.)

`tool-converter.ts` line ~96:

```ts
      const origin = readCallOrigin(liveConfig)
      const recorded =
        tool.clientTool === true
          ? undefined
          : { toolCallId, toolName: tool.name, ...(origin ? { origin } : {}) }
```

(import `readCallOrigin` alongside `recordToolCall`).

`subagent-tool-bridge.ts`:
- `ResolvedSubagentGraph` gains `/** The child route's key (`<routeId>#<mode>`), as the tool-call record names routes. */ readonly routeKey: string`.
- `B4SubagentStackEntry` gains `readonly routeKey: string`; `isSubagentStackEntry` requires `typeof entry.routeKey === "string"`.
- The stack entry: `{ callId, name: input.subagent, routeId: resolved.child.routeId, routeKey: resolved.child.routeKey }`.
- The `recordToolCall` call: compute `const origin = readCallOrigin(liveConfig)` before it (the stack **before** this task pushes its own entry — that is `liveConfig`'s stack) and pass `{ toolCallId: providerCallId ?? "", toolName: tool.name, ...(origin ? { origin } : {}) }`. Import `readCallOrigin`.
- Events keep `route_id: resolved.child.routeId` (bare id) — unchanged on the wire.

- [ ] **Step 3: Verify, commit**

From `packages/langchain`: `npx vitest run test/tool-call-recording.test.ts test/tool-converter.test.ts test/subagent-tool-bridge.test.ts test/agent-adapter-client-tool-recorder.test.ts` → PASS; then `pnpm --filter @b4run/langchain test` (whole package), `typecheck`, `lint` → clean.

```bash
git add packages/langchain
git commit -m "feat(langchain): tool calls record their issuing route and parent task

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: CLI — the child route key, the recorder resolves origin, fixture fallout, one end-to-end test

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts` (`prepareChild`'s return, ~line 1731)
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (recorder `issue`, ~line 975; the foreign-park comment ~line 700)
- Test: `packages/cli/test/agui-client-tools.test.ts`, plus every CLI test with a `ClientToolCallRecord` literal or a fake recorder (`grep -rln "settledAt: null\|issue:" packages/cli/test`)

- [ ] **Step 1: Failing end-to-end test**

In `agui-client-tools.test.ts`, add to `fixtureApp`'s `files` map:

```ts
    "src/app/plain/subagents/researcher/index.ts": PARK_ROUTE,
    "src/app/plain/subagents/researcher/tools/readNote.ts": READ_NOTE_TOOL,
```

with, near `DEPLOY_TOOL`:

```ts
const READ_NOTE_TOOL = [
  "/** Read a note. */",
  "export default async function readNote(input: { id: string }): Promise<string> {",
  '  return "note " + input.id',
  "}",
  "",
].join("\n")
```

Append to the describe "the tool-call record covers every tool call on a run with a store":

```ts
  it("a subagent's calls name the child route and the task that launched them; the task row names the run's route", async () => {
    const store = createMemoryClientToolCallStore()
    await withModel([
      // Parent: turn 1 calls task; once the task result is back, replies.
      { match: { userMessage: "hello", hasToolResult: true }, response: { content: "Done." } },
      {
        match: { userMessage: "hello" },
        response: {
          toolCalls: [{ id: "call_task_1", name: "task", arguments: { subagent: "researcher", input: "read note 7" } }],
        },
      },
      // Child: calls readNote, then replies.
      { match: { userMessage: "read note 7", hasToolResult: true }, response: { content: "note 7 read." } },
      {
        match: { userMessage: "read note 7" },
        response: { toolCalls: [{ id: "call_read_1", name: "readNote", arguments: { id: "7" } }] },
      },
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
    const rows = new Map((await store.listForThread(threadId)).map((r) => [r.toolCallId, r]))
    expect(rows.get("call_task_1")).toMatchObject({
      kind: "server",
      toolName: "task",
      routeId: "/plain#agent",
      parentToolCallId: null,
      runId: "run-1",
    })
    expect(rows.get("call_read_1")).toMatchObject({
      kind: "server",
      toolName: "readNote",
      routeId: "/plain/subagents/researcher#agent",
      parentToolCallId: "call_task_1",
      runId: "run-1",
    })
    expect(rows.get("call_read_1")?.settledAt).not.toBeNull()
    expect(rows.get("call_task_1")?.settledAt).not.toBeNull()
  })
```

If aimock's `match` cannot separate the child's model requests by `userMessage` (the child receives `read note 7` as its user message — check the `script` builder used in `packages/cli/test/subagent-registry-runtime.test.ts` lines 27–70 and use that API instead if simpler), adapt the fixtures; the assertions are the point. If the `/plain` parent needs an explicit subagent registration, look at how `subagent-runtime.test.ts`'s `nestedFixtureApp` lays out routes (a `subagents/<name>/index.ts` under the parent is auto-discovered).

Run from `packages/cli`: `npx vitest run test/agui-client-tools.test.ts -t "subagent's calls"` → FAIL (typecheck or `routeId`/`parentToolCallId` mismatch).

- [ ] **Step 2: Implement**

`execute-route-core.ts`, `prepareChild`'s return object: add `routeKey: createRouteAssistantId(route.id, route.kind),` (import `createRouteAssistantId` from `./route-identity.js`; `RouteDefinition.kind` is the `RouteKind`).

`agui-handler.ts`, the recorder's `issue`:

```ts
                issue: async (call: {
                  readonly toolCallId: string
                  readonly toolName: string
                  readonly origin?: ToolCallOrigin
                }) => {
                  // The writer says where the call was issued from (a subagent's
                  // route and its launching `task`); at the root it is this run's
                  // route with no parent.
                  const origin = call.origin ?? { routeId: routeKey, parentToolCallId: null }
                  await clientToolStore.issue({
                    threadId,
                    toolCallId: call.toolCallId,
                    kind: "server",
                    interruptId: "",
                    toolName: call.toolName,
                    runId: input.runId,
                    routeId: origin.routeId,
                    issuedAt: new Date().toISOString(),
                    expiresAt: null,
                    answeredAt: null,
                    result: null,
                    voidedAt: null,
                    settledAt: null,
                    parentToolCallId: origin.parentToolCallId,
                  })
                },
```

(import `ToolCallOrigin` type from `@b4run/sdk`). `record` (client rows) adds `parentToolCallId: null`. Where the handler compares a client row's `routeId` to the request's route (the `foreignClientPark` computation and `closeAbandonedClientParks`'s `recordedRoutes`), add one comment: "Client rows are issued by the root route only (child routes get no client-tool stubs), so a client row's `routeId` is the route that answers its park."

Fixture fallout: every `ClientToolCallRecord` literal in `packages/cli/test` gains `parentToolCallId: null`; any typed fake recorder `issue` accepts `origin?`.

- [ ] **Step 3: Verify, commit**

`pnpm build` (root) if dists are stale, then from `packages/cli`: `npx vitest run test/agui-client-tools.test.ts test/client-tool-park-visibility.test.ts test/client-tool-abandon.test.ts test/client-tool-turn.test.ts test/client-tools-command.test.ts test/client-tools-command-parsing.test.ts test/subagent-runtime.test.ts test/subagent-interrupts.test.ts test/subagent-registry-runtime.test.ts` → PASS. `pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli lint` → clean.

```bash
git add packages/cli
git commit -m "feat(cli): child routes carry their route key; server rows record their origin

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Docs, changeset, lastmod

**Files:**
- Modify: `apps/web/content/docs/ag-ui.mdx` ("### The tool-call record", first paragraph)
- Modify: `apps/web/content/docs/api/sdk.mdx` (the `ClientToolCallRecord` row)
- Create: `.changeset/tool-call-record-parent-link.md`
- Regenerate: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: ag-ui.mdx**

In the first paragraph of "### The tool-call record", replace "the subagent's own tool calls are recorded against the parent thread." with: "the subagent's own tool calls are recorded against the parent thread, each naming the child route that issued it and the `task` call that launched the subagent (`parentToolCallId`; `null` for a root call)."

- [ ] **Step 2: api/sdk.mdx**

Change the `ClientToolCallRecord` row's description to: "Describe one row of the tool-call record: a client-provided call the server issued and is waiting on, or a server tool call recorded for identity — with the route that issued it and, inside a subagent, the launching `task` call." Add a row for `ToolCallOrigin`: "Say where a server tool call was issued from when inside a subagent: the child route's key and the launching `task` call id."

- [ ] **Step 3: Changeset**

```md
---
"@b4run/sdk": patch
"@b4run/langchain": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

Tool-call record rows now say where they were issued from. `routeId` is the route that issued the call — for a subagent's tool calls, the child route's key rather than the parent's — and a new required `parentToolCallId` (`null` at the root) names the `task` call that launched the subagent. The SQLite and Postgres stores append migration 3 (`parent_tool_call_id`, nullable); rows that predate it read `null`. `ClientToolRecorder.issue` takes an optional `origin` (`ToolCallOrigin`) the writer supplies; the runtime resolves a missing origin to the run's route with no parent.

Breaking for custom stores and recorder fakes: `ClientToolCallRecord.parentToolCallId` is required, and a store must persist it. Client rows are unchanged: they are only ever issued by the root route.
```

- [ ] **Step 4: Checks, commits, lastmod**

```bash
node scripts/check-docs.mjs && node scripts/check-changesets.mjs
git add apps/web/content/docs/ag-ui.mdx apps/web/content/docs/api/sdk.mdx .changeset/tool-call-record-parent-link.md
git commit -m "docs: tool-call rows name their issuing route and parent task

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod for the AG-UI and SDK API docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod:check; echo "exit $?"
```

---

### Task 7: Full verification and PR

- [ ] **Step 1:** `pnpm lint && pnpm build && pnpm typecheck && pnpm test > gate.log 2>&1; echo "EXIT $?"` from the repo root, then READ the summary lines (`grep -E "Test Files|^EXIT" gate.log`) before doing anything else. Failures in `k8s-compat`, Vercel, `b4 dev` lifecycle or software-factory suites under heavy load are known timing flakes (#535); rerun any such file in isolation and report plainly.
- [ ] **Step 2:** `git push -u origin blove/tool-call-record-parent-link`, then `gh pr create --base main` with a body that links the spec, states the `routeId` meaning change for child rows and the required field as breaking for custom stores, lists the test plan honestly, and ends with the attribution line.

---

## Self-review

**Spec coverage.** §1 column meanings → Tasks 1 (docs on the type), 5 (handler resolves root origin; invariant comment). §2 migration 3 + required field + mirrors → Tasks 1–3. §3 writers decide origin: recorder contract (`issue` with `origin?`) → Task 1; stack entry route key + `ResolvedSubagentGraph.routeKey` + `prepareChild` → Tasks 4, 5; `readCallOrigin` + pass-through + converter/bridge callers → Task 4; fallback-id dangling link → no code, covered by `readCallOrigin` using `callId` as-is. §4 unchanged areas → no tasks (the invariant comment only). §5 edge cases: nesting (Task 4 test with two entries), same key in both roles (nothing to do), replay (idempotent `issue`, unchanged). §6 tests → Tasks 1–5 incl. the CLI end-to-end case. §7 docs/changeset → Task 6. §8 out of scope → nothing added.

**Type consistency.** `ToolCallOrigin { routeId, parentToolCallId }` (Task 1) is what `readCallOrigin` returns and what `recordToolCall`'s `call.origin` and the recorder's `issue` carry (Tasks 4, 5). `ResolvedSubagentGraph.routeKey` and the stack entry's `routeKey` (Task 4) are set by `prepareChild` (Task 5) with `createRouteAssistantId(route.id, route.kind)`. `parentToolCallId: string | null` everywhere.

**Placeholders.** None; the "unchanged" markers in Task 4's `recordToolCall` body and the handler's `issue` refer to code quoted in the same step.
