# Activity Restore From Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host can rebuild a full-fidelity activity `TurnsView` for a thread from B4's existing storage after a reload: `GET /threads/:id/turns` served by the CLI, backed by a pure `turnsFromState()` in `@b4run/ag-ui/view` that synthesises AG-UI events from the checkpoint chain and folds them through the unchanged `reduceTurns`.

**Architecture:** Three PRs on one branch (spec `docs/superpowers/specs/2026-10-05-activity-restore-from-storage-design.md`). PR 1 stamps the facts a turn needs where they are born: a complete `additional_kwargs.b4_step` on every ToolMessage (the `task` tool included, with `b4_subagent` naming the child's checkpoint namespace), the permission decision reported by the gate wrappers into that stamp, a `b4:turn` end record re-put onto the head checkpoint's metadata when a run ends, and a `listNamespaces` method on both checkpointers. PR 2 adds `turnsFromState` to the view entry: it reads the serialized LangChain message envelopes, emits the events the live stream would have carried, and reduces them. PR 3 adds the endpoint next to `/state` with `/pending_interrupts`' gate, fixes `/state.created_at`, and moves the docs and pins. No run id, no new table, no backward compatibility.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), LangChain core messages + LangGraph checkpoint savers (SQLite via `node:sqlite`, Postgres via `pg`), `@ag-ui/core` 1.0.1 event types, Vitest 4, Biome (always `--config-path packages/config-biome/biome.json`), Node 24.

---

## Mapping facts the tasks rely on

- **Precondition: PR cacheplane/b4run#936 (denial branding) must be merged first.** It adds `packages/sdk/src/tool-denial.ts` (`toolDenial`, `isToolDenial`, `TOOL_DENIAL`), makes `wrapToolWithApproval`/`wrapToolWithConstraint` return `toolDenial(...)`, adds `describeDenied(display)` in `packages/langchain/src/tool-display.ts`, and teaches `unwrapToolResult` the branded shape. Start this plan's branch from main after #936 lands (`git log --oneline origin/main | grep -i "brand denied"`). Task 3 builds on `isToolDenial`.
- **Converter today** (`packages/langchain/src/tool-converter.ts:85-251`): builds a `ToolMessage` only when `partsForUi` or a display `step` exists; otherwise returns the raw string and LangChain wraps it. `B4_STEP_KEY = "b4_step"`, `B4_CONTENT_PARTS_KEY = "b4_content_parts"`. `step` is `describeDone(display, input, rawResult, tool.name)`. No try/catch: a thrown tool reaches `agent-middleware.ts:112-121` `wrapToolCall`, which returns `toolErrorMessage(error, name, id)` — a `status: "error"` ToolMessage with no `additional_kwargs`. The tool run context type (langchain local `B4ToolDefinition.run` at `:38-57` and core `packages/core/src/types.ts` `B4ToolDefinition`) is `{ middleware?, signal, threadId?, params?, toolCallId? }`.
- **Bridge today** (`packages/langchain/src/subagent-tool-bridge.ts:51-176`): returns plain strings on every path (`[B4_E5003] …` depth, `resolved.message`, `subagent_failed: …`, `extractFinalAiText(output)`); rethrows GraphInterrupt/abort. `childConfig` spreads `liveConfig`, so the child checkpoints under `liveConfig.configurable.checkpoint_ns` (LangGraph sets it to `tools:<task id>` for the task; verified in the navlog example's database). `recordToolCall(config, call, body)` wraps the body.
- **Gate today** (`packages/core/src/capabilities/permission-gate.ts`): `GateResult = { allowed: true } | { allowed: false; reason; code? }` (`:15`); `emitPermissionInterrupt` reads `interrupt(...)` as `"once" | "always" | "deny"` and returns `"allow" | "deny"` (`:461,:536-554`); `wrapToolWithApproval` (`:324-343`) and `wrapToolWithConstraint` (`:376-411`) call `gateToolOp` and read `(context as { readonly toolCallId?: string }).toolCallId`. The decision is not observable in the tool body.
- **Saver wrapper** (`packages/cli/src/lib/runtime/checkpoint-route-provenance.ts`): a Proxy over the saver that only intercepts `put`, recomputing `"b4:checkpoint-routes"` from the parent. The HTTP handlers hold the RAW saver (`getCheckpointer(request)`), so a re-put of the head through the raw saver keeps that stamp as stored. `BaseCheckpointSaver.put(config, checkpoint, metadata, newVersions)` upserts on `(thread_id, checkpoint_ns, checkpoint_id)` in both savers; `parent_checkpoint_id` comes from `config.configurable.checkpoint_id`, so a re-put passes `tuple.parentConfig` (or `{thread_id, checkpoint_ns}` with no id for a root checkpoint).
- **Terminal sites** (where a run's end is known): `agui-handler.ts` finally block (`terminalChunk`, `sawInterrupt`, `run.cancelled`, `threadsStore.updateStatus(... terminalStatus(...))` at `:1394`); `runtime-fetch-core.ts` `handleApStreamRequest` success (`:2876`) and catch (`:2916`), `handleResumeRequest` success (`:4272`) and catch (`:4309`), `handleApWaitRequest` (`:3351`, always `"idle"`). All five have `checkpointer`, `threadId`, `sawInterrupt`, and either `terminalChunk?.output.error` / `run.cancelled` or the AG-UI `RUN_ERROR` message.
- **Savers:** `packages/sqlite-storage/src/checkpointer/saver.ts` (`B4SqliteSaver`, `this.db.prepare(sql).all(...)`), `packages/postgres-storage/src/checkpointer.ts` (`B4PostgresSaver`, `await this.ready()` then `this.pool.query<Row>(sql, params)` against `this.checkpointsTable`, `COLLATE "C"`). Conformance suite `packages/testing/src/checkpointer-conformance.ts` (`runCheckpointerConformance({ name, makeSaver, describe, close?, supports? })`), instantiated by `packages/testing/test/checkpointer-conformance.test.ts` (SQLite) and `packages/postgres-storage/test/checkpointer-conformance.test.ts` (Postgres, `B4_TEST_PGSTORAGE=1`). SQLite `list()` yields tuples without `pendingWrites`; both decode with `JsonPlusSerializer`, so `channel_values.messages` are LangChain class instances server-side; `JSON.stringify` turns each into `{ lc: 1, type: "constructor", id: [..., "ToolMessage"], kwargs: {...} }`, which is what `/state` clients (and `examples/navlog/web/app/lib/hydrate.ts`) read.
- **Endpoint patterns** (`packages/cli/src/lib/dev/runtime-fetch-core.ts`): routes are `RouteMatcher { method, pattern, handle(request, params) }` objects in an array; `/state` at `:2139-2180` (404 `"No checkpoint found for thread"`, `created_at: new Date().toISOString()` at `:2170`); `/pending_interrupts` at `:2182-2201` → `handleApPendingInterruptsRequest` (`:3415-3655`): thread row first (404 `thread_not_found` with `createRequestErrorBody("Thread not found", { code: "thread_not_found" })`), thread-access gate via `makeThreadGate(threadAccess, request)({ action: "read", notFound, operation: "thread.pending_interrupts", threadId, thread })`, then route identity (`readParkedRoute(thread) ?? threadRouteMap.get(threadId) ?? thread.metadata.route`, 409 `thread_route_unknown`), route middleware (`runMiddleware`, `method: "GET"`), then `readPendingInterrupts(checkpointer, threadId)` → `withoutClientToolParks` → `{ interruptId, resumeKey, value, grant? }`. `ThreadOperation` union lives in `packages/sdk/src/thread-access.ts:50-63`, pinned member-by-member in `packages/sdk/test/thread-access.contract.ts:27-44`.
- **View entry** (`packages/ag-ui/src/view/`): `reduceTurns(state, event, { now, hiddenTools, resuming })`, `readStepEvent`, `readPlan` (exported from `subagent-runs.ts`), `B4_PLAN_ACTIVITY_TYPE` from `../activities.js`, `toAguiInterrupt` from `../interrupts.ts` (internal, importable by view code). Public-api test pins the sorted export list and the no-React file list (`test/view/public-api.test.ts`). Live event shapes to mirror: `outbound.ts:379-387` (reasoning), `:696-708` (result then `failed` step), `:810-839` (`SUBAGENT_*`), `:497-530` (`RUN_FINISHED`).
- **Docs and pins to move** (PR 3): `apps/web/content/docs/dev-server/agent-protocol.mdx` table (`:34-47`) and the sections at `:151-169`, `:233-239`; `scripts/check-docs.mjs` required strings for that page (`:2797-2840`) and the endpoint pin loop (`:5040-5050`); `apps/web/app/llms.txt/route.ts:112-128` endpoint list; `apps/web/content/docs/thread-access.mdx:141-152` default-deny table (mirrored in `packages/cli/docs/thread-access.md`); `apps/web/content/docs/security-architecture.mdx:36`; `apps/web/content/docs/ag-ui.mdx:569` and `:641`; `apps/web/content/docs/api/ag-ui.mdx` `./view` table (`:98-135`) and `api/sdk.mdx` for new SDK exports (the inventory diffs tables against barrels both ways); specs `2026-10-03-b4-activity-components-design.md:193-197,358-361` and `2026-08-09-ap-stream-reattach-design.md:422`; `apps/web/content/docs/upgrading.mdx` (newest-first entries starting "Landed in the first release after **0.13.1**."); changesets are fixed-group `patch` with a `**Breaking:**` lead (`.changeset/agui-protobuf-transport.md` is the model). Every docs change needs `pnpm --dir apps/web seo:lastmod` after committing.
- **Conventions:** commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; format from the owning package dir with `npx biome check --write --config-path ../config-biome/biome.json <paths>` (never bare `biome check --write` at root); `src/` imports `.js`, tests `.ts` (the ag-ui package's tests use `.js`; follow the file you are in); conditional spreads for optional fields; stage only your own files; run from the repo root with Node 24 (`source ~/.nvm/nvm.sh; nvm use 24`).

## File structure

```
packages/sdk/src/persisted-turn.ts                 NEW: stamp keys, PersistedStep/PersistedSubagent/PersistedTurnEnd, GateDecision, readers
packages/sdk/src/index.ts                          export them
packages/core/src/types.ts                         B4ToolDefinition.run context gains onGateDecision?
packages/core/src/capabilities/permission-gate.ts  GateResult.decision; emitPermissionInterrupt returns the decision; wrappers report it
packages/langchain/src/tool-converter.ts           always a ToolMessage; complete b4_step (timing, status, decision); thrown → failed ToolMessage
packages/langchain/src/subagent-tool-bridge.ts     returns a ToolMessage with b4_step + b4_subagent (checkpointNs)
packages/cli/src/lib/dev/turn-end-stamp.ts         NEW: stampTurnEnd(checkpointer, threadId, end) re-puts the head with "b4:turn"
packages/cli/src/lib/dev/agui-handler.ts           call stampTurnEnd at the terminal site
packages/cli/src/lib/dev/runtime-fetch-core.ts     call stampTurnEnd at the four AP sites; /turns route; /state.created_at fix
packages/cli/src/lib/dev/thread-turns.ts           NEW: handleApThreadTurnsRequest + loadThreadStateForTurns
packages/cli/src/lib/runtime/execute-route-core.ts corrected comment (children DO checkpoint)
packages/sqlite-storage/src/checkpointer/saver.ts  listNamespaces(threadId)
packages/postgres-storage/src/checkpointer.ts      listNamespaces(threadId)
packages/testing/src/checkpointer-conformance.ts   listNamespaces conformance test
packages/ag-ui/src/view/turns-from-state.ts        NEW: ThreadStateForTurns, synthesiser, turnsFromState
packages/ag-ui/src/view/index.ts                   export it
packages/sdk/src/thread-access.ts                  ThreadOperation gains "thread.turns"
tests: packages/{core,langchain,cli,sqlite-storage,ag-ui,sdk}/test/**, packages/testing/src
docs: agent-protocol.mdx, ag-ui.mdx, api/ag-ui.mdx, api/sdk.mdx, thread-access.mdx (+ packages/cli/docs copy), security-architecture.mdx, upgrading.mdx, llms.txt/route.ts, scripts/check-docs.mjs, two specs, three changesets, lastmod
```

---

### Task 0: Amend the spec's gate wording and branch

**Files:**
- Modify: `docs/superpowers/specs/2026-10-05-activity-restore-from-storage-design.md` (§4 bullets 2–3, §5 table last row)

The extraction found that `/pending_interrupts` requires the thread ROW (404 `thread_not_found` when missing, even with checkpoints) and that a denied read is the same 404 bytes as a miss, never a 403. The spec said "404 when neither row nor checkpoint exists" and "403". Align the spec with the endpoint it copies.

- [ ] **Step 1: Branch**

```bash
git fetch origin main
git log --oneline origin/main | grep -i "brand denied" || echo "WAIT: #936 not merged yet"
git checkout -B blove/activity-restore-storage origin/main
```

- [ ] **Step 2: Edit the spec**

In §4 replace the two bullets beginning "404 when neither the thread row" and "Gate:" with:

```md
- 404 `thread_not_found` when the thread row is missing (the checkpointer is a separate store; a
  transcript without a row is not served), exactly as `/pending_interrupts`.
- Gate: the one `/pending_interrupts` enforces — the thread-access read gate with operation
  `thread.turns` (a denied read returns the same 404 bytes as a genuine miss), then the parking
  route's middleware with the route identity resolved thread-first (409 `thread_route_unknown`
  when no route is recorded). A parked gate's payload is never exposed more widely than today.
```

In §5 replace the last row with `| Gate denial / unknown thread / no recorded route | 404 same bytes as a miss / 404 \`thread_not_found\` / 409 \`thread_route_unknown\` |`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-05-activity-restore-from-storage-design.md
git commit -m "docs(spec): /turns follows /pending_interrupts gate semantics exactly

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

# PR 1 — Stamps into existing storage

### Task 1: Persisted-turn types and readers in the SDK

**Files:**
- Create: `packages/sdk/src/persisted-turn.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/persisted-turn.test.ts`
- Docs: `apps/web/content/docs/api/sdk.mdx` (rows for every new export; the inventory diffs the table against the barrel)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest"
import {
  B4_STEP_KEY,
  B4_SUBAGENT_KEY,
  B4_TURN_METADATA_KEY,
  readPersistedStep,
  readPersistedSubagent,
  readPersistedTurnEnd,
} from "../src/persisted-turn.ts"

describe("persisted turn stamps", () => {
  test("keys are the ones the converter, bridge and saver wrapper write", () => {
    expect(B4_STEP_KEY).toBe("b4_step")
    expect(B4_SUBAGENT_KEY).toBe("b4_subagent")
    expect(B4_TURN_METADATA_KEY).toBe("b4:turn")
  })

  test("readPersistedStep accepts a complete stamp and drops invalid optional fields", () => {
    const step = readPersistedStep({
      status: "completed",
      icon: "search",
      label: "Searched the corpus",
      sources: [{ title: "a.md" }, { title: "" }, "x"],
      startedAt: "2026-10-05T00:00:00.000Z",
      settledAt: "2026-10-05T00:00:01.000Z",
      decision: "once",
    })
    expect(step).toEqual({
      status: "completed",
      icon: "search",
      label: "Searched the corpus",
      sources: [{ title: "a.md" }],
      startedAt: "2026-10-05T00:00:00.000Z",
      settledAt: "2026-10-05T00:00:01.000Z",
      decision: "once",
    })
    expect(readPersistedStep({ status: "failed", startedAt: "2026-10-05T00:00:00.000Z", settledAt: "2026-10-05T00:00:01.000Z", icon: "nope", decision: "maybe" })).toEqual({
      status: "failed",
      startedAt: "2026-10-05T00:00:00.000Z",
      settledAt: "2026-10-05T00:00:01.000Z",
    })
  })

  test("readPersistedStep rejects a missing status or time", () => {
    expect(readPersistedStep({ status: "completed", startedAt: "x" })).toBeUndefined()
    expect(readPersistedStep({ startedAt: "2026-10-05T00:00:00.000Z", settledAt: "2026-10-05T00:00:01.000Z" })).toBeUndefined()
    expect(readPersistedStep({ status: "running", startedAt: "2026-10-05T00:00:00.000Z", settledAt: "2026-10-05T00:00:01.000Z" })).toBeUndefined()
    expect(readPersistedStep(null)).toBeUndefined()
  })

  test("readPersistedSubagent and readPersistedTurnEnd validate their shapes", () => {
    expect(readPersistedSubagent({ name: "researcher", routeId: "/researcher", depth: 1, checkpointNs: "tools:abc", outcome: "done", description: "Finds sources" })).toEqual({ name: "researcher", routeId: "/researcher", depth: 1, checkpointNs: "tools:abc", outcome: "done", description: "Finds sources" })
    expect(readPersistedSubagent({ name: "r", routeId: "/r", depth: 1, checkpointNs: "tools:abc", outcome: "lost" })).toBeUndefined()
    expect(readPersistedTurnEnd({ status: "failed", error: "boom", endedAt: "2026-10-05T00:00:02.000Z" })).toEqual({ status: "failed", error: "boom", endedAt: "2026-10-05T00:00:02.000Z" })
    expect(readPersistedTurnEnd({ status: "done", endedAt: "not a date" })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @b4run/sdk exec vitest run test/persisted-turn.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

`packages/sdk/src/persisted-turn.ts`:

```ts
import { isToolDisplayIcon, type ToolDisplayIcon, type ToolDisplaySource } from "./tool-display.js"

/** `additional_kwargs` key: the step a ToolMessage persists (every tool, display or not). */
export const B4_STEP_KEY = "b4_step"
/** `additional_kwargs` key: the subagent a `task` ToolMessage launched. */
export const B4_SUBAGENT_KEY = "b4_subagent"
/** Checkpoint-metadata key: how and when the turn that owns this checkpoint ended. */
export const B4_TURN_METADATA_KEY = "b4:turn"

/** How a permission gate was answered for a call. */
export type GateDecision = "once" | "always" | "deny"

/** The step a ToolMessage carries for a restored thread (spec §2.1). Times are ISO strings. */
export interface PersistedStep {
  readonly status: "completed" | "failed"
  readonly icon?: ToolDisplayIcon
  readonly label?: string
  readonly sources?: readonly ToolDisplaySource[]
  readonly startedAt: string
  readonly settledAt: string
  readonly decision?: GateDecision
}

/** The subagent a `task` call launched, on its ToolMessage (spec §2.1). */
export interface PersistedSubagent {
  readonly name: string
  readonly routeId: string
  readonly description?: string
  readonly depth: number
  /** The child's LangGraph checkpoint namespace, e.g. `tools:<task id>`. */
  readonly checkpointNs: string
  readonly outcome: "done" | "failed" | "suspended"
  readonly error?: string
}

/** How a turn ended, stamped on the head checkpoint's metadata when the run ends (spec §2.2). */
export interface PersistedTurnEnd {
  readonly status: "done" | "failed" | "stopped"
  readonly error?: string
  readonly endedAt: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value))

const DECISIONS: ReadonlySet<string> = new Set(["once", "always", "deny"])

function readSources(value: unknown): readonly ToolDisplaySource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sources: ToolDisplaySource[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.title !== "string" || entry.title === "") continue
    sources.push({ title: entry.title, ...(typeof entry.href === "string" ? { href: entry.href } : {}) })
  }
  return sources
}

/** A `b4_step` stamp, or undefined when its identity fields are missing. Invalid optional fields are dropped. */
export function readPersistedStep(value: unknown): PersistedStep | undefined {
  if (!isRecord(value)) return undefined
  if (value.status !== "completed" && value.status !== "failed") return undefined
  if (!isIsoDate(value.startedAt) || !isIsoDate(value.settledAt)) return undefined
  const sources = readSources(value.sources)
  return {
    status: value.status,
    startedAt: value.startedAt,
    settledAt: value.settledAt,
    ...(isToolDisplayIcon(value.icon) ? { icon: value.icon } : {}),
    ...(typeof value.label === "string" && value.label !== "" ? { label: value.label } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(typeof value.decision === "string" && DECISIONS.has(value.decision)
      ? { decision: value.decision as GateDecision }
      : {}),
  }
}

/** A `b4_subagent` stamp, or undefined when any required field is missing or malformed. */
export function readPersistedSubagent(value: unknown): PersistedSubagent | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.name !== "string" || value.name === "") return undefined
  if (typeof value.routeId !== "string" || value.routeId === "") return undefined
  if (typeof value.depth !== "number" || !Number.isInteger(value.depth) || value.depth < 1) return undefined
  if (typeof value.checkpointNs !== "string" || value.checkpointNs === "") return undefined
  if (value.outcome !== "done" && value.outcome !== "failed" && value.outcome !== "suspended") return undefined
  return {
    name: value.name,
    routeId: value.routeId,
    depth: value.depth,
    checkpointNs: value.checkpointNs,
    outcome: value.outcome,
    ...(typeof value.description === "string" && value.description !== "" ? { description: value.description } : {}),
    ...(typeof value.error === "string" && value.error !== "" ? { error: value.error } : {}),
  }
}

/** A `b4:turn` stamp, or undefined when malformed. */
export function readPersistedTurnEnd(value: unknown): PersistedTurnEnd | undefined {
  if (!isRecord(value)) return undefined
  if (value.status !== "done" && value.status !== "failed" && value.status !== "stopped") return undefined
  if (!isIsoDate(value.endedAt)) return undefined
  return {
    status: value.status,
    endedAt: value.endedAt,
    ...(typeof value.error === "string" && value.error !== "" ? { error: value.error } : {}),
  }
}
```

Add to `packages/sdk/src/index.ts` (next to the `tool-display.js` export line):

```ts
export {
  B4_STEP_KEY,
  B4_SUBAGENT_KEY,
  B4_TURN_METADATA_KEY,
  type GateDecision,
  type PersistedStep,
  type PersistedSubagent,
  type PersistedTurnEnd,
  readPersistedStep,
  readPersistedSubagent,
  readPersistedTurnEnd,
} from "./persisted-turn.js"
```

Then remove the local `B4_STEP_KEY` constant from `packages/langchain/src/tool-converter.ts:83` in Task 3 (it imports the SDK's).

- [ ] **Step 4: Docs rows**

In `apps/web/content/docs/api/sdk.mdx`, in the root export table, add one row per new runtime export and type (the inventory requires every barrel export to have a row). Wording:

```mdx
| `B4_STEP_KEY` | The `additional_kwargs` key under which every ToolMessage persists its step (`b4_step`). |
| `B4_SUBAGENT_KEY` | The `additional_kwargs` key under which a `task` ToolMessage persists the subagent it launched (`b4_subagent`). |
| `B4_TURN_METADATA_KEY` | The checkpoint-metadata key under which the runtime stamps how a turn ended (`b4:turn`). |
| `GateDecision` | How a permission gate was answered: `once`, `always` or `deny`. |
| `PersistedStep` | The step a ToolMessage persists: status, icon, label, sources, start and settle times, and the gate decision. |
| `PersistedSubagent` | The subagent a `task` call launched: name, route, description, depth, child checkpoint namespace, outcome and error. |
| `PersistedTurnEnd` | How and when a turn ended, stamped on the head checkpoint's metadata. |
| `readPersistedStep` | Validate a `b4_step` value; invalid optional fields are dropped, a missing identity returns undefined. |
| `readPersistedSubagent` | Validate a `b4_subagent` value. |
| `readPersistedTurnEnd` | Validate a `b4:turn` value. |
```

- [ ] **Step 5: Run tests, typecheck, lint, check-docs; commit**

Run: `pnpm --filter @b4run/sdk exec vitest run test/persisted-turn.test.ts && pnpm --filter @b4run/sdk typecheck && pnpm --filter @b4run/sdk lint && pnpm --filter @b4run/sdk build && node scripts/check-docs.mjs`
Expected: pass. (If check-docs lists a row/export mismatch it names the export.)

```bash
git add packages/sdk/src/persisted-turn.ts packages/sdk/src/index.ts packages/sdk/test/persisted-turn.test.ts apps/web/content/docs/api/sdk.mdx
git commit -m "feat(sdk): persisted step, subagent and turn-end stamps with readers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: The gate reports its decision into the tool context

**Files:**
- Modify: `packages/core/src/types.ts` (`B4ToolDefinition.run` context), `packages/core/src/capabilities/permission-gate.ts`
- Modify: `packages/langchain/src/tool-converter.ts:38-57` (local `B4ToolDefinition` context type — type only in this task)
- Test: `packages/core/test/permission-gate.test.ts` (extend; find the existing `wrapToolWithApproval` tests with `grep -n "wrapToolWithApproval" packages/core/test/*.ts`)

- [ ] **Step 1: Write the failing tests**

Append to the existing permission-gate test file (adapt the store/`interrupt` mocking the file already uses — it mocks `@langchain/langgraph`'s `interrupt` to return a decision):

```ts
describe("gate decisions reach the tool context", () => {
  test("an interactive approval reports once/always; a denial reports deny and returns a branded denial", async () => {
    const decisions: string[] = []
    const context = { signal: new AbortController().signal, toolCallId: "call_1", onGateDecision: (d: string) => decisions.push(d) }
    const tool = { name: "deployProd", run: async () => "deployed" }

    mockInterrupt.mockReturnValueOnce("once")
    const once = wrapToolWithApproval(tool, interactivePermissions())
    expect(await once.run({}, context)).toBe("deployed")

    mockInterrupt.mockReturnValueOnce("always")
    expect(await once.run({}, context)).toBe("deployed")

    mockInterrupt.mockReturnValueOnce("deny")
    const denied = await once.run({}, context)
    expect(isToolDenial(denied)).toBe(true)

    expect(decisions).toEqual(["once", "always", "deny"])
  })

  test("a static allow or deny rule reports nothing", async () => {
    const decisions: string[] = []
    const context = { signal: new AbortController().signal, onGateDecision: (d: string) => decisions.push(d) }
    const allowed = wrapToolWithApproval({ name: "x", run: async () => 1 }, permissionsAllowing("x"))
    await allowed.run({}, context)
    expect(decisions).toEqual([])
  })
})
```

(`interactivePermissions()` / `permissionsAllowing()` / `mockInterrupt` — reuse the helpers the file already defines for the interrupt-path tests; if it has none, build a `PermissionsStore` stub with `mode: "interactive"`, `match: () => "ask"`, `addAllow: async () => {}` and `vi.mock("@langchain/langgraph", ...)` for `interrupt`.)

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @b4run/core exec vitest run test/permission-gate.test.ts` → FAIL (`onGateDecision` never called).

- [ ] **Step 3: Implement**

`packages/core/src/types.ts` — in `B4ToolDefinition.run`'s context type, after `toolCallId?`:

```ts
      /**
       * Receives how a permission gate answered this call (`once`, `always`,
       * `deny`) when one ran interactively; the runtime persists it on the
       * call's step. Absent outside the runtime's converter.
       */
      readonly onGateDecision?: (decision: GateDecision) => void
```

with `import type { GateDecision } from "@b4run/sdk"` at the top (core already depends on the SDK). Mirror the same optional field, with the same doc comment, in the langchain local type `packages/langchain/src/tool-converter.ts:38-57`.

`permission-gate.ts`:

```ts
import type { GateDecision } from "@b4run/sdk"

export type GateResult =
  | { allowed: true; decision?: GateDecision }
  | { allowed: false; reason: string; code?: B4ErrorCode; decision?: GateDecision }
```

Change `emitPermissionInterrupt`'s signature to `Promise<GateDecision>` and its tail to:

```ts
  const decision = interrupt(grant === undefined ? payload : { ...payload, grant }) as GateDecision
  if (decision === "always") {
    const tool = /* unchanged mapping */
    await args.permissions.addAllow(tool, suggestedPattern)
  }
  return decision
```

In every caller (`gatePathOp`, `gateBashOp`, `gateToolOp`, `gateSubagentOp`, `gateMemorySupersede`), replace

```ts
  const result = await emitPermissionInterrupt({ ... })
  if (result === "deny") { return { allowed: false, reason: ..., code: ... } }
  return { allowed: true }
```

with

```ts
  const decision = await emitPermissionInterrupt({ ... })
  if (decision === "deny") { return { allowed: false, reason: ..., code: ..., decision } }
  return { allowed: true, decision }
```

(static `allow`/`deny` rule paths keep returning results without `decision`). In `wrapToolWithApproval` and both gate calls inside `wrapToolWithConstraint`, after `const gate = await gateToolOp(...)`:

```ts
      if (gate.decision !== undefined) {
        ;(context as { readonly onGateDecision?: (d: GateDecision) => void }).onGateDecision?.(gate.decision)
      }
```

`gateSubagentOp`'s caller in `core/src/subagents/policy.ts` ignores `decision` (the bridge records it in Task 4 only if the resolver surfaces it; out of scope here).

- [ ] **Step 4: Run tests, typecheck, lint; commit**

Run: `pnpm --filter @b4run/core exec vitest run test/permission-gate.test.ts && pnpm --filter @b4run/core typecheck && pnpm --filter @b4run/core lint && pnpm --filter @b4run/langchain typecheck`

```bash
git add packages/core/src/types.ts packages/core/src/capabilities/permission-gate.ts packages/langchain/src/tool-converter.ts packages/core/test/permission-gate.test.ts
git commit -m "feat(core): permission gates report once/always/deny into the tool context

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: The converter always builds a ToolMessage with a complete `b4_step`

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts`
- Modify: `packages/langchain/src/tool-display.ts` (export `StepEventData.status` union gains nothing; add `describeFailed`)
- Test: `packages/langchain/test/tool-converter-step.test.ts` (new)

Behaviour: every call returns a `ToolMessage` (never a bare string), whose `additional_kwargs.b4_step` is a `PersistedStep` with `startedAt`/`settledAt` from the converter's own clock, `status: "completed"` on success, `status: "failed"` for a branded denial or a thrown tool, `decision` when the gate reported one, and `icon/label/sources` from `display` when present. A thrown tool (not a GraphInterrupt, not an abort) becomes a `status: "error"` ToolMessage built here, with the same content `toolErrorMessage` produces, so the agent middleware's catch stays a safety net. The streamed `b4.step` events are unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
import { B4_STEP_KEY, toolDenial } from "@b4run/sdk"
import { ToolMessage } from "@langchain/core/messages"
import { describe, expect, test, vi } from "vitest"
import { convertToolToLangChain } from "../src/tool-converter.js"

const config = (toolCallId = "call_1") => ({ configurable: { thread_id: "t-1", toolCallId } })
const run = (tool: Parameters<typeof convertToolToLangChain>[0], input = {}, id?: string) =>
  convertToolToLangChain(tool).invoke(input, { ...config(id), toolCall: { id: id ?? "call_1", name: tool.name, args: input } } as never)

describe("converter persists a complete b4_step", () => {
  test("a display-less tool returns a ToolMessage with status, timing and no label", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-05T00:00:00.000Z") })
    const result = await run({ name: "searchCorpus", run: async () => { vi.advanceTimersByTime(1500); return "3 hits" } })
    vi.useRealTimers()
    expect(result).toBeInstanceOf(ToolMessage)
    const message = result as ToolMessage
    expect(message.content).toBe("3 hits")
    expect(message.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "completed",
      startedAt: "2026-10-05T00:00:00.000Z",
      settledAt: "2026-10-05T00:00:01.500Z",
    })
  })

  test("a displayed tool keeps icon, label and sources", async () => {
    const result = (await run({
      name: "readDoc",
      display: { icon: "read", done: (input) => `Read ${(input as { path: string }).path}`, sources: () => [{ title: "a.md" }] },
      run: async () => "…",
    }, { path: "a.md" })) as ToolMessage
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "completed", icon: "read", label: "Read a.md", sources: [{ title: "a.md" }] })
  })

  test("a branded denial is a failed step carrying the decision the gate reported", async () => {
    const result = (await run({
      name: "deployProd",
      display: { icon: "run", done: () => "Deployed" },
      run: async (_input, context) => { context.onGateDecision?.("deny"); return toolDenial("[B4_E3001] Permission denied by user: tool deployProd") },
    })) as ToolMessage
    expect(result.content).toBe("[B4_E3001] Permission denied by user: tool deployProd")
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "failed", icon: "run", decision: "deny" })
    expect(result.additional_kwargs[B4_STEP_KEY]).not.toHaveProperty("label", "Deployed")
  })

  test("an approved call records once/always on a completed step", async () => {
    const result = (await run({ name: "deployProd", run: async (_i, context) => { context.onGateDecision?.("always"); return "ok" } })) as ToolMessage
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "completed", decision: "always" })
  })

  test("a thrown tool becomes an error ToolMessage with a failed step; interrupts and aborts still throw", async () => {
    const result = (await run({ name: "x", run: async () => { throw new Error("ENOENT") } })) as ToolMessage
    expect(result.status).toBe("error")
    expect(result.content).toBe("Error: ENOENT\n Please fix your mistakes.")
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "failed" })

    const { GraphInterrupt } = await import("@langchain/langgraph")
    await expect(run({ name: "x", run: async () => { throw new GraphInterrupt() } })).rejects.toBeInstanceOf(GraphInterrupt)
  })

  test("a call with no tool call id is still a ToolMessage (id empty), streams no step", async () => {
    const result = (await convertToolToLangChain({ name: "x", run: async () => "v" }).invoke({}, {} as never)) as ToolMessage
    expect(result.tool_call_id).toBe("")
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "completed" })
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @b4run/langchain exec vitest run test/tool-converter-step.test.ts` → FAIL (string results, no `b4_step`).

- [ ] **Step 3: Implement**

In `tool-display.ts` add, next to `describeDenied`:

```ts
/** The step for a tool that threw: the icon only; the label is the client's fallback. */
export function describeFailed(display: ToolDisplay | undefined): StepPayload {
  return display?.icon !== undefined ? { icon: display.icon } : {}
}
```

In `tool-converter.ts`: replace the local `B4_STEP_KEY` constant with `import { B4_STEP_KEY, type GateDecision, isToolDenial, type PersistedStep, ... } from "@b4run/sdk"` (keep `B4_CONTENT_PARTS_KEY` local), import `describeFailed` and `describeDenied`, `isGraphInterrupt` from `@langchain/langgraph`, and `toolErrorMessage` from `./agent-middleware.js`. Rewrite the `func` body from `const body = async () => {` through `return convertedResult` as:

```ts
      const startedAt = new Date().toISOString()
      let decision: GateDecision | undefined
      const context = {
        ...(middlewareContext ? { middleware: middlewareContext } : {}),
        signal,
        ...(threadId ? { threadId } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(toolCallId !== "" ? { toolCallId } : {}),
        onGateDecision: (d: GateDecision) => {
          decision = d
        },
      }
      const persisted = (status: PersistedStep["status"], payload: StepPayload): PersistedStep => ({
        status,
        ...payload,
        startedAt,
        settledAt: new Date().toISOString(),
        ...(decision !== undefined ? { decision } : {}),
      })
      const body = async () => {
        let rawResult: unknown
        try {
          rawResult = await tool.run(input, context)
        } catch (error) {
          // A park or an abort is not a failure; everything else is this
          // call's failed step, persisted here so the restored thread sees it.
          if (isGraphInterrupt(error) || signal.aborted) throw error
          const failed = toolErrorMessage(error, tool.name, toolCallId)
          return new ToolMessage({
            tool_call_id: toolCallId,
            name: tool.name,
            status: "error",
            content: failed.content,
            additional_kwargs: { [B4_STEP_KEY]: persisted("failed", describeFailed(display)) },
          })
        }
        const denied = isToolDenial(rawResult)
        const step: StepPayload =
          display === undefined
            ? {}
            : denied
              ? describeDenied(display)
              : describeDone(display, input, rawResult, tool.name)
        const { content, stateUpdates } = unwrapToolResult(rawResult)
        /* … finalContent / partsForUi / dropped-parts block unchanged … */

        const toolMessage = (): ToolMessage =>
          new ToolMessage({
            tool_call_id: toolCallId,
            name: tool.name,
            ...(denied ? { status: "error" as const } : {}),
            additional_kwargs: {
              ...(partsForUi !== undefined ? { [B4_CONTENT_PARTS_KEY]: partsForUi } : {}),
              [B4_STEP_KEY]: persisted(denied ? "failed" : "completed", step),
            },
            ...(typeof finalContent === "string"
              ? { content: finalContent }
              : { content: finalContent as unknown as MessageContent, response_metadata: V1_RESPONSE_METADATA }),
          })

        const convertedResult = stateUpdates
          ? new Command({ update: { ...stateUpdates, messages: [toolMessage()] } })
          : toolMessage()

        /* … streamTransformers loop unchanged … */

        if (display !== undefined && !denied) {
          await dispatchStep(liveConfig, { tool_call_id: toolCallId, status: "completed", ...step })
        }
        return convertedResult
      }
```

Keep the `recorded ? recordToolCall(...) : body()` tail. The `tool.run(input, {...})` call site at the old `:143-149` is replaced by `tool.run(input, context)`. Note the denial marks the ToolMessage `status: "error"` so the live translator keeps emitting the `failed` step as today.

- [ ] **Step 4: Fix existing tests that pinned string results**

`pnpm --filter @b4run/langchain exec vitest run` — tests in `tool-converter.test.ts`, `tool-converter-runtime.test.ts`, `tool-converter-parts.test.ts` and `agent-adapter*.test.ts` that asserted a plain-string result or an `additional_kwargs`-less ToolMessage now see a ToolMessage with `b4_step`. Update each to `expect(result).toBeInstanceOf(ToolMessage)` + `content` assertions, and use `expect.objectContaining({ status: "completed" })` for the stamp where timing is incidental. Do not weaken assertions on content.

- [ ] **Step 5: Run, lint, typecheck; commit**

Run: `pnpm --filter @b4run/langchain exec vitest run && pnpm --filter @b4run/langchain typecheck && pnpm --filter @b4run/langchain lint` — pass. Scoped Biome from `packages/langchain` on `src/tool-converter.ts src/tool-display.ts test/tool-converter-step.test.ts` plus any test you edited.

```bash
git add packages/langchain/src/tool-converter.ts packages/langchain/src/tool-display.ts packages/langchain/test
git commit -m "feat(langchain)!: every tool call persists a complete b4_step on its ToolMessage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: The `task` bridge returns a ToolMessage with `b4_step` and `b4_subagent`

**Files:**
- Modify: `packages/langchain/src/subagent-tool-bridge.ts`
- Test: `packages/langchain/test/subagent-tool-bridge.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (append; reuse the file's resolver/graph fakes)

```ts
describe("task bridge persists the subagent on its ToolMessage", () => {
  test("success: ToolMessage with the final text, a completed step and the child namespace", async () => {
    const tool = convertSubagentTaskToLangChain(placeholderWithDisplay(), resolverReturning(childGraphReplying("Done: ReAct interleaves…")))
    const result = (await tool.invoke({ subagent: "researcher", input: "summarize ReAct" }, taskConfig("call_task_1", "tools:abc"))) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.content).toBe("Done: ReAct interleaves…")
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "completed", icon: "agent", label: "Heard back from researcher" })
    expect(result.additional_kwargs[B4_SUBAGENT_KEY]).toEqual({
      name: "researcher",
      routeId: "/researcher",
      description: "Finds sources",
      depth: 1,
      checkpointNs: "tools:abc",
      outcome: "done",
    })
  })

  test("child threw: error ToolMessage, failed step, outcome failed with the error", async () => {
    const tool = convertSubagentTaskToLangChain(placeholderWithDisplay(), resolverReturning(childGraphThrowing(new Error("boom"))))
    const result = (await tool.invoke({ subagent: "researcher", input: "x" }, taskConfig("call_task_2", "tools:def"))) as ToolMessage
    expect(result.status).toBe("error")
    expect(result.content).toBe("subagent_failed: boom")
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "failed", icon: "agent" })
    expect(result.additional_kwargs[B4_SUBAGENT_KEY]).toMatchObject({ outcome: "failed", error: "boom", checkpointNs: "tools:def" })
  })

  test("resolver refused and depth exceeded are error ToolMessages with a failed step and no b4_subagent", async () => {
    const refused = convertSubagentTaskToLangChain(placeholderWithDisplay(), async () => ({ ok: false, message: "[B4_E5003] No subagent named ghost" }))
    const result = (await refused.invoke({ subagent: "ghost", input: "x" }, taskConfig("call_task_3", "tools:ghi"))) as ToolMessage
    expect(result.status).toBe("error")
    expect(result.content).toBe("[B4_E5003] No subagent named ghost")
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "failed" })
    expect(result.additional_kwargs).not.toHaveProperty(B4_SUBAGENT_KEY)
  })

  test("a GraphInterrupt from the child still propagates", async () => {
    const { GraphInterrupt } = await import("@langchain/langgraph")
    const tool = convertSubagentTaskToLangChain(placeholderWithDisplay(), resolverReturning(childGraphThrowing(new GraphInterrupt())))
    await expect(tool.invoke({ subagent: "researcher", input: "x" }, taskConfig("call_task_4", "tools:jkl"))).rejects.toBeInstanceOf(GraphInterrupt)
  })
})
```

Helpers to add at the top of the test file: `taskConfig(callId, ns)` returns `{ configurable: { thread_id: "t", toolCallId: callId, checkpoint_ns: ns }, toolCall: { id: callId, name: "task", args: {} } }`; `placeholderWithDisplay()` returns `{ name: "task", schema: z.object({ subagent: z.string(), input: z.string() }), display: TASK_DISPLAY }` (import `TASK_DISPLAY` from `@b4run/core`'s built-ins or inline `{ icon: "agent", running: (i) => \`Asking ${i.subagent} to ${i.input}\`, done: (i) => \`Heard back from ${i.subagent}\` }`); `resolverReturning(graph)` returns `{ ok: true, child: { routeId: "/researcher", routeKey: "/researcher#agent", description: "Finds sources", graph } }`; `childGraphReplying(text)` returns `{ invoke: async () => ({ messages: [new AIMessage(text)] }) }`; `childGraphThrowing(e)` returns `{ invoke: async () => { throw e } }`.

- [ ] **Step 2: Run to verify it fails** — FAIL (strings returned).

- [ ] **Step 3: Implement**

Imports: `import { B4_STEP_KEY, B4_SUBAGENT_KEY, type PersistedStep, type PersistedSubagent } from "@b4run/sdk"`, `import { ToolMessage } from "@langchain/core/messages"`, `describeFailed` from `./tool-display.js`. Inside `func`, right after `const display = ...`:

```ts
      const startedAt = new Date().toISOString()
      const checkpointNs =
        typeof liveConfig.configurable?.checkpoint_ns === "string" ? liveConfig.configurable.checkpoint_ns : ""
      const persisted = (status: PersistedStep["status"], payload: StepPayload): PersistedStep => ({
        status,
        ...payload,
        startedAt,
        settledAt: new Date().toISOString(),
      })
      const toolMessage = (
        content: string,
        step: PersistedStep,
        subagent: PersistedSubagent | undefined,
        failed: boolean,
      ): ToolMessage =>
        new ToolMessage({
          tool_call_id: providerCallId ?? "",
          name: tool.name,
          content,
          ...(failed ? { status: "error" as const } : {}),
          additional_kwargs: {
            [B4_STEP_KEY]: step,
            ...(subagent !== undefined ? { [B4_SUBAGENT_KEY]: subagent } : {}),
          },
        })
```

Then change the `recordToolCall` body's returns:

- depth exceeded: `return toolMessage(\`[B4_E5003] …\`, persisted("failed", describeFailed(display)), undefined, true)`
- resolver refused: `return toolMessage(resolved.message, persisted("failed", describeFailed(display)), undefined, true)`
- after `resolved` is known, build `const identity = { name: input.subagent, routeId: resolved.child.routeId, depth: nextDepth, checkpointNs, ...(resolved.child.description !== undefined && resolved.child.description !== "" ? { description: resolved.child.description } : {}) }`
- child threw (non-interrupt): dispatch the `end` event as today, then `return toolMessage(\`subagent_failed: ${message}\`, persisted("failed", describeFailed(display)), { ...identity, outcome: "failed", error: message }, true)`
- success: `const finalText = extractFinalAiText(output)`, dispatch `end` as today, then `return toolMessage(finalText, persisted("completed", display !== undefined ? describeDone(display, input, finalText, tool.name) : {}), { ...identity, outcome: "done" }, false)`.

After `recordToolCall` returns, the `completed` dispatch becomes: `if (display !== undefined && providerCallId !== undefined && result.status !== "error") { await dispatchStep(liveConfig, { tool_call_id: providerCallId, status: "completed", ...describeDone(display, input, result.content, tool.name) }) }` (type `result` as `ToolMessage`). `outcome: "suspended"` is never written by the bridge (a suspended child rethrows and the parent parks; the stamp appears only once the child finishes after resume) — note this in a comment so nobody expects it in stored data today; the reader keeps the value for the spec's shape.

`checkpointNs` empty string: LangGraph always sets it inside a tool task; if empty (unit tests without LangGraph), the stamp still has `checkpointNs: ""` and `readPersistedSubagent` rejects it — tests pass a namespace via `taskConfig`.

- [ ] **Step 4: Run the bridge tests and the agent-adapter tests; fix assertions that pinned the string return**

Run: `pnpm --filter @b4run/langchain exec vitest run && pnpm --filter @b4run/langchain typecheck && pnpm --filter @b4run/langchain lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/subagent-tool-bridge.ts packages/langchain/test/subagent-tool-bridge.test.ts
git commit -m "feat(langchain)!: the task tool returns a ToolMessage with its step and the child's checkpoint namespace

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: `listNamespaces` on both checkpointers

**Files:**
- Modify: `packages/sqlite-storage/src/checkpointer/saver.ts`, `packages/postgres-storage/src/checkpointer.ts`
- Modify: `packages/testing/src/checkpointer-conformance.ts`
- Create: `packages/core/src/checkpointer-namespaces.ts` (the structural type + guard, so the CLI and the view's server loader share one definition); export from `packages/core/src/index.ts`; docs row in `apps/web/content/docs/api/core.mdx`

- [ ] **Step 1: Write the failing conformance test**

In `runCheckpointerConformance`, after the `checkpoint_ns isolates…` test:

```ts
    test("listNamespaces returns every namespace the thread has written, root first", async () => {
      const s = (await makeSaver()) as BaseCheckpointSaver & {
        listNamespaces?: (threadId: string) => Promise<readonly string[]>
      }
      try {
        expect(typeof s.listNamespaces).toBe("function")
        const root = mk("ckpt-1", { messages: ["root"] })
        const child = mk("ckpt-1", { messages: ["child"] })
        await s.put(cfg("t1"), root.checkpoint, meta(), root.newVersions)
        await s.put(cfg("t1", "tools:abc"), child.checkpoint, meta(), child.newVersions)
        await s.put(cfg("t1", "tools:abc|tools:def"), child.checkpoint, meta(), child.newVersions)
        await s.put(cfg("t2", "tools:zzz"), child.checkpoint, meta(), child.newVersions)
        expect(await s.listNamespaces?.("t1")).toEqual(["", "tools:abc", "tools:abc|tools:def"])
        expect(await s.listNamespaces?.("t-none")).toEqual([])
      } finally {
        await close?.(s)
      }
    })
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @b4run/testing exec vitest run test/checkpointer-conformance.test.ts` → FAIL (`listNamespaces` undefined).

- [ ] **Step 3: Implement**

SQLite (`saver.ts`, after `list`):

```ts
  /** Every `checkpoint_ns` this thread has checkpoints in, root (`""`) first, then byte order. */
  async listNamespaces(threadId: string): Promise<readonly string[]> {
    if (!threadId) return []
    const rows = this.db
      .prepare("SELECT DISTINCT checkpoint_ns FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_ns")
      .all(threadId) as unknown as Array<{ checkpoint_ns: string }>
    return rows.map((row) => row.checkpoint_ns)
  }
```

Postgres (`checkpointer.ts`, after `list`):

```ts
  /** Every `checkpoint_ns` this thread has checkpoints in, root (`""`) first, then byte order. */
  async listNamespaces(threadId: string): Promise<readonly string[]> {
    if (!threadId) return []
    await this.ready()
    const res = await this.pool.query<{ checkpoint_ns: string }>(
      `SELECT DISTINCT checkpoint_ns FROM ${this.checkpointsTable}
       WHERE thread_id = $1 ORDER BY checkpoint_ns COLLATE "C"`,
      [threadId],
    )
    return res.rows.map((row) => row.checkpoint_ns)
  }
```

`packages/core/src/checkpointer-namespaces.ts`:

```ts
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"

/** A checkpointer that can enumerate a thread's namespaces (B4's SQLite and Postgres savers do). */
export interface NamespaceListingCheckpointer extends BaseCheckpointSaver {
  listNamespaces(threadId: string): Promise<readonly string[]>
}

export function canListNamespaces(saver: BaseCheckpointSaver): saver is NamespaceListingCheckpointer {
  return typeof (saver as { listNamespaces?: unknown }).listNamespaces === "function"
}
```

Export both from `packages/core/src/index.ts`; add two rows to `apps/web/content/docs/api/core.mdx`'s root table (`NamespaceListingCheckpointer` — "A checkpointer that enumerates a thread's checkpoint namespaces; B4's savers implement it, `GET /threads/:id/turns` requires it." and `canListNamespaces` — "Whether a checkpointer implements `listNamespaces`.").

Also correct the comment at `packages/cli/src/lib/runtime/execute-route-core.ts:1868-1870` to:

```ts
    // Resolve and prepare children only after the guarded policy boundary has
    // allowed the current invocation. Child graphs are materialized natively;
    // `checkpointer: false` here resolves to "omitted", so LangGraph inherits
    // the parent's saver and a child checkpoints under its own `tools:<task>`
    // namespace — which is what `GET /threads/:id/turns` walks to restore it.
```

- [ ] **Step 4: Run gates; commit**

Run: `pnpm --filter @b4run/sqlite-storage exec vitest run && pnpm --filter @b4run/testing exec vitest run test/checkpointer-conformance.test.ts && pnpm --filter @b4run/postgres-storage typecheck && pnpm --filter @b4run/core typecheck && pnpm -r --filter "./packages/{core,sqlite-storage,postgres-storage,testing,cli}" lint && node scripts/check-docs.mjs`. If Docker is available, also `B4_TEST_PGSTORAGE=1 pnpm --filter @b4run/postgres-storage exec vitest run test/checkpointer-conformance.test.ts`.

```bash
git add packages/sqlite-storage/src/checkpointer/saver.ts packages/postgres-storage/src/checkpointer.ts packages/testing/src/checkpointer-conformance.ts packages/core/src/checkpointer-namespaces.ts packages/core/src/index.ts apps/web/content/docs/api/core.mdx packages/cli/src/lib/runtime/execute-route-core.ts
git commit -m "feat(storage): listNamespaces on both checkpointers; children checkpoint under their own namespace

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Stamp `b4:turn` on the head checkpoint when a run ends

**Files:**
- Create: `packages/cli/src/lib/dev/turn-end-stamp.ts`
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (one call at the terminal site), `packages/cli/src/lib/dev/runtime-fetch-core.ts` (four calls)
- Test: `packages/cli/test/turn-end-stamp.test.ts` (new, unit with `MemorySaver`), plus one assertion in an existing AP stream handler test that a drained run leaves `b4:turn` on the head

- [ ] **Step 1: Write the failing unit test**

```ts
import { B4_TURN_METADATA_KEY, readPersistedTurnEnd } from "@b4run/sdk"
import { MemorySaver } from "@langchain/langgraph-checkpoint"
import { describe, expect, test } from "vitest"
import { stampTurnEnd, turnEndFor } from "../src/lib/dev/turn-end-stamp.ts"

const cfg = (threadId: string) => ({ configurable: { thread_id: threadId, checkpoint_ns: "" } })
const checkpoint = (id: string) => ({ v: 4, id, ts: "2026-10-05T00:00:00.000Z", channel_values: { messages: [] }, channel_versions: {}, versions_seen: {} })

describe("turn end stamp", () => {
  test("re-puts the head checkpoint with b4:turn, keeping id, parent, values and other metadata", async () => {
    const saver = new MemorySaver()
    const first = await saver.put(cfg("t1"), checkpoint("c1") as never, { source: "input", step: -1, parents: {} } as never, {})
    await saver.put(first, checkpoint("c2") as never, { source: "loop", step: 0, parents: {}, "b4:checkpoint-routes": { checkpointId: "c2", routes: ["/x#agent"] } } as never, {})

    await stampTurnEnd(saver, "t1", { status: "done", endedAt: "2026-10-05T00:00:03.000Z" })

    const head = await saver.getTuple(cfg("t1"))
    expect(head?.checkpoint.id).toBe("c2")
    expect(head?.parentConfig?.configurable?.checkpoint_id).toBe("c1")
    expect(readPersistedTurnEnd(head?.metadata?.[B4_TURN_METADATA_KEY])).toEqual({ status: "done", endedAt: "2026-10-05T00:00:03.000Z" })
    expect((head?.metadata as Record<string, unknown>)["b4:checkpoint-routes"]).toEqual({ checkpointId: "c2", routes: ["/x#agent"] })
  })

  test("a thread with no checkpoint is a no-op; a saver failure is swallowed", async () => {
    const saver = new MemorySaver()
    await expect(stampTurnEnd(saver, "t-none", { status: "done", endedAt: "2026-10-05T00:00:03.000Z" })).resolves.toBeUndefined()
    const broken = { getTuple: async () => { throw new Error("db down") } } as unknown as MemorySaver
    await expect(stampTurnEnd(broken, "t1", { status: "done", endedAt: "2026-10-05T00:00:03.000Z" })).resolves.toBeUndefined()
  })

  test("turnEndFor maps the handler facts: parked → none, cancelled → stopped, error → failed, else done", () => {
    const at = () => "2026-10-05T00:00:03.000Z"
    expect(turnEndFor({ sawInterrupt: true, cancelled: false }, at)).toBeUndefined()
    expect(turnEndFor({ sawInterrupt: false, cancelled: true }, at)).toEqual({ status: "stopped", endedAt: at() })
    expect(turnEndFor({ sawInterrupt: false, cancelled: false, error: "boom" }, at)).toEqual({ status: "failed", error: "boom", endedAt: at() })
    expect(turnEndFor({ sawInterrupt: false, cancelled: false }, at)).toEqual({ status: "done", endedAt: at() })
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @b4run/cli exec vitest run test/turn-end-stamp.test.ts` → FAIL.

- [ ] **Step 3: Implement `turn-end-stamp.ts`**

```ts
import { B4_TURN_METADATA_KEY, type PersistedTurnEnd } from "@b4run/sdk"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"

/**
 * The turn-end record for the facts a handler has when a run settles, or
 * undefined for a park (the awaiting state is the parked interrupt itself).
 */
export function turnEndFor(
  facts: { readonly sawInterrupt: boolean; readonly cancelled: boolean; readonly error?: string | undefined },
  now: () => string = () => new Date().toISOString(),
): PersistedTurnEnd | undefined {
  if (facts.sawInterrupt) return undefined
  if (facts.cancelled) return { status: "stopped", endedAt: now() }
  if (facts.error !== undefined && facts.error !== "") return { status: "failed", error: facts.error, endedAt: now() }
  return { status: "done", endedAt: now() }
}

/**
 * Write `b4:turn` onto the thread's head root checkpoint by re-putting it under
 * the same id and parent through the RAW saver (the provenance Proxy only wraps
 * runs). Every saver upserts on the id, so this touches metadata only; pending
 * writes live in their own table. Never throws: a failed stamp degrades the
 * restored turn to "done without an end time", never the run.
 */
export async function stampTurnEnd(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  end: PersistedTurnEnd,
): Promise<void> {
  try {
    const head = await checkpointer.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: "" } })
    if (!head) return
    const parent = head.parentConfig ?? { configurable: { thread_id: threadId, checkpoint_ns: "" } }
    await checkpointer.put(
      parent,
      head.checkpoint,
      { ...head.metadata, [B4_TURN_METADATA_KEY]: end } as typeof head.metadata & Record<string, unknown>,
      head.checkpoint.channel_versions ?? {},
    )
  } catch (error) {
    console.warn(`B4: could not stamp the turn end on ${threadId}.`, error)
  }
}
```

- [ ] **Step 4: Call it at the five sites**

Import `stampTurnEnd, turnEndFor` in both handler files. Each call goes right BEFORE the `threadsStore.updateStatus(... terminalStatus(...))` line, awaited with `.catch(() => undefined)` safety already inside:

- `agui-handler.ts` finally (`:1394`): `const end = turnEndFor({ sawInterrupt, cancelled: terminalChunk?.output !== null && typeof terminalChunk?.output === "object" && (terminalChunk.output as { cancelled?: boolean }).cancelled === true, error: readTerminalError(terminalChunk) }); if (end) await stampTurnEnd(checkpointer, threadId, end)` where `readTerminalError(chunk)` returns `chunk?.output` 's `error` string if any (add a small local helper).
- `runtime-fetch-core.ts` `handleApStreamRequest` success (`:2876`): `turnEndFor({ sawInterrupt, cancelled: false, error: readTerminalError(terminalChunk) })`; catch (`:2916`): `turnEndFor({ sawInterrupt, cancelled: run.cancelled, error: run.cancelled ? undefined : (error instanceof Error ? error.message : String(error)) })`.
- `handleResumeRequest` success/catch (`:4272`, `:4309`): same two shapes.
- `handleApWaitRequest` (`:3351`): `turnEndFor({ sawInterrupt: <the wait handler's parked flag>, cancelled: false, error: undefined })` — read how that handler tracks a park (`settleParkedRouteForTurn`'s inputs) and pass it.

- [ ] **Step 5: Integration assertion**

In `packages/cli/test/pending-interrupts-endpoint.test.ts` (it already drives real routes), add to the "returns an empty list for a thread that ran without parking" test: after the run, read the head tuple through a `sqliteCheckpointer` opened on the fixture's `.b4/checkpoints.sqlite` (or inject a `MemorySaver` via `createHandler(appRoot, saver)`) and assert `readPersistedTurnEnd(head.metadata["b4:turn"])?.status === "done"`. In the "returns the parked interrupt" test assert the head has NO `b4:turn`.

- [ ] **Step 6: Run, lint, typecheck; commit**

Run: `pnpm --filter @b4run/cli exec vitest run test/turn-end-stamp.test.ts test/pending-interrupts-endpoint.test.ts test/agui-endpoint.test.ts && pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli lint`.

```bash
git add packages/cli/src/lib/dev/turn-end-stamp.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test/turn-end-stamp.test.ts packages/cli/test/pending-interrupts-endpoint.test.ts
git commit -m "feat(cli): stamp how a turn ended on the head checkpoint's metadata

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: PR 1 changeset, validation, PR

- [ ] **Step 1: Changeset** `.changeset/activity-restore-stamps.md`:

```md
---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/langchain": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

**Breaking:** every tool call now returns a `ToolMessage` whose `additional_kwargs.b4_step` is complete (`status`, `startedAt`, `settledAt`, the gate `decision`, and the display's icon, label and sources), display or not; the `task` tool returns a `ToolMessage` (not a string) carrying `b4_step` and `b4_subagent` with the child's checkpoint namespace; a thrown tool's error message is built by the converter with a `failed` step. Raw `GET /threads/:id/state` readers see the new keys. The runtime stamps `b4:turn` (`done | failed | stopped`, `error`, `endedAt`) on the head checkpoint's metadata when a run ends, and both checkpointers gain `listNamespaces(threadId)`. These are the facts `GET /threads/:id/turns` (next release) restores a thread's activity from. Threads written before this release do not restore through it.
```

- [ ] **Step 2: Gates**

Run: `pnpm build && pnpm lint && pnpm typecheck && node scripts/check-docs.mjs && pnpm -r --filter "./packages/{sdk,core,langchain,cli,sqlite-storage,postgres-storage,testing,ag-ui}" test && node scripts/check-changesets.mjs && pnpm pack:check`. Then `pnpm verify:harness:framework` (~7 min; the generated navlog journey exercises real tool calls and the AG-UI stream — the `TOOL_CALL_RESULT.content` text is unchanged, so it should pass; if a `b4.step` assertion in `test/generated/run-generated-navlog-activation.test.ts` pins a denied call's label, update it to the failed shape).

- [ ] **Step 3: Push, PR, auto-merge**

```bash
git push -u origin blove/activity-restore-storage
gh pr create --base main --title "feat!: persist every tool step, the task subagent and the turn end in the checkpoint (restore, PR 1/3)" --body "$(cat <<'EOF'
PR 1 of 3 for `docs/superpowers/specs/2026-10-05-activity-restore-from-storage-design.md` (plan `docs/superpowers/plans/2026-10-05-activity-restore-from-storage.md`): the stamps a restored activity view reads.

- Every tool call returns a `ToolMessage` with a complete `b4_step` (status, timing, gate decision, display fields); a thrown tool's failed step is built in the converter; branded denials are failed steps with `decision: "deny"`.
- The `task` tool returns a `ToolMessage` with `b4_step` and `b4_subagent` (child checkpoint namespace, outcome).
- Permission gates report `once | always | deny` into the tool context.
- `b4:turn` stamped on the head checkpoint when a run ends; `listNamespaces` on both checkpointers; the "children have no checkpointer" comment corrected (they do).
- **Breaking** for raw `/state` readers; no backward compatibility by decision.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then `mcp__ccd_pr__get_status`, `mcp__ccd_pr__set_monitor` (auto_fix), `mcp__ccd_pr__set_auto_merge` (squash). PR 2 branches from this branch and is retargeted to main after the squash (rebase `--onto origin/main <pr1-head>`).

---

# PR 2 — `turnsFromState` in `@b4run/ag-ui/view`

### Task 8: `turnsFromState` — synthesise the stream from storage and reduce it

**Files:**
- Create: `packages/ag-ui/src/view/turns-from-state.ts`
- Modify: `packages/ag-ui/src/view/index.ts`, `packages/ag-ui/test/view/public-api.test.ts`
- Test: `packages/ag-ui/test/view/turns-from-state.test.ts`

Input is plain JSON data: the serialized LangChain envelopes a `/state` reader sees (`{ lc, type: "constructor", id: [..., "HumanMessage" | "AIMessageChunk" | "AIMessage" | "ToolMessage"], kwargs }`). Output is `{ turns: TurnsView, warnings: string[] }`. The function emits the AG-UI events the live stream would have carried and folds them through `reduceTurns`, driving the clock from stamped times.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest"
import { reduceTurns, type TurnsView } from "../../src/view/turns.js"
import { type ThreadStateForTurns, turnsFromState } from "../../src/view/turns-from-state.js"
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"

const T0 = Date.parse("2026-10-05T00:00:00.000Z")
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()
const env = (cls: string, kwargs: Record<string, unknown>) => ({ lc: 1, type: "constructor", id: ["langchain_core", "messages", cls], kwargs })
const human = (id: string, content: string) => env("HumanMessage", { id, content })
const ai = (id: string, content: unknown, tool_calls: unknown[] = []) => env("AIMessageChunk", { id, content, tool_calls, additional_kwargs: {} })
const toolMsg = (tool_call_id: string, name: string, content: string, step: Record<string, unknown>, extra: Record<string, unknown> = {}, status?: string) =>
  env("ToolMessage", { tool_call_id, name, content, ...(status ? { status } : {}), additional_kwargs: { b4_step: step, ...extra } })
const ckpt = (id: string, s: number, messages: unknown[], extra: { todos?: unknown; metadata?: Record<string, unknown> } = {}) => ({
  id, ts: iso(s), metadata: { source: "loop", step: 0, parents: {}, ...(extra.metadata ?? {}) }, values: { messages, ...(extra.todos ? { todos: extra.todos } : {}) },
})
const base = (root: ReturnType<typeof ckpt>[], children: Record<string, ReturnType<typeof ckpt>[]> = {}, pending: unknown[] = [], status: ThreadStateForTurns["status"] = "idle"): ThreadStateForTurns =>
  ({ threadId: "t-1", status, root, children, pendingInterrupts: pending as never })

describe("turnsFromState", () => {
  test("one turn: user message opens it, tool call + result become a done step with the stamped times, b4:turn closes it", () => {
    const search = { id: "c1", name: "searchCorpus", args: { query: "ReAct" }, type: "tool_call" }
    const history = [
      ckpt("k0", 0, [human("u1", "Compare ReAct")]),
      ckpt("k1", 1, [human("u1", "Compare ReAct"), ai("a1", "", [search])]),
      ckpt("k2", 4, [human("u1", "Compare ReAct"), ai("a1", "", [search]), toolMsg("c1", "searchCorpus", "3 hits", { status: "completed", icon: "search", label: "Searched the corpus", startedAt: iso(1), settledAt: iso(3) })]),
      ckpt("k3", 6, [human("u1", "Compare ReAct"), ai("a1", "", [search]), toolMsg("c1", "searchCorpus", "3 hits", { status: "completed", icon: "search", label: "Searched the corpus", startedAt: iso(1), settledAt: iso(3) }), ai("a2", "ReAct interleaves…")], { metadata: { "b4:turn": { status: "done", endedAt: iso(6) } } }),
    ]
    const { turns, warnings } = turnsFromState(base(history))
    expect(warnings).toEqual([])
    expect(turns.threadId).toBe("t-1")
    expect(turns.turns).toHaveLength(1)
    const turn = turns.turns[0]!
    expect(turn).toMatchObject({ runId: "u1", status: "done", startedAt: T0, endedAt: T0 + 6000, text: "ReAct interleaves…", failed: 0 })
    expect(turn.steps).toEqual([
      expect.objectContaining({ kind: "tool", id: "c1", name: "searchCorpus", status: "done", args: '{"query":"ReAct"}', result: "3 hits", label: "Searched the corpus", icon: "search", startedAt: T0 + 1000, settledAt: T0 + 3000 }),
    ])
  })

  test("a failed step, a denied decision, reasoning blocks and a plan snapshot", () => {
    const call = { id: "c1", name: "runBash", args: { command: "node x" }, type: "tool_call" }
    const todos = [{ content: "a", status: "completed" }, { content: "b", status: "pending" }]
    const history = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", [{ type: "thinking", thinking: "plan it" }, { type: "text", text: "" }], [call])], { todos }),
      ckpt("k2", 3, [human("u1", "go"), ai("a1", [{ type: "thinking", thinking: "plan it" }], [call]), toolMsg("c1", "runBash", "[B4_E3001] Permission denied by user: command", { status: "failed", icon: "run", decision: "deny", startedAt: iso(1), settledAt: iso(2) }, {}, "error")], { todos, metadata: { "b4:turn": { status: "done", endedAt: iso(3) } } }),
    ]
    const { turns } = turnsFromState(base(history))
    const turn = turns.turns[0]!
    expect(turn.steps.map((s) => s.kind)).toEqual(["reasoning", "plan", "tool"])
    expect(turn.steps[0]).toMatchObject({ kind: "reasoning", text: "plan it", status: "done" })
    expect(turn.steps[1]).toMatchObject({ kind: "plan", todos })
    expect(turn.steps[2]).toMatchObject({ kind: "tool", status: "failed", icon: "run", result: "[B4_E3001] Permission denied by user: command" })
    expect(turn.failed).toBe(1)
  })

  test("a task ToolMessage nests the child namespace's turn", () => {
    const task = { id: "ct", name: "task", args: { subagent: "researcher", input: "summarize" }, type: "tool_call" }
    const read = { id: "n1", name: "readDoc", args: { path: "a.md" }, type: "tool_call" }
    const child = [
      ckpt("x0", 1, [human("cu", "summarize")]),
      ckpt("x1", 2, [human("cu", "summarize"), ai("ca1", "", [read])]),
      ckpt("x2", 4, [human("cu", "summarize"), ai("ca1", "", [read]), toolMsg("n1", "readDoc", "…", { status: "completed", label: "Read a.md", startedAt: iso(2), settledAt: iso(3) }), ai("ca2", "ReAct is…")]),
    ]
    const root = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [task])]),
      ckpt("k2", 5, [human("u1", "go"), ai("a1", "", [task]), toolMsg("ct", "task", "ReAct is…", { status: "completed", icon: "agent", label: "Heard back from researcher", startedAt: iso(1), settledAt: iso(5) }, { b4_subagent: { name: "researcher", routeId: "/researcher", description: "Finds sources", depth: 1, checkpointNs: "tools:abc", outcome: "done" } }), ai("a2", "Done.")], { metadata: { "b4:turn": { status: "done", endedAt: iso(5) } } }),
    ]
    const { turns, warnings } = turnsFromState(base(root, { "tools:abc": child }))
    expect(warnings).toEqual([])
    const sub = turns.turns[0]!.steps.find((s) => s.kind === "subagent")
    expect(sub).toMatchObject({ kind: "subagent", id: "ct", name: "researcher", description: "Finds sources", status: "done" })
    expect((sub as { turn: { steps: unknown[]; text: string } }).turn.steps).toEqual([expect.objectContaining({ kind: "tool", id: "n1", label: "Read a.md", status: "done" })])
    expect((sub as { turn: { text: string } }).turn.text).toBe("ReAct is…")
  })

  test("a parked head yields an awaiting turn with the approval attached to its step", () => {
    const call = { id: "c1", name: "runBash", args: { command: "node x" }, type: "tool_call" }
    const history = [ckpt("k0", 0, [human("u1", "go")]), ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [call])])]
    const pending = [{ interruptId: "perm-1", resumeKey: "a".repeat(32), value: { interruptId: "perm-1", type: "permission-request", kind: "command", toolCallId: "c1", detail: { command: "node x", suggestedPattern: "node" } } }]
    const { turns } = turnsFromState(base(history, {}, pending, "interrupted"))
    const turn = turns.turns[0]!
    expect(turn.status).toBe("awaiting")
    expect(turn.steps[0]).toMatchObject({ kind: "tool", id: "c1", status: "awaiting", approval: expect.objectContaining({ interruptId: "perm-1", kind: "command", offersAlways: true }) })
  })

  test("a failed and a stopped turn, two turns delimited by user messages", () => {
    const history = [
      ckpt("k0", 0, [human("u1", "one")]),
      ckpt("k1", 1, [human("u1", "one"), ai("a1", "first")], { metadata: { "b4:turn": { status: "failed", error: "model unavailable", endedAt: iso(1) } } }),
      ckpt("k2", 2, [human("u1", "one"), ai("a1", "first"), human("u2", "two")]),
      ckpt("k3", 3, [human("u1", "one"), ai("a1", "first"), human("u2", "two"), ai("a2", "sec")], { metadata: { "b4:turn": { status: "stopped", endedAt: iso(3) } } }),
    ]
    const { turns } = turnsFromState(base(history))
    expect(turns.turns.map((t) => [t.runId, t.status, t.error])).toEqual([["u1", "failed", "model unavailable"], ["u2", "stopped", undefined]])
  })

  test("missing or malformed stamps are ignored with a warning; the function never throws", () => {
    const call = { id: "c1", name: "x", args: {}, type: "tool_call" }
    const history = [
      ckpt("k0", 0, [human("u1", "go")]),
      ckpt("k1", 1, [human("u1", "go"), ai("a1", "", [call]), env("ToolMessage", { tool_call_id: "c1", name: "x", content: "v", additional_kwargs: {} })]),
    ]
    const { turns, warnings } = turnsFromState(base(history, { "tools:ghost": [ckpt("g0", 0, [human("gu", "hi")])] }))
    expect(turns.turns[0]!.steps[0]).toMatchObject({ kind: "tool", id: "c1", status: "done", result: "v" })
    expect(warnings).toEqual([
      expect.stringContaining("c1"),
      expect.stringContaining("tools:ghost"),
    ])
    expect(() => turnsFromState({ threadId: "t", status: "idle", root: [{ id: "k", ts: "bad", metadata: null as never, values: { messages: [null, 5, {}] } }], children: {}, pendingInterrupts: [] })).not.toThrow()
  })

  test("live and restored views agree: the synthesised events reduce to the same turns as the hand-written live stream", () => {
    const search = { id: "c1", name: "searchCorpus", args: { query: "ReAct" }, type: "tool_call" }
    const stamp = { status: "completed", icon: "search", label: "Searched the corpus", startedAt: iso(1), settledAt: iso(3) }
    const history = [
      ckpt("k0", 0, [human("u1", "Compare ReAct")]),
      ckpt("k1", 1, [human("u1", "Compare ReAct"), ai("a1", "", [search])]),
      ckpt("k2", 4, [human("u1", "Compare ReAct"), ai("a1", "", [search]), toolMsg("c1", "searchCorpus", "3 hits", stamp), ai("a2", "ReAct interleaves…")], { metadata: { "b4:turn": { status: "done", endedAt: iso(6) } } }),
    ]
    const restored = turnsFromState(base(history)).turns

    let clock = T0
    const now = () => clock
    const live: Array<[number, BaseEvent]> = [
      [0, { type: EventType.RUN_STARTED, threadId: "t-1", runId: "u1" } as BaseEvent],
      [1, { type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "searchCorpus" } as BaseEvent],
      [1, { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"query":"ReAct"}' } as BaseEvent],
      [1, { type: EventType.TOOL_CALL_END, toolCallId: "c1" } as BaseEvent],
      [3, { type: EventType.CUSTOM, name: "b4.step", value: { toolCallId: "c1", status: "completed", icon: "search", label: "Searched the corpus" } } as BaseEvent],
      [3, { type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", messageId: "tr-1", content: "3 hits" } as BaseEvent],
      [4, { type: EventType.TEXT_MESSAGE_START, messageId: "a2", role: "assistant" } as BaseEvent],
      [4, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a2", delta: "ReAct interleaves…" } as BaseEvent],
      [4, { type: EventType.TEXT_MESSAGE_END, messageId: "a2" } as BaseEvent],
      [6, { type: EventType.RUN_FINISHED, threadId: "t-1", runId: "u1", outcome: { type: "success" } } as BaseEvent],
    ]
    let view: TurnsView = { turns: [] }
    for (const [s, event] of live) {
      clock = T0 + s * 1000
      view = reduceTurns(view, event, { now })
    }
    expect(restored).toEqual(view)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @b4run/ag-ui exec vitest run test/view/turns-from-state.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `turns-from-state.ts`**

```ts
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import {
  B4_STEP_KEY,
  B4_SUBAGENT_KEY,
  B4_TURN_METADATA_KEY,
  type PersistedStep,
  readPersistedStep,
  readPersistedSubagent,
  readPersistedTurnEnd,
} from "@b4run/sdk"
import { B4_PLAN_ACTIVITY_TYPE } from "../activities.js"
import { toAguiInterrupt } from "../interrupts.js"
import { B4_STEP_EVENT_NAME } from "../step.js"
import { readPlan } from "./subagent-runs.js"
import { EMPTY_TURNS, reduceTurns, type TurnsView } from "./turns.js"

/** One decoded checkpoint of one namespace, oldest first in a history. */
export interface CheckpointForTurns {
  readonly id: string
  /** The checkpoint's own timestamp (ISO). */
  readonly ts: string
  readonly metadata: Readonly<Record<string, unknown>> | null | undefined
  readonly values: { readonly messages?: unknown; readonly todos?: unknown }
}

/** A parked interrupt in the shape `GET /threads/:id/pending_interrupts` returns. */
export interface PendingInterruptForTurns {
  readonly interruptId: string
  readonly value?: unknown
}

/** What `GET /threads/:id/turns` assembles (spec §3); plain JSON, never class instances. */
export interface ThreadStateForTurns {
  readonly threadId: string
  readonly status: "idle" | "busy" | "interrupted"
  /** The root namespace's history, oldest first. */
  readonly root: readonly CheckpointForTurns[]
  /** Child namespaces (`tools:<task id>`) and their histories, oldest first. */
  readonly children: Readonly<Record<string, readonly CheckpointForTurns[]>>
  readonly pendingInterrupts: readonly PendingInterruptForTurns[]
  /** The clock for a `busy` head's open turn; defaults to `Date.now`. */
  readonly now?: () => number
}

export interface TurnsFromStateResult {
  readonly turns: TurnsView
  /** One line per ignored stamp or unattached child namespace. */
  readonly warnings: readonly string[]
}

type Timed = { readonly at: number; readonly event: BaseEvent }

interface Envelope {
  readonly cls: string
  readonly kwargs: Record<string, unknown>
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** The LangChain class name and kwargs of a serialized message, or undefined. */
function envelope(value: unknown): Envelope | undefined {
  if (!isRecord(value) || !Array.isArray(value.id) || !isRecord(value.kwargs)) return undefined
  const cls = value.id.at(-1)
  return typeof cls === "string" ? { cls, kwargs: value.kwargs } : undefined
}

const ms = (iso: string): number => Date.parse(iso)

/** Text of a message's content: a string, or the `text` parts of a block array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("")
}

/** Reasoning text of a message's content blocks (`thinking`/`reasoning`), joined. */
function reasoningOf(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => {
      if (!isRecord(b)) return ""
      if (b.type === "thinking" && typeof b.thinking === "string") return b.thinking
      if (b.type === "reasoning" && typeof b.reasoning === "string") return b.reasoning
      return ""
    })
    .join("")
}

function stringifyArgs(args: unknown): string {
  if (typeof args === "string") return args
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return "{}"
  }
}

interface Synth {
  readonly events: Timed[]
  readonly warnings: string[]
}

function push(s: Synth, at: number, event: BaseEvent, owner?: string): void {
  s.events.push({ at, event: owner === undefined ? event : ({ ...event, subagentRunId: owner } as BaseEvent) })
}

/**
 * Emit the events one namespace's history would have streamed. Messages are
 * walked once (the last checkpoint holds the full list); the checkpoint that
 * first contained each message gives it a time. Returns the index after the
 * last message seen, so a `task` child's turn is synthesised in place.
 */
function synthesiseNamespace(
  s: Synth,
  input: ThreadStateForTurns,
  history: readonly CheckpointForTurns[],
  owner: string | undefined,
  nested: boolean,
): void {
  if (history.length === 0) return
  const last = history.at(-1) as CheckpointForTurns
  const messages = Array.isArray(last.values.messages) ? last.values.messages : []
  // When each message first appeared: the ts of the first checkpoint whose list is long enough.
  const firstSeenAt = (index: number): number => {
    for (const cp of history) {
      const list = Array.isArray(cp.values.messages) ? cp.values.messages : []
      if (list.length > index) {
        const t = ms(cp.ts)
        return Number.isNaN(t) ? 0 : t
      }
    }
    const t = ms(last.ts)
    return Number.isNaN(t) ? 0 : t
  }
  // Plan snapshots: every checkpoint whose todos differ from the previous one.
  const planAt: Array<{ at: number; todos: NonNullable<ReturnType<typeof readPlan>>; afterMessage: number }> = []
  let previous = ""
  for (const cp of history) {
    const todos = readPlan({ todos: cp.values.todos })
    const key = JSON.stringify(todos ?? null)
    if (todos !== undefined && key !== previous) {
      const count = Array.isArray(cp.values.messages) ? cp.values.messages.length : 0
      planAt.push({ at: ms(cp.ts) || 0, todos, afterMessage: count })
    }
    previous = key
  }

  const threadId = owner === undefined ? input.threadId : owner
  let openRun: string | undefined
  let turnStartedAt = 0
  const endOf = (fromIndex: number): { at: number; end: ReturnType<typeof readPersistedTurnEnd> } | undefined => {
    // The b4:turn stamp lives on the head of the turn: the last checkpoint before the next user message.
    for (let i = history.length - 1; i >= 0; i--) {
      const cp = history[i] as CheckpointForTurns
      const list = Array.isArray(cp.values.messages) ? cp.values.messages : []
      if (list.length <= fromIndex) break
      const stamp = isRecord(cp.metadata) ? cp.metadata[B4_TURN_METADATA_KEY] : undefined
      const end = readPersistedTurnEnd(stamp)
      if (end) return { at: ms(end.endedAt), end }
      if (stamp !== undefined) s.warnings.push(`ignored malformed ${B4_TURN_METADATA_KEY} on checkpoint ${cp.id}`)
    }
    return undefined
  }

  const closeRun = (upTo: number, lastAt: number, parked: boolean): void => {
    if (openRun === undefined) return
    const runId = openRun
    const resolved = endOf(upTo)
    if (parked) {
      const interrupts = input.pendingInterrupts
        .map((p) => toAguiInterrupt(p.value))
        .filter((i): i is NonNullable<typeof i> => i !== null)
      push(s, lastAt, { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: "interrupt", interrupts } } as BaseEvent)
    } else if (resolved?.end.status === "failed") {
      push(s, resolved.at, { type: EventType.RUN_ERROR, threadId, runId, message: resolved.end.error ?? "The run failed." } as BaseEvent)
    } else if (resolved?.end.status === "stopped") {
      push(s, resolved.at, { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: "cancelled" } } as BaseEvent)
    } else if (resolved !== undefined || nested || input.status !== "busy") {
      push(s, resolved?.at ?? lastAt, { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: "success" } } as BaseEvent)
    }
    openRun = undefined
  }

  const lastAtOf = (index: number): number => firstSeenAt(index)
  const flushPlans = (beforeMessage: number): void => {
    while (planAt.length > 0 && (planAt[0] as { afterMessage: number }).afterMessage <= beforeMessage) {
      const plan = planAt.shift() as { at: number; todos: unknown }
      if (openRun === undefined) continue
      push(s, plan.at, { type: EventType.ACTIVITY_SNAPSHOT, messageId: `b4:plan:${openRun}`, activityType: B4_PLAN_ACTIVITY_TYPE, replace: true, content: { todos: plan.todos } } as BaseEvent, owner)
    }
  }

  for (let index = 0; index < messages.length; index++) {
    const message = envelope(messages[index])
    const at = firstSeenAt(index)
    if (!message) {
      s.warnings.push(`ignored unreadable message ${index} in ${owner ?? "root"}`)
      continue
    }
    const { cls, kwargs } = message
    const id = typeof kwargs.id === "string" && kwargs.id !== "" ? kwargs.id : `${owner ?? "root"}:${index}`

    if (cls === "HumanMessage") {
      if (nested && openRun !== undefined) continue // a nested run has one user message
      closeRun(index, at, false)
      openRun = id
      turnStartedAt = at
      push(s, at, { type: EventType.RUN_STARTED, threadId, runId: id } as BaseEvent)
      flushPlans(index + 1)
      continue
    }
    if (openRun === undefined) continue
    flushPlans(index + 1)

    if (cls === "AIMessage" || cls === "AIMessageChunk") {
      const reasoning = reasoningOf(kwargs.content)
      if (reasoning !== "") {
        push(s, at, { type: EventType.REASONING_START, messageId: `rspan:${id}` } as BaseEvent, owner)
        push(s, at, { type: EventType.REASONING_MESSAGE_START, messageId: `rsn:${id}`, role: "reasoning" } as BaseEvent, owner)
        push(s, at, { type: EventType.REASONING_MESSAGE_CONTENT, messageId: `rsn:${id}`, delta: reasoning } as BaseEvent, owner)
        push(s, at, { type: EventType.REASONING_MESSAGE_END, messageId: `rsn:${id}` } as BaseEvent, owner)
        push(s, at, { type: EventType.REASONING_END, messageId: `rspan:${id}` } as BaseEvent, owner)
      }
      const text = textOf(kwargs.content)
      if (text !== "") {
        push(s, at, { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" } as BaseEvent, owner)
        push(s, at, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: text } as BaseEvent, owner)
        push(s, at, { type: EventType.TEXT_MESSAGE_END, messageId: id } as BaseEvent, owner)
      }
      const calls = Array.isArray(kwargs.tool_calls) ? kwargs.tool_calls : []
      for (const call of calls) {
        if (!isRecord(call) || typeof call.id !== "string" || typeof call.name !== "string") continue
        push(s, at, { type: EventType.TOOL_CALL_START, toolCallId: call.id, toolCallName: call.name } as BaseEvent, owner)
        push(s, at, { type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: stringifyArgs(call.args) } as BaseEvent, owner)
        push(s, at, { type: EventType.TOOL_CALL_END, toolCallId: call.id } as BaseEvent, owner)
      }
      continue
    }

    if (cls === "ToolMessage") {
      const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : ""
      if (toolCallId === "") continue
      const additional = isRecord(kwargs.additional_kwargs) ? kwargs.additional_kwargs : {}
      const stampValue = additional[B4_STEP_KEY]
      const step = readPersistedStep(stampValue)
      if (step === undefined) s.warnings.push(`ignored ${stampValue === undefined ? "missing" : "malformed"} ${B4_STEP_KEY} on tool call ${toolCallId}`)
      const failed = step?.status === "failed" || kwargs.status === "error"
      const startedAt = step ? ms(step.startedAt) : at
      const settledAt = step ? ms(step.settledAt) : at
      const subagent = readPersistedSubagent(additional[B4_SUBAGENT_KEY])
      if (additional[B4_SUBAGENT_KEY] !== undefined && subagent === undefined) s.warnings.push(`ignored malformed ${B4_SUBAGENT_KEY} on tool call ${toolCallId}`)

      if (subagent) {
        push(s, startedAt, { type: EventType.SUBAGENT_STARTED, subagentRunId: toolCallId, name: subagent.name, parentToolCallId: toolCallId, ...(owner !== undefined ? { parentSubagentRunId: owner } : {}), ...(subagent.description !== undefined ? { description: subagent.description } : {}) } as BaseEvent)
        const child = input.children[subagent.checkpointNs]
        if (child === undefined) s.warnings.push(`no checkpoints for child namespace ${subagent.checkpointNs} of tool call ${toolCallId}`)
        else synthesiseNamespace(s, input, child, toolCallId, true)
        if (subagent.outcome === "failed") {
          push(s, settledAt, { type: EventType.SUBAGENT_ERROR, subagentRunId: toolCallId, message: subagent.error ?? "The subagent failed." } as BaseEvent)
        } else {
          push(s, settledAt, { type: EventType.SUBAGENT_FINISHED, subagentRunId: toolCallId, result: textOf(kwargs.content), outcome: { type: "success" } } as BaseEvent)
        }
        continue
      }

      const stepEvent = (status: PersistedStep["status"]): BaseEvent =>
        ({ type: EventType.CUSTOM, name: B4_STEP_EVENT_NAME, value: { toolCallId, status, ...(step?.icon !== undefined ? { icon: step.icon } : {}), ...(step?.label !== undefined ? { label: step.label } : {}), ...(step?.sources !== undefined ? { sources: step.sources } : {}) } }) as BaseEvent
      if (!failed) push(s, settledAt, stepEvent("completed"), owner)
      push(s, settledAt, { type: EventType.TOOL_CALL_RESULT, toolCallId, messageId: `tr:${id}`, content: textOf(kwargs.content) } as BaseEvent, owner)
      if (failed) push(s, settledAt, stepEvent("failed"), owner)
      continue
    }
    // System/developer envelopes are prompt plumbing.
  }
  flushPlans(Number.POSITIVE_INFINITY)
  const parked = !nested && input.status === "interrupted" && input.pendingInterrupts.length > 0
  closeRun(messages.length, lastAtOf(Math.max(0, messages.length - 1)), parked)
  void turnStartedAt
}

/**
 * The turns of a thread, rebuilt from its checkpoint chain (spec §3): the AG-UI
 * events the live stream would have carried are synthesised and folded
 * through the unchanged `reduceTurns`, with the clock driven by the stamped
 * and checkpoint times. Stamps that are missing or malformed are ignored and
 * named in `warnings`; the function never throws.
 */
export function turnsFromState(input: ThreadStateForTurns): TurnsFromStateResult {
  const s: Synth = { events: [], warnings: [] }
  try {
    for (const ns of Object.keys(input.children)) {
      // A child namespace is attached from its task message; one nobody names is reported once.
      const named = input.root.some((cp) => JSON.stringify(cp.values.messages ?? []).includes(`"checkpointNs":"${ns}"`))
      if (!named) s.warnings.push(`child namespace ${ns} is not named by any task message`)
    }
    synthesiseNamespace(s, input, input.root, undefined, false)
  } catch (error) {
    s.warnings.push(`synthesis stopped: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Events are already in message order; a stable sort by time keeps parallel
  // calls in that order while placing a late-settling result after an earlier one.
  const ordered = s.events.map((e, i) => ({ ...e, i })).sort((a, b) => a.at - b.at || a.i - b.i)
  let clock = 0
  let view: TurnsView = EMPTY_TURNS
  const now = () => clock
  for (const { at, event } of ordered) {
    clock = Number.isFinite(at) ? at : clock
    view = reduceTurns(view, event, { now, resuming: false })
  }
  return { turns: view, warnings: s.warnings }
}
```

Implementation notes for the engineer: (1) the stable time sort is what makes "completed before or after the result" irrelevant and lets a long-running call settle after a later-started one, as live would; keep `TOOL_CALL_RESULT` and its step at the same `at` so they stay adjacent. (2) `resuming: false` is correct because a restored turn is delimited by user messages, so there is never a resume to glue. (3) The warning for `tools:ghost` in the test comes from the `named` check; the warning for `c1` from the missing stamp. (4) The equivalence test's live stream places `TOOL_CALL_RESULT.messageId: "tr-1"` while synthesis uses `tr:<message id>`; `TurnView` does not keep result message ids, so the views are equal. If the reducer ever stores one, normalise it in the test rather than in the synthesiser.

- [ ] **Step 4: Register exports**

`src/view/index.ts`: add

```ts
export {
  type CheckpointForTurns,
  type PendingInterruptForTurns,
  type ThreadStateForTurns,
  type TurnsFromStateResult,
  turnsFromState,
} from "./turns-from-state.js"
```

`test/view/public-api.test.ts`: add `"turnsFromState"` to the sorted list (after `"stepLabel"`) and `"turns-from-state.ts"` to the no-React file list.

- [ ] **Step 5: Run, iterate until green, lint, typecheck; commit**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/view && pnpm --filter @b4run/ag-ui typecheck && pnpm --filter @b4run/ag-ui lint`. Scoped Biome from `packages/ag-ui` on `src/view test/view`.

```bash
git add packages/ag-ui/src/view/turns-from-state.ts packages/ag-ui/src/view/index.ts packages/ag-ui/test/view
git commit -m "feat(ag-ui): turnsFromState rebuilds a thread's turns from its checkpoint history

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: PR 2 docs, changeset, PR

- [ ] **Step 1: Docs rows** in `apps/web/content/docs/api/ag-ui.mdx` `./view` table (after `reduceTurns`):

```mdx
| `turnsFromState` | Rebuild a thread's turns from its checkpoint history and parked interrupts: the AG-UI events the stream would have carried are synthesised and folded through `reduceTurns`, so a restored view matches a live one. Never throws; ignored stamps are named in `warnings`. |
| `ThreadStateForTurns` | What `GET /threads/:id/turns` assembles: thread id and status, the root namespace's history, child namespaces, parked interrupts, an optional clock. |
| `CheckpointForTurns` | One decoded checkpoint: id, timestamp, metadata, and `values.messages`/`values.todos` as serialized LangChain envelopes. |
| `PendingInterruptForTurns` | A parked interrupt as `/pending_interrupts` returns it. |
| `TurnsFromStateResult` | The rebuilt `TurnsView` plus warnings. |
```

Also change the `ag-ui.mdx:569` sentence to: "The step's payload is stored on the checkpointed tool message as `additional_kwargs.b4_step` for every tool (the `task` tool's message also carries `b4_subagent`), which is what `GET /threads/:id/turns` rebuilds a restored thread's activity from." (the endpoint ships in PR 3; the sentence is true from PR 3's merge, so land it there if PR 2 and PR 3 could ship in different releases — they will not, per the single-branch rollout).

- [ ] **Step 2: Changeset** `.changeset/activity-restore-view.md`:

```md
---
"@b4run/ag-ui": patch
---

`@b4run/ag-ui/view` gains `turnsFromState(input)`: rebuild a thread's `TurnsView` from its checkpoint history and parked interrupts by synthesising the AG-UI events the live stream would have carried and folding them through the unchanged `reduceTurns`. Input is the serialized state `GET /threads/:id/turns` assembles; output carries `warnings` for ignored stamps. Threads from releases before the `b4_step`/`b4:turn` stamps do not restore.
```

- [ ] **Step 3: Gates, lastmod, PR**

Run: `pnpm build && node scripts/check-docs.mjs && pnpm --filter @b4run/ag-ui test && pnpm --filter @b4run/web exec vitest run app/components/docs && pnpm pack:check && node scripts/check-changesets.mjs`. Commit docs + changeset; `pnpm --dir apps/web seo:lastmod`; commit the manifest. PR title `feat(ag-ui): turnsFromState — restore a thread's activity turns from storage (restore, PR 2/3)`, body in the PR 1 style; monitor + auto-merge after PR 1 lands and the branch is rebased onto main past its squash.

---

# PR 3 — `GET /threads/:id/turns`, `/state.created_at`, docs

### Task 10: `thread.turns` operation, the loader and the handler

**Files:**
- Modify: `packages/sdk/src/thread-access.ts` (`ThreadOperation` gains `"thread.turns"` after `"thread.pending_interrupts"`, with a doc comment "`GET /threads/:id/turns`. Gated like `thread.pending_interrupts`."), `packages/sdk/test/thread-access.contract.ts` (add the member), `packages/cli/test/thread-access-coverage.test.ts` (if it enumerates every operation, add it)
- Create: `packages/cli/src/lib/dev/thread-turns.ts`
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (route entry after `/pending_interrupts`; `/state.created_at`)
- Test: `packages/cli/test/thread-turns-endpoint.test.ts` (new), `packages/cli/test/thread-access-endpoints.test.ts` (the `/state.created_at` fix)

- [ ] **Step 1: Write the failing tests**

`thread-turns-endpoint.test.ts` (copy `createHandler`, `fixtureApp`, `withAimock`, `parkRunRequest`, `runStreamRequest`, `drain`, `readSseText` from `pending-interrupts-endpoint.test.ts`):

```ts
describe("GET /threads/:thread_id/turns", () => {
  it("returns 404 thread_not_found for an unknown thread, same bytes under a denying policy", async () => {
    const open = await createHandler(await fixtureApp())
    const miss = await open.fetch(turnsRequest("t-missing"))
    expect(miss.status).toBe(404)
    expect(((await miss.clone().json()) as ErrorBody).error.details?.code).toBe("thread_not_found")
    const gated = await createHandler(await fixtureApp(), undefined, { fallback: () => ({ decision: "deny" }) })
    const denied = await gated.fetch(turnsRequest("t-missing"))
    expect(denied.status).toBe(404)
    expect(await denied.text()).toBe(await miss.text())
  })

  it("uses the thread.turns operation and the parking route's middleware", async () => {
    const seen: string[] = []
    const handler = await createHandler(await fixtureApp(), undefined, { fallback: (req) => { seen.push(req.operation); return { decision: "allow" } } })
    await drain(await handler.fetch(runStreamRequest("t-ops", "/echo#graph")))
    const response = await handler.fetch(turnsRequest("t-ops"))
    expect(response.status).toBe(200)
    expect(seen).toContain("thread.turns")
  })

  it("returns a 409 thread_route_unknown for a thread that never ran", async () => {
    const handler = await createHandler(await fixtureApp())
    await handler.fetch(new Request("http://localhost/threads", { method: "POST", body: JSON.stringify({ thread_id: "t-new" }), headers: { "content-type": "application/json" } }))
    const response = await handler.fetch(turnsRequest("t-new"))
    expect(response.status).toBe(409)
  })

  it("rebuilds a drained run: one done turn with its tool step, text and end time", async () => {
    await withAimock(script().user("search").callsTool("searchCorpus", { query: "x" }).replies("Found it.").build())
    const handler = await createHandler(await fixtureApp())
    await drain(await handler.fetch(runStreamRequest("t-done", "/search#agent")))
    const body = (await (await handler.fetch(turnsRequest("t-done"))).json()) as TurnsBody
    expect(body.threadId).toBe("t-done")
    expect(body.status).toBe("idle")
    expect(body.warnings).toEqual([])
    expect(body.truncated).toBe(false)
    expect(body.turns.turns).toHaveLength(1)
    const turn = body.turns.turns[0]!
    expect(turn.status).toBe("done")
    expect(typeof turn.endedAt).toBe("number")
    expect(turn.text).toBe("Found it.")
    expect(turn.steps).toEqual([expect.objectContaining({ kind: "tool", name: "searchCorpus", status: "done", result: expect.any(String) })])
  })

  it("rebuilds a parked run as awaiting with the approval on its step, and the resumed run as the same done turn", async () => {
    await withAimock(script().user("deploy").callsTool("deployProd", { env: "staging" }).replies("Deployed.").build())
    const handler = await createHandler(await fixtureApp())
    await readSseText(await handler.fetch(parkRunRequest("t-park", "deploy")))
    const parked = (await (await handler.fetch(turnsRequest("t-park"))).json()) as TurnsBody
    expect(parked.status).toBe("interrupted")
    expect(parked.turns.turns[0]).toMatchObject({ status: "awaiting" })
    expect(parked.turns.turns[0]!.steps[0]).toMatchObject({ kind: "tool", name: "deployProd", status: "awaiting", approval: expect.objectContaining({ kind: "tool" }) })
    // resume with "once" through POST /threads/:id/resume (shape per pending-interrupts tests), then:
    const done = (await (await handler.fetch(turnsRequest("t-park"))).json()) as TurnsBody
    expect(done.turns.turns).toHaveLength(1)
    expect(done.turns.turns[0]).toMatchObject({ status: "done" })
    expect(done.turns.turns[0]!.steps[0]).toMatchObject({ status: "done" })
  })

  it("caps decoding and reports truncated", async () => {
    // seed a MemorySaver with 2001 root checkpoints of one trivial message each via createHandler(appRoot, saver)
    // and a thread row; expect body.truncated === true and turns.turns.length >= 1
  })
})
```

Add a `/state.created_at` case to `thread-access-endpoints.test.ts`'s `GET /threads/:thread_id/state` block: with `checkpointerWithTuple()` returning `checkpoint: { id: "c1", ts: "2026-10-05T00:00:00.000Z", channel_values: {...} }`, expect `(await served.json()).created_at === "2026-10-05T00:00:00.000Z"`.

The fixture needs a `/search#agent` route with a `searchCorpus` tool (model `gpt-5-mini`, no approval) in `fixtureApp` next to the `park` route — copy the `PARK_ROUTE` shape without `tools.approve` and with `tools/searchCorpus.ts` returning `"3 hits"`.

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @b4run/cli exec vitest run test/thread-turns-endpoint.test.ts` → FAIL (404 Not found for every request).

- [ ] **Step 3: Implement `thread-turns.ts`**

```ts
import { canListNamespaces } from "@b4run/core"
import { type ThreadStateForTurns, turnsFromState } from "@b4run/ag-ui/view"
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph-checkpoint"
import type { ThreadsStore } from "../../storage/threads.js" // same import the pending-interrupts handler uses
import { grantOf, readPendingInterrupts, withoutClientToolParks } from "./pending-interrupts.js"

/** Decoded checkpoints the handler decodes before giving up and reporting `truncated`. */
export const TURNS_CHECKPOINT_CAP = 2000

/** Serialize LangChain instances to the envelope shape clients already read (`toJSON`). */
const toPlain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

async function history(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  ns: string,
  budget: { left: number },
): Promise<ThreadStateForTurns["root"]> {
  const tuples: CheckpointTuple[] = []
  for await (const tuple of checkpointer.list({ configurable: { thread_id: threadId, checkpoint_ns: ns } })) {
    if (budget.left <= 0) break
    budget.left -= 1
    tuples.push(tuple)
  }
  // list() is newest first; the synthesiser wants oldest first.
  tuples.reverse()
  return tuples.map((tuple) => ({
    id: tuple.checkpoint.id,
    ts: tuple.checkpoint.ts,
    metadata: toPlain(tuple.metadata ?? null),
    values: toPlain({
      messages: tuple.checkpoint.channel_values?.messages,
      todos: tuple.checkpoint.channel_values?.todos,
    }),
  }))
}

/**
 * Everything `turnsFromState` needs for one thread, read in one pass: root
 * and child histories (oldest first, decoded once), the parked interrupts off
 * the head, and the thread status. `truncated` when the cap stopped decoding.
 */
export async function loadThreadStateForTurns(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  status: ThreadStateForTurns["status"],
): Promise<{ state: ThreadStateForTurns; truncated: boolean }> {
  const budget = { left: TURNS_CHECKPOINT_CAP }
  const root = await history(checkpointer, threadId, "", budget)
  const children: Record<string, ThreadStateForTurns["root"]> = {}
  if (canListNamespaces(checkpointer)) {
    for (const ns of await checkpointer.listNamespaces(threadId)) {
      if (ns === "") continue
      if (budget.left <= 0) break
      children[ns] = await history(checkpointer, threadId, ns, budget)
    }
  }
  const pendingSnapshot = await readPendingInterrupts(checkpointer, threadId)
  const snapshot = pendingSnapshot ? withoutClientToolParks(pendingSnapshot) : null
  const pendingInterrupts = (snapshot?.interrupts ?? []).map(({ interruptId, value }) => ({
    interruptId,
    value: toPlain(value),
    ...(grantOf(value) !== undefined ? { grant: grantOf(value) } : {}),
  }))
  return { state: { threadId, status, root, children, pendingInterrupts }, truncated: budget.left <= 0 }
}
```

Then the handler, in `runtime-fetch-core.ts`, a copy of `handleApPendingInterruptsRequest` named `handleApThreadTurnsRequest` with: operation `"thread.turns"`, the same thread-row 404, the same gate, the same route identity + middleware block, and the tail replaced by

```ts
  const { state, truncated } = await loadThreadStateForTurns(checkpointer, threadId, thread.status)
  const { turns, warnings } = turnsFromState(state)
  return Response.json(
    { threadId, status: thread.status, turns, warnings, truncated },
    { headers: { "cache-control": "no-store" }, status: 200 },
  )
```

(Keep it in `runtime-fetch-core.ts` next to the pending-interrupts handler so the route-identity helpers stay private; `thread-turns.ts` holds only the loader and cap.) Register the route after `/pending_interrupts`:

```ts
    {
      handle: async (request, params) =>
        handleApThreadTurnsRequest({ checkpointer: getCheckpointer(request), middleware, registry, request, threadAccess, threadId: params.thread_id ?? "", threadRouteMap, threadsStore: getThreadsStore(request) }),
      method: "GET",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/turns(?:\?.*)?$/,
    },
```

Fix `/state`: `created_at: tuple.checkpoint.ts,` (the `Checkpoint.ts` field is the ISO string).

`@b4run/cli` must depend on `@b4run/ag-ui` (it already does for `toAguiEvents`) and on `@b4run/core` (it does). Import `turnsFromState` from `@b4run/ag-ui/view`.

- [ ] **Step 4: Run, lint, typecheck; commit**

Run: `pnpm --filter @b4run/sdk exec vitest run test/thread-access.contract.ts && pnpm --filter @b4run/cli exec vitest run test/thread-turns-endpoint.test.ts test/thread-access-endpoints.test.ts test/thread-access-coverage.test.ts test/pending-interrupts-endpoint.test.ts && pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli lint && pnpm --filter @b4run/sdk typecheck`.

```bash
git add packages/sdk/src/thread-access.ts packages/sdk/test/thread-access.contract.ts packages/cli/src/lib/dev/thread-turns.ts packages/cli/src/lib/dev/runtime-fetch-core.ts packages/cli/test
git commit -m "feat(cli)!: GET /threads/:id/turns rebuilds a thread's activity; /state.created_at is the checkpoint time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: Live-versus-restored equivalence through the real runtime

**Files:**
- Test: `packages/cli/test/thread-turns-equivalence.test.ts` (new)

- [ ] **Step 1: Write the test**

Drive the `/search#agent` fixture route through the AG-UI endpoint (`POST /agui/%2Fsearch%23agent`, body `RunAgentInput` with one user message, as `agui-endpoint.test.ts` does), parse the SSE into events, fold them with `reduceTurns` (import from `@b4run/ag-ui/view`) using a fixed clock; then `GET /threads/:id/turns`. Normalise both sides (set every `runId` to `"turn"`, every `startedAt`/`settledAt`/`endedAt` to `0`, every reasoning step `id`/`messageId` to `"r"`) and `expect(normalised(restored)).toEqual(normalised(live))`. Do the same for a parked `/park#agent` run (both sides `awaiting`, same approval shape minus `grant`).

- [ ] **Step 2: Run, fix synthesis mismatches in `turns-from-state.ts` (PR 2's file, same branch) until equal; commit**

```bash
git add packages/cli/test/thread-turns-equivalence.test.ts packages/ag-ui/src/view/turns-from-state.ts
git commit -m "test(cli): a thread restored through /turns equals its live AG-UI view

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: Docs, pins, specs, changeset, PR

- [ ] **Step 1: Endpoint docs**

`apps/web/content/docs/dev-server/agent-protocol.mdx`: add after the `/pending_interrupts` row

```md
| `GET /threads/:thread_id/turns` | None | `200 { threadId, status, turns, warnings, truncated }`: the thread's activity turns rebuilt from its checkpoints (`turns` is `@b4run/ag-ui/view`'s `TurnsView`). `404` `thread_not_found`. `409` `thread_route_unknown` when no route is recorded |
```

and change the `/state` row's success to `` `200 { config, created_at, metadata, next, parent_config, values }` (`created_at` is the checkpoint's time), or `404` without a checkpoint ``. Add a subsection after "Recovering prompts without a live stream":

```md
### Restoring a thread's activity

`GET /threads/:thread_id/turns` returns the same turns a live AG-UI client builds with
`reduceTurns`: tool steps with their labels and timing, the plan, reasoning, nested subagent
turns, and the approval a parked turn is waiting on. The runtime rebuilds it from the checkpoint
chain (every tool call persists `additional_kwargs.b4_step`, a `task` call persists
`b4_subagent`, and a run's end is stamped as `b4:turn` on the head checkpoint), so there is no
separate event store. `warnings` names stamps the runtime could not read; `truncated` is true
when a very long thread hit the decoding cap and only the newest turns are returned. Threads
written before these stamps existed do not restore. Responses carry `cache-control: no-store`.
```

and in "Client disconnect" append: "After a reload, `GET /threads/:thread_id/turns` rebuilds the activity view."

`scripts/check-docs.mjs`: add `"GET /threads/:thread_id/turns"` and `"GET /threads/:thread_id/pending_interrupts"` to the agent-protocol `required` list (`:2797-2840`) and to the endpoint pin loop (`:5040-5050`). `apps/web/app/llms.txt/route.ts`: add `"- \`GET /threads/:thread_id/pending_interrupts\`",` and `"- \`GET /threads/:thread_id/turns\`",` after the `/state` line. `apps/web/content/docs/thread-access.mdx` default-deny table + `packages/cli/docs/thread-access.md`: add `| \`GET /threads/:thread_id/turns\` | 404 \`thread_not_found\`, the same body a genuine miss returns |`. `apps/web/content/docs/security-architecture.mdx:36`: add a `Turns` row mirroring `State`.

`apps/web/content/docs/ag-ui.mdx:641`: append "`GET /threads/:thread_id/turns` rebuilds the activity view the chat showed, approvals included, from the checkpoint." `apps/web/content/docs/api/ag-ui.mdx`: the `./view` prose gains one sentence pointing at `/turns`.

- [ ] **Step 2: Specs**

`2026-10-03-b4-activity-components-design.md:193-197`: replace with "Every tool's done payload, with timing and the gate decision, is stored on the checkpointed `ToolMessage` as `additional_kwargs.b4_step` (the `task` tool's message also carries `b4_subagent`); `GET /threads/:id/turns` rebuilds a restored thread from it (`2026-10-05-activity-restore-from-storage-design.md`)." `:358-361`: replace the spike bullet with "Pending interrupts after a reload: CopilotKit restores them from the replayed `RUN_FINISHED`; a host with its own transcript reads `GET /threads/:id/turns`, which embeds them." `2026-08-09-ap-stream-reattach-design.md:422`: "Documented: the attach stream is self-contained; do not merge it with `/state` or `/turns` reads."

- [ ] **Step 3: Upgrading entry** (newest first):

```mdx
### Threads restore their activity from `GET /threads/:thread_id/turns`

Landed in the first release after **0.13.1**. Action required if you read `GET /threads/:thread_id/state` to rebuild a transcript, or parse `values.messages` yourself.

Every tool call's `ToolMessage` now carries a complete `additional_kwargs.b4_step` (status, start and settle times, the permission decision, and the display's icon, label and sources), the `task` tool returns a `ToolMessage` with `b4_subagent`, and the runtime stamps `b4:turn` on the head checkpoint when a run ends. `GET /threads/:thread_id/turns` rebuilds the same `TurnsView` a live AG-UI client builds, approvals included, so prefer it over parsing `/state`. `/state.created_at` is now the checkpoint's time. Threads written before this release do not restore through `/turns`. See [Agent Protocol](/docs/dev-server/agent-protocol#restoring-a-threads-activity).
```

- [ ] **Step 4: Changeset** `.changeset/activity-restore-endpoint.md`:

```md
---
"@b4run/cli": patch
"@b4run/sdk": patch
---

**Breaking:** `GET /threads/:thread_id/state` reports `created_at` as the checkpoint's time instead of the request time. New `GET /threads/:thread_id/turns` rebuilds a thread's activity turns (`@b4run/ag-ui/view`'s `TurnsView`) from its checkpoints, parked interrupts embedded, gated like `/pending_interrupts`; `ThreadOperation` gains `thread.turns`. Threads from releases before the `b4_step`/`b4:turn` stamps do not restore.
```

- [ ] **Step 5: Gates, lastmod, PR**

Run: `pnpm build && pnpm lint && pnpm typecheck && node scripts/check-docs.mjs && pnpm --filter @b4run/cli test && pnpm --filter @b4run/web exec vitest run && node scripts/check-changesets.mjs && pnpm pack:check && pnpm verify:harness:framework`. Commit docs/specs/changeset; `pnpm --dir apps/web seo:lastmod`; commit. PR title `feat(cli)!: GET /threads/:id/turns restores a thread's activity from storage (restore, PR 3/3)`; monitor + auto-merge once PR 2 is in and the branch is rebased past its squash. Update the memory file `project_b4_activity_components.md` when each PR merges.

---

## Self-review

**Spec coverage.** §2.1 (`b4_step` everywhere, `task` ToolMessage, `b4_subagent.checkpointNs`, `decision`) → Tasks 1–4. §2.2 (`b4:turn` via the raw saver re-put) → Task 6. §2.3 (`listNamespaces`, comment fix) → Task 5. §3 (`turnsFromState`, synthesis table, warnings, never throws, derived reasoning ids, `runId` = user message id) → Task 8. §4 (handler, 404/gate/409, cap 2000, `truncated`, `/state.created_at`, both backends) → Tasks 10, 5. §5 error table → Tasks 8 (warnings), 10 (gate/404/409, busy snapshot). §6 tests → each task's tests plus Task 11's equivalence; Postgres conformance in Task 5; harness lane in Tasks 7 and 12. §7 rollout → three PRs, three `**Breaking:**`/additive changesets, upgrading entry, pins moved (Task 12). §8 out of scope untouched. Task 0 reconciles the spec's gate wording with the real `/pending_interrupts` behaviour found during extraction.

**Placeholders.** Task 10's cap test and Task 11 describe the test's shape in prose rather than full code because they depend on fixture helpers that exist only in `pending-interrupts-endpoint.test.ts`; the implementer copies those helpers. Task 2's test references the gate test file's existing mocking helpers by role. Everything else carries the code.

**Type consistency.** `PersistedStep/PersistedSubagent/PersistedTurnEnd` and `readPersisted*` (Task 1) are the names Tasks 3, 4, 6, 8 import; `GateDecision` (Task 1) is used by Tasks 2 and 3; `onGateDecision` (Task 2) is the field Task 3's context sets; `describeFailed` (Task 3) is used by Task 4; `canListNamespaces`/`NamespaceListingCheckpointer` (Task 5) by Task 10; `turnEndFor`/`stampTurnEnd` (Task 6) by the five sites; `ThreadStateForTurns.{threadId,status,root,children,pendingInterrupts}` (Task 8) matches what `loadThreadStateForTurns` (Task 10) builds; `TurnsFromStateResult.{turns,warnings}` matches the handler's response; the `/turns` body `{ threadId, status, turns, warnings, truncated }` matches Task 10's tests and Task 12's docs.
