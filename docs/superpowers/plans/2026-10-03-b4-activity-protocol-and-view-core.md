# B4 Activity Components — Sub-project 1: Protocol + View Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every fact a chat UI needs to tell a turn's story in plain language on the AG-UI wire — clean tool output, a `b4.step` label event per tool call, interrupts that name their tool call — and fold it all into one framework-free reducer, `reduceTurns`, published as `@b4run/ag-ui/view`.

**Architecture:** Three PRs on `main`, each independently shippable. **PR A** fixes the protocol: `TOOL_CALL_RESULT.content` becomes the tool's actual output, permission interrupts carry `toolCallId` (and `subagentRunId` for a child's gate) plus a `responseSchema`. **PR B** adds the `display` tool export (`ToolDisplay` in the SDK), evaluates it in the langchain tool converter, emits it as AG-UI `CUSTOM` `b4.step` events, persists it on the checkpointed `ToolMessage`, and labels every built-in tool. **PR C** adds the `./view` entry: `reduceTurns` (absorbing `reduceSubagentRuns`), label fallbacks, step grouping, and the docs/pin plumbing a new subpath needs; it ends with the CopilotKit slot spike that de-risks sub-project 2.

**Tech Stack:** TypeScript (NodeNext ESM; `src/` imports use `.js`, `test/` uses `.ts`), vitest, zod 4, `@ag-ui/core` 1.0.1, LangChain `createAgent` + LangGraph, Biome (always via `pnpm lint` or scoped `biome check --config-path packages/config-biome/biome.json <files>` — never bare `biome check --write`).

**Spec:** `docs/superpowers/specs/2026-10-03-b4-activity-components-design.md`. This plan amends the spec in three places (Task 14): the `b4.step` value shape, where labels persist, and dropping `display.group` from the server.

**Repo rules that bite here** (from `AGENTS.md`): run everything from the repo root; `exactOptionalPropertyTypes` is on (never assign `{ x: undefined }` — spread conditionally); changesets are `patch`; `pnpm build` before anything that reads `dist/`; Node 24 (`nvm use 24`).

---

## Mapping facts the tasks rely on

- `tool_result.output` reaching the translator is the live LangChain `ToolMessage` (string-returning tools) or a `Command` whose `update.messages` ends in one (`{result, state}` tools); the error path emits the error `ToolMessage` (`packages/langchain/src/agent-adapter.ts:513-527`). `packages/ag-ui/src/outbound.ts:137` JSON-serializes it, which is why clients see `{"lc":1,…}`.
- Only `kind:"subagent"` envelopes carry `callId` today (`packages/core/src/capabilities/permission-gate.ts:425-466`); the adapter injects a child's task `callId` for `command|memory|path|tool` gates raised inside a subagent (`agent-adapter.ts:1053-1063`). Root gates carry no call id at all.
- `closeOpenSubagents` attributes an interrupt to a suspended child with `interrupt.toolCallId === open.callId` (`outbound.ts:303`), and `finishInterrupted` tags `subagentRunId` the same way (`outbound.ts:350`). A child gate that names its own tool call must therefore carry `subagentRunId` separately.
- The tool converter's `func` has the validated input, the raw result, `toolCallId` and `liveConfig` (`packages/langchain/src/tool-converter.ts:74-154`); `dispatchCustomEvent("b4.capability", …)` there is the precedent for a custom event. The adapter turns `on_custom_event` into chunks at `agent-adapter.ts:941-953`; `childData` (`:694-703`) strips `tool_call_id` from child capability events, so `b4.step` must not go through it.
- langchain's `ToolNode` returns a `ToolMessage` a tool returns as-is (`node_modules/langchain/dist/agents/nodes/ToolNode.js:160`), so the converter can attach `additional_kwargs` and the checkpoint keeps them. The tool-call record (`recordToolCall`) is opt-in and pruned — not a durable home for labels.
- `normalizeToolModule` (`packages/cli/src/lib/runtime/tool-shape.ts:80`) is the single normalizer for Node discovery and static manifests; `b4 check` validates tool shape only through it. Capability tools are copied field by field at `execute-route-core.ts:1628-1640`.
- `packages/ag-ui` builds with plain `tsc -b` over `src/**`; a `src/view/` directory emits automatically. The orchestration ledger suppresses `writeTodos` frames only (`orchestration-ledger.ts:13-16`).
- The docs site's `ag-ui.subagents.lifecycle` behavior contract pins three `outbound.test.ts` **test names**; those names must not change.

## File structure

**PR A — protocol**
- Modify: `packages/ag-ui/src/outbound.ts` (tool-result view), `packages/ag-ui/src/interrupts.ts` (`subagentRunId`, `responseSchema`), `packages/core/src/capabilities/permission-gate.ts` (`toolCallId` on envelopes), `packages/core/src/capabilities/built-in/workspace.ts` (runBash passes it), `packages/core/src/capabilities/built-in/memory.ts` (remember passes it)
- Tests: `packages/ag-ui/test/outbound.test.ts`, `packages/ag-ui/test/interrupts.test.ts`, `packages/core/test/capabilities/permission-gate-tool-call-id.test.ts` (new)
- Docs: `apps/web/content/docs/ag-ui.mdx`, `apps/web/content/docs/permissions.mdx`, `apps/web/content/docs/api/ag-ui.mdx`
- Changeset: `.changeset/activity-protocol-clean-results.md`

**PR B — display + b4.step**
- Create: `packages/sdk/src/tool-display.ts`, `packages/langchain/src/tool-display.ts`
- Modify: `packages/sdk/src/index.ts`, `packages/core/src/capabilities/types.ts`, `packages/cli/src/lib/runtime/tool-shape.ts`, `packages/cli/src/lib/runtime/execute-route-core.ts`, `packages/langchain/src/tool-converter.ts`, `packages/langchain/src/subagent-tool-bridge.ts`, `packages/langchain/src/agent-adapter.ts`, `packages/ag-ui/src/types.ts`, `packages/ag-ui/src/step.ts` (new), `packages/ag-ui/src/outbound.ts`, built-in tools under `packages/core/src/capabilities/built-in/`
- Tests: `packages/sdk/test/tool-display.test.ts`, `packages/cli/test/tool-discovery-errors.test.ts`, `packages/langchain/test/tool-display.test.ts`, `packages/langchain/test/tool-converter.test.ts`, `packages/langchain/test/tool-converter-runtime.test.ts`, `packages/langchain/test/agent-adapter.test.ts`, `packages/ag-ui/test/outbound.test.ts`, `packages/ag-ui/test/conformance.test.ts`, `packages/core/test/capabilities/built-in-display.test.ts` (new)
- Docs: `apps/web/content/docs/tools.mdx`, `apps/web/content/docs/ag-ui.mdx`, `apps/web/content/docs/api/sdk.mdx`, spec amendments
- Changeset: `.changeset/tool-display-step-events.md`

**PR C — view entry**
- Create: `packages/ag-ui/src/view/index.ts`, `packages/ag-ui/src/view/subagent-runs.ts` (moved reducer), `packages/ag-ui/src/view/turns.ts`, `packages/ag-ui/src/view/labels.ts`
- Modify: `packages/ag-ui/src/react/useSubagentRuns.ts` (hook only; re-exports), `packages/ag-ui/src/react/index.ts`, `packages/ag-ui/package.json`, `scripts/check-docs.mjs`, `apps/web/app/components/docs/api-reference.ts`, `apps/web/app/components/docs/api-reference.test.ts`, `apps/web/content/docs/api/ag-ui.mdx`, `apps/web/content/docs/ag-ui.mdx`, `packages/ag-ui/README.md`
- Tests: `packages/ag-ui/test/view/turns.test.ts`, `packages/ag-ui/test/view/labels.test.ts`, `packages/ag-ui/test/view/public-api.test.ts`
- Spike: local edits to `examples/research/web/app/page.tsx` (not committed) + findings appended to this plan
- Changeset: `.changeset/ag-ui-view-entry.md`

---

# PR A — Protocol fixes

Branch: `blove/activity-protocol-clean-results` off `origin/main`.

### Task 1: `TOOL_CALL_RESULT.content` carries the tool's output

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts:137-146` (add helpers), `:532-552` (`tool_result` case)
- Test: `packages/ag-ui/test/outbound.test.ts:103-133`

- [ ] **Step 1: Rewrite the failing-tool test and add two more**

In `packages/ag-ui/test/outbound.test.ts`, replace the body of the test `"a failing tool's error ToolMessage reaches TOOL_CALL_RESULT under the same toolCallId"` (keep the name — it is not docs-pinned, but keeping it stable keeps `git blame` useful) so the assertion reads the content, not the wrapper, and add two sibling tests right after it:

```ts
  test("a failing tool's error ToolMessage reaches TOOL_CALL_RESULT under the same toolCallId", async () => {
    // What @b4run/langchain emits for a thrown tool: the error ToolMessage the
    // model receives, keyed by the model's tool-call id. The wire carries the
    // text the model saw, never the serialized message object.
    const errorToolMessage = {
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        status: "error",
        content: "Error: kaboom\n Please fix your mistakes.",
        name: "customerStatement",
        tool_call_id: "call_stmt_1",
      },
    }
    const events = await collect([
      { type: "tool_call", data: { id: "call_stmt_1", name: "customerStatement", input: {} } },
      {
        type: "tool_result",
        data: { id: "call_stmt_1", name: "customerStatement", output: errorToolMessage },
      },
      { type: "done", data: {} },
    ])
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
    expect(result).toEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "tr-1",
      toolCallId: "call_stmt_1",
      content: "Error: kaboom\n Please fix your mistakes.",
    })
  })

  test("a live ToolMessage instance shape yields its content, not its fields", async () => {
    // The adapter forwards LangGraph's `on_tool_end` output unserialized: a
    // ToolMessage whose own properties are the fields (no `kwargs` wrapper).
    const liveToolMessage = {
      content: "(no memories found)",
      status: "success",
      name: "recall",
      tool_call_id: "call_recall_1",
      additional_kwargs: {},
      response_metadata: {},
    }
    const events = await collect([
      { type: "tool_call", data: { id: "call_recall_1", name: "recall", input: { query: "x" } } },
      { type: "tool_result", data: { id: "call_recall_1", name: "recall", output: liveToolMessage } },
      { type: "done", data: {} },
    ])
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
    expect(result).toMatchObject({ toolCallId: "call_recall_1", content: "(no memories found)" })
  })

  test("a Command output yields the content of its last ToolMessage", async () => {
    const command = {
      update: {
        todos: [{ content: "a", status: "pending" }],
        messages: [
          {
            content: '{"todos":[{"content":"a","status":"pending"}]}',
            name: "writeTodos",
            tool_call_id: "call_plan_1",
          },
        ],
      },
    }
    const events = await collect([
      { type: "tool_call", data: { id: "call_plan_1", name: "savePlan", input: {} } },
      { type: "tool_result", data: { id: "call_plan_1", name: "savePlan", output: command } },
      { type: "done", data: {} },
    ])
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
    expect(result).toMatchObject({
      toolCallId: "call_plan_1",
      content: '{"todos":[{"content":"a","status":"pending"}]}',
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/outbound.test.ts -t "ToolMessage"`
Expected: 3 failures — the first two receive the serialized/raw object as `content`, the third receives `JSON.stringify(command)`.

- [ ] **Step 3: Add the tool-result view and use it**

In `packages/ag-ui/src/outbound.ts`, directly after `stringifyContent` (ends at line 146), add:

```ts
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A ToolMessage's fields, whether the value is the live instance (fields on
 * the object) or its serialized form (fields under `kwargs`). Anything
 * without a string `tool_call_id` is not a ToolMessage.
 */
function readToolMessageFields(
  value: unknown,
): { readonly content: unknown; readonly status: unknown } | undefined {
  if (!isPlainObject(value)) return undefined
  const fields = isPlainObject(value.kwargs) ? value.kwargs : value
  if (typeof fields.tool_call_id !== "string") return undefined
  return { content: fields.content, status: fields.status }
}

/** What a tool result looks like on the wire: the text the model saw, and whether the tool failed. */
export interface ToolResultView {
  readonly content: string
  readonly failed: boolean
}

/**
 * The adapter forwards LangGraph's `on_tool_end` output unchanged: a
 * ToolMessage for a string-returning tool, a Command whose `update.messages`
 * ends in one for a `{result, state}` tool, or the error ToolMessage for a
 * tool that threw. The protocol wants the tool's output, so unwrap all three;
 * a bare value (tests, third-party producers) is serialized as before.
 */
export function toolResultView(output: unknown): ToolResultView {
  const direct = readToolMessageFields(output)
  if (direct !== undefined) {
    return { content: stringifyContent(direct.content), failed: direct.status === "error" }
  }
  if (isPlainObject(output) && isPlainObject(output.update) && Array.isArray(output.update.messages)) {
    const messages = output.update.messages
    for (let index = messages.length - 1; index >= 0; index--) {
      const fields = readToolMessageFields(messages[index])
      if (fields !== undefined) {
        return { content: stringifyContent(fields.content), failed: fields.status === "error" }
      }
    }
  }
  return { content: stringifyContent(output), failed: false }
}
```

Then in the `tool_result` case (line ~541) replace `content: stringifyContent(tr.output),` with:

```ts
          content: toolResultView(tr.output).content,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/outbound.test.ts`
Expected: all pass (the three new ones included; no other test asserted the wrapper).

- [ ] **Step 5: Run the conformance gate**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/conformance.test.ts`
Expected: PASS (content shape is unconstrained by the schema; the canned outputs are strings/arrays).

- [ ] **Step 6: Commit**

```bash
git add packages/ag-ui/src/outbound.ts packages/ag-ui/test/outbound.test.ts
git commit -m "fix(ag-ui): TOOL_CALL_RESULT carries the tool's output, not the serialized ToolMessage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: Permission envelopes name their tool call

**Files:**
- Modify: `packages/core/src/capabilities/permission-gate.ts` (`gateBashOp`, `gateToolOp`, `gateMemorySupersede`, `gatePathOp` option; `InterruptArgs`; `emitPermissionInterrupt`; `wrapToolWithApproval`; `wrapToolWithConstraint`)
- Modify: `packages/core/src/capabilities/built-in/workspace.ts:321-331` (runBash), `packages/core/src/capabilities/built-in/memory.ts:189` and `:322` (remember)
- Test: `packages/core/test/capabilities/permission-gate-tool-call-id.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/capabilities/permission-gate-tool-call-id.test.ts`. It runs each gate inside a real compiled graph, the way `approval-grants.test.ts` does, and reads the parked envelope back out of the checkpoint:

```ts
import type { PermissionsStore } from "@b4run/permissions"
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import { describe, expect, it } from "vitest"
import {
  gateBashOp,
  gateMemorySupersede,
  gateToolOp,
  wrapToolWithApproval,
} from "../../src/capabilities/permission-gate.js"

const State = Annotation.Root({
  parked: Annotation<unknown>({ reducer: (_a, b) => b, default: () => undefined }),
})

/** An interactive store that knows nothing, so every gate parks. */
function askingStore(): PermissionsStore {
  return {
    mode: "interactive",
    match: () => "unknown",
    addAllow: async () => {},
  } as unknown as PermissionsStore
}

function parkingGraph(body: () => Promise<unknown>) {
  return new StateGraph(State)
    .addNode("park", async () => ({ parked: await body() }))
    .addEdge(START, "park")
    .addEdge("park", END)
    .compile({ checkpointer: new MemorySaver() })
}

/** Pull the parked `__interrupt__` envelope back out of the checkpoint. */
function parkedEnvelope(result: unknown): Record<string, unknown> | undefined {
  const interrupts = (result as { __interrupt__?: { value?: unknown }[] }).__interrupt__
  const value = interrupts?.[0]?.value
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

const config = { configurable: { thread_id: "t" } }

describe("permission envelopes name the tool call they gate", () => {
  it("gateToolOp puts toolCallId on a kind:tool envelope", async () => {
    const app = parkingGraph(() =>
      gateToolOp(askingStore(), "deployProd", "{}", { toolCallId: "call_deploy_1" }),
    )
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).toMatchObject({ kind: "tool", toolCallId: "call_deploy_1" })
  })

  it("gateBashOp puts toolCallId on a kind:command envelope", async () => {
    const app = parkingGraph(() =>
      gateBashOp(askingStore(), "node scripts/fetch.mjs", { toolCallId: "call_bash_1" }),
    )
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).toMatchObject({ kind: "command", toolCallId: "call_bash_1" })
  })

  it("gateMemorySupersede puts toolCallId on a kind:memory envelope", async () => {
    const app = parkingGraph(() =>
      gateMemorySupersede(
        askingStore(),
        { namespace: "ns", identity: "id", oldId: "m1", oldContent: "a", newContent: "b" },
        { toolCallId: "call_mem_1" },
      ),
    )
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).toMatchObject({ kind: "memory", toolCallId: "call_mem_1" })
  })

  it("omits toolCallId when the gate has none", async () => {
    const app = parkingGraph(() => gateBashOp(askingStore(), "ls"))
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).not.toHaveProperty("toolCallId")
  })

  it("wrapToolWithApproval forwards the run context's toolCallId", async () => {
    const wrapped = wrapToolWithApproval(
      { name: "deployProd", run: async () => "deployed" },
      askingStore(),
    )
    const app = parkingGraph(() =>
      wrapped.run({}, { signal: new AbortController().signal, toolCallId: "call_deploy_2" }),
    )
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).toMatchObject({ kind: "tool", toolCallId: "call_deploy_2" })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @b4run/core exec vitest run test/capabilities/permission-gate-tool-call-id.test.ts`
Expected: FAIL — `gateToolOp` rejects the fourth argument shape at type level only; at runtime the envelopes simply lack `toolCallId` (4 of 5 fail; the "omits" test passes).

- [ ] **Step 3: Thread `toolCallId` through the gates**

In `packages/core/src/capabilities/permission-gate.ts`:

1. Add a shared option type after `GateResult` (line ~15):

```ts
/** The model's id for the tool call a gate is deciding; absent outside a model tool call. */
export interface GateCallOptions {
  readonly toolCallId?: string | undefined
}
```

2. `gatePathOp` (line 22): change the `opts` type to `opts?: { readonly interruptCapable?: boolean } & GateCallOptions` and pass it to the interrupt: add `...(opts?.toolCallId ? { toolCallId: opts.toolCallId } : {}),` inside the `emitPermissionInterrupt({ kind: "path", … })` call.

3. `gateBashOp` (line 74): add a third parameter `opts?: GateCallOptions` and the same spread inside its `emitPermissionInterrupt({ kind: "command", … })` call.

4. `gateToolOp` (line 106): change `opts` to `opts?: { readonly interruptCapable?: boolean } & GateCallOptions` and add the spread inside its `emitPermissionInterrupt({ kind: "tool", … })` call.

5. `gateMemorySupersede` (line 255): add a third parameter `opts?: GateCallOptions` and the spread inside its `emitPermissionInterrupt({ kind: "memory", … })` call.

6. `InterruptArgs` (line ~402): add `toolCallId?: string | undefined` to the `command`, `path`, `tool` and `memory` members (not `subagent`, which carries `callId`):

```ts
type InterruptArgs =
  | { kind: "command"; command: string; permissions: PermissionsStore; toolCallId?: string | undefined }
  | {
      kind: "path"
      operation: PathOperation
      path: string
      permissions: PermissionsStore
      toolCallId?: string | undefined
    }
  | {
      kind: "tool"
      toolName: string
      argsPreview: string
      permissions: PermissionsStore
      toolCallId?: string | undefined
    }
  | { /* subagent member unchanged */ }
  | {
      kind: "memory"
      namespace: string
      identity: string
      oldId: string
      oldContent: string
      newContent: string
      permissions: PermissionsStore
      toolCallId?: string | undefined
    }
```

7. In `emitPermissionInterrupt`'s `payload` (line ~437), after the `callId`/`threadId` spread add:

```ts
    // The model's id for the gated call, so a client can show the prompt on
    // the call it belongs to. A subagent dispatch gate names its call as
    // `callId` instead (the two coexist on a child's own gate: `callId` is the
    // task call, `toolCallId` the child's call).
    ...("toolCallId" in args && args.toolCallId ? { toolCallId: args.toolCallId } : {}),
```

8. `wrapToolWithApproval` (line ~320): the gate call becomes

```ts
      const toolCallId = (context as { readonly toolCallId?: string }).toolCallId
      const gate = await gateToolOp(permissions, tool.name, buildArgsPreview(input), {
        ...opts,
        ...(toolCallId ? { toolCallId } : {}),
      })
```

9. `wrapToolWithConstraint` (line ~385): the escalation gate call becomes

```ts
        const toolCallId = (context as { readonly toolCallId?: string }).toolCallId
        const gate = await gateToolOp(permissions, tool.name, buildArgsPreview(input), {
          ...(toolCallId ? { toolCallId } : {}),
        })
```

In `packages/core/src/capabilities/built-in/workspace.ts` (runBash, line ~327):

```ts
      const gate = await gateBashOp(permissions, command, {
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      })
```

In `packages/core/src/capabilities/built-in/memory.ts`: change the `remember` tool's `run` signature (line 189) from `run: async (input: unknown) => {` to

```ts
        run: async (input: unknown, ctx?: { readonly toolCallId?: string }) => {
```

and at the `gateMemorySupersede(permissions, { … })` call (line 322) add a third argument after the detail object:

```ts
                }, { ...(ctx?.toolCallId ? { toolCallId: ctx.toolCallId } : {}) })
```

(Keep the detail object exactly as it is; only append the options argument.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @b4run/core exec vitest run test/capabilities/permission-gate-tool-call-id.test.ts test/capabilities/permission-gate.test.ts test/capabilities/workspace.test.ts test/capabilities/memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck core**

Run: `pnpm --filter @b4run/core typecheck`
Expected: clean. (The `memory.test.ts` calls `remember.run(input, { signal })` — the new optional `ctx` accepts that.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capabilities/permission-gate.ts packages/core/src/capabilities/built-in/workspace.ts packages/core/src/capabilities/built-in/memory.ts packages/core/test/capabilities/permission-gate-tool-call-id.test.ts
git commit -m "feat(core): permission interrupts name the tool call they gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: `toAguiInterrupt` carries `subagentRunId` and a `responseSchema`

**Files:**
- Modify: `packages/ag-ui/src/interrupts.ts:60-87`, `packages/ag-ui/src/outbound.ts:303, :350`
- Test: `packages/ag-ui/test/interrupts.test.ts`, `packages/ag-ui/test/outbound.test.ts`

- [ ] **Step 1: Update and add interrupt tests**

In `packages/ag-ui/test/interrupts.test.ts`, find the test that passes both `callId: "call-a"` and `toolCallId: "call-b"` (around line 69) and change its expectation to include the attribution:

```ts
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-4",
      reason: "tool",
      toolCallId: "call-b",
      subagentRunId: "call-a",
      metadata: envelope,
    })
```

Add these tests after it:

```ts
  test("a root gate carries toolCallId and no subagentRunId", () => {
    const envelope = { interruptId: "perm-7", kind: "command", toolCallId: "call-c" }
    const interrupt = toAguiInterrupt(envelope)
    expect(interrupt).toMatchObject({ toolCallId: "call-c" })
    expect(Object.hasOwn(interrupt as object, "subagentRunId")).toBe(false)
  })

  test("a subagent dispatch gate keeps callId as the toolCallId with no subagentRunId", () => {
    const envelope = { interruptId: "perm-8", kind: "subagent", callId: "call-task" }
    expect(toAguiInterrupt(envelope)).toEqual({
      id: "perm-8",
      reason: "subagent",
      toolCallId: "call-task",
      metadata: envelope,
      responseSchema: { type: "string", enum: ["once", "always", "deny"] },
    })
  })

  test("a permission request advertises the once/always/deny answers", () => {
    const envelope = { interruptId: "perm-9", type: "permission-request", kind: "tool" }
    expect(toAguiInterrupt(envelope)).toMatchObject({
      responseSchema: { type: "string", enum: ["once", "always", "deny"] },
    })
  })

  test("a non-permission interrupt has no responseSchema", () => {
    const envelope = { interruptId: "x-1", kind: "custom" }
    const interrupt = toAguiInterrupt(envelope)
    expect(Object.hasOwn(interrupt as object, "responseSchema")).toBe(false)
  })
```

Also update the existing expectations in this file that `toEqual` a full interrupt for a `kind: "subagent"`/`type: "permission-request"` envelope so they include `responseSchema` (the `kind: "tool"` envelope at line ~69 is a permission kind, so it gains `responseSchema: { type: "string", enum: ["once", "always", "deny"] }` too). The rule implemented in Step 3: `responseSchema` is present when `type === "permission-request"` OR `kind` is one of `command|path|tool|subagent|memory`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/interrupts.test.ts`
Expected: FAIL on `subagentRunId` and `responseSchema`.

- [ ] **Step 3: Implement**

In `packages/ag-ui/src/interrupts.ts`, replace the body of `toAguiInterrupt` from `const toolCallId =` through the `return` with:

```ts
  const envToolCallId =
    typeof env.toolCallId === "string" && env.toolCallId.length > 0 ? env.toolCallId : undefined
  const envCallId =
    typeof env.callId === "string" && env.callId.length > 0 ? env.callId : undefined
  // `callId` names the `task` call of the subagent an interrupt belongs to;
  // `toolCallId` names the gated call itself. A root gate has only the
  // latter, a dispatch gate only the former (the task call IS the gated
  // call), and a child's own gate has both — then the task call is the
  // AG-UI `subagentRunId` and the child's call is the `toolCallId`.
  const toolCallId = envToolCallId ?? envCallId
  const subagentRunId = envToolCallId !== undefined && envCallId !== undefined ? envCallId : undefined
  const isPermission =
    env.type === "permission-request" || (typeof env.kind === "string" && PERMISSION_KINDS.has(env.kind))
  return {
    id: interruptId,
    reason,
    ...(typeof env.message === "string" ? { message: env.message } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(subagentRunId !== undefined ? { subagentRunId } : {}),
    metadata: env,
    ...(isPermission ? { responseSchema: PERMISSION_RESPONSE_SCHEMA } : {}),
  }
```

and above the function add:

```ts
const PERMISSION_KINDS: ReadonlySet<string> = new Set(["command", "path", "tool", "subagent", "memory"])

/** What a client may answer a permission prompt with (`resume[].payload`). */
const PERMISSION_RESPONSE_SCHEMA = { type: "string", enum: ["once", "always", "deny"] } as const
```

In `packages/ag-ui/src/outbound.ts`, the attribution must prefer the explicit run id. At line ~303 (`closeOpenSubagents`):

```ts
        const interruptIds = reason.interrupts
          .filter((interrupt) => (interrupt.subagentRunId ?? interrupt.toolCallId) === open.callId)
          .map((interrupt) => interrupt.id)
```

At line ~350 (`finishInterrupted`), replace the `interrupts:` mapping with:

```ts
        interrupts: pendingInterrupts.map((interrupt) => {
          const run = interrupt.subagentRunId ?? interrupt.toolCallId
          return run !== undefined && suspended.has(run) && interrupt.subagentRunId === undefined
            ? { ...interrupt, subagentRunId: run }
            : interrupt
        }),
```

- [ ] **Step 4: Run all ag-ui tests and typecheck**

Run: `pnpm --filter @b4run/ag-ui test && pnpm --filter @b4run/ag-ui typecheck`
Expected: PASS. If `outbound.test.ts`'s `"a child interrupt suspends the child, tags the interrupt, and text closes first"` asserts a full `toEqual` on the interrupt, add `responseSchema` to its expected object (its envelope is `kind: "command"`); do not rename the test.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/interrupts.ts packages/ag-ui/src/outbound.ts packages/ag-ui/test/interrupts.test.ts packages/ag-ui/test/outbound.test.ts
git commit -m "feat(ag-ui): interrupts carry subagentRunId for a child's gate and a once/always/deny responseSchema

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: Docs and changeset for PR A

**Files:**
- Modify: `apps/web/content/docs/ag-ui.mdx:478`, `apps/web/content/docs/ag-ui.mdx` interrupt section (~`:540-556`), `apps/web/content/docs/permissions.mdx:85-96`, `apps/web/content/docs/api/ag-ui.mdx:61`
- Create: `.changeset/activity-protocol-clean-results.md`

- [ ] **Step 1: Edit the docs**

`apps/web/content/docs/ag-ui.mdx`, the chunk table row for a failing tool (line 478) becomes:

```
| `tool_result` for a tool that threw | `TOOL_CALL_RESULT` under the same `toolCallId`, with `content` set to the error text the model receives (a `b4.step` event with `status: "failed"` follows it; see [Step events](#step-events)) |
```

(The `#step-events` section is added in PR B; until then leave the parenthetical out: `… the error text the model receives |`. PR B's Task 13 adds it.)

In the same file's interrupt section (after the `resume?: Array<…>` block, before "## Response schema"), add:

```
A permission interrupt names the tool call it gates in `toolCallId`. Inside a subagent, a tool, command or memory gate also carries `subagentRunId`, the `task` call that started that subagent (see [Subagents](#subagents)). A path gate inside a subagent, or a gate whose model call had no id, gets the enclosing `task` call as its `toolCallId` instead. A path gate at the root carries no `toolCallId` yet. A permission prompt carries `responseSchema: { type: "string", enum: ["once", "always", "deny"] }`, so a client knows what a resolved payload may say.
```

`apps/web/content/docs/permissions.mdx`, the tool interrupt payload sample (line ~85) gains a line after `"kind": "tool",`:

```
  "toolCallId": "call_deploy_1",
```

and after the `detail.argsPreview …` paragraph add:

```
`toolCallId` is the model's id for the gated call, so a client can show the prompt on that call. Command and memory gates carry it too; path gates don't carry it yet.
```

`apps/web/content/docs/api/ag-ui.mdx`, the `B4AguiInterrupt` row (line 61) becomes:

```
| `B4AguiInterrupt` | AG-UI's interrupt as B4.run emits it: `toolCallId` names the gated call, `subagentRunId` the child it was raised in, `responseSchema` the answers a permission prompt accepts; the approval grant is at `metadata.grant`. |
```

- [ ] **Step 2: Create the changeset**

`.changeset/activity-protocol-clean-results.md`:

```md
---
"@b4run/ag-ui": patch
"@b4run/core": patch
---

AG-UI `TOOL_CALL_RESULT.content` now carries the tool's output — the text the model received — instead of the serialized LangChain `ToolMessage`. Permission interrupts name the tool call they gate (`toolCallId`; command, tool and memory gates), a tool, command or memory gate raised inside a subagent also carries `subagentRunId`, and every permission prompt advertises its answers as `responseSchema: { type: "string", enum: ["once", "always", "deny"] }`.
```

- [ ] **Step 3: Run the gates that read these files**

Run: `pnpm build && node scripts/check-docs.mjs && pnpm --filter @b4run/web test -- --run app/components/docs`
Expected: PASS. (`check-docs` scans the three mdx files; the docs-site tests pin the `api/ag-ui.mdx` export table rows, which only changed text.)

- [ ] **Step 4: Regenerate the SEO manifest and commit**

```bash
git add apps/web/content/docs .changeset/activity-protocol-clean-results.md
git commit -m "docs: tool results carry output; interrupts name their tool call

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate seo lastmod

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Validate and open PR A

- [ ] **Step 1: Full validation**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS. If `test/security-dependencies/brand-migration.test.ts` flags your new test file, you used the retired product name somewhere — don't.

- [ ] **Step 2: Push, open the PR, enable auto-merge**

```bash
git push -u origin blove/activity-protocol-clean-results
gh pr create --base main --title "feat(ag-ui): tool results carry the tool's output; interrupts name their tool call" --body "$(cat <<'EOF'
Sub-project 1 of `docs/superpowers/specs/2026-10-03-b4-activity-components-design.md`, PR A (protocol fixes).

- `TOOL_CALL_RESULT.content` is the text the model saw (ToolMessage content, Command's last ToolMessage, or the error text), never the serialized `{"lc":1,…}` message.
- Permission interrupts carry `toolCallId` for command, tool and memory gates (root gates had none); a child's own gate also carries `subagentRunId`; permission prompts carry `responseSchema: { enum: ["once","always","deny"] }`.
- Subagent suspension attribution prefers `subagentRunId`.

Path gates keep the option but are not yet threaded (needs `createWorkspaceFs` plumbing; follow-up).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then in the Claude Code session: `mcp__ccd_pr__get_status`, and `mcp__ccd_pr__set_auto_merge` with `enabled: true`, `merge_method: "squash"`.

---

# PR B — `display` on tools, `b4.step` on the wire

Branch: `blove/tool-display-step-events` off `origin/main` **after PR A merges** (Task 7 builds on `toolResultView`).

### Task 6: `ToolDisplay` in the SDK

**Files:**
- Create: `packages/sdk/src/tool-display.ts`
- Modify: `packages/sdk/src/index.ts` (after the `workspace-fs.js` export line)
- Test: `packages/sdk/test/tool-display.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import {
  describeToolDisplayProblem,
  TOOL_DISPLAY_ICONS,
  TOOL_DISPLAY_LABEL_MAX,
  type ToolDisplay,
} from "../src/tool-display.ts"

describe("ToolDisplay", () => {
  it("lists the fixed icon set", () => {
    expect(TOOL_DISPLAY_ICONS).toEqual([
      "search",
      "read",
      "write",
      "run",
      "web",
      "memory",
      "plan",
      "agent",
      "think",
      "tool",
    ])
    expect(TOOL_DISPLAY_LABEL_MAX).toBe(120)
  })

  it("accepts a complete display and an empty one", () => {
    const full: ToolDisplay<{ query: string }, string[]> = {
      icon: "search",
      running: ({ query }) => `Searching for ${query}`,
      done: ({ query }, results) => `Found ${results.length} results for ${query}`,
      sources: (results) => results.map((title) => ({ title })),
    }
    expect(describeToolDisplayProblem(full)).toBeUndefined()
    expect(describeToolDisplayProblem({})).toBeUndefined()
  })

  it("names the first problem it finds", () => {
    expect(describeToolDisplayProblem(null)).toBe("display must be an object")
    expect(describeToolDisplayProblem([])).toBe("display must be an object")
    expect(describeToolDisplayProblem({ icon: "nope" })).toBe(
      'display.icon must be one of search, read, write, run, web, memory, plan, agent, think, tool (got "nope")',
    )
    expect(describeToolDisplayProblem({ running: "Searching" })).toBe(
      "display.running must be a function (got string)",
    )
    expect(describeToolDisplayProblem({ sources: 1 })).toBe(
      "display.sources must be a function (got number)",
    )
    expect(describeToolDisplayProblem({ group: () => "" })).toBe(
      'display has an unknown key "group" (allowed: icon, running, done, sources)',
    )
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/sdk exec vitest run test/tool-display.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/sdk/src/tool-display.ts`:

```ts
/**
 * How a tool call reads to a person. A tool file exports `display` next to
 * `description`; the runtime evaluates it per call and streams the result as
 * an AG-UI `CUSTOM` event named `b4.step`, so a chat UI can say
 * "Searched the corpus for “agents”" instead of `searchCorpus`.
 *
 * Every field is optional. Without `running`/`done` a client falls back to
 * "Using <tool>…" / "Used <tool>". Labels are plain text; the runtime
 * truncates them at {@link TOOL_DISPLAY_LABEL_MAX} characters.
 */
export const TOOL_DISPLAY_ICONS = [
  "search",
  "read",
  "write",
  "run",
  "web",
  "memory",
  "plan",
  "agent",
  "think",
  "tool",
] as const

export type ToolDisplayIcon = (typeof TOOL_DISPLAY_ICONS)[number]

/** A file, URL or record a call drew on; shown as a chip under the step. */
export interface ToolDisplaySource {
  readonly title: string
  readonly href?: string
}

// biome-ignore lint/suspicious/noExplicitAny: defaults widen to the tool's own input/output types
export interface ToolDisplay<TInput = any, TOutput = any> {
  readonly icon?: ToolDisplayIcon
  /** The sentence while the call runs, e.g. `Searching the corpus for “${query}”`. */
  readonly running?: (input: TInput) => string
  /** The sentence once it returned, e.g. `Searched the corpus for “${query}”`. */
  readonly done?: (input: TInput, output: TOutput) => string
  /** What the call drew on, from its output. */
  readonly sources?: (output: TOutput) => readonly ToolDisplaySource[]
}

export const TOOL_DISPLAY_LABEL_MAX = 120

const DISPLAY_KEYS = ["icon", "running", "done", "sources"] as const
const FUNCTION_KEYS = ["running", "done", "sources"] as const

export function isToolDisplayIcon(value: unknown): value is ToolDisplayIcon {
  return typeof value === "string" && (TOOL_DISPLAY_ICONS as readonly string[]).includes(value)
}

/**
 * The first thing wrong with a `display` export, as a sentence, or undefined
 * when it is valid. Used by `b4 check` and the runtime's tool normalizer, so
 * a bad export fails at discovery rather than on the first call.
 */
export function describeToolDisplayProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "display must be an object"
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(DISPLAY_KEYS as readonly string[]).includes(key)) {
      return `display has an unknown key "${key}" (allowed: ${DISPLAY_KEYS.join(", ")})`
    }
  }
  if (record.icon !== undefined && !isToolDisplayIcon(record.icon)) {
    return `display.icon must be one of ${TOOL_DISPLAY_ICONS.join(", ")} (got ${JSON.stringify(record.icon)})`
  }
  for (const key of FUNCTION_KEYS) {
    const field = record[key]
    if (field !== undefined && typeof field !== "function") {
      return `display.${key} must be a function (got ${typeof field})`
    }
  }
  return undefined
}
```

Append to `packages/sdk/src/index.ts`:

```ts
export type { ToolDisplay, ToolDisplayIcon, ToolDisplaySource } from "./tool-display.js"
export {
  describeToolDisplayProblem,
  isToolDisplayIcon,
  TOOL_DISPLAY_ICONS,
  TOOL_DISPLAY_LABEL_MAX,
} from "./tool-display.js"
```

- [ ] **Step 4: Run tests, typecheck, and the SDK export inventory**

Run: `pnpm --filter @b4run/sdk test && pnpm --filter @b4run/sdk typecheck`
Expected: PASS.

Then add rows to `apps/web/content/docs/api/sdk.mdx`, in the `@b4run/sdk` table after the `WorkspaceContext` row:

```
| `ToolDisplay` | Describe how a tool call reads to a person (icon, running/done labels, sources). |
| `ToolDisplayIcon` | Name one of the fixed step icons. |
| `ToolDisplaySource` | Describe a file, URL or record a call drew on. |
| `TOOL_DISPLAY_ICONS` | List the fixed step icon names. |
| `TOOL_DISPLAY_LABEL_MAX` | Cap a step label's length. |
| `describeToolDisplayProblem` | Name what is wrong with a `display` export, or nothing. |
| `isToolDisplayIcon` | Narrow a string to a step icon name. |
```

Run: `pnpm build && node scripts/check-docs.mjs`
Expected: PASS (the inventory check sees a row per export).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/tool-display.ts packages/sdk/src/index.ts packages/sdk/test/tool-display.test.ts apps/web/content/docs/api/sdk.mdx
git commit -m "feat(sdk): ToolDisplay — how a tool call reads to a person

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: `display` is a tool export, validated at discovery

**Files:**
- Modify: `packages/core/src/capabilities/types.ts:331` (`B4ToolDefinition`), `packages/cli/src/lib/runtime/tool-shape.ts` (`DiscoveredToolDefinition`, `normalizeToolModule`), `packages/cli/src/lib/runtime/execute-route-core.ts:1633-1640`, `packages/langchain/src/tool-converter.ts:23-46` (local `B4ToolDefinition`), `packages/langchain/src/subagent-tool-bridge.ts:29-33` (`SubagentTaskPlaceholder`)
- Test: `packages/cli/test/tool-discovery-errors.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe` in `packages/cli/test/tool-discovery-errors.test.ts`:

```ts
  it("keeps a valid display export on the definition", async () => {
    writeTool(
      "search.ts",
      `export const display = {
        icon: "search",
        running: (input) => "Searching for " + input.query,
        done: (input, output) => "Found " + output.length + " results",
      }
      export default async (input) => [input.query]`,
    )
    const [tool] = await discover()
    expect(tool?.display?.icon).toBe("search")
    expect(tool?.display?.running?.({ query: "agents" })).toBe("Searching for agents")
  })

  it("rejects a display export with an unknown icon, naming the field and the code", async () => {
    writeTool(
      "search.ts",
      `export const display = { icon: "sparkle" }
      export default async () => "ok"`,
    )
    await expect(discover()).rejects.toThrow(/exports display, but display\.icon must be one of/)
    await expect(discover()).rejects.toThrow(/B4_E5002/)
  })

  it("rejects a display export whose label is not a function", async () => {
    writeTool(
      "search.ts",
      `export const display = { running: "Searching" }
      export default async () => "ok"`,
    )
    await expect(discover()).rejects.toThrow(/display\.running must be a function \(got string\)/)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/cli exec vitest run test/tool-discovery-errors.test.ts`
Expected: the first fails (`display` undefined on the definition), the other two fail (no error thrown).

- [ ] **Step 3: Implement**

`packages/core/src/capabilities/types.ts` — add to `B4ToolDefinition` after `schema?`:

```ts
  /** How a call of this tool reads to a person; see `ToolDisplay` in `@b4run/sdk`. */
  readonly display?: import("@b4run/sdk").ToolDisplay
```

`packages/cli/src/lib/runtime/tool-shape.ts`:

1. Import: change the `@b4run/sdk` imports to

```ts
import type { ToolDisplay, WorkspaceFs } from "@b4run/sdk"
import { describeError, describeToolDisplayProblem, errorDocsUrl } from "@b4run/sdk"
```

2. Add to `DiscoveredToolDefinition` after `returnDirect?`:

```ts
  /** How a call reads to a person; see `ToolDisplay`. */
  readonly display?: ToolDisplay
```

3. In `normalizeToolModule`, add `readonly display?: unknown` to the `toolModule` cast type, and after the `returnDirect` validation block add:

```ts
  if (toolModule.display !== undefined) {
    const problem = describeToolDisplayProblem(toolModule.display)
    if (problem !== undefined) {
      throw new Error(`Tool file ${filePath} exports display, but ${problem}.\n${toolShapeDocsFooter()}`)
    }
  }
  const display =
    toolModule.display !== undefined ? { display: toolModule.display as ToolDisplay } : {}
```

and spread `...display,` into both returned definitions (next to `...returnDirect,`).

`packages/cli/src/lib/runtime/execute-route-core.ts` (capability copy, line ~1633): add inside the pushed object, after the `schema` spread:

```ts
            ...(t.display !== undefined ? { display: t.display } : {}),
```

`packages/langchain/src/tool-converter.ts` — the local `B4ToolDefinition` gains, after `schema?`:

```ts
  /** How a call reads to a person; evaluated per call and streamed as `b4.step`. */
  readonly display?: ToolDisplay
```

with `import type { ToolDisplay } from "@b4run/sdk"` added at the top.

`packages/langchain/src/subagent-tool-bridge.ts` — `SubagentTaskPlaceholder` gains `readonly display?: ToolDisplay` with the same import.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @b4run/cli exec vitest run test/tool-discovery-errors.test.ts test/check-command.test.ts && pnpm -r --filter @b4run/core --filter @b4run/cli --filter @b4run/langchain typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capabilities/types.ts packages/cli/src/lib/runtime/tool-shape.ts packages/cli/src/lib/runtime/execute-route-core.ts packages/langchain/src/tool-converter.ts packages/langchain/src/subagent-tool-bridge.ts packages/cli/test/tool-discovery-errors.test.ts
git commit -m "feat(cli): tools may export display; b4 check validates its shape

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: Evaluate labels safely (langchain `tool-display.ts`)

**Files:**
- Create: `packages/langchain/src/tool-display.ts`
- Test: `packages/langchain/test/tool-display.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { describeDone, describeRunning, type StepPayload } from "../src/tool-display.ts"

afterEach(() => vi.restoreAllMocks())

describe("describeRunning / describeDone", () => {
  it("returns the icon and label", () => {
    const display = { icon: "search" as const, running: (i: { q: string }) => `Searching ${i.q}` }
    expect(describeRunning(display, { q: "agents" }, "searchCorpus")).toEqual({
      icon: "search",
      label: "Searching agents",
    })
  })

  it("returns undefined label when the field is absent, but still the icon", () => {
    expect(describeRunning({ icon: "read" }, {}, "readDoc")).toEqual({ icon: "read" })
    expect(describeDone({ icon: "read" }, {}, "x", "readDoc")).toEqual({ icon: "read" })
  })

  it("truncates a long label at 120 characters with an ellipsis", () => {
    const label = "x".repeat(200)
    const out = describeRunning({ running: () => label }, {}, "t")
    expect(out.label).toHaveLength(120)
    expect(out.label?.endsWith("…")).toBe(true)
  })

  it("falls back and warns once per tool and field when a label throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const display = {
      running: () => {
        throw new Error("boom")
      },
    }
    expect(describeRunning(display, {}, "flaky")).toEqual({})
    expect(describeRunning(display, {}, "flaky")).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/display\.running for tool "flaky" threw/)
  })

  it("coerces non-string labels and drops malformed sources", () => {
    const display = {
      done: () => 42 as unknown as string,
      sources: () => [{ title: "a.md" }, { title: 3 }, "x", { title: "b.md", href: "http://b" }] as never,
    }
    const out: StepPayload = describeDone(display, {}, {}, "t")
    expect(out).toEqual({
      label: "42",
      sources: [{ title: "a.md" }, { title: "b.md", href: "http://b" }],
    })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/langchain exec vitest run test/tool-display.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/langchain/src/tool-display.ts`:

```ts
import {
  TOOL_DISPLAY_LABEL_MAX,
  type ToolDisplay,
  type ToolDisplayIcon,
  type ToolDisplaySource,
} from "@b4run/sdk"
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch/web"
import type { RunnableConfig } from "@langchain/core/runnables"

/** The name of the AG-UI `CUSTOM` event (and the LangChain custom event) a step travels as. */
export const B4_STEP_EVENT_NAME = "b4.step"

/** What one `b4.step` dispatch carries, before the adapter adds identity. */
export interface StepPayload {
  readonly icon?: ToolDisplayIcon
  readonly label?: string
  readonly sources?: readonly ToolDisplaySource[]
}

export interface StepEventData extends StepPayload {
  readonly tool_call_id: string
  readonly status: "running" | "completed"
}

const warned = new Set<string>()

function warnOnce(toolName: string, field: string): void {
  const key = `${toolName}\u0000${field}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[b4] display.${field} for tool "${toolName}" threw; using the default label`)
}

function truncate(label: string): string {
  return label.length > TOOL_DISPLAY_LABEL_MAX ? `${label.slice(0, TOOL_DISPLAY_LABEL_MAX - 1)}…` : label
}

function readLabel(toolName: string, field: "running" | "done", produce: () => unknown): string | undefined {
  try {
    const value = produce()
    if (value === undefined || value === null) return undefined
    return truncate(String(value))
  } catch {
    warnOnce(toolName, field)
    return undefined
  }
}

function readSources(toolName: string, produce: () => unknown): readonly ToolDisplaySource[] | undefined {
  try {
    const value = produce()
    if (!Array.isArray(value)) return undefined
    const sources: ToolDisplaySource[] = []
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue
      const { title, href } = entry as { title?: unknown; href?: unknown }
      if (typeof title !== "string" || title === "") continue
      sources.push({ title, ...(typeof href === "string" && href !== "" ? { href } : {}) })
    }
    return sources
  } catch {
    warnOnce(toolName, "sources")
    return undefined
  }
}

/** The step as a call begins: icon plus the `running` sentence. Never throws. */
export function describeRunning(display: ToolDisplay, input: unknown, toolName: string): StepPayload {
  const label = display.running ? readLabel(toolName, "running", () => display.running?.(input)) : undefined
  return {
    ...(display.icon !== undefined ? { icon: display.icon } : {}),
    ...(label !== undefined ? { label } : {}),
  }
}

/** The step as a call returns: icon, the `done` sentence, and its sources. Never throws. */
export function describeDone(
  display: ToolDisplay,
  input: unknown,
  output: unknown,
  toolName: string,
): StepPayload {
  const label = display.done ? readLabel(toolName, "done", () => display.done?.(input, output)) : undefined
  const sources = display.sources ? readSources(toolName, () => display.sources?.(output)) : undefined
  return {
    ...(display.icon !== undefined ? { icon: display.icon } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(sources !== undefined ? { sources } : {}),
  }
}

/** Stream one step over LangChain's custom-event channel; a failure never fails the tool. */
export async function dispatchStep(config: RunnableConfig | undefined, data: StepEventData): Promise<void> {
  try {
    await dispatchCustomEvent(B4_STEP_EVENT_NAME, data, config)
  } catch {
    // Display is secondary; the tool result is what matters.
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @b4run/langchain exec vitest run test/tool-display.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/tool-display.ts packages/langchain/test/tool-display.test.ts
git commit -m "feat(langchain): evaluate a tool's display per call, never throwing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: The converter emits `b4.step` and persists labels on the ToolMessage

**Files:**
- Modify: `packages/langchain/src/tool-converter.ts:74-154`
- Test: `packages/langchain/test/tool-converter.test.ts`, `packages/langchain/test/tool-converter-runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/langchain/test/tool-converter.test.ts` inside `describe("convertToolToLangChain", …)`:

```ts
  test("dispatches a running step before the body and a completed step after it, with labels", async () => {
    const order: string[] = []
    dispatchCustomEvent.mockImplementation(async (name, payload) => {
      order.push(`${name}:${(payload as { status?: string }).status ?? (payload as { event?: string }).event}`)
    })
    const converted = convertToolToLangChain({
      name: "searchCorpus",
      display: {
        icon: "search",
        running: (input: { query: string }) => `Searching the corpus for “${input.query}”`,
        done: (input: { query: string }, output: { path: string }[]) =>
          `Searched the corpus for “${input.query}” (${output.length} hits)`,
        sources: (output: { path: string }[]) => output.map((hit) => ({ title: hit.path })),
      },
      run: async () => {
        order.push("run")
        return [{ path: "corpus/a.md" }]
      },
    })
    const config = { configurable: {}, toolCall: { id: "call_search_1" } }
    await converted.func({ query: "agents" }, undefined, config)
    expect(order).toEqual(["b4.step:running", "run", "b4.step:completed"])
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      1,
      "b4.step",
      {
        tool_call_id: "call_search_1",
        status: "running",
        icon: "search",
        label: "Searching the corpus for “agents”",
      },
      expect.anything(),
    )
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      2,
      "b4.step",
      {
        tool_call_id: "call_search_1",
        status: "completed",
        icon: "search",
        label: "Searched the corpus for “agents” (1 hits)",
        sources: [{ title: "corpus/a.md" }],
      },
      expect.anything(),
    )
  })

  test("a tool without display dispatches no step and returns a plain string", async () => {
    const converted = convertToolToLangChain({ name: "plain", run: async () => "ok" })
    const result = await converted.func({}, undefined, { configurable: {}, toolCall: { id: "c1" } })
    expect(result).toBe('"ok"')
    expect(dispatchCustomEvent).not.toHaveBeenCalled()
  })

  test("a tool with display returns a ToolMessage carrying the step in additional_kwargs", async () => {
    const converted = convertToolToLangChain({
      name: "readDoc",
      display: { icon: "read", done: (input: { path: string }) => `Read ${input.path}` },
      run: async () => ({ content: "# Title" }),
    })
    const result = (await converted.func({ path: "corpus/a.md" }, undefined, {
      configurable: {},
      toolCall: { id: "call_read_1" },
    })) as { content: string; tool_call_id: string; additional_kwargs: Record<string, unknown> }
    expect(result.content).toBe('{"content":"# Title"}')
    expect(result.tool_call_id).toBe("call_read_1")
    expect(result.additional_kwargs.b4_step).toEqual({ icon: "read", label: "Read corpus/a.md" })
  })

  test("a {result, state} tool with display keeps the Command and annotates its ToolMessage", async () => {
    const converted = convertToolToLangChain({
      name: "savePlan",
      display: { icon: "plan", done: () => "Updated the plan" },
      run: async () => ({ result: "saved", state: { todos: [] } }),
    })
    const result = await converted.func({}, undefined, { configurable: {}, toolCall: { id: "call_plan_1" } })
    expect(isCommand(result)).toBe(true)
    const message = (result as Command).update as { messages: { additional_kwargs: Record<string, unknown> }[] }
    expect(message.messages[0]?.additional_kwargs.b4_step).toEqual({ icon: "plan", label: "Updated the plan" })
  })

  test("without a provider tool-call id no step is dispatched (nothing to attach it to)", async () => {
    const converted = convertToolToLangChain({
      name: "searchCorpus",
      display: { running: () => "Searching" },
      run: async () => "ok",
    })
    await converted.func({}, undefined, { configurable: {} })
    expect(dispatchCustomEvent).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/langchain exec vitest run test/tool-converter.test.ts -t "step|display"`
Expected: FAIL (no dispatch, plain string results).

- [ ] **Step 3: Implement**

In `packages/langchain/src/tool-converter.ts`:

1. Add the import: `import { describeDone, describeRunning, dispatchStep, type StepPayload } from "./tool-display.js"`.

2. Inside `func`, right after `const recorded = …` (before `const body = async () => {`), add:

```ts
      // A step is only worth streaming when a client can attach it to a call.
      const display = toolCallId !== "" ? tool.display : undefined
      if (display !== undefined) {
        await dispatchStep(liveConfig, {
          tool_call_id: toolCallId,
          status: "running",
          ...describeRunning(display, input, tool.name),
        })
      }
```

3. Inside `body`, after `const rawResult = await tool.run(…)` and before `const { content, stateUpdates } = unwrapToolResult(rawResult)`, add:

```ts
        const step: StepPayload | undefined =
          display !== undefined ? describeDone(display, input, rawResult, tool.name) : undefined
```

4. Replace the `convertedResult` construction with:

```ts
        // With a display, the step rides on the checkpointed ToolMessage too,
        // so a restored thread can tell the same story without the stream.
        // LangChain's ToolNode returns a ToolMessage a tool returns as-is.
        const additionalKwargs = step !== undefined ? { b4_step: step } : undefined
        const toolMessage = () =>
          new ToolMessage({
            content: finalContent,
            tool_call_id: toolCallId,
            name: tool.name,
            ...(additionalKwargs !== undefined ? { additional_kwargs: additionalKwargs } : {}),
          })
        const convertedResult = stateUpdates
          ? new Command({ update: { ...stateUpdates, messages: [toolMessage()] } })
          : step !== undefined
            ? toolMessage()
            : finalContent
```

5. After the `for (const transformer of streamTransformers)` loop, before `return convertedResult`, add:

```ts
        if (display !== undefined && step !== undefined) {
          await dispatchStep(liveConfig, { tool_call_id: toolCallId, status: "completed", ...step })
        }
```

(`describeDone` is called before the transformers so its `sources` are available to them later if needed; the dispatch happens after, so a transformer's capability events precede the completed step — the same order the model sees.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @b4run/langchain exec vitest run test/tool-converter.test.ts test/tool-converter-runtime.test.ts test/return-direct-graph.test.ts test/offload-integration.test.ts`
Expected: PASS. The `streamTransformers` input `toolOutput` is unchanged for tools without `display`; the planning transformer sees a `Command` as before.

- [ ] **Step 5: Add a runtime test that the ToolMessage survives invoke**

Append to `packages/langchain/test/tool-converter-runtime.test.ts`:

```ts
  it("a displayed tool invoked with a ToolCall returns a ToolMessage carrying b4_step", async () => {
    const converted = convertToolToLangChain({
      name: "readDoc",
      display: { icon: "read", done: (input: { path: string }) => `Read ${input.path}` },
      run: async () => "# Title",
    })
    const message = (await converted.invoke(
      { name: "readDoc", args: { path: "corpus/a.md" }, id: "call_read_9", type: "tool_call" },
      { configurable: { thread_id: "thread-1" } },
    )) as { content: string; tool_call_id: string; additional_kwargs: Record<string, unknown> }
    expect(message.tool_call_id).toBe("call_read_9")
    expect(message.content).toBe('"# Title"')
    expect(message.additional_kwargs.b4_step).toEqual({ icon: "read", label: "Read corpus/a.md" })
  })
```

Run: `pnpm --filter @b4run/langchain exec vitest run test/tool-converter-runtime.test.ts`
Expected: PASS (a `DynamicStructuredTool` returns a `ToolMessage` the func returned when invoked with a ToolCall).

- [ ] **Step 6: Commit**

```bash
git add packages/langchain/src/tool-converter.ts packages/langchain/test/tool-converter.test.ts packages/langchain/test/tool-converter-runtime.test.ts
git commit -m "feat(langchain): stream b4.step per displayed tool call and persist it on the ToolMessage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: The adapter forwards `b4.step` as a `step` chunk

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts:941-953` (`on_custom_event` case)
- Test: `packages/langchain/test/agent-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new `describe` at the end of `packages/langchain/test/agent-adapter.test.ts`, reusing the file's existing way of building a fake entry and collecting chunks (look at the first `describe` for the helper that runs `streamAgent` over a fake `streamEvents` — use the same helper; it is the one that yields the `on_custom_event` events quoted at lines 20-70). The events to feed and the assertions:

```ts
describe("b4.step custom events", () => {
  it("becomes a root `step` chunk with its tool_call_id intact", async () => {
    const chunks = await collectChunksFromEvents([
      {
        event: "on_custom_event",
        run_id: "custom-step-1",
        name: "b4.step",
        data: { tool_call_id: "call_1", status: "running", icon: "search", label: "Searching" },
      },
    ])
    expect(chunks).toContainEqual({
      type: "step",
      data: { tool_call_id: "call_1", status: "running", icon: "search", label: "Searching" },
    })
  })

  it("becomes a `subagent.step` chunk carrying the child's identity AND its tool_call_id", async () => {
    const chunks = await collectChunksFromEvents([
      {
        event: "on_custom_event",
        run_id: "custom-step-2",
        name: "b4.step",
        data: { tool_call_id: "child_call_1", status: "completed", label: "Read a.md" },
        metadata: childMetadata({ callId: "task-1", name: "researcher", routeId: "/r#researcher", depth: 1 }),
      },
    ])
    expect(chunks).toContainEqual({
      type: "subagent.step",
      data: {
        tool_call_id: "child_call_1",
        status: "completed",
        label: "Read a.md",
        call_id: "task-1",
        subagent: "researcher",
        route_id: "/r#researcher",
        depth: 1,
      },
    })
  })

  it("drops a b4.step without a tool_call_id", async () => {
    const chunks = await collectChunksFromEvents([
      { event: "on_custom_event", run_id: "custom-step-3", name: "b4.step", data: { status: "running" } },
    ])
    expect(chunks.some((chunk) => chunk.type === "step")).toBe(false)
  })
})
```

If the file has no `collectChunksFromEvents`/`childMetadata` helpers under those names, add them beside the existing helper: `collectChunksFromEvents(events)` builds the same fake entry the first describe builds (its `streamEvents` yields the given events then the `on_chain_end` root event) and returns every chunk `streamAgent` yields; `childMetadata({ callId, name, routeId, depth })` returns the `metadata` object the adapter's `resolveEventSubagentContext` reads — copy the shape from the existing subagent tests in this file (search for `subagent_stack`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/langchain exec vitest run test/agent-adapter.test.ts -t "b4.step"`
Expected: FAIL — no `step` chunks.

- [ ] **Step 3: Implement**

In `packages/langchain/src/agent-adapter.ts`, the `case "on_custom_event":` (line ~941) becomes:

```ts
    case "on_custom_event": {
      if (event.name === "b4.step") {
        // A step names the call it describes. Unlike `childData`, a child's
        // step KEEPS its tool_call_id: since #914 a child's tool frames are
        // public (tagged `subagentRunId`), so the id is the one the client
        // already has for that call.
        if (!isRecord(event.data) || typeof event.data.tool_call_id !== "string") break
        return {
          capturesFinalOutput: false,
          child,
          chunks: [
            child
              ? { type: "subagent.step", data: { ...event.data, ...childIdentity(child) } }
              : { type: "step", data: event.data },
          ],
          finalOutput: undefined,
          interrupts: [],
        }
      }
      if (event.name !== "b4.capability") break
      const payload = parseCapabilityEvent(event.data)
      if (!payload) break
      return {
        capturesFinalOutput: false,
        child,
        chunks: [
          child
            ? { type: `subagent.${payload.event}`, data: childData(child, payload.data) }
            : { type: payload.event, data: payload.data },
        ],
        finalOutput: undefined,
        interrupts: [],
      }
    }
```

- [ ] **Step 4: Run the adapter tests**

Run: `pnpm --filter @b4run/langchain exec vitest run test/agent-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/langchain/src/agent-adapter.ts packages/langchain/test/agent-adapter.test.ts
git commit -m "feat(langchain): forward b4.step as step / subagent.step chunks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: The translator emits `CUSTOM b4.step`, and `failed` on an error result

**Files:**
- Create: `packages/ag-ui/src/step.ts`
- Modify: `packages/ag-ui/src/types.ts` (add `asStepData`), `packages/ag-ui/src/outbound.ts` (union, `step` case, failed emission)
- Test: `packages/ag-ui/test/outbound.test.ts`, `packages/ag-ui/test/conformance.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/ag-ui/test/outbound.test.ts`'s `describe("toAguiEvents", …)`:

```ts
  test("a step chunk becomes CUSTOM b4.step keyed by the call, root and child alike", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_s_1", name: "searchCorpus", input: { query: "a" } } },
      {
        type: "step",
        data: { tool_call_id: "call_s_1", status: "running", icon: "search", label: "Searching for “a”" },
      },
      {
        type: "tool_result",
        data: { id: "call_s_1", name: "searchCorpus", output: [{ path: "corpus/a.md" }] },
      },
      {
        type: "step",
        data: {
          tool_call_id: "call_s_1",
          status: "completed",
          icon: "search",
          label: "Searched for “a”",
          sources: [{ title: "corpus/a.md" }],
        },
      },
      { type: "tool_call", data: { id: CHILD.call_id, name: "task", input: {} } },
      { type: "subagent.start", data: CHILD },
      { type: "subagent.tool_call", data: { ...CHILD, id: "child_1", name: "readDoc", input: {} } },
      {
        type: "subagent.step",
        data: { ...CHILD, tool_call_id: "child_1", status: "running", label: "Reading a.md" },
      },
      { type: "subagent.end", data: { ...CHILD, final_message: "done" } },
      { type: "done", data: {} },
    ])
    const custom = events.filter((event) => event.type === EventType.CUSTOM)
    expect(custom).toEqual([
      {
        type: EventType.CUSTOM,
        name: "b4.step",
        value: { toolCallId: "call_s_1", status: "running", icon: "search", label: "Searching for “a”" },
      },
      {
        type: EventType.CUSTOM,
        name: "b4.step",
        value: {
          toolCallId: "call_s_1",
          status: "completed",
          icon: "search",
          label: "Searched for “a”",
          sources: [{ title: "corpus/a.md" }],
        },
      },
      {
        type: EventType.CUSTOM,
        name: "b4.step",
        subagentRunId: CHILD.call_id,
        value: { toolCallId: "child_1", status: "running", label: "Reading a.md" },
      },
    ])
    // The running step precedes the result; the completed step follows it.
    const kinds = events.map((event) => event.type)
    expect(kinds.indexOf(EventType.CUSTOM)).toBeLessThan(kinds.indexOf(EventType.TOOL_CALL_RESULT))
  })

  test("an error ToolMessage result is followed by a failed step for the same call", async () => {
    const events = await collect([
      { type: "tool_call", data: { id: "call_e_1", name: "readDoc", input: {} } },
      {
        type: "tool_result",
        data: {
          id: "call_e_1",
          name: "readDoc",
          output: { status: "error", content: "ENOENT: corpus/x.md", name: "readDoc", tool_call_id: "call_e_1" },
        },
      },
      { type: "done", data: {} },
    ])
    const resultIndex = events.findIndex((event) => event.type === EventType.TOOL_CALL_RESULT)
    expect(events[resultIndex]).toMatchObject({ content: "ENOENT: corpus/x.md" })
    expect(events[resultIndex + 1]).toEqual({
      type: EventType.CUSTOM,
      name: "b4.step",
      value: { toolCallId: "call_e_1", status: "failed" },
    })
  })

  test("a malformed step chunk is ignored", async () => {
    const events = await collect([
      { type: "step", data: { status: "running" } },
      { type: "step", data: { tool_call_id: "c", status: "exploded" } },
      { type: "done", data: {} },
    ])
    expect(events.some((event) => event.type === EventType.CUSTOM)).toBe(false)
  })
```

In `packages/ag-ui/test/conformance.test.ts`:
- Insert into `CANNED`, right after the `searchCorpus` `tool_call` entry and before its `tool_result`:

```ts
  {
    type: "step",
    data: { tool_call_id: ORDINARY_TOOL_CALL_ID, status: "running", icon: "search", label: "Searching the corpus for “agents”" },
  },
```

  and right after that `tool_result`:

```ts
  {
    type: "step",
    data: {
      tool_call_id: ORDINARY_TOOL_CALL_ID,
      status: "completed",
      icon: "search",
      label: "Searched the corpus for “agents”",
      sources: [{ title: "corpus/a.md" }],
    },
  },
```

- Replace `expect(kinds).not.toContain(EventType.CUSTOM)` (line ~420) with:

```ts
  // The only CUSTOM event B4.run emits is `b4.step`, and the 1.0 client passes it through intact.
  const custom = events.filter((event) => event.type === EventType.CUSTOM)
  expect(custom.length).toBeGreaterThan(0)
  for (const event of custom) {
    expect(event).toMatchObject({ name: "b4.step", value: { toolCallId: expect.any(String) } })
  }
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/outbound.test.ts test/conformance.test.ts`
Expected: FAIL — no CUSTOM events.

- [ ] **Step 3: Implement**

`packages/ag-ui/src/step.ts` (new):

```ts
import type { ToolDisplayIcon, ToolDisplaySource } from "@b4run/sdk"

/** The AG-UI `CUSTOM` event name a tool call's human-readable step travels as. */
export const B4_STEP_EVENT_NAME = "b4.step"

export type B4StepStatus = "running" | "completed" | "failed"

/** `CustomEvent.value` for `b4.step`. */
export interface B4StepEventValue {
  readonly toolCallId: string
  readonly status: B4StepStatus
  readonly icon?: ToolDisplayIcon
  readonly label?: string
  readonly sources?: readonly ToolDisplaySource[]
}
```

Add `"@b4run/sdk": "workspace:*"` to `packages/ag-ui/package.json` `dependencies` if it is not already there (check: `grep '"@b4run/sdk"' packages/ag-ui/package.json`). `@b4run/sdk`'s main entry is edge-safe, so the root/`./sse` purity guards stay green. Run `pnpm install` after editing.

`packages/ag-ui/src/types.ts` — add after `asToolResultData`:

```ts
/** The `step` chunk the langchain adapter forwards from a `b4.step` custom event. */
export interface B4StepData {
  readonly tool_call_id: string
  readonly status: "running" | "completed" | "failed"
  readonly icon?: string | undefined
  readonly label?: string | undefined
  readonly sources?: ReadonlyArray<{ readonly title: string; readonly href?: string }> | undefined
}

const STEP_STATUSES: ReadonlySet<string> = new Set(["running", "completed", "failed"])

/** Validates and narrows a `step` chunk's `data`. Returns null if malformed. */
export function asStepData(data: unknown): B4StepData | null {
  if (!isRecord(data)) return null
  if (typeof data.tool_call_id !== "string" || data.tool_call_id === "") return null
  if (typeof data.status !== "string" || !STEP_STATUSES.has(data.status)) return null
  const sources = Array.isArray(data.sources)
    ? data.sources.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.title !== "string") return []
        return [{ title: entry.title, ...(typeof entry.href === "string" ? { href: entry.href } : {}) }]
      })
    : undefined
  return {
    tool_call_id: data.tool_call_id,
    status: data.status as B4StepData["status"],
    ...(typeof data.icon === "string" ? { icon: data.icon } : {}),
    ...(typeof data.label === "string" ? { label: data.label } : {}),
    ...(sources !== undefined ? { sources } : {}),
  }
}
```

`packages/ag-ui/src/outbound.ts`:

1. Add `CustomEvent` to the `@ag-ui/core` type import and to the `AguiOutboundEvent` union; import `asStepData` from `./types.js` and `B4_STEP_EVENT_NAME` from `./step.js`.

2. Add a helper beside `tag`:

```ts
function stepEvent(owner: Owner, value: B4StepEventValue): CustomEvent {
  return tag(owner, { type: EventType.CUSTOM, name: B4_STEP_EVENT_NAME, value })
}
```

(import `type B4StepEventValue` from `./step.js`).

3. In the `tool_result` case, replace the `content:` line and the emission with:

```ts
        const view = toolResultView(tr.output)
        const resultEvent: ToolCallResultEvent = tag(owner, {
          type: EventType.TOOL_CALL_RESULT,
          messageId: nextId("toolResult"),
          toolCallId,
          content: view.content,
        })
        if (owner === undefined) {
          yield* ledger.onToolResult(tr.id, tr.name, resultEvent)
        } else {
          yield* ledger.onPassthrough(resultEvent)
        }
        // A tool that threw: say so on the step, since the result's text alone
        // cannot tell an error from an answer.
        if (view.failed) {
          yield* ledger.onPassthrough(stepEvent(owner, { toolCallId, status: "failed" }))
        }
        break
```

4. Add a `step` case before `default:`:

```ts
      case "step": {
        const step = asStepData(chunk.data)
        if (!step) break
        yield* ledger.onPassthrough(
          stepEvent(owner, {
            toolCallId: step.tool_call_id,
            status: step.status,
            ...(step.icon !== undefined ? { icon: step.icon as B4StepEventValue["icon"] } : {}),
            ...(step.label !== undefined ? { label: step.label } : {}),
            ...(step.sources !== undefined ? { sources: step.sources } : {}),
          }),
        )
        break
      }
```

(A `step` does not flush open text: it describes a call the text already yielded to.)

- [ ] **Step 4: Run ag-ui tests and typecheck**

Run: `pnpm --filter @b4run/ag-ui test && pnpm --filter @b4run/ag-ui typecheck`
Expected: PASS, conformance included (the 1.0 verifier passes `CUSTOM` through; a child's CUSTOM must follow its `SUBAGENT_STARTED`, which `unwrapSubagentChunk` guarantees via the announce check).

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/step.ts packages/ag-ui/src/types.ts packages/ag-ui/src/outbound.ts packages/ag-ui/package.json pnpm-lock.yaml packages/ag-ui/test/outbound.test.ts packages/ag-ui/test/conformance.test.ts
git commit -m "feat(ag-ui): CUSTOM b4.step per tool call; failed on an error result

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: Built-in tools ship labels; the `task` bridge streams its step

**Files:**
- Modify: `packages/core/src/capabilities/built-in/workspace.ts` (five tools), `memory.ts` (recall, remember), `skills.ts` (readSkill), `planning.ts` (writeTodos), `subagents.ts` (task), `packages/langchain/src/subagent-tool-bridge.ts`
- Test: `packages/core/test/capabilities/built-in-display.test.ts` (new), `packages/langchain/test/subagent-tool-bridge.test.ts`

- [ ] **Step 1: Write the failing core test**

`packages/core/test/capabilities/built-in-display.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { MEMORY_DISPLAY } from "../../src/capabilities/built-in/memory.js"
import { WRITE_TODOS_DISPLAY } from "../../src/capabilities/built-in/planning.js"
import { READ_SKILL_DISPLAY } from "../../src/capabilities/built-in/skills.js"
import { TASK_DISPLAY } from "../../src/capabilities/built-in/subagents.js"
import { WORKSPACE_DISPLAY } from "../../src/capabilities/built-in/workspace.js"

describe("built-in tool display", () => {
  it("workspace tools read as sentences", () => {
    expect(WORKSPACE_DISPLAY.readFile.running?.({ path: "corpus/a.md" })).toBe("Reading corpus/a.md")
    expect(WORKSPACE_DISPLAY.readFile.done?.({ path: "corpus/a.md" }, "")).toBe("Read corpus/a.md")
    expect(WORKSPACE_DISPLAY.writeFile.done?.({ path: "r.md", content: "" }, "")).toBe("Saved r.md")
    expect(WORKSPACE_DISPLAY.editFile.done?.({ path: "r.md", oldText: "", newText: "" }, "")).toBe("Edited r.md")
    expect(WORKSPACE_DISPLAY.listDir.done?.({ path: "corpus" }, [])).toBe("Listed corpus")
    expect(WORKSPACE_DISPLAY.runBash.running?.({ command: "ls -la" })).toBe("Running ls -la")
    expect(WORKSPACE_DISPLAY.runBash.done?.({ command: "ls -la" }, "")).toBe("Ran ls -la")
    expect(WORKSPACE_DISPLAY.readFile.icon).toBe("read")
    expect(WORKSPACE_DISPLAY.runBash.icon).toBe("run")
  })

  it("memory, skills, plan and task read as sentences", () => {
    expect(MEMORY_DISPLAY.recall.running?.({ query: "agents" })).toBe("Recalling “agents”")
    expect(MEMORY_DISPLAY.recall.done?.({}, "")).toBe("Checked memory")
    expect(MEMORY_DISPLAY.remember.done?.({}, "")).toBe("Remembered this")
    expect(READ_SKILL_DISPLAY.done?.({ name: "cite" }, "")).toBe("Loaded the cite skill")
    expect(WRITE_TODOS_DISPLAY.done?.({}, "")).toBe("Updated the plan")
    expect(TASK_DISPLAY.running?.({ subagent: "researcher", input: "summarize ReAct" })).toBe(
      "Asking researcher to summarize ReAct",
    )
    expect(TASK_DISPLAY.done?.({ subagent: "researcher", input: "x" }, "")).toBe("researcher finished")
    expect(TASK_DISPLAY.icon).toBe("agent")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/core exec vitest run test/capabilities/built-in-display.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement the display constants and attach them**

`packages/core/src/capabilities/built-in/workspace.ts` — add near the top (after imports; import `type ToolDisplay` from `@b4run/sdk`):

```ts
/** How each workspace tool's call reads to a person. */
export const WORKSPACE_DISPLAY = {
  readFile: {
    icon: "read",
    running: (input: { path: string }) => `Reading ${input.path}`,
    done: (input: { path: string }) => `Read ${input.path}`,
  },
  writeFile: {
    icon: "write",
    running: (input: { path: string }) => `Saving ${input.path}`,
    done: (input: { path: string }) => `Saved ${input.path}`,
  },
  editFile: {
    icon: "write",
    running: (input: { path: string }) => `Editing ${input.path}`,
    done: (input: { path: string }) => `Edited ${input.path}`,
  },
  listDir: {
    icon: "read",
    running: (input: { path: string }) => `Listing ${input.path}`,
    done: (input: { path: string }) => `Listed ${input.path}`,
  },
  runBash: {
    icon: "run",
    running: (input: { command: string }) => `Running ${input.command}`,
    done: (input: { command: string }) => `Ran ${input.command}`,
  },
} satisfies Record<string, ToolDisplay>
```

and add `display: WORKSPACE_DISPLAY.readFile,` (etc.) to each of the five tool literals, after `overridable: true,`.

`memory.ts` — add (exported) near the top:

```ts
export const MEMORY_DISPLAY = {
  recall: {
    icon: "memory",
    running: (input: { query?: string }) =>
      input.query ? `Recalling “${input.query}”` : "Checking memory",
    done: () => "Checked memory",
  },
  remember: {
    icon: "memory",
    running: () => "Remembering this",
    done: () => "Remembered this",
  },
} satisfies Record<string, ToolDisplay>
```

and `display: MEMORY_DISPLAY.recall,` / `display: MEMORY_DISPLAY.remember,` in the two tool literals.

`skills.ts`:

```ts
export const READ_SKILL_DISPLAY = {
  icon: "think",
  running: (input: { name: string }) => `Loading the ${input.name} skill`,
  done: (input: { name: string }) => `Loaded the ${input.name} skill`,
} satisfies ToolDisplay
```

with `display: READ_SKILL_DISPLAY,` on `readSkill`.

`planning.ts`:

```ts
export const WRITE_TODOS_DISPLAY = {
  icon: "plan",
  running: () => "Updating the plan",
  done: () => "Updated the plan",
} satisfies ToolDisplay
```

with `display: WRITE_TODOS_DISPLAY,` on `writeTodos`.

`subagents.ts`:

```ts
export const TASK_DISPLAY = {
  icon: "agent",
  running: (input: { subagent: string; input: string }) => `Asking ${input.subagent} to ${input.input}`,
  done: (input: { subagent: string }) => `${input.subagent} finished`,
} satisfies ToolDisplay
```

with `display: TASK_DISPLAY,` on `task`. (Label truncation at 120 characters happens in the evaluator, so a long task description is safe.)

`packages/langchain/src/subagent-tool-bridge.ts` — the bridge replaces the converter for `task`, so it dispatches its own steps. Import `describeDone, describeRunning, dispatchStep` from `./tool-display.js`. Inside `func`, right after `const input = rawInput as …`, add:

```ts
      const display = providerCallId !== undefined ? tool.display : undefined
      if (display !== undefined) {
        await dispatchStep(liveConfig, {
          tool_call_id: providerCallId,
          status: "running",
          ...describeRunning(display, input, tool.name),
        })
      }
```

and wrap the `recordToolCall(…)` call's result: change `return recordToolCall(` to `const result = await recordToolCall(` and after the call add:

```ts
      if (display !== undefined && providerCallId !== undefined) {
        await dispatchStep(liveConfig, {
          tool_call_id: providerCallId,
          status: "completed",
          ...describeDone(display, input, result, tool.name),
        })
      }
      return result
```

(`result` is the child's final string, or a denial/limit message; both are fine for `done`.)

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4run/core test && pnpm --filter @b4run/langchain exec vitest run test/subagent-tool-bridge.test.ts && pnpm -r --filter @b4run/core --filter @b4run/langchain typecheck`
Expected: PASS. (`workspace.test.ts:90` asserts only names; `skills.test.ts:60` likewise.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capabilities/built-in packages/langchain/src/subagent-tool-bridge.ts packages/core/test/capabilities/built-in-display.test.ts
git commit -m "feat(core): built-in tools describe their calls in plain language

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 13: Docs for `display` and `b4.step`

**Files:**
- Modify: `apps/web/content/docs/tools.mdx` (new section after "## Tool descriptions"), `apps/web/content/docs/ag-ui.mdx` (chunk table + new "## Step events" section before "## Adapter API"), `apps/web/content/docs/api/ag-ui.mdx:250-254`

- [ ] **Step 1: tools.mdx**

Insert after the "## Tool descriptions" section (before "## Ending the run from a tool"):

```mdx
## Describing a call to people

The model reads `description`; a person reads the step a call becomes in the chat. Export `display` to say how a call reads while it runs and once it returns:

```ts title="src/tools/searchCorpus.ts"
import type { ToolDisplay } from "@b4run/sdk"

export const display = {
  icon: "search",
  running: ({ query }) => `Searching the corpus for “${query}”`,
  done: ({ query }, hits) => `Searched the corpus for “${query}”`,
  sources: (hits) => hits.map((hit) => ({ title: hit.path })),
} satisfies ToolDisplay<{ query: string }, { path: string }[]>

export default async (input: { readonly query: string }) => { /* … */ }
```

Every field is optional. `icon` is one of `search`, `read`, `write`, `run`, `web`, `memory`, `plan`, `agent`, `think` or `tool`. The runtime evaluates `running` as the call starts and `done` and `sources` as it returns, truncates labels at 120 characters, and streams the result to AG-UI clients as a `b4.step` event (see [AG-UI](/docs/ag-ui#step-events)). A label that throws falls back to the default and is logged once. Without `display`, clients show "Using searchCorpus…" and then "Used searchCorpus". The built-in workspace, memory, skill, plan and subagent tools ship their own labels.

`b4 check` rejects a `display` with an unknown icon, a non-function label or an unknown key (`B4_E5002`).
```

- [ ] **Step 2: ag-ui.mdx**

Add to the chunk table (after the `tool_result` rows):

```
| `step` (from a tool's `display`) | `CUSTOM { name: "b4.step", value: { toolCallId, status: "running" | "completed", icon?, label?, sources? } }`, before the call's result for `running` and after it for `completed`; a child's step is tagged `subagentRunId` |
```

and restore the parenthetical on the failing-tool row from Task 4: `… (a `b4.step` event with `status: "failed"` follows it; see [Step events](#step-events))`.

Add a section before "## Adapter API":

```mdx
## Step events

A tool that exports [`display`](/docs/tools#describing-a-call-to-people) tells the chat what each call means. The runtime emits one `CUSTOM` event named `b4.step` as the call starts (`status: "running"`, with `icon` and the running `label`) and one as it returns (`status: "completed"`, with the done `label` and any `sources`). A tool that threw gets a `status: "failed"` step after its `TOOL_CALL_RESULT`, whether or not it has a `display`. Every step names its call in `value.toolCallId`; a subagent's step carries `subagentRunId`.

The labels also ride on the checkpointed tool message as `additional_kwargs.b4_step`, so `GET /threads/:id/state` replays them. A client that does not know `b4.step` ignores it.
```

- [ ] **Step 3: api/ag-ui.mdx**

In "### Stream edge cases" append a sentence: `A \`step\` chunk becomes a \`CUSTOM\` event named \`b4.step\`; a malformed one is ignored.`

- [ ] **Step 4: Run the doc gates, regenerate lastmod, commit**

Run: `pnpm build && node scripts/check-docs.mjs && pnpm --filter @b4run/web test -- --run app/components/docs`
Expected: PASS.

```bash
git add apps/web/content/docs
git commit -m "docs: tool display and b4.step events

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod && git add apps/web/app/seo/lastmod.generated.json && git commit -m "chore(web): regenerate seo lastmod

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 14: Amend the spec; changeset; open PR B

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-b4-activity-components-design.md` §4, §4.1
- Create: `.changeset/tool-display-step-events.md`

- [ ] **Step 1: Spec amendments**

In §4, remove the `group: (n: number) => …` line from the example and the "`group` is not sent per call" bullet in §4.1. Replace the §4.1 event block with:

```
{ type: "CUSTOM", name: "b4.step", value: {
  toolCallId, status: "running" | "completed" | "failed", icon?, label?, sources?
} }
```

and these bullets:

- `running` goes out as the call starts (before `TOOL_CALL_RESULT`), `completed` after the result with the `done` label and `sources`; `failed` follows an error result even for tools without `display`.
- The labels are stored on the checkpointed `ToolMessage` as `additional_kwargs.b4_step`, so `GET /threads/:id/state` carries them for a restored thread.
- Grouped-step labels ("Searched the corpus 2 times") are a client concern: the view core's label table for built-in tools, plus the connector's `labels` overrides.

- [ ] **Step 2: Changeset**

`.changeset/tool-display-step-events.md`:

```md
---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/langchain": patch
"@b4run/ag-ui": patch
---

Tools can export `display` (`ToolDisplay`): an icon and `running`/`done`/`sources` functions that say how a call reads to a person. The runtime evaluates it per call, streams it to AG-UI clients as `CUSTOM` `b4.step` events (`running` before the result, `completed` after; `failed` after an error result for every tool), and keeps it on the checkpointed tool message (`additional_kwargs.b4_step`). `b4 check` validates the export. The built-in workspace, memory, skill, plan and subagent tools ship labels.
```

- [ ] **Step 3: Full validation and PR**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

```bash
git add docs/superpowers/specs/2026-10-03-b4-activity-components-design.md .changeset/tool-display-step-events.md
git commit -m "docs(spec): b4.step status shape, ToolMessage persistence, client-side grouping

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin blove/tool-display-step-events
gh pr create --base main --title "feat: tools describe their calls — display export and b4.step events" --body "$(cat <<'EOF'
Sub-project 1, PR B of `docs/superpowers/specs/2026-10-03-b4-activity-components-design.md`.

- `@b4run/sdk`: `ToolDisplay` (icon + `running`/`done`/`sources`), `describeToolDisplayProblem`.
- Tools export `display`; `b4 check` validates it (`B4_E5002`); capability tools carry it.
- `@b4run/langchain`: evaluates labels per call (never throws; truncates at 120; warns once), dispatches `b4.step` running/completed, persists `additional_kwargs.b4_step` on the ToolMessage; the `task` bridge does the same.
- `@b4run/ag-ui`: `step` chunks → `CUSTOM b4.step`; an error result is followed by `status: "failed"`.
- Built-in tools ship labels. Docs on `/docs/tools` and `/docs/ag-ui`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then `mcp__ccd_pr__get_status` and `mcp__ccd_pr__set_auto_merge` (`enabled: true`, `squash`).

---

# PR C — `@b4run/ag-ui/view`

Branch: `blove/ag-ui-view-entry` off `origin/main` **after PR B merges**.

### Task 15: Move the subagent reducer under `src/view/`

**Files:**
- Create: `packages/ag-ui/src/view/subagent-runs.ts`, `packages/ag-ui/src/view/index.ts`
- Modify: `packages/ag-ui/src/react/useSubagentRuns.ts`, `packages/ag-ui/src/react/index.ts`, `packages/ag-ui/package.json`
- Test: `packages/ag-ui/test/view/public-api.test.ts` (new); existing `test/react/useSubagentRuns.test.tsx` keeps passing

- [ ] **Step 1: Write the failing public-api test**

`packages/ag-ui/test/view/public-api.test.ts`:

```ts
import { expect, it } from "vitest"
import * as view from "../../src/view/index.ts"

it("exports the framework-free view surface", () => {
  expect(Object.keys(view).sort()).toEqual([
    "B4_STEP_EVENT_NAME",
    "BUILT_IN_GROUP_LABELS",
    "EMPTY_SUBAGENT_RUNS",
    "EMPTY_TURNS",
    "groupSteps",
    "isSubagentMessage",
    "readStepEvent",
    "reduceSubagentRuns",
    "reduceTurns",
    "stepLabel",
  ])
})

it("imports nothing from React", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    Promise.all(
      ["index.ts", "subagent-runs.ts", "turns.ts", "labels.ts"].map((file) =>
        fs.readFile(new URL(`../../src/view/${file}`, import.meta.url), "utf8"),
      ),
    ),
  )
  for (const text of source) expect(text).not.toMatch(/from "react"|@copilotkit/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/view/public-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Move the reducer**

Create `packages/ag-ui/src/view/subagent-runs.ts` by moving everything from `packages/ag-ui/src/react/useSubagentRuns.ts` EXCEPT the `useSubagentRuns` hook, the `SubagentEventSource` type, and the React import: that is `SubagentToolCall`, `SubagentRun`, `SubagentRunsState`, `EMPTY_SUBAGENT_RUNS`, the private helpers (`isRecord`, `withRun`, `withToolCall`, `readPlan`, `Attributed`), `reduceSubagentRuns`, and `isSubagentMessage`. Fix the activities import to `../activities.js`. Remove `AbstractAgent` from the `@ag-ui/client` import if it becomes unused there (keep `Message` from `@ag-ui/core`).

Reduce `packages/ag-ui/src/react/useSubagentRuns.ts` to:

```ts
import type { AbstractAgent } from "@ag-ui/client"
import { useEffect, useState } from "react"
import {
  EMPTY_SUBAGENT_RUNS,
  reduceSubagentRuns,
  type SubagentRunsState,
} from "../view/subagent-runs.js"

export {
  EMPTY_SUBAGENT_RUNS,
  isSubagentMessage,
  reduceSubagentRuns,
  type SubagentRun,
  type SubagentRunsState,
  type SubagentToolCall,
} from "../view/subagent-runs.js"

/** The subset of `AbstractAgent` the hook needs: the subscription seam. */
export type SubagentEventSource = Pick<AbstractAgent, "subscribe">

/**
 * The subagent tree of the agent's current thread, kept current from its event
 * stream. Pass the `agent` CopilotKit's `useAgent()` returns (or any
 * `@ag-ui/client` agent); `undefined` while there is none.
 */
export function useSubagentRuns(agent: SubagentEventSource | undefined): SubagentRunsState {
  const [state, setState] = useState<SubagentRunsState>(EMPTY_SUBAGENT_RUNS)
  useEffect(() => {
    if (agent === undefined) return
    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        setState((previous) => reduceSubagentRuns(previous, event))
      },
    })
    return () => subscription.unsubscribe()
  }, [agent])
  return state
}
```

(`react/index.ts` keeps exporting the same names from `./useSubagentRuns.js`, so nothing downstream changes.)

Create `packages/ag-ui/src/view/index.ts` (the `turns.js`/`labels.js` lines are added in Tasks 16–17; the test above fails until then — that is expected):

```ts
/**
 * `@b4run/ag-ui/view`: the framework-free half of the client. Pure reducers
 * and selectors over AG-UI events — what a chat shows for a turn — with no
 * React, no CopilotKit. `./react` builds on it; so can an Angular client.
 */
export { B4_STEP_EVENT_NAME, readStepEvent } from "./step.js"
export type { B4StepEventValue, B4StepStatus } from "../step.js"
export {
  EMPTY_SUBAGENT_RUNS,
  isSubagentMessage,
  reduceSubagentRuns,
  type SubagentRun,
  type SubagentRunsState,
  type SubagentToolCall,
} from "./subagent-runs.js"
```

Create `packages/ag-ui/src/view/step.ts`:

```ts
import type { BaseEvent, CustomEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { B4_STEP_EVENT_NAME, type B4StepEventValue } from "../step.js"

export { B4_STEP_EVENT_NAME }

const STATUSES: ReadonlySet<string> = new Set(["running", "completed", "failed"])

/** The `b4.step` value an event carries, or undefined for any other event or a malformed value. */
export function readStepEvent(event: BaseEvent): B4StepEventValue | undefined {
  if (event.type !== EventType.CUSTOM) return undefined
  const custom = event as CustomEvent
  if (custom.name !== B4_STEP_EVENT_NAME) return undefined
  const value = custom.value as Record<string, unknown> | null | undefined
  if (typeof value !== "object" || value === null) return undefined
  if (typeof value.toolCallId !== "string" || value.toolCallId === "") return undefined
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) return undefined
  return value as unknown as B4StepEventValue
}
```

Add the subpath to `packages/ag-ui/package.json` `exports`, before `"./react"`:

```json
    "./view": {
      "types": "./dist/view/index.d.ts",
      "default": "./dist/view/index.js"
    },
```

- [ ] **Step 4: Run the existing react tests and typecheck**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react && pnpm --filter @b4run/ag-ui typecheck`
Expected: PASS (the view public-api test still fails until Task 17).

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/view packages/ag-ui/src/react/useSubagentRuns.ts packages/ag-ui/package.json packages/ag-ui/test/view/public-api.test.ts
git commit -m "refactor(ag-ui): move the subagent reducer to a framework-free view entry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 16: `reduceTurns`

**Files:**
- Create: `packages/ag-ui/src/view/turns.ts`
- Test: `packages/ag-ui/test/view/turns.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/ag-ui/test/view/turns.test.ts`:

```ts
import { type BaseEvent, EventType } from "@ag-ui/core"
import { describe, expect, it } from "vitest"
import { createCounterIdFactory } from "../../src/ids.ts"
import { toAguiEvents } from "../../src/outbound.ts"
import type { B4AgentStreamChunk } from "../../src/types.ts"
import {
  EMPTY_TURNS,
  reduceTurns,
  type SubagentStep,
  type ToolStep,
  type TurnsView,
} from "../../src/view/turns.ts"

const CTX = { threadId: "th-1", runId: "rn-1" }
const CHILD = { call_id: "call-task", subagent: "researcher", route_id: "/r#researcher", depth: 1 } as const

async function* toAsync(items: readonly B4AgentStreamChunk[]) {
  yield* items
}

/** Run B4 chunks through the real translator, then fold the events. */
async function fold(chunks: readonly B4AgentStreamChunk[], clock = fixedClock()): Promise<TurnsView> {
  let view = EMPTY_TURNS
  for await (const event of toAguiEvents(toAsync(chunks), CTX, { idFactory: createCounterIdFactory() })) {
    view = reduceTurns(view, event as BaseEvent, { now: clock })
  }
  return view
}

/** A clock that advances 1000ms per read, so timing is deterministic. */
function fixedClock() {
  let t = 0
  return () => (t += 1000)
}

const RUN: B4AgentStreamChunk[] = [
  { type: "reasoning", data: "search first" },
  { type: "tool_call", data: { id: "c1", name: "recall", input: { query: "agents" } } },
  { type: "step", data: { tool_call_id: "c1", status: "running", icon: "memory", label: "Recalling “agents”" } },
  { type: "tool_result", data: { id: "c1", name: "recall", output: "(no memories found)" } },
  { type: "step", data: { tool_call_id: "c1", status: "completed", icon: "memory", label: "Checked memory" } },
  { type: "tool_call", data: { id: "c2", name: "writeTodos", input: { todos: [] } } },
  { type: "plan_update", data: { tool_call_id: "c2", todos: [{ content: "search", status: "in_progress" }] } },
  { type: "tool_result", data: { id: "c2", name: "writeTodos", output: "ok" } },
  { type: "tool_call", data: { id: "c3", name: "searchCorpus", input: { query: "a" } } },
  { type: "tool_result", data: { id: "c3", name: "searchCorpus", output: [{ path: "a.md" }] } },
  { type: "tool_call", data: { id: "c4", name: "searchCorpus", input: { query: "b" } } },
  { type: "tool_result", data: { id: "c4", name: "searchCorpus", output: [] } },
  { type: "tool_call", data: { id: CHILD.call_id, name: "task", input: { subagent: "researcher", input: "x" } } },
  { type: "subagent.start", data: { ...CHILD, description: "summarize ReAct" } },
  { type: "subagent.tool_call", data: { ...CHILD, id: "k1", name: "readDoc", input: { path: "a.md" } } },
  { type: "subagent.step", data: { ...CHILD, tool_call_id: "k1", status: "running", label: "Reading a.md" } },
  { type: "subagent.tool_result", data: { ...CHILD, id: "k1", name: "readDoc", output: "text" } },
  { type: "subagent.token", data: { ...CHILD, data: "ReAct is…", messageId: "m1" } },
  { type: "subagent.end", data: { ...CHILD, final_message: "ReAct is…" } },
  { type: "tool_result", data: { id: CHILD.call_id, name: "task", output: "ReAct is…" } },
  { type: "token", data: "Here is the comparison." },
  { type: "done", data: {} },
]

describe("reduceTurns", () => {
  it("builds one turn with steps in event order, hiding writeTodos behind the plan", async () => {
    const view = await fold(RUN)
    expect(view.threadId).toBe("th-1")
    expect(view.turns).toHaveLength(1)
    const [turn] = view.turns
    expect(turn?.status).toBe("done")
    expect(turn?.steps.map((step) => step.kind)).toEqual([
      "reasoning",
      "tool",
      "plan",
      "tool",
      "tool",
      "subagent",
    ])
  })

  it("merges b4.step labels, icons and sources into the tool step", async () => {
    const view = await fold(RUN)
    const recall = view.turns[0]?.steps[1] as ToolStep
    expect(recall).toMatchObject({
      kind: "tool",
      id: "c1",
      name: "recall",
      status: "done",
      icon: "memory",
      label: "Checked memory",
      result: "(no memories found)",
    })
    expect(recall.args).toBe('{"query":"agents"}')
  })

  it("keeps the plan in place and updated", async () => {
    const view = await fold(RUN)
    expect(view.turns[0]?.steps[2]).toMatchObject({
      kind: "plan",
      todos: [{ content: "search", status: "in_progress" }],
    })
  })

  it("replaces the task call with a subagent step holding a nested turn", async () => {
    const view = await fold(RUN)
    const subagent = view.turns[0]?.steps[5] as SubagentStep
    expect(subagent).toMatchObject({
      kind: "subagent",
      id: CHILD.call_id,
      name: "researcher",
      description: "summarize ReAct",
      status: "done",
    })
    expect(subagent.turn.steps.map((step) => step.kind)).toEqual(["tool"])
    expect(subagent.turn.steps[0]).toMatchObject({ id: "k1", name: "readDoc", label: "Reading a.md", status: "done" })
    expect(subagent.turn.text).toBe("ReAct is…")
  })

  it("marks a failed step from a failed b4.step and leaves the turn done", async () => {
    const view = await fold([
      { type: "tool_call", data: { id: "e1", name: "readDoc", input: {} } },
      {
        type: "tool_result",
        data: { id: "e1", name: "readDoc", output: { status: "error", content: "ENOENT", name: "readDoc", tool_call_id: "e1" } },
      },
      { type: "done", data: {} },
    ])
    expect(view.turns[0]?.steps[0]).toMatchObject({ kind: "tool", status: "failed", result: "ENOENT" })
    expect(view.turns[0]?.status).toBe("done")
    expect(view.turns[0]?.failed).toBe(1)
  })

  it("attaches an interrupt to its tool step and pauses the subagent above it", async () => {
    const view = await fold([
      { type: "tool_call", data: { id: CHILD.call_id, name: "task", input: {} } },
      { type: "subagent.start", data: CHILD },
      { type: "subagent.tool_call", data: { ...CHILD, id: "k2", name: "runBash", input: { command: "node x" } } },
      {
        type: "interrupt",
        data: {
          interruptId: "perm-1",
          type: "permission-request",
          kind: "command",
          callId: CHILD.call_id,
          toolCallId: "k2",
          detail: { command: "node x", suggestedPattern: "node x" },
        },
      },
    ])
    const turn = view.turns[0]
    expect(turn?.status).toBe("awaiting")
    const subagent = turn?.steps[0] as SubagentStep
    expect(subagent.status).toBe("paused")
    const gated = subagent.turn.steps[0] as ToolStep
    expect(gated.status).toBe("awaiting")
    expect(gated.approval).toMatchObject({
      interruptId: "perm-1",
      kind: "command",
      detail: { command: "node x" },
      offersAlways: true,
    })
    expect(turn?.approvals).toEqual([])
  })

  it("keeps an interrupt that names no step on the turn", async () => {
    const view = await fold([
      { type: "interrupt", data: { interruptId: "x-1", kind: "custom", message: "look" } },
    ])
    expect(view.turns[0]?.steps).toEqual([])
    expect(view.turns[0]?.approvals).toEqual([
      { interruptId: "x-1", kind: "custom", detail: {}, offersAlways: false, message: "look" },
    ])
  })

  it("fails running steps and the turn on RUN_ERROR, and stops on cancel", async () => {
    const errored = await fold([
      { type: "tool_call", data: { id: "r1", name: "searchCorpus", input: {} } },
      { type: "step", data: { tool_call_id: "r1", status: "running", label: "Searching" } },
    ].concat([{ type: "throw", data: new Error("boom") } as unknown as B4AgentStreamChunk]))
    // `toAguiEvents` turns an upstream throw into RUN_ERROR; the fake "throw"
    // chunk above is replaced by this helper in Step 3 if needed.
    expect(errored.turns[0]?.status).toBe("failed")
    expect(errored.turns[0]?.steps[0]).toMatchObject({ status: "failed" })
  })

  it("merges repeated running steps for one call into a single step and never downgrades done", async () => {
    // LangGraph re-executes a resumed tool node, so the converter dispatches a
    // second `running` for the same tool_call_id before `completed`.
    const view = await fold([
      { type: "tool_call", data: { id: "r1", name: "searchCorpus", input: { query: "a" } } },
      { type: "step", data: { tool_call_id: "r1", status: "running", label: "Searching" } },
      { type: "step", data: { tool_call_id: "r1", status: "running", label: "Searching again" } },
      { type: "tool_result", data: { id: "r1", name: "searchCorpus", output: "ok" } },
      { type: "step", data: { tool_call_id: "r1", status: "completed", label: "Searched" } },
      { type: "step", data: { tool_call_id: "r1", status: "running", label: "Late running" } },
      { type: "done", data: {} },
    ])
    const tools = view.turns[0]?.steps.filter((step) => step.kind === "tool") ?? []
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ id: "r1", status: "done", label: "Late running" })
  })

  it("starts over on a different thread and appends a turn on the same one", () => {
    const first = reduceTurns(EMPTY_TURNS, { type: EventType.RUN_STARTED, threadId: "a", runId: "1" } as BaseEvent)
    const second = reduceTurns(first, { type: EventType.RUN_STARTED, threadId: "a", runId: "2" } as BaseEvent)
    expect(second.turns.map((turn) => turn.runId)).toEqual(["1", "2"])
    const other = reduceTurns(second, { type: EventType.RUN_STARTED, threadId: "b", runId: "3" } as BaseEvent)
    expect(other.turns.map((turn) => turn.runId)).toEqual(["3"])
  })

  it("is a pure function of the events: replaying yields a deep-equal view", async () => {
    const a = await fold(RUN, fixedClock())
    const b = await fold(RUN, fixedClock())
    expect(a).toEqual(b)
  })
})
```

For the RUN_ERROR test, use a stream that throws instead of the fake chunk: define

```ts
async function* thenThrow(items: readonly B4AgentStreamChunk[]): AsyncIterable<B4AgentStreamChunk> {
  yield* items
  throw new Error("boom")
}
```

and a `foldStream(stream)` variant of `fold` that takes the iterable; use it there.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/view/turns.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `turns.ts`**

`packages/ag-ui/src/view/turns.ts`:

```ts
import type {
  ActivitySnapshotEvent,
  BaseEvent,
  Interrupt,
  ReasoningMessageContentEvent,
  ReasoningStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  SubagentErrorEvent,
  SubagentFinishedEvent,
  SubagentStartedEvent,
  TextMessageContentEvent,
  ToolCallArgsEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { B4_PLAN_ACTIVITY_TYPE, type B4PlanActivityContent } from "../activities.js"
import type { B4StepEventValue } from "../step.js"
import { readStepEvent } from "./step.js"

export type StepStatus = "pending" | "running" | "done" | "failed" | "awaiting"
export type TurnStatus = "working" | "awaiting" | "done" | "failed" | "stopped"

export interface StepSource {
  readonly title: string
  readonly href?: string
}

/** A parked interrupt, as a chat shows it. */
export interface ApprovalView {
  readonly interruptId: string
  /** The interrupt's `reason`: a permission kind (`command`, `tool`, …) or the producer's own word. */
  readonly kind: string
  readonly detail: Readonly<Record<string, unknown>>
  readonly message?: string
  /** The single-use grant to echo back on resume, when the runtime minted one. */
  readonly grant?: string
  /** Whether "Always allow" is an answer here (from the interrupt's `responseSchema`). */
  readonly offersAlways: boolean
}

export interface ToolStep {
  readonly kind: "tool"
  readonly id: string
  readonly name: string
  readonly status: StepStatus
  /** The arguments text streamed so far. */
  readonly args: string
  readonly result?: string
  readonly icon?: string
  readonly label?: string
  readonly sources?: readonly StepSource[]
  readonly startedAt: number
  readonly settledAt?: number
  readonly approval?: ApprovalView
}

export interface PlanStep {
  readonly kind: "plan"
  readonly id: string
  readonly todos: B4PlanActivityContent["todos"]
  readonly startedAt: number
  readonly updatedAt: number
}

export interface ReasoningStep {
  readonly kind: "reasoning"
  readonly id: string
  readonly text: string
  readonly status: "streaming" | "done"
  readonly startedAt: number
  readonly settledAt?: number
}

export interface SubagentStep {
  readonly kind: "subagent"
  /** The `subagentRunId`, which is also the `task` call it replaced. */
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly status: "running" | "paused" | "done" | "failed"
  readonly result?: unknown
  readonly error?: string
  readonly startedAt: number
  readonly settledAt?: number
  /** The child's own turn: its steps, text and approvals. */
  readonly turn: TurnView
}

export type StepView = ToolStep | PlanStep | ReasoningStep | SubagentStep

export interface TurnView {
  readonly runId: string
  readonly status: TurnStatus
  readonly startedAt: number
  readonly endedAt?: number
  readonly steps: readonly StepView[]
  /** The assistant's prose for this turn (root) or the child's (nested). */
  readonly text: string
  /** Interrupts that named no step. */
  readonly approvals: readonly ApprovalView[]
  readonly error?: string
  /** How many steps failed, nested subagents included. */
  readonly failed: number
}

export interface TurnsView {
  readonly threadId?: string
  readonly turns: readonly TurnView[]
}

export interface ReduceTurnsOptions {
  /** The clock; injected so the reducer stays a pure function in tests. */
  readonly now?: () => number
  /** Tools whose frames the view drops entirely (in addition to `writeTodos`, which becomes the plan). */
  readonly hiddenTools?: readonly string[]
}

export const EMPTY_TURNS: TurnsView = { turns: [] }

type Attributed = BaseEvent & { readonly subagentRunId?: string }

function newTurn(runId: string, startedAt: number): TurnView {
  return { runId, status: "working", startedAt, steps: [], text: "", approvals: [], failed: 0 }
}

/** The turn a tagged event belongs to: the subagent's nested turn, else the root turn. */
function updateOwner(
  turns: readonly TurnView[],
  owner: string | undefined,
  update: (turn: TurnView) => TurnView,
): readonly TurnView[] {
  const last = turns.length - 1
  if (last < 0) return turns
  const root = turns[last] as TurnView
  const next = owner === undefined ? update(root) : updateNested(root, owner, update)
  return next === root ? turns : [...turns.slice(0, last), next]
}

function updateNested(turn: TurnView, owner: string, update: (turn: TurnView) => TurnView): TurnView {
  let changed = false
  const steps = turn.steps.map((step) => {
    if (step.kind !== "subagent") return step
    if (step.id === owner) {
      changed = true
      return { ...step, turn: update(step.turn) }
    }
    const nested = updateNested(step.turn, owner, update)
    if (nested === step.turn) return step
    changed = true
    return { ...step, turn: nested }
  })
  return changed ? { ...turn, steps } : turn
}

/** Also mark every subagent on the path to `owner` as `paused`. */
function pauseAncestors(turn: TurnView, owner: string): TurnView {
  const steps = turn.steps.map((step) => {
    if (step.kind !== "subagent") return step
    if (step.id === owner || containsOwner(step.turn, owner)) {
      return { ...step, status: "paused" as const, turn: pauseAncestors(step.turn, owner) }
    }
    return step
  })
  return { ...turn, steps }
}

function containsOwner(turn: TurnView, owner: string): boolean {
  return turn.steps.some(
    (step) => step.kind === "subagent" && (step.id === owner || containsOwner(step.turn, owner)),
  )
}

function mapStep(turn: TurnView, id: string, update: (step: ToolStep) => ToolStep): TurnView {
  let changed = false
  const steps = turn.steps.map((step) => {
    if (step.kind !== "tool" || step.id !== id) return step
    changed = true
    return update(step)
  })
  return changed ? { ...turn, steps } : turn
}

function readTodos(content: unknown): B4PlanActivityContent["todos"] | undefined {
  if (typeof content !== "object" || content === null) return undefined
  const todos = (content as { todos?: unknown }).todos
  return Array.isArray(todos) ? (todos as B4PlanActivityContent["todos"]) : undefined
}

function approvalOf(interrupt: Interrupt): ApprovalView {
  const metadata = (interrupt.metadata ?? {}) as Record<string, unknown>
  const detail = metadata.detail
  const schema = interrupt.responseSchema as { enum?: unknown } | undefined
  return {
    interruptId: interrupt.id,
    kind: interrupt.reason,
    detail: typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : {},
    ...(interrupt.message !== undefined ? { message: interrupt.message } : {}),
    ...(typeof metadata.grant === "string" ? { grant: metadata.grant } : {}),
    offersAlways: Array.isArray(schema?.enum) && schema.enum.includes("always"),
  }
}

/** Running or pending work never settles on its own: the turn ending settles it. */
function settleOpen(turn: TurnView, status: "failed", at: number): TurnView {
  const steps = turn.steps.map((step): StepView => {
    switch (step.kind) {
      case "tool":
        return step.status === "running" || step.status === "pending"
          ? { ...step, status, settledAt: at }
          : step
      case "reasoning":
        return step.status === "streaming" ? { ...step, status: "done", settledAt: at } : step
      case "subagent":
        return step.status === "running"
          ? { ...step, status, settledAt: at, turn: settleOpen(step.turn, status, at) }
          : step
      default:
        return step
    }
  })
  return { ...turn, steps, failed: countFailed(steps) }
}

function countFailed(steps: readonly StepView[]): number {
  let failed = 0
  for (const step of steps) {
    if (step.kind === "tool" && step.status === "failed") failed++
    if (step.kind === "subagent") failed += (step.status === "failed" ? 1 : 0) + step.turn.failed
  }
  return failed
}

function withFailedCount(turn: TurnView): TurnView {
  const failed = countFailed(turn.steps)
  return failed === turn.failed ? turn : { ...turn, failed }
}

/**
 * Fold one AG-UI event into the turns of a thread. Pure given `now`: the same
 * events in the same order yield a deep-equal view, live, replayed or
 * restored. Root events land on the last turn; an event tagged
 * `subagentRunId` lands on that subagent's nested turn, however deep.
 */
export function reduceTurns(state: TurnsView, event: BaseEvent, options: ReduceTurnsOptions = {}): TurnsView {
  const now = options.now ?? Date.now
  const hidden = new Set(options.hiddenTools ?? [])
  const owner = (event as Attributed).subagentRunId

  switch (event.type) {
    case EventType.RUN_STARTED: {
      const { threadId, runId } = event as RunStartedEvent
      const turn = newTurn(runId, now())
      return threadId === state.threadId
        ? { threadId, turns: [...state.turns, turn] }
        : { threadId, turns: [turn] }
    }
    case EventType.RUN_FINISHED: {
      const { outcome } = event as RunFinishedEvent
      const at = now()
      return {
        ...state,
        turns: updateOwner(state.turns, undefined, (turn) => {
          if (outcome?.type === "interrupt") {
            let next: TurnView = { ...turn, status: "awaiting" }
            for (const interrupt of outcome.interrupts) next = attachInterrupt(next, interrupt)
            return next
          }
          const settled = settleOpen(turn, "failed", at)
          return {
            ...settled,
            status: outcome?.type === "cancelled" ? "stopped" : "done",
            endedAt: at,
          }
        }),
      }
    }
    case EventType.RUN_ERROR: {
      const { message } = event as RunErrorEvent
      const at = now()
      return {
        ...state,
        turns: updateOwner(state.turns, undefined, (turn) => ({
          ...settleOpen(turn, "failed", at),
          status: "failed",
          endedAt: at,
          error: message,
        })),
      }
    }
    case EventType.SUBAGENT_STARTED: {
      const started = event as SubagentStartedEvent
      const at = now()
      const parent = started.parentSubagentRunId
      return {
        ...state,
        turns: updateOwner(state.turns, parent, (turn) => {
          const existing = turn.steps.find(
            (step): step is SubagentStep => step.kind === "subagent" && step.id === started.subagentRunId,
          )
          const step: SubagentStep = {
            kind: "subagent",
            id: started.subagentRunId,
            name: started.name,
            ...(started.description !== undefined ? { description: started.description } : {}),
            status: "running",
            startedAt: existing?.startedAt ?? at,
            // A continued invocation keeps what the earlier run showed.
            turn: existing?.turn ?? newTurn(started.subagentRunId, at),
          }
          if (existing !== undefined) {
            return { ...turn, steps: turn.steps.map((s) => (s === existing ? step : s)) }
          }
          // Replace the `task` call that started it, in place.
          const index = turn.steps.findIndex(
            (s) => s.kind === "tool" && s.id === (started.parentToolCallId ?? started.subagentRunId),
          )
          const steps = index === -1 ? [...turn.steps, step] : turn.steps.with(index, step)
          return { ...turn, steps }
        }),
      }
    }
    case EventType.SUBAGENT_FINISHED: {
      const finished = event as SubagentFinishedEvent
      const at = now()
      return {
        ...state,
        turns: updateOwner(state.turns, finished.parentSubagentRunId, (turn) =>
          withFailedCount({
            ...turn,
            steps: turn.steps.map((step) =>
              step.kind === "subagent" && step.id === finished.subagentRunId
                ? {
                    ...step,
                    status: finished.outcome?.type === "suspended" ? "paused" : "done",
                    ...(finished.result !== undefined ? { result: finished.result } : {}),
                    ...(finished.outcome?.type === "suspended"
                      ? {}
                      : { settledAt: at, turn: { ...settleOpen(step.turn, "failed", at), status: "done", endedAt: at } }),
                  }
                : step,
            ),
          }),
        ),
      }
    }
    case EventType.SUBAGENT_ERROR: {
      const failed = event as SubagentErrorEvent
      const at = now()
      return {
        ...state,
        turns: updateOwner(state.turns, failed.parentSubagentRunId, (turn) =>
          withFailedCount({
            ...turn,
            steps: turn.steps.map((step) =>
              step.kind === "subagent" && step.id === failed.subagentRunId
                ? {
                    ...step,
                    status: "failed",
                    error: failed.message,
                    settledAt: at,
                    turn: { ...settleOpen(step.turn, "failed", at), status: "failed", endedAt: at, error: failed.message },
                  }
                : step,
            ),
          }),
        ),
      }
    }
    default:
      break
  }

  const step = readStepEvent(event)
  if (step !== undefined) {
    return { ...state, turns: updateOwner(state.turns, owner, (turn) => applyStep(turn, step, now())) }
  }

  switch (event.type) {
    case EventType.TOOL_CALL_START: {
      const { toolCallId, toolCallName } = event as ToolCallStartEvent
      if (hidden.has(toolCallName)) return state
      const at = now()
      return {
        ...state,
        turns: updateOwner(state.turns, owner, (turn) => {
          if (toolCallName === "writeTodos") {
            // The plan presents this call; keep its place with an empty plan
            // until the snapshot arrives (root frames are usually suppressed
            // upstream, so this mostly matters for a child's plan).
            if (turn.steps.some((s) => s.kind === "plan")) return turn
            return { ...turn, steps: [...turn.steps, { kind: "plan", id: `plan:${turn.runId}`, todos: [], startedAt: at, updatedAt: at }] }
          }
          if (turn.steps.some((s) => s.kind === "tool" && s.id === toolCallId)) return turn
          return {
            ...turn,
            steps: [
              ...turn.steps,
              { kind: "tool", id: toolCallId, name: toolCallName, status: "pending", args: "", startedAt: at },
            ],
          }
        }),
      }
    }
    case EventType.TOOL_CALL_ARGS: {
      const { toolCallId, delta } = event as ToolCallArgsEvent
      return { ...state, turns: updateOwner(state.turns, owner, (turn) => mapStep(turn, toolCallId, (s) => ({ ...s, args: s.args + delta }))) }
    }
    case EventType.TOOL_CALL_END: {
      const { toolCallId } = event as { toolCallId: string }
      return {
        ...state,
        turns: updateOwner(state.turns, owner, (turn) =>
          mapStep(turn, toolCallId, (s) => (s.status === "pending" ? { ...s, status: "running" } : s)),
        ),
      }
    }
    case EventType.TOOL_CALL_RESULT: {
      const { toolCallId, content } = event as ToolCallResultEvent
      const result =
        typeof content === "string"
          ? content
          : content.map((part) => (part.type === "text" ? part.text : "")).join("")
      const at = now()
      return {
        ...state,
        turns: updateOwner(state.turns, owner, (turn) =>
          mapStep(turn, toolCallId, (s) =>
            s.status === "failed" ? { ...s, result } : { ...s, result, status: "done", settledAt: at },
          ),
        ),
      }
    }
    case EventType.ACTIVITY_SNAPSHOT: {
      const { activityType, content, messageId } = event as ActivitySnapshotEvent
      if (activityType !== B4_PLAN_ACTIVITY_TYPE) return state
      const todos = readTodos(content)
      if (todos === undefined) return state
      const at = now()
      return {
        ...state,
        turns: updateOwner(state.turns, owner, (turn) => {
          const index = turn.steps.findIndex((s) => s.kind === "plan")
          if (index === -1) {
            return { ...turn, steps: [...turn.steps, { kind: "plan", id: messageId, todos, startedAt: at, updatedAt: at }] }
          }
          const existing = turn.steps[index] as PlanStep
          return { ...turn, steps: turn.steps.with(index, { ...existing, id: messageId, todos, updatedAt: at }) }
        }),
      }
    }
    case EventType.REASONING_START: {
      const { messageId } = event as ReasoningStartEvent
      const at = now()
      return {
        ...state,
        turns: updateOwner(state.turns, owner, (turn) => ({
          ...turn,
          steps: [...turn.steps, { kind: "reasoning", id: messageId, text: "", status: "streaming", startedAt: at }],
        })),
      }
    }
    case EventType.REASONING_MESSAGE_CONTENT: {
      const { delta } = event as ReasoningMessageContentEvent
      return {
        ...state,
        turns: updateOwner(state.turns, owner, (turn) => {
          // Content belongs to the newest open reasoning span of this owner.
          for (let index = turn.steps.length - 1; index >= 0; index--) {
            const s = turn.steps[index]
            if (s?.kind === "reasoning" && s.status === "streaming") {
              return { ...turn, steps: turn.steps.with(index, { ...s, text: s.text + delta }) }
            }
          }
          return turn
        }),
      }
    }
    case EventType.REASONING_END: {
      const { messageId } = event as { messageId: string }
      const at = now()
      return {
        ...state,
        turns: updateOwner(state.turns, owner, (turn) => ({
          ...turn,
          steps: turn.steps.map((s) =>
            s.kind === "reasoning" && s.id === messageId ? { ...s, status: "done", settledAt: at } : s,
          ),
        })),
      }
    }
    case EventType.TEXT_MESSAGE_CONTENT: {
      const { delta } = event as TextMessageContentEvent
      return { ...state, turns: updateOwner(state.turns, owner, (turn) => ({ ...turn, text: turn.text + delta })) }
    }
    default:
      return state
  }
}

function applyStep(turn: TurnView, step: B4StepEventValue, at: number): TurnView {
  const patch = {
    ...(step.icon !== undefined ? { icon: step.icon } : {}),
    ...(step.label !== undefined ? { label: step.label } : {}),
    ...(step.sources !== undefined ? { sources: step.sources } : {}),
  }
  if (!turn.steps.some((s) => s.kind === "tool" && s.id === step.toolCallId)) {
    // A step for a call this turn never saw framed (e.g. frames suppressed
    // upstream): nothing to annotate.
    return turn
  }
  const next = mapStep(turn, step.toolCallId, (s) => {
    switch (step.status) {
      case "running":
        return { ...s, ...patch, status: s.status === "pending" ? "running" : s.status }
      case "completed":
        return { ...s, ...patch }
      case "failed":
        return { ...s, ...patch, status: "failed", settledAt: s.settledAt ?? at }
    }
  })
  return step.status === "failed" ? withFailedCount(next) : next
}

/** Put an interrupt on the step it names (pausing the subagents above it), or on the turn. */
function attachInterrupt(turn: TurnView, interrupt: Interrupt): TurnView {
  const approval = approvalOf(interrupt)
  const owner = interrupt.subagentRunId
  const place = (target: TurnView): TurnView => {
    if (interrupt.toolCallId !== undefined && target.steps.some((s) => s.kind === "tool" && s.id === interrupt.toolCallId)) {
      return mapStep(target, interrupt.toolCallId, (s) => ({ ...s, status: "awaiting", approval }))
    }
    return { ...target, approvals: [...target.approvals, approval] }
  }
  if (owner === undefined) return place(turn)
  const placed = updateNested(turn, owner, (nested) => ({ ...place(nested), status: "awaiting" }))
  return placed === turn ? place(turn) : pauseAncestors(placed, owner)
}
```

If `Array.prototype.with` is not in the package's `lib` (`tsconfig.json` has `ES2022`), replace each `.with(index, value)` with `[...arr.slice(0, index), value, ...arr.slice(index + 1)]` via a small `replaceAt(arr, index, value)` helper at the top of the file.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/view/turns.test.ts && pnpm --filter @b4run/ag-ui typecheck`
Expected: PASS. Debug by printing `view.turns[0]?.steps` for a failing case; the most likely slips are the plan placeholder order (the `writeTodos` START on root is suppressed by the ledger in the canned run, so the plan is inserted at the snapshot) and `exactOptionalPropertyTypes` complaints on conditional spreads.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/view/turns.ts packages/ag-ui/test/view/turns.test.ts
git commit -m "feat(ag-ui): reduceTurns — a turn's steps, nested subagents and approvals from AG-UI events

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 17: Labels, fallbacks and grouping

**Files:**
- Create: `packages/ag-ui/src/view/labels.ts`
- Modify: `packages/ag-ui/src/view/index.ts`
- Test: `packages/ag-ui/test/view/labels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { BUILT_IN_GROUP_LABELS, groupSteps, stepLabel } from "../../src/view/labels.ts"
import type { StepView, ToolStep } from "../../src/view/turns.ts"

function tool(partial: Partial<ToolStep> & { id: string; name: string }): ToolStep {
  return { kind: "tool", status: "done", args: "{}", startedAt: 0, ...partial }
}

describe("stepLabel", () => {
  it("prefers the server label, then the override, then the fallback", () => {
    expect(stepLabel(tool({ id: "1", name: "searchCorpus", label: "Searched the corpus" }))).toBe("Searched the corpus")
    expect(
      stepLabel(tool({ id: "1", name: "searchCorpus", args: '{"query":"a"}' }), {
        searchCorpus: { done: (args: { query: string }) => `Looked for ${args.query}` },
      }),
    ).toBe("Looked for a")
    expect(stepLabel(tool({ id: "1", name: "searchCorpus", status: "running" }))).toBe("Using searchCorpus…")
    expect(stepLabel(tool({ id: "1", name: "searchCorpus" }))).toBe("Used searchCorpus")
  })

  it("never throws when an override does, and never claims unknown args", () => {
    expect(
      stepLabel(tool({ id: "1", name: "x", args: "not json" }), {
        x: {
          done: () => {
            throw new Error("boom")
          },
        },
      }),
    ).toBe("Used x")
  })
})

describe("groupSteps", () => {
  it("merges consecutive done calls of the same tool, two or more, with a built-in or fallback label", () => {
    const steps: StepView[] = [
      tool({ id: "1", name: "readFile" }),
      tool({ id: "2", name: "readFile" }),
      tool({ id: "3", name: "searchCorpus" }),
      tool({ id: "4", name: "runBash" }),
      tool({ id: "5", name: "runBash" }),
      tool({ id: "6", name: "runBash" }),
      tool({ id: "7", name: "searchCorpus", status: "running" }),
      tool({ id: "8", name: "searchCorpus", status: "running" }),
    ]
    const grouped = groupSteps(steps)
    expect(grouped.map((g) => (g.kind === "group" ? `${g.name}×${g.steps.length}:${g.label}` : g.kind))).toEqual([
      "readFile×2:Read 2 files",
      "tool",
      "runBash×3:Ran 3 commands",
      "tool",
      "tool",
    ])
    expect(BUILT_IN_GROUP_LABELS.searchCorpus).toBeUndefined()
    expect(groupSteps([tool({ id: "a", name: "zap" }), tool({ id: "b", name: "zap" })])[0]).toMatchObject({
      kind: "group",
      label: "Used zap 2 times",
    })
  })

  it("never groups task or writeTodos, and lets an override name the group", () => {
    const steps: StepView[] = [tool({ id: "1", name: "task" }), tool({ id: "2", name: "task" })]
    expect(groupSteps(steps).map((g) => g.kind)).toEqual(["tool", "tool"])
    const two: StepView[] = [tool({ id: "1", name: "searchCorpus" }), tool({ id: "2", name: "searchCorpus" })]
    expect(groupSteps(two, { searchCorpus: { group: (n) => `Searched the corpus ${n} times` } })[0]).toMatchObject({
      label: "Searched the corpus 2 times",
    })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/view/labels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/ag-ui/src/view/labels.ts`:

```ts
import type { StepView, ToolStep } from "./turns.js"

/** Client-side wording for a tool: reword, localize, or label a group. */
export interface StepLabelOverride {
  readonly icon?: string
  readonly running?: (args: unknown) => string
  readonly done?: (args: unknown, result: string | undefined) => string
  readonly group?: (count: number) => string
}

export type StepLabelOverrides = Readonly<Record<string, StepLabelOverride>>

/** Group wording for B4.run's built-in tools; apps extend it through overrides. */
export const BUILT_IN_GROUP_LABELS: Readonly<Record<string, (count: number) => string>> = {
  readFile: (n) => `Read ${n} files`,
  writeFile: (n) => `Saved ${n} files`,
  editFile: (n) => `Edited ${n} files`,
  listDir: (n) => `Listed ${n} directories`,
  runBash: (n) => `Ran ${n} commands`,
  recall: (n) => `Checked memory ${n} times`,
  readSkill: (n) => `Loaded ${n} skills`,
}

/** Tools a chat presents some other way; never merged into a group. */
const NEVER_GROUPED: ReadonlySet<string> = new Set(["task", "writeTodos"])

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args)
  } catch {
    return undefined
  }
}

function tryLabel(produce: () => string): string | undefined {
  try {
    const label = produce()
    return typeof label === "string" && label !== "" ? label : undefined
  } catch {
    return undefined
  }
}

/**
 * The sentence for a tool step: the server's `b4.step` label, else the
 * app's override for that tool (given parsed args), else "Using X…" /
 * "Used X". Never throws.
 */
export function stepLabel(step: ToolStep, overrides: StepLabelOverrides = {}): string {
  if (step.label !== undefined) return step.label
  const override = overrides[step.name]
  const live = step.status === "pending" || step.status === "running" || step.status === "awaiting"
  if (override !== undefined) {
    const args = parseArgs(step.args)
    const produced = live
      ? override.running && tryLabel(() => override.running?.(args) ?? "")
      : override.done && tryLabel(() => override.done?.(args, step.result) ?? "")
    if (produced) return produced
  }
  return live ? `Using ${step.name}…` : `Used ${step.name}`
}

export interface StepGroup {
  readonly kind: "group"
  readonly name: string
  readonly label: string
  readonly steps: readonly ToolStep[]
}

export type GroupedStep = StepView | StepGroup

/**
 * Consecutive done calls of one tool, two or more, folded into a group with a
 * summary label ("Read 2 files"). Running, failed and awaiting steps never
 * join a group, and `task`/`writeTodos` never do.
 */
export function groupSteps(steps: readonly StepView[], overrides: StepLabelOverrides = {}): readonly GroupedStep[] {
  const out: GroupedStep[] = []
  let run: ToolStep[] = []
  const flush = () => {
    if (run.length >= 2) {
      const name = (run[0] as ToolStep).name
      const label = overrides[name]?.group ?? BUILT_IN_GROUP_LABELS[name] ?? ((n: number) => `Used ${name} ${n} times`)
      out.push({ kind: "group", name, label: label(run.length), steps: run })
    } else {
      out.push(...run)
    }
    run = []
  }
  for (const step of steps) {
    const groupable = step.kind === "tool" && step.status === "done" && !NEVER_GROUPED.has(step.name)
    if (groupable && (run.length === 0 || (run[0] as ToolStep).name === step.name)) {
      run.push(step)
      continue
    }
    flush()
    if (groupable) run.push(step)
    else out.push(step)
  }
  flush()
  return out
}
```

Append to `packages/ag-ui/src/view/index.ts`:

```ts
export {
  BUILT_IN_GROUP_LABELS,
  type GroupedStep,
  groupSteps,
  type StepGroup,
  type StepLabelOverride,
  type StepLabelOverrides,
  stepLabel,
} from "./labels.js"
export {
  type ApprovalView,
  EMPTY_TURNS,
  type PlanStep,
  type ReasoningStep,
  type ReduceTurnsOptions,
  reduceTurns,
  type StepSource,
  type StepStatus,
  type StepView,
  type SubagentStep,
  type ToolStep,
  type TurnStatus,
  type TurnView,
  type TurnsView,
} from "./turns.js"
```

- [ ] **Step 4: Run all view tests and the whole package**

Run: `pnpm --filter @b4run/ag-ui test && pnpm --filter @b4run/ag-ui typecheck && pnpm --filter @b4run/ag-ui lint`
Expected: PASS, including `test/view/public-api.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/view packages/ag-ui/test/view/labels.test.ts
git commit -m "feat(ag-ui): step labels with fallbacks and consecutive-call grouping

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 18: Register the `./view` entry everywhere a subpath is pinned

**Files:**
- Modify: `scripts/check-docs.mjs:1035-1039` and `:1333-1340`, `apps/web/app/components/docs/api-reference.ts:1211-1214` and `:1410-1420`, `apps/web/app/components/docs/api-reference.test.ts:66-74`, `apps/web/content/docs/api/ag-ui.mdx` (new `### \`@b4run/ag-ui/view\`` table before `### \`@b4run/ag-ui/react\``, and the `/react` paragraph), `apps/web/content/docs/ag-ui.mdx:429-441`, `packages/ag-ui/README.md:86-118`

- [ ] **Step 1: Pins**

`scripts/check-docs.mjs`: in `EXPECTED_API_ARTIFACT_POLICY_TUPLES` after the `./client` tuple add
`["import:@b4run/ag-ui:./view", "detailed", "surfaceKind", "typescript-runtime"],`
and in `EDGE_SAFE_API_ADDRESSES` after `"import:@b4run/ag-ui:./client",` add `"import:@b4run/ag-ui:./view",`.

`apps/web/app/components/docs/api-reference.ts`: after the `./client` `runtimeImport` line add
`runtimeImport("@b4run/ag-ui", "./view", "detailed", "edge-safe", "integration"),`
and in the ag-ui `packageEntry` address list after `importAddress("@b4run/ag-ui", "./client"),` add `importAddress("@b4run/ag-ui", "./view"),`.

`apps/web/app/components/docs/api-reference.test.ts`: in the detailed-imports array after `["@b4run/ag-ui", "./client"],` add `["@b4run/ag-ui", "./view"],`.

- [ ] **Step 2: Docs**

`apps/web/content/docs/api/ag-ui.mdx` — insert before `### \`@b4run/ag-ui/react\``:

```mdx
### `@b4run/ag-ui/view`

The framework-free half of the client: pure reducers and selectors over AG-UI events, with no React and no CopilotKit. `./react` builds on it; so can any other framework.

| Export | Responsibility |
|---|---|
| `reduceTurns` | Fold one AG-UI event into the turns of a thread: steps in order, nested subagent turns, the plan, reasoning, prose, and approvals attached to the calls they gate. |
| `EMPTY_TURNS` | The initial turns state. |
| `TurnsView` | The thread id and its turns. |
| `TurnView` | One turn: status, timing, steps, text, unattached approvals, failure count. |
| `StepView` | A tool, plan, reasoning or subagent step. |
| `ToolStep` | One tool call with its args, result, label, icon, sources and approval. |
| `PlanStep` | The plan as its latest snapshot. |
| `ReasoningStep` | One reasoning span and its text. |
| `SubagentStep` | A subagent invocation holding its nested turn. |
| `ApprovalView` | A parked interrupt as a chat shows it, with whether "always" is offered. |
| `StepSource` | A file, URL or record a step drew on. |
| `StepStatus` | `pending`, `running`, `done`, `failed` or `awaiting`. |
| `TurnStatus` | `working`, `awaiting`, `done`, `failed` or `stopped`. |
| `ReduceTurnsOptions` | Inject the clock and name tools to hide. |
| `stepLabel` | The sentence for a tool step: server label, app override, or "Using X…"/"Used X". |
| `groupSteps` | Fold consecutive done calls of one tool into a labeled group. |
| `StepLabelOverride` | Reword, localize or group-label one tool on the client. |
| `StepLabelOverrides` | Overrides keyed by tool name. |
| `StepGroup` | A run of merged tool steps and its label. |
| `GroupedStep` | A step or a group. |
| `BUILT_IN_GROUP_LABELS` | Group wording for B4.run's built-in tools. |
| `B4_STEP_EVENT_NAME` | The `CUSTOM` event name a step travels as (`b4.step`). |
| `B4StepEventValue` | A step event's value: `toolCallId`, `status`, `icon`, `label`, `sources`. |
| `B4StepStatus` | `running`, `completed` or `failed`. |
| `readStepEvent` | Read a `b4.step` value from an event, or nothing. |
| `reduceSubagentRuns` | The pure subagent-tree reducer (also re-exported from `./react`). |
| `EMPTY_SUBAGENT_RUNS` | The initial subagent-tree state. |
| `isSubagentMessage` | Narrow a transcript message to one a subagent produced. |
| `SubagentRun` | Everything known about one subagent invocation. |
| `SubagentRunsState` | The thread id and the invocations keyed by `subagentRunId`. |
| `SubagentToolCall` | One tool call a subagent made. |
```

In the `/react` table, change the `reduceSubagentRuns` row to `| \`reduceSubagentRuns\` | Re-export of the pure reducer from \`@b4run/ag-ui/view\`. |` and likewise note re-export on `EMPTY_SUBAGENT_RUNS`, `isSubagentMessage`, `SubagentRun`, `SubagentRunsState`, `SubagentToolCall`.

`apps/web/content/docs/ag-ui.mdx` — at the end of the React section paragraph that mentions `reduceSubagentRuns` (line ~441), add: `The reducers live in \`@b4run/ag-ui/view\`, which has no React dependency: \`reduceTurns\` folds a whole thread into turns, steps and approvals, for any framework.`

`packages/ag-ui/README.md` — after the "React renderers" section add:

```md
## Framework-free view

`@b4run/ag-ui/view` is the half of the client with no React: `reduceTurns(view, event)` folds AG-UI events into the turns of a thread — tool steps with their `b4.step` labels, the plan, reasoning, nested subagent turns, and approvals attached to the calls they gate — and `stepLabel`/`groupSteps` turn steps into sentences. `./react` builds on it; an Angular client can too.
```

- [ ] **Step 3: Run the gates**

Run: `pnpm build && node scripts/check-docs.mjs && pnpm --filter @b4run/web test -- --run app/components/docs && pnpm pack:check`
Expected: PASS. (`pack:check` checks every export target exists in the tarball; `dist/view/index.js` is emitted by `tsc -b`.)

- [ ] **Step 4: Regenerate lastmod and commit**

```bash
git add scripts/check-docs.mjs apps/web/app/components/docs apps/web/content/docs packages/ag-ui/README.md
git commit -m "docs: register @b4run/ag-ui/view

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod && git add apps/web/app/seo/lastmod.generated.json && git commit -m "chore(web): regenerate seo lastmod

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 19: Changeset, validation, PR C

- [ ] **Step 1: Changeset**

`.changeset/ag-ui-view-entry.md`:

```md
---
"@b4run/ag-ui": patch
---

New `@b4run/ag-ui/view` entry: the framework-free client half. `reduceTurns` folds AG-UI events into a thread's turns — tool steps with their `b4.step` labels, the plan, reasoning, nested subagent turns, and approvals attached to the calls they gate — and `stepLabel`/`groupSteps` turn steps into sentences. `reduceSubagentRuns` moved here (still re-exported from `./react`).
```

- [ ] **Step 2: Full validation and PR**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm pack:check`
Expected: PASS.

```bash
git add .changeset/ag-ui-view-entry.md
git commit -m "chore: changeset for @b4run/ag-ui/view

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin blove/ag-ui-view-entry
gh pr create --base main --title "feat(ag-ui): @b4run/ag-ui/view — reduceTurns, labels and grouping without React" --body "$(cat <<'EOF'
Sub-project 1, PR C of `docs/superpowers/specs/2026-10-03-b4-activity-components-design.md`.

- New `./view` subpath (edge-safe, no React): `reduceTurns` folds a thread's events into turns → steps (tool/plan/reasoning/subagent), nested subagent turns, `b4.step` labels, and approvals attached by `toolCallId`/`subagentRunId`; `stepLabel` + `groupSteps` for sentences and merged runs.
- `reduceSubagentRuns` moves to `./view` (re-exported from `./react`).
- Docs: `/docs/api/ag-ui` gains the `./view` table; pins in `check-docs.mjs` and `api-reference.ts`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then `mcp__ccd_pr__get_status` and `mcp__ccd_pr__set_auto_merge` (`enabled: true`, `squash`).

---

# Spike — CopilotKit slots and pending interrupts after reload

Not a PR. Run after PR C merges, in a worktree on `main`, with `pnpm build` done and the research example's server (`pnpm --dir examples/research/server dev`, `OPENAI_API_KEY` exported) and web (`pnpm --dir examples/research/web dev`) running. Nothing here is committed except the findings (Step 5).

### Task 20: Verify the three slot props and interrupt restore

- [ ] **Step 1: Make the research web page a minimal CopilotChat with the slot props**

Overwrite `examples/research/web/app/page.tsx` locally (do not commit) with:

```tsx
"use client"
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotKit,
  type Message,
  useDefaultRenderTool,
} from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useState } from "react"

/** SPIKE 1: a tool-calls view that proves the slot is reached and sees the message. */
function SpikeToolCallsView({ message }: { message: { toolCalls?: unknown[] } }) {
  return <div data-spike="toolcalls">[spike toolCallsView: {message.toolCalls?.length ?? 0} calls]</div>
}

/** SPIKE 2: hide the toolbar on tool-only messages. */
function SpikeAssistantMessage(props: Parameters<typeof CopilotChatAssistantMessage>[0]) {
  const hasText = typeof props.message.content === "string" && props.message.content.trim() !== ""
  return <CopilotChatAssistantMessage {...props} toolbarVisible={hasText} toolCallsView={SpikeToolCallsView} />
}

function DefaultTools() {
  useDefaultRenderTool()
  return null
}

export default function Home() {
  const [threadId, setThreadId] = useState<string | undefined>(undefined)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setThreadId(new URLSearchParams(window.location.search).get("thread") ?? undefined)
    setReady(true)
  }, [])

  /** SPIKE 3: merge a turn's consecutive tool-only assistant messages into one. */
  const transformMessages = useCallback((messages: Message[]) => {
    const out: Message[] = []
    for (const message of messages) {
      const previous = out[out.length - 1]
      const toolOnly = (m: Message) =>
        m.role === "assistant" && (!m.content || m.content === "") && Array.isArray((m as { toolCalls?: unknown[] }).toolCalls)
      if (previous && toolOnly(previous) && toolOnly(message)) {
        out[out.length - 1] = {
          ...previous,
          toolCalls: [
            ...((previous as { toolCalls?: unknown[] }).toolCalls ?? []),
            ...((message as { toolCalls?: unknown[] }).toolCalls ?? []),
          ],
        } as Message
        continue
      }
      out.push(message)
    }
    return out
  }, [])

  if (!ready) return null
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint={false}>
      <DefaultTools />
      <div style={{ height: "100vh" }}>
        <CopilotChat
          {...(threadId !== undefined ? { threadId } : {})}
          messageView={{ transformMessages, assistantMessage: SpikeAssistantMessage }}
        />
      </div>
    </CopilotKit>
  )
}
```

Run: `pnpm --filter @b4-example/research-web typecheck`
Expected: clean. If `messageView`'s partial-props form rejects `assistantMessage`, pass it one level up as a sibling prop on `CopilotChat`'s `chatView` slot instead; record which form worked.

- [ ] **Step 2: Observe a live run**

Open `http://localhost:3010`, send "Compare ReAct and plan-and-execute using the corpus." Record in the findings:
- Does `[spike toolCallsView: N calls]` render once per turn with N > 1 (merge works) or once per tool call (merge not applied)?
- Does the copy/wrench toolbar disappear under tool-only rows and remain under the final answer?
- Console errors (Inspector button → console), especially "must be a stable" warnings.

- [ ] **Step 3: Observe a restored thread**

Reload the page at `http://localhost:3010/?thread=<the thread id from the Inspector or the server's threads.sqlite>`. Record whether tool calls and the final text come back and whether the toolCallsView count matches the live run.

- [ ] **Step 4: Pending interrupt after reload**

Send "Fetch https://example.org/paper with the fetch-source script and summarize it." so the agent calls `runBash` with `node scripts/fetch-source.mjs …`, which is off the allow-list. When the run parks:
- Record whether CopilotKit's stock chat renders any approval UI (it should not; it has none registered).
- Reload the page with `?thread=<id>`. In the Inspector (wrench → View in Inspector), or via `GET http://127.0.0.1:3002/threads/<id>/state`, confirm the interrupt is still parked server-side.
- Add temporarily to the page a component calling `useInterrupt({ render: ({ interrupts }) => <pre>{JSON.stringify(interrupts.map((i) => i.id))}</pre>, renderInChat: false })` mounted inside `CopilotKit`, and render its return value. Reload again. Record whether the parked interrupt ids render **after reload** (CopilotKit restores pending interrupts) or only after a fresh run (it does not — the sub-project 2 connector must read `/threads/:id/state` and seed `reduceTurns` with the parked interrupts).
- Approve the gate once via a direct `POST http://127.0.0.1:3002/agui/%2Fresearch%23agent` resume if needed to leave the thread clean, or delete the thread.

- [ ] **Step 5: Record the findings and restore the page**

Append a `## Spike findings (<date>)` section to this plan file with the four answers (merge via `transformMessages`: yes/no and the prop form that worked; `toolbarVisible` per message: yes/no; `toolCallsView` slot reached: yes/no; pending interrupts restored by CopilotKit after reload: yes/no). Then:

```bash
git checkout -- examples/research/web/app/page.tsx
git add docs/superpowers/plans/2026-10-03-b4-activity-protocol-and-view-core.md
git commit -m "docs(plan): CopilotKit slot spike findings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Open a small docs-only PR for the findings (same `gh pr create` shape as above, title `docs(plan): CopilotKit slot spike findings`), auto-merge on green. Sub-project 2's spec cites these findings for the connector design.

---

## Self-review

**Spec coverage (§6.3, §4, §4.1, §6.1, §6.2 of the spec):**
- §6.3.1 clean `TOOL_CALL_RESULT.content` → Task 1. §6.3.2 `b4.step` → Tasks 8–11. §6.3.3 interrupts: `toolCallId` → Task 2; scope inputs (`suggestedPattern` already in `detail`, kind in `reason`, "always offered" via `responseSchema`) → Task 3. Path gates are deferred and documented (Task 4 docs; PR A body).
- §4 `display` export + validation + built-in labels → Tasks 6, 7, 12. §4.1 event, persistence → Tasks 9, 11 (spec amended in Task 14: status shape, `additional_kwargs.b4_step`, client-side grouping).
- §6.1 view core → Tasks 15–17 (`reduceTurns`, approvals by `toolCallId`/`subagentRunId`, plan per owner, reasoning, nested subagents, failure propagation, labels + fallbacks, grouping). The 300 ms spinner threshold and open/closed defaults are component-time decisions on `startedAt`/`status` and belong to sub-project 2, as the spec's §3.1 places them with the components.
- §6.2 spike → Task 20.

**Placeholder scan:** no TBD/TODO; every code step shows its code; the RUN_ERROR test names its `thenThrow` helper; the agent-adapter test names the two helpers it needs and where their shapes come from.

**Type consistency:** `StepEventData` (langchain) ↔ `B4StepData` (ag-ui types, snake_case `tool_call_id`) ↔ `B4StepEventValue` (wire, camelCase `toolCallId`) are three deliberate layers; Task 11's `step` case maps the second to the third. `ToolStep.status` uses `done`, matching `StepStatus`; `B4StepStatus` uses `completed` on the wire, and `applyStep` maps it. `offersAlways` reads `responseSchema.enum`, which Task 3 sets.
