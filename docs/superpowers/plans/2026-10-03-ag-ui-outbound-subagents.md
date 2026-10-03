# AG-UI subagent lifecycle and attribution (AG-UI 1.0 sub-project 2, PR 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** `toAguiEvents` presents a subagent the way AG-UI 1.0 does — `SUBAGENT_STARTED/FINISHED/ERROR` plus the child's own text, reasoning, tool calls, usage and plan tagged `subagentRunId` — and nothing else: the `b4.subagent` activity, `SubagentActivityCard`, and the ledger's suppression of `task` tool frames are removed; `@b4run/ag-ui/react` gains an event-driven `useSubagentRuns` hook and `SubagentPanel`; the chat and research examples (and the research scaffold template) migrate; `GET /agui/:routeId` advertises `multiAgent` from the subagent registry the `task` tool dispatches from.

**Architecture:** The translator's per-run text/reasoning/tool bookkeeping becomes per-**owner** (root, or one `call_id`), a `subagent.<type>` chunk is unwrapped to its root shape plus an owner and handled by the same code, and every event emitted under a child owner carries `subagentRunId`. `subagent.start/end` become the lifecycle events; a terminal boundary closes every open invocation first (deepest first). The plan projector becomes owner-aware; the subagent state machine is deleted. `task` leaves the orchestration ledger. On the client, `useSubagentRuns(agent)` reduces `SUBAGENT_*` and attributed events into a tree that `SubagentPanel` renders.

**Tech Stack:** TypeScript, vitest, `@ag-ui/core`/`@ag-ui/client` 1.0.1, React 19, CopilotKit 1.76.

Spec: `docs/superpowers/specs/2026-10-02-ag-ui-1-0-outbound-richness-design.md` §5, §6, §7. Stacked on PR 3a (`blove/agui-subagent-stream`), which supplies the root-shaped child chunks. **Hard cut, no compatibility shim** (spec §1 decision 4).

Conventions: as the previous plans — run from the repo root on Node 24; format from the package dir with `--config-path ../config-biome/biome.json`; `exactOptionalPropertyTypes`; `patch` changesets; commit docs before `seo:lastmod`; kill orphaned test processes before trusting a red `ci:validate`.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/ag-ui/src/outbound.ts` | **Modify (major).** Per-owner state, `subagent.*` unwrap, `subagentRunId` tagging, `SUBAGENT_*` lifecycle, terminal closing, attributed interrupts. |
| `packages/ag-ui/src/subagent-chunks.ts` | **Create.** `unwrapSubagentChunk(chunk)` → `{ owner, chunk } | null`; `asSubagentStartData`, `asSubagentEndData`. Pure parsing, unit-tested alone. |
| `packages/ag-ui/src/activities.ts` | **Modify.** Plan projector only, owner-aware; subagent machine, `B4_SUBAGENT_ACTIVITY_TYPE`, `B4SubagentActivityContent` deleted; `B4ActivityChunkType` shrinks to `plan_update`. |
| `packages/ag-ui/src/orchestration-ledger.ts` | **Modify.** `ORCHESTRATION_TOOLS` = `{ writeTodos: true }`; `OrchestrationToolName = "writeTodos"`. |
| `packages/ag-ui/src/index.ts` | **Modify.** Drop the two subagent exports. |
| `packages/ag-ui/src/react/{index.ts,renderers.tsx,schemas.ts,SubagentActivityCard.tsx}` | **Modify/Delete.** Card, renderer, schema and type removed; `b4ActivityRenderers = [b4PlanActivityRenderer]`. |
| `packages/ag-ui/src/react/useSubagentRuns.ts`, `SubagentPanel.tsx` | **Create.** Hook + panel. |
| `packages/ag-ui/src/react/styles.css` | **Modify.** Panel classes (`b4-subagents`, `b4-subagent`, …) reusing the activity tokens. |
| `packages/ag-ui/test/*` | **Modify.** `outbound`, `activities`, `orchestration-ledger`, `conformance`, `public-api`, `types`, `react/*`; new `subagent-chunks.test.ts`, `react/useSubagentRuns.test.tsx`, `react/SubagentPanel.test.tsx`. |
| `packages/cli/src/lib/runtime/execute-route-core.ts`, `packages/cli/src/lib/dev/agui-capabilities.ts`, `packages/cli/test/agui-capabilities.test.ts` | **Modify.** `checkRouteSubagents` preflight → `multiAgent`. |
| `examples/research/web/app/components/{Transcript.tsx,SubagentCard.tsx,activity-renderers.tsx,activity-renderers.test.tsx}`, `examples/research/web/app/lib/transcript.ts`, `examples/research/web/README.md` | **Modify/Delete.** Panel mounted from `useSubagentRuns(agent)`; card deleted. |
| `packages/devkit/templates/app-research/web/…` | **Mirror** every research-web change (parity test `packages/devkit/test/templates.test.ts` compares `app/` byte-for-byte; test files are `.template`). |
| `examples/chat/web/app/page.tsx`, `examples/chat/README.md`, `examples/chat/web/README.md`, `packages/devkit/templates/app-research/server/README.md`, `packages/ag-ui/README.md` | **Modify.** Wording. |
| `scripts/published-artifact-smoke.mjs`, `scripts/published-artifacts.test.mjs`, `scripts/release/test/fixtures/release-script-hashes.json`, `scripts/release/test/workflow-contracts.test.mjs` | **Modify.** Root export surface loses `B4_SUBAGENT_ACTIVITY_TYPE`; the smoke script is release-pinned, so its sha256 and the pin-file digest snapshot (`STARTING_SCRIPT_PIN_SHA256`) are re-recorded in the same commit. |
| `apps/web/content/docs/{ag-ui.mdx,api/ag-ui.mdx,recipes/research-web-ui.mdx,upgrading.mdx}`, `apps/web/app/components/docs/{api-reference.ts,api-reference.test.ts,api-reference-inventory.test.ts}`, `scripts/check-docs.mjs` | **Modify.** Sections rewritten; contract pins for the removed symbols dropped and the new React exports added; the `ag-ui.activities.subagent-privacy` behavior contract replaced by `ag-ui.subagents.lifecycle`. |
| `.changeset/agui-subagents.md` | **Create.** `patch` for `@b4run/ag-ui`, `@b4run/cli`, `@b4run/devkit`, `create-b4-app`. |

---

### Task 1: `unwrapSubagentChunk` — a child chunk as its root shape plus an owner

**Files:**
- Create: `packages/ag-ui/src/subagent-chunks.ts`
- Test: `packages/ag-ui/test/subagent-chunks.test.ts`

- [x] **Step 1: Tests**

```ts
import { describe, expect, test } from "vitest"
import {
  asSubagentEndData,
  asSubagentStartData,
  unwrapSubagentChunk,
} from "../src/subagent-chunks.ts"

const ID = { call_id: "c1", subagent: "researcher", route_id: "/r#researcher", depth: 1 }

describe("unwrapSubagentChunk", () => {
  test("token and reasoning become string-payload chunks with the owner", () => {
    expect(
      unwrapSubagentChunk({ type: "subagent.token", data: { ...ID, data: "hi", messageId: "m1" } }),
    ).toEqual({ owner: "c1", chunk: { type: "token", data: "hi", messageId: "m1" } })
    expect(
      unwrapSubagentChunk({ type: "subagent.reasoning", data: { ...ID, data: "think", messageId: "m1" } }),
    ).toEqual({ owner: "c1", chunk: { type: "reasoning", data: "think", messageId: "m1" } })
  })

  test("object payloads keep their keys and lose the identity", () => {
    expect(
      unwrapSubagentChunk({
        type: "subagent.tool_call",
        data: { ...ID, id: "t1", name: "search", input: { q: 1 } },
      }),
    ).toEqual({ owner: "c1", chunk: { type: "tool_call", data: { id: "t1", name: "search", input: { q: 1 } } } })
    expect(
      unwrapSubagentChunk({ type: "subagent.message_end", data: { ...ID, messageId: "m1" } }),
    ).toEqual({ owner: "c1", chunk: { type: "message_end", data: { messageId: "m1" } } })
    expect(
      unwrapSubagentChunk({ type: "subagent.plan_update", data: { ...ID, todos: [] } }),
    ).toEqual({ owner: "c1", chunk: { type: "plan_update", data: { todos: [] } } })
  })

  test("lifecycle, usage, non-subagent and malformed chunks are not unwrapped", () => {
    expect(unwrapSubagentChunk({ type: "subagent.start", data: ID })).toBeNull()
    expect(unwrapSubagentChunk({ type: "subagent.end", data: ID })).toBeNull()
    expect(unwrapSubagentChunk({ type: "subagent.usage", data: { ...ID, usage_metadata: {} } })).toBeNull()
    expect(unwrapSubagentChunk({ type: "token", data: "root" })).toBeNull()
    expect(unwrapSubagentChunk({ type: "subagent.token", data: { data: "no id" } })).toBeNull()
    expect(unwrapSubagentChunk({ type: "subagent.token", data: { ...ID, call_id: "" } })).toBeNull()
  })
})

describe("start and end data", () => {
  test("start carries identity plus optional parent and description", () => {
    expect(asSubagentStartData({ ...ID, parent_call_id: "c0", description: "Finds" })).toEqual({
      callId: "c1",
      name: "researcher",
      depth: 1,
      parentCallId: "c0",
      description: "Finds",
    })
    expect(asSubagentStartData(ID)).toEqual({ callId: "c1", name: "researcher", depth: 1 })
    expect(asSubagentStartData({ ...ID, subagent: "" })).toBeNull()
  })
  test("end is success with a result, or an error", () => {
    expect(asSubagentEndData({ ...ID, final_message: "done" })).toEqual({ callId: "c1", result: "done" })
    expect(asSubagentEndData({ ...ID, error: "boom" })).toEqual({ callId: "c1", error: "boom" })
    expect(asSubagentEndData({ ...ID })).toEqual({ callId: "c1" })
    expect(asSubagentEndData({ ...ID, final_message: 3 })).toBeNull()
  })
})
```

- [x] **Step 2: Run → FAIL (module missing).** **Step 3: Implement**

```ts
import type { B4AgentStreamChunk } from "./types.js"

const IDENTITY_KEYS = new Set(["call_id", "subagent", "route_id", "depth"])
const LIFECYCLE = new Set(["subagent.start", "subagent.end", "subagent.usage"])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * A child's chunk as the root chunk it mirrors, plus its owner (the `call_id`
 * that is also its AG-UI `subagentRunId`). Lifecycle chunks and `usage` are
 * handled elsewhere and return null, as does anything without a `call_id`.
 */
export function unwrapSubagentChunk(
  chunk: B4AgentStreamChunk,
): { readonly owner: string; readonly chunk: B4AgentStreamChunk } | null {
  if (!chunk.type.startsWith("subagent.") || LIFECYCLE.has(chunk.type)) return null
  if (!isRecord(chunk.data)) return null
  const owner = chunk.data.call_id
  if (typeof owner !== "string" || owner === "") return null
  const inner = chunk.type.slice("subagent.".length)
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(chunk.data)) {
    if (!IDENTITY_KEYS.has(key)) rest[key] = value
  }
  if (inner === "token" || inner === "reasoning") {
    const { data, messageId } = rest
    return {
      owner,
      chunk: {
        type: inner,
        data: typeof data === "string" ? data : "",
        ...(typeof messageId === "string" ? { messageId } : {}),
      } as B4AgentStreamChunk,
    }
  }
  return { owner, chunk: { type: inner, data: rest } as B4AgentStreamChunk }
}

export interface SubagentStartData {
  readonly callId: string
  readonly name: string
  readonly depth: number
  readonly parentCallId?: string
  readonly description?: string
}

export function asSubagentStartData(data: unknown): SubagentStartData | null {
  if (!isRecord(data)) return null
  const { call_id, subagent, depth, parent_call_id, description } = data
  if (typeof call_id !== "string" || call_id === "") return null
  if (typeof subagent !== "string" || subagent.trim() === "") return null
  if (!Number.isInteger(depth) || (depth as number) < 1) return null
  return {
    callId: call_id,
    name: subagent,
    depth: depth as number,
    ...(typeof parent_call_id === "string" && parent_call_id !== "" ? { parentCallId: parent_call_id } : {}),
    ...(typeof description === "string" && description.trim() !== "" ? { description } : {}),
  }
}

export interface SubagentEndData {
  readonly callId: string
  readonly result?: string
  readonly error?: string
}

export function asSubagentEndData(data: unknown): SubagentEndData | null {
  if (!isRecord(data)) return null
  const { call_id, final_message, error } = data
  if (typeof call_id !== "string" || call_id === "") return null
  if (final_message !== undefined && typeof final_message !== "string") return null
  if (error !== undefined && typeof error !== "string") return null
  return {
    callId: call_id,
    ...(typeof final_message === "string" ? { result: final_message } : {}),
    ...(typeof error === "string" ? { error } : {}),
  }
}
```

- [x] **Step 4: Run → PASS; format; commit** `feat(ag-ui): unwrap a subagent chunk to its root shape and owner`.

---

### Task 2: Translator — owners, lifecycle, attribution; `task` leaves the ledger; plan is owner-aware

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts`, `packages/ag-ui/src/activities.ts`, `packages/ag-ui/src/orchestration-ledger.ts`, `packages/ag-ui/src/index.ts`, `packages/ag-ui/src/types.ts` (if `B4ActivityChunkType` is re-exported)
- Modify: `packages/ag-ui/test/outbound.test.ts`, `test/activities.test.ts`, `test/orchestration-ledger.test.ts`, `test/public-api.test.ts`, `test/types.test.ts`

- [x] **Step 1: Tests first — the new `describe("subagents")` in `outbound.test.ts`**

Delete every test that asserts a `b4.subagent` `ACTIVITY_SNAPSHOT` or that `task` frames are suppressed (search `B4_SUBAGENT_ACTIVITY_TYPE`, `"task"` in `outbound.test.ts` and `orchestration-ledger.test.ts`; in the ledger test, `task` cases become `writeTodos` cases or go). Add:

```ts
describe("subagents", () => {
  const START = { type: "subagent.start", data: { ...CHILD, description: "Finds sources" } } as const
  const t = (data: string, messageId = "cm1") => ({
    type: "subagent.token",
    data: { ...CHILD, data, messageId },
  }) as const

  test("start → SUBAGENT_STARTED with the task call as parent; end → FINISHED with the result", async () => {
    const out = await collect([
      { type: "tool_call", data: { id: CHILD.call_id, name: "task", input: { subagent: "researcher" } } },
      START,
      t("Reading"),
      { type: "subagent.message_end", data: { ...CHILD, messageId: "cm1" } },
      { type: "subagent.end", data: { ...CHILD, final_message: "found it" } },
      { type: "tool_result", data: { id: CHILD.call_id, name: "task", output: "found it" } },
      { type: "done" },
    ])
    const kinds = out.map((e) => e.type)
    // The task call is an ordinary tool call again: its frames are on the wire.
    expect(kinds.slice(1, 4)).toEqual([EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END])
    expect(out[4]).toEqual({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: CHILD.call_id,
      name: "researcher",
      description: "Finds sources",
      parentToolCallId: CHILD.call_id,
    })
    expect(out[5]).toEqual({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
      subagentRunId: CHILD.call_id,
    })
    expect(out[6]).toMatchObject({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "Reading", subagentRunId: CHILD.call_id })
    expect(out[7]).toEqual({ type: EventType.TEXT_MESSAGE_END, messageId: "msg-1", subagentRunId: CHILD.call_id })
    expect(out[8]).toEqual({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: CHILD.call_id,
      result: "found it",
      outcome: { type: "success" },
    })
    expect(out[9]).toMatchObject({ type: EventType.TOOL_CALL_RESULT, toolCallId: CHILD.call_id })
    expect(out[9]).not.toHaveProperty("subagentRunId")
    expect(kinds).not.toContain(EventType.ACTIVITY_SNAPSHOT)
  })

  test("a failed child is SUBAGENT_ERROR", async () => {
    const out = await collect([START, { type: "subagent.end", data: { ...CHILD, error: "boom" } }, { type: "done" }])
    expect(out[1]).toMatchObject({ type: EventType.SUBAGENT_STARTED })
    expect(out[2]).toEqual({ type: EventType.SUBAGENT_ERROR, subagentRunId: CHILD.call_id, message: "boom" })
  })

  test("the child's tool calls, reasoning, usage and plan are attributed; the plan has its own id", async () => {
    const out = await collect([
      START,
      { type: "subagent.reasoning", data: { ...CHILD, data: "plan", messageId: "cm1" } },
      { type: "subagent.tool_call", data: { ...CHILD, id: "ct1", name: "readDoc", input: { p: "a" } } },
      { type: "subagent.tool_result", data: { ...CHILD, id: "ct1", name: "readDoc", output: "text" } },
      { type: "subagent.plan_update", data: { ...CHILD, todos: [{ content: "read", status: "completed" }] } },
      { type: "subagent.usage", data: { ...CHILD, usage_metadata: { input_tokens: 1, output_tokens: 1 } } },
      { type: "subagent.end", data: { ...CHILD, final_message: "ok" } },
      { type: "done" },
    ])
    for (const e of out.filter((e) => e.type !== EventType.RUN_STARTED && e.type !== EventType.RUN_FINISHED)) {
      expect(e).toHaveProperty("subagentRunId", CHILD.call_id)
    }
    const plan = out.find((e) => e.type === EventType.ACTIVITY_SNAPSHOT)
    expect(plan).toMatchObject({ messageId: `b4:plan:${CHILD.call_id}`, activityType: B4_PLAN_ACTIVITY_TYPE, replace: true })
    expect(out.find((e) => e.type === EventType.TOOL_CALL_START)).toMatchObject({ toolCallId: "ct1", toolCallName: "readDoc" })
    // Open reasoning closes before the child finishes.
    const kinds = out.map((e) => e.type)
    expect(kinds.indexOf(EventType.REASONING_END)).toBeLessThan(kinds.indexOf(EventType.SUBAGENT_FINISHED))
    expect(out.at(-1)).toMatchObject({ usage: [{ inputTokens: 1, outputTokens: 1 }] })
  })

  test("a nested child names its parent invocation", async () => {
    const GRAND = { call_id: "c2", subagent: "reader", route_id: "/r#reader", depth: 2 }
    const out = await collect([
      START,
      { type: "subagent.start", data: { ...GRAND, parent_call_id: CHILD.call_id } },
      { type: "subagent.end", data: { ...GRAND, final_message: "x" } },
      { type: "subagent.end", data: { ...CHILD, final_message: "y" } },
      { type: "done" },
    ])
    expect(out[2]).toEqual({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "c2",
      name: "reader",
      parentToolCallId: "c2",
      parentSubagentRunId: CHILD.call_id,
    })
  })

  test("a child interrupt suspends the child, tags the interrupt, and the resume re-announces the same id", async () => {
    const out = await collect([
      START,
      t("asking"),
      { type: "interrupt", data: { interruptId: "i1", kind: "tool", callId: CHILD.call_id } },
      { type: "done" },
    ])
    const kinds = out.map((e) => e.type)
    expect(kinds.slice(-2)).toEqual([EventType.SUBAGENT_FINISHED, EventType.RUN_FINISHED])
    expect(out.at(-2)).toEqual({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: CHILD.call_id,
      outcome: { type: "suspended", interruptIds: ["i1"] },
    })
    expect(out.at(-1)).toMatchObject({
      outcome: { type: "interrupt", interrupts: [{ id: "i1", toolCallId: CHILD.call_id, subagentRunId: CHILD.call_id }] },
    })
    // Text was closed before the child suspended.
    expect(kinds.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(kinds.indexOf(EventType.SUBAGENT_FINISHED))
  })

  test("a parent suspended only because its child interrupted carries no interruptIds", async () => {
    const GRAND = { call_id: "c2", subagent: "reader", route_id: "/r#reader", depth: 2 }
    const out = await collect([
      START,
      { type: "subagent.start", data: { ...GRAND, parent_call_id: CHILD.call_id } },
      { type: "interrupt", data: { interruptId: "i1", kind: "tool", callId: "c2" } },
      { type: "done" },
    ])
    const finished = out.filter((e) => e.type === EventType.SUBAGENT_FINISHED)
    // Deepest first.
    expect(finished.map((e) => e.subagentRunId)).toEqual(["c2", CHILD.call_id])
    expect(finished[0]).toMatchObject({ outcome: { type: "suspended", interruptIds: ["i1"] } })
    expect(finished[1]).toEqual({ type: EventType.SUBAGENT_FINISHED, subagentRunId: CHILD.call_id, outcome: { type: "suspended" } })
  })

  test("open children at done, stream end, or cancel are closed with SUBAGENT_ERROR; RUN_ERROR abandons them", async () => {
    for (const tail of [[{ type: "done" }], []] as B4AgentStreamChunk[][]) {
      const out = await collect([START, t("x"), ...tail])
      expect(out.at(-2)).toEqual({
        type: EventType.SUBAGENT_ERROR,
        subagentRunId: CHILD.call_id,
        message: "The run ended before the subagent finished.",
        code: "unterminated",
      })
      expect(out.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    }
    async function* failing(): AsyncIterable<B4AgentStreamChunk> {
      yield START
      throw new Error("stop")
    }
    for (const cancelled of [true, false]) {
      const out = []
      for await (const ev of toAguiEvents(failing(), CTX, { idFactory: createCounterIdFactory(), cancelled: () => cancelled })) out.push(ev)
      if (cancelled) {
        expect(out.at(-2)).toEqual({ type: EventType.SUBAGENT_ERROR, subagentRunId: CHILD.call_id, message: "The run was cancelled.", code: "cancelled" })
      } else {
        expect(out.map((e) => e.type)).not.toContain(EventType.SUBAGENT_ERROR)
        expect(out.at(-1)?.type).toBe(EventType.RUN_ERROR)
      }
    }
  })

  test("a chunk for an unannounced child, or a re-announce of an open child, is dropped", async () => {
    const out = await collect([
      t("orphan"),
      START,
      START,
      { type: "subagent.end", data: { ...CHILD, final_message: "ok" } },
      { type: "done" },
    ])
    const kinds = out.map((e) => e.type)
    expect(kinds.filter((k) => k === EventType.SUBAGENT_STARTED)).toHaveLength(1)
    expect(kinds).not.toContain(EventType.TEXT_MESSAGE_START)
  })
})
```

Plus, in `activities.test.ts`, replace every subagent-machine test with: the plan projector takes an `owner` and mints `b4:plan:<runId>` (root) or `b4:plan:<callId>` (child), correlating `writeTodos` only for root. In `orchestration-ledger.test.ts`, every `task` scenario is deleted and `MAX_TRACKED_CALLS` scenarios use `writeTodos`. `public-api.test.ts` export list loses `B4_SUBAGENT_ACTIVITY_TYPE`.

- [x] **Step 2: Run → FAIL.** **Step 3: Implement**

`activities.ts`: delete `B4_SUBAGENT_ACTIVITY_TYPE`, `B4SubagentActivityContent`, every `Internal*`/`parseSubagentIdentity`/`identitiesMatch`/`parseEndError`/`subagentSnapshot`; `B4ActivityChunkType = "plan_update"`; `OrchestrationToolName = "writeTodos"`; `createB4ActivityProjector(runId)` keeps `project(type, data, owner?: string)`:

```ts
      if (type === "plan_update") {
        const parsedTodos = parseTodos(data)
        if (parsedTodos === null) return projectEvent(null)
        const event: ActivitySnapshotEvent = {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: owner === undefined ? `b4:plan:${runId}` : `b4:plan:${owner}`,
          activityType: B4_PLAN_ACTIVITY_TYPE,
          replace: true,
          content: { todos: parsedTodos },
          ...(owner !== undefined ? { subagentRunId: owner } : {}),
        }
        const toolCallId = owner === undefined ? readRawNonemptyString(data, "tool_call_id") : null
        return { event, ...(toolCallId !== null ? { orchestration: { toolCallId, toolName: "writeTodos" as const } } : {}) }
      }
      return projectEvent(null)
```

`orchestration-ledger.ts`: `ORCHESTRATION_TOOLS = { writeTodos: true }`; comments that mention `task` updated.

`outbound.ts` — the shape of the change (write it fully; the pieces):

```ts
/** Per-owner framing state: root (`undefined`) and one per announced child. */
interface OwnerState {
  openMessageId: string | null
  readonly identifiedMessages: Map<string, string>
  openReasoning: OpenReasoning | null
  readonly identifiedReasoning: Map<string, OpenReasoning>
  readonly openStreamedToolCalls: Map<string, string>
  readonly pendingFallbackToolCallIds: Map<string, string[]>
}
interface OpenSubagent {
  readonly callId: string
  readonly name: string
  readonly parentCallId: string | undefined
}
```

- `const owners = new Map<string | undefined, OwnerState>()`, `stateFor(owner)`; `const openSubagents = new Map<string, OpenSubagent>()` (insertion-ordered; children start after parents, so reverse iteration is deepest-first).
- `function tag<E extends AguiOutboundEvent>(owner: string | undefined, event: E): E` → `owner === undefined ? event : { ...event, subagentRunId: owner }`. Every `ledger.onPassthrough(...)` / `ledger.onActivity(...)` / `onToolCall` / `onToolResult` call in the text, reasoning, tool and plan paths takes `tag(owner, …)`. Only root uses `onToolCall`/`onToolResult`/`onActivity` with correlation; a child's frames go through `onPassthrough` (nothing of a child's is ever suppressed).
- The existing helpers (`flushText`, `closeIdentified`, `flushAllText`, `closeStreamedToolCalls`, `flushReasoning`, `openReasoningFrame`) take `owner` and operate on `stateFor(owner)`; `flushOwner(owner)` = all of them for one owner; `flushEverything()` = every owner.
- The chunk loop: 
  ```ts
  const unwrapped = unwrapSubagentChunk(chunk)
  if (unwrapped !== null) {
    if (!openSubagents.has(unwrapped.owner)) continue // never announced: drop
    yield* handle(unwrapped.owner, unwrapped.chunk)
    continue
  }
  if (chunk.type === "subagent.start") { … SUBAGENT_STARTED; continue }
  if (chunk.type === "subagent.end") { … flushOwner; FINISHED/ERROR; delete; continue }
  yield* handle(undefined, chunk)
  ```
  where `handle(owner, chunk)` is today's `switch` body with `owner` threaded (including `plan_update` → `activityProjector.project("plan_update", data, owner)`, `usage` → collector, interrupts — root only; a child never emits `interrupt` chunks, the adapter projects them at root with `callId`).
- `SUBAGENT_STARTED`: `{ type, subagentRunId: callId, name, parentToolCallId: callId, ...(parentCallId ? { parentSubagentRunId: parentCallId } : {}), ...(description ? { description } : {}) }`. If already open → drop. Emitted via `ledger.onPassthrough` so it stays ordered behind any held `writeTodos` candidate.
- `SUBAGENT_FINISHED` (end with no error): `{ type, subagentRunId, ...(result !== undefined ? { result } : {}), outcome: { type: "success" } }`; `SUBAGENT_ERROR`: `{ type, subagentRunId, message: error }`.
- Terminal closing, called before every `RUN_FINISHED` (after `flushEverything()`, before `ledger.settle()`):
  ```ts
  function* closeOpenSubagents(reason: { kind: "interrupt"; interrupts: readonly Interrupt[] } | { kind: "unterminated" } | { kind: "cancelled" }) {
    for (const open of [...openSubagents.values()].reverse()) {
      yield* flushOwner(open.callId)
      if (reason.kind === "interrupt") {
        const ids = reason.interrupts.filter((i) => i.toolCallId === open.callId).map((i) => i.id)
        yield* ledger.onPassthrough({ type: EventType.SUBAGENT_FINISHED, subagentRunId: open.callId, outcome: { type: "suspended", ...(ids.length > 0 ? { interruptIds: ids } : {}) } })
      } else {
        yield* ledger.onPassthrough({ type: EventType.SUBAGENT_ERROR, subagentRunId: open.callId, message: reason.kind === "cancelled" ? "The run was cancelled." : "The run ended before the subagent finished.", code: reason.kind })
      }
    }
    openSubagents.clear()
  }
  ```
  `RUN_ERROR` paths do not call it. Interrupts whose `toolCallId` names an open subagent get `subagentRunId` set when the `RUN_FINISHED { outcome: interrupt }` is built (map over `pendingInterrupts`).
- `AguiOutboundEvent` gains `SubagentStartedEvent | SubagentFinishedEvent | SubagentErrorEvent`.
- Delete `isB4ActivityChunkType` usage for subagent types; the only activity chunk is `plan_update`.

`index.ts`: remove `B4_SUBAGENT_ACTIVITY_TYPE`, `B4SubagentActivityContent`.

- [x] **Step 4: Run the ag-ui suite (expect the react tests and conformance to fail — next tasks); typecheck. Format; commit** `feat(ag-ui)!: SUBAGENT_* lifecycle and subagentRunId attribution replace the b4.subagent activity; task frames flow`.

---

### Task 3: Conformance through the real 1.0 client

**Files:** `packages/ag-ui/test/conformance.test.ts`

- [x] `CANNED`: the child section already carries root-shaped chunks (3a). Remove the `b4.subagent` privacy assertions and the "task frames are suppressed" assertion; replace with: `SUBAGENT_STARTED` precedes the first attributed event; every event between `SUBAGENT_STARTED` and `SUBAGENT_FINISHED` whose type is not a run/subagent event carries `subagentRunId: childIdentity.call_id`; `TOOL_CALL_START` names include `task`; the plan snapshot for the child has `messageId: b4:plan:c1` and `subagentRunId`; `agent.messages` contains the child's assistant text as a message with `subagentRunId` (the 1.0 reducer keeps it); zero warnings.
- [x] New run: child interrupt → `suspended` outcome with `interruptIds`, the `Interrupt` carries `subagentRunId`, then a resume run re-announces `c1` (allowed across runs) and finishes it — through `agent.runAgent` on the same agent, under `withNoWarnings`.
- [x] New run: cancel with an open child → `SUBAGENT_ERROR … code: "cancelled"` before `RUN_FINISHED { cancelled }`.
- [x] New run: a two-level tree (`parent_call_id`) — the verifier requires the parent to be announced first and both to close; assert ordering and zero warnings.
- [x] Run; commit `test(ag-ui): conformance covers subagent lifecycle, attribution, suspension and nesting`.

---

### Task 4: React — `useSubagentRuns` and `SubagentPanel`; the card goes

**Files:**
- Create: `packages/ag-ui/src/react/useSubagentRuns.ts`, `packages/ag-ui/src/react/SubagentPanel.tsx`
- Delete: `packages/ag-ui/src/react/SubagentActivityCard.tsx`
- Modify: `react/index.ts`, `react/renderers.tsx`, `react/schemas.ts`, `react/styles.css`, tests under `test/react/`

- [x] **Step 1: Tests** — `test/react/useSubagentRuns.test.tsx` drives the reducer directly (export `reduceSubagentRuns(state, event)` beside the hook so the reduction is testable without React): started → running with name/parent; attributed `TOOL_CALL_START/ARGS/END/RESULT` → `toolCalls` with args text and result; attributed `TEXT_MESSAGE_*` → `text`; attributed `REASONING_MESSAGE_*` → `reasoning`; attributed `ACTIVITY_SNAPSHOT b4.plan` → `plan`; `SUBAGENT_FINISHED success` → `completed` + `result`; `suspended` → `suspended`; `SUBAGENT_ERROR` → `failed` + `error`; nested `parentSubagentRunId` → `children`; `RUN_STARTED` with a new `threadId` clears, same thread keeps. `test/react/SubagentPanel.test.tsx` renders a tree with `renderToStaticMarkup` and asserts names, statuses, nested indentation class, result text, tool rows (reuse the `ToolRow` slot and `ActivityChecklist` for the plan).
- [x] **Step 2: Implement**

```ts
// useSubagentRuns.ts
import type { AbstractAgent } from "@ag-ui/client"
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { useEffect, useState } from "react"
import { B4_PLAN_ACTIVITY_TYPE, type B4PlanActivityContent } from "../activities.js"

export interface SubagentToolCall { readonly id: string; readonly name: string; readonly args: string; readonly result?: string; readonly status: "running" | "completed" }
export interface SubagentRun {
  readonly subagentRunId: string
  readonly name: string
  readonly description?: string
  readonly parentToolCallId?: string
  readonly parentSubagentRunId?: string
  readonly status: "running" | "completed" | "suspended" | "failed"
  readonly result?: unknown
  readonly error?: string
  readonly children: readonly string[]
  readonly toolCalls: readonly SubagentToolCall[]
  readonly plan?: B4PlanActivityContent["todos"]
  readonly text: string
  readonly reasoning: string
}
export interface SubagentRunsState { readonly threadId: string | undefined; readonly runs: ReadonlyMap<string, SubagentRun> }
export const EMPTY_SUBAGENT_RUNS: SubagentRunsState = { threadId: undefined, runs: new Map() }
export function reduceSubagentRuns(state: SubagentRunsState, event: BaseEvent): SubagentRunsState { /* switch on event.type as in Step 1 */ }
export function useSubagentRuns(agent: Pick<AbstractAgent, "subscribe"> | undefined): SubagentRunsState {
  const [state, setState] = useState(EMPTY_SUBAGENT_RUNS)
  useEffect(() => {
    if (!agent) return
    const subscription = agent.subscribe({ onEvent: ({ event }) => setState((prev) => reduceSubagentRuns(prev, event)) })
    return () => subscription.unsubscribe()
  }, [agent])
  return state
}
```

`SubagentPanel({ runs, classNames?, components? })` renders roots (`parentSubagentRunId === undefined`) recursively: header (name · status · N tools), description, reasoning (muted), text, `ActivityChecklist` for `plan`, tool rows via `ToolRow` slot or default, result/error footer. Classes `b4-subagents`, `b4-subagent`, `b4-subagent__header`, `b4-subagent__children`, … in `styles.css` using the existing `--b4-activity-*` tokens.

`index.ts`: export `useSubagentRuns`, `reduceSubagentRuns`, `EMPTY_SUBAGENT_RUNS`, `SubagentPanel`, types `SubagentRun`, `SubagentRunsState`, `SubagentToolCall`; remove `SubagentActivityCard`, `b4SubagentActivityRenderer`, `subagentActivityContentSchema`, `SubagentActivityContentOutput`. `renderers.tsx`: `b4ActivityRenderers = [b4PlanActivityRenderer]`. `schemas.ts`: plan only. Update the module doc comment (three layers → hook/panel). `@ag-ui/client` is already an optional peer; the hook's import is type-only plus the `subscribe` call on the instance the app passes, so no new dependency.

- [x] **Step 3: Run `pnpm --filter @b4run/ag-ui test` and `typecheck`; format; commit** `feat(ag-ui/react)!: useSubagentRuns + SubagentPanel replace SubagentActivityCard`.

---

### Task 5: `multiAgent` capability

**Files:** `packages/cli/src/lib/runtime/execute-route-core.ts`, `packages/cli/src/lib/dev/agui-capabilities.ts`, `packages/cli/test/agui-capabilities.test.ts`

- [x] Test: a fixture route with `subagents: { researcher: agent({ model: "gpt-5-mini", description: "Finds sources", systemPrompt: "t" }) }` advertises `multiAgent: { supported: true, delegation: true, handoffs: false, subagents: [{ name: "researcher", description: "Finds sources" }] }`; `/open#agent` (no subagents), graph and raw routes have **no** `multiAgent` key.
- [x] Implement `checkRouteSubagents(routeModule): Promise<{ ok: true; subagents: readonly { name: string; description?: string }[] } | PreparedRouteError>` next to the other preflights, built from the same registry resolution the `task` tool uses (find where `subagentRegistry` is produced in `execute-route-core.ts` — `resolveSubagents`/registry helper over `descriptor.subagents` plus convention routes — and reuse that function so the advertised list is the dispatchable list). In `agentCapabilities`, `...(subagents.length > 0 ? { multiAgent: { delegation: true, handoffs: false, subagents, supported: true } } : {})`. Update the module doc bullet for `multiAgent`.
- [x] Run, format, commit `feat(cli): advertise multiAgent from the subagent registry the task tool dispatches from`.

---

### Task 6: Examples and the research template

**Files:** `examples/research/web/app/components/{Transcript.tsx,activity-renderers.tsx,activity-renderers.test.tsx}`, delete `SubagentCard.tsx`; `examples/research/web/README.md`; mirror into `packages/devkit/templates/app-research/web/app/components/` (test as `.template`); `examples/chat/web/app/page.tsx`, `examples/chat/README.md`, `examples/chat/web/README.md`, `packages/devkit/templates/app-research/server/README.md`

- [x] `Transcript.tsx`: accept `agent` (the `useAgent()` instance `AppShell` holds) as a prop; `const subagents = useSubagentRuns(agent)`; render `<SubagentPanel runs={subagents.runs} classNames={…} />` after the transcript items while any run exists; the `RESTORED_HISTORY_NOTICE` wording becomes "Subagent activity from earlier runs isn't saved — new runs show it as it happens." (update the test that asserts the string). `activity-renderers.tsx`: plan only; `activity-renderers.test.tsx`: drop the subagent card tests; `SubagentCard.tsx` deleted. READMEs: `b4ActivityRenderers` sentences mention the plan card and `SubagentPanel`.
- [x] Mirror every change byte-for-byte into the template (`pnpm --filter @b4run/devkit test` runs the parity test), and run `pnpm --filter @b4-example/research-web test` and `typecheck`, `pnpm --filter @b4-example/chat-web typecheck`.
- [x] Commit `feat(examples)!: research and chat clients present subagents from SUBAGENT_* events`.

---

### Task 7: Release-pinned smoke scripts, docs, pins, changeset

- [x] `scripts/published-artifact-smoke.mjs`: remove `B4_SUBAGENT_ACTIVITY_TYPE` from the ESM and type probes (and the `subagentActivityType` line); `scripts/published-artifacts.test.mjs`: the mirrored expectations (lines ~1614-1660, ~3339-3370) and `B4SubagentActivityContent` in the fake declarations. Then re-pin: `node -p "require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('scripts/published-artifact-smoke.mjs')).digest('hex')"` into `scripts/release/test/fixtures/release-script-hashes.json`, and the pin **file's** sha256 into `STARTING_SCRIPT_PIN_SHA256` in `scripts/release/test/workflow-contracts.test.mjs`. Run `pnpm test:release-integrity` then `node --test scripts/release/test/workflow-contracts.test.mjs` then `pnpm test:release-controller`.
- [x] Docs: `ag-ui.mdx` — outbound table rows for `subagent.*` → `SUBAGENT_STARTED/FINISHED/ERROR` + attributed events; "Activity snapshots" keeps only the plan (root and child ids); "Canonical orchestration presentation" becomes `writeTodos` only, with "`task` calls are ordinary tool calls; the subagent they start is `SUBAGENT_STARTED { parentToolCallId }`"; a new "Subagents" section (lifecycle, attribution, suspension, cancel, nesting, `multiAgent`); the Callout about activity renderers mentions `SubagentPanel`. `api/ag-ui.mdx`: drop the two symbols and `ag-ui.activities.subagent-privacy`; add the React exports table rows and a behavior contract `ag-ui.subagents.lifecycle` anchored to the new conformance tests. `recipes/research-web-ui.mdx`: panel instead of card. `upgrading.mdx` entry: `b4.subagent`/`SubagentActivityCard`/`b4SubagentActivityRenderer` removed, `task` frames back, migration = `useSubagentRuns` + `SubagentPanel`. Pins: `api-reference.ts` (contracts + behavior contract), `api-reference.test.ts` (count), `api-reference-inventory.test.ts` (fixture count and ids), `scripts/check-docs.mjs` (contract list). `pnpm --dir apps/web seo:lastmod` after committing.
- [x] Changeset `.changeset/agui-subagents.md` (`@b4run/ag-ui`, `@b4run/cli`, `@b4run/devkit`, `create-b4-app`, patch) with the **Breaking** paragraph.
- [x] `pnpm build && node scripts/check-docs.mjs && node scripts/check-changesets.mjs && pnpm --filter @b4run/web test`.

---

### Task 8: Validation and PR

- [x] Package gates for ag-ui, cli, devkit, web, research-web, chat-web, chat-server; `pnpm lint`; `pnpm ci:validate` (orphan check first; known contention flakes as before). The `copilotkit-examples-e2e` lane must be green on the PR (it rewrites example UIs).
- [x] Rebase onto `main` once 3a merges (`--onto`), rebuild, re-run; push `blove/agui-subagents`; PR title `feat(ag-ui)!: SUBAGENT_* lifecycle and attribution; b4.subagent removed; multiAgent capability (AG-UI 1.0 sub-project 2, PR 3b)`; bind; squash auto-merge if asked.
- [x] Close #885 in the PR body (`Closes #885`) — this is the last PR of the sub-project.

---

## Self-review

- **Spec §5.1–5.4, §6, §7:** lifecycle → Task 2; attribution → Task 2; suspended/cancelled/unterminated/RUN_ERROR → Task 2 + 3; malformed drop → Task 2; removals (`b4.subagent`, `task` in ledger, check-docs pins) → Tasks 2, 4, 7; `multiAgent` → Task 5; React hook/panel → Task 4; examples/template → Task 6; docs/upgrading → Task 7; conformance → Task 3. The release-pinned smoke script (not in the spec) → Task 7.
- **Placeholders:** Task 2's `reduceSubagentRuns` body and Task 4's panel markup are described by their tests rather than pasted; the engineer writes them to those tests. Everything on the wire is spelled out.
- **Type consistency:** `OwnerState`/`OpenSubagent`/`tag(owner, event)`/`closeOpenSubagents(reason)` consistent across Task 2; `SubagentRun` fields match the hook tests in Task 4 and the panel; `unwrapSubagentChunk` returns `{ owner, chunk }` as Task 1 defines and Task 2 consumes.
