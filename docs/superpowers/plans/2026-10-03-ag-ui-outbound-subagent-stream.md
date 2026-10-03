# Subagent child stream — same shapes as root (AG-UI sub-project 2, PR 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A subagent's model turns and tool calls reach the B4 stream as `subagent.<type>` chunks whose `data` is **identical to the root chunk of the same type** plus the child identity — text as `subagent.token` with a `messageId`, `subagent.message_end`, `subagent.reasoning`, `subagent.tool_call_args`, and tool calls announced under the model's **logical** tool-call id from the child's `on_chat_model_end` — and `subagent.start` carries `parent_call_id` and `description`. Every consumer of the old shapes (`subagent.message { chunk }`, `subagent.tool_call { tool, id: <execution run id> }`) moves with it.

**Architecture:** `classifyStreamEvent` stops special-casing children. The root-only `RootToolProjectionState` becomes a per-owner `ToolProjectionState` (one for root, one per child `call_id`), every branch computes its chunks for the current owner exactly as root does today, and a single `wrapChild(child, chunk)` turns a root-shaped chunk into its `subagent.*` form by prefixing the type and spreading the identity into `data`. The AG-UI translator is **not** rewritten here (that is PR 3b: `SUBAGENT_*`, attribution, `b4.subagent` removal); it only follows the two renamed inputs it already consumes.

**Tech Stack:** TypeScript (NodeNext ESM; `src/` imports `.js`, `test/` imports `.ts`), vitest, LangChain `streamEvents` v2.

Spec: `docs/superpowers/specs/2026-10-02-ag-ui-1-0-outbound-richness-design.md` §2.1 (the chunk table), §5.1 (`parent_call_id`, `description`). PR 3 is split: **3a** (this plan) is the wire; **3b** is the AG-UI presentation (`SUBAGENT_*`, attribution, removal of `b4.subagent`, React panel, examples, release-pinned smoke scripts). Stacked on PR 2 (`blove/agui-outbound-reasoning`, #910) because it extends the `reasoning` chunk to children.

Conventions (from `AGENTS.md`): run from the repo root on Node 24; format from **the package directory** with `pnpm exec biome check --write --config-path ../config-biome/biome.json <files>` (never bare, never from the root without `--config-path`); `exactOptionalPropertyTypes` (conditional spreads); changesets are `patch`. Commit docs content **before** `pnpm --dir apps/web seo:lastmod`. If a local `ci:validate` is killed by the shell timeout, `ps | grep <worktree>` and kill orphaned vitest / `b4 __dev-child` processes before trusting the next run.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/langchain/src/agent-adapter.ts` | **Modify.** Per-owner `ToolProjectionState`; `wrapChild`; children take the root code paths in `on_chat_model_stream`, `on_chat_model_end`, `on_tool_start/end/error`, `on_chain_end`; `parseSubagentPhaseEvent` passes `parent_call_id`/`description` through. |
| `packages/langchain/src/subagent-tool-bridge.ts` | **Modify.** `ResolvedSubagentGraph.description?`; `b4.subagent` events carry `parent_call_id` (from the parent stack) and `description`. |
| `packages/langchain/test/agent-adapter.test.ts` | **Modify.** The native-projection test expects the new shapes; new tests for child logical ids, child `message_end`, child reasoning, child streamed args, depth-2 `parent_call_id`. |
| `packages/langchain/test/agent-adapter-interrupt.test.ts` | **Check.** Unchanged expectations (`subagent.end` error shape is untouched); run it. |
| `packages/cli/src/lib/runtime/execute-route-core.ts` | **Modify.** `prepareChild` returns `description: entry.description`. |
| `packages/cli/src/lib/dev/live-turn-hub.ts` + `test/live-turn-hub.test.ts` | **Modify.** Coalesce `subagent.token` by `call_id` + `messageId`, concatenating `data`. |
| `packages/testing/src/run-result.ts` + `test/run-result.test.ts`, `test/matchers.test.ts` | **Modify.** `subagent.tool_call` reads `name`; `subagent.token` is the child text. |
| `packages/ag-ui/src/activities.ts`, `src/types.ts`, `test/activities.test.ts`, `test/outbound.test.ts`, `test/conformance.test.ts` | **Modify.** Chunk-type list and the two fields the subagent projector reads (`name`, consumes `subagent.token`). |
| `apps/web/content/docs/recipes/stream-output.mdx`, `apps/web/content/docs/subagents.mdx`, `apps/web/content/docs/ag-ui.mdx`, `apps/web/content/docs/upgrading.mdx` | **Modify.** Wire shapes; upgrading entry. |
| `apps/web/app/seo/lastmod.generated.json` | **Regenerate.** |
| `.changeset/agui-subagent-stream.md` | **Create.** `patch` for `@b4run/langchain`, `@b4run/cli`, `@b4run/testing`, `@b4run/ag-ui`. |

---

### Task 1: `subagent.start` carries `parent_call_id` and `description`

**Files:**
- Modify: `packages/langchain/src/subagent-tool-bridge.ts` (`ResolvedSubagentGraph` ~line 10; `eventBase` ~line 90)
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts` (`prepareChild` return ~line 1733)
- Test: `packages/langchain/test/agent-adapter.test.ts` (the `collectCustomEvents` helper at the top of the file drives the bridge directly — read its first describe to see how a resolver is faked)

- [x] **Step 1: Write the failing test**

In `packages/langchain/test/agent-adapter.test.ts`, inside the first describe that uses `collectCustomEvents` (read lines 13-95 to copy its resolver fake), add:

```ts
  test("subagent.start names its parent call and carries the child's description", async () => {
    // Mirror the describe's existing resolver fake, returning
    // `{ ok: true, child: { routeId, description: "Finds sources", graph } }`,
    // and invoke the task tool with config.metadata.b4.subagent_stack =
    // [{ callId: "call-parent", name: "coordinator", routeId: "/coordinator" }]
    // and configurable.toolCallId = "call-child".
    const events = await collectCustomEvents(/* as above */)
    const start = events.find((e) => e.data.phase === "start")
    expect(start?.data).toMatchObject({
      call_id: "call-child",
      parent_call_id: "call-parent",
      subagent: "researcher",
      description: "Finds sources",
      depth: 2,
    })
    const end = events.find((e) => e.data.phase === "end")
    expect(end?.data).toMatchObject({ call_id: "call-child", parent_call_id: "call-parent" })
  })
```

Fill the fake from the existing helper; the assertion is the contract. A root-level dispatch (empty stack) must produce **no** `parent_call_id` key (add `expect(start?.data).not.toHaveProperty("parent_call_id")` in a second case with an empty stack).

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/langchain exec vitest run test/agent-adapter.test.ts -t "names its parent call"`
Expected: FAIL — `parent_call_id`/`description` missing.

- [x] **Step 3: Implement**

`packages/langchain/src/subagent-tool-bridge.ts`:

```ts
export interface ResolvedSubagentGraph {
  readonly routeId: string
  /** The child's declared description, surfaced on `subagent.start` for clients. */
  readonly description?: string
  readonly graph: {
    invoke(input: unknown, config: RunnableConfig): Promise<unknown>
  }
}
```

and in the tool `func`, after `const parentStack = readSubagentStack(parentB4)`:

```ts
      const parentCallId = parentStack.at(-1)?.callId
      const eventBase = {
        call_id: callId,
        ...(parentCallId !== undefined ? { parent_call_id: parentCallId } : {}),
        ...(toolRunId !== undefined ? { tool_run_id: toolRunId } : {}),
        subagent: input.subagent,
        route_id: resolved.child.routeId,
        depth: nextDepth,
        ...(resolved.child.description !== undefined && resolved.child.description !== ""
          ? { description: resolved.child.description }
          : {}),
      }
```

(replacing the existing `eventBase` literal). `packages/cli/src/lib/runtime/execute-route-core.ts` `prepareChild` return:

```ts
          return {
            graph: withEpisodeRecording(graph, childPrepared),
            routeId: route.id,
            ...(entry.description !== "" ? { description: entry.description } : {}),
          }
```

In `packages/langchain/src/agent-adapter.ts` `parseSubagentPhaseEvent`, the `{ phase, tool_run_id, ...data }` destructuring already forwards every other key, so `parent_call_id` and `description` reach the `subagent.start`/`subagent.end` chunk `data` with no change — confirm by reading it; add nothing.

- [x] **Step 4: Run, format, commit**

```bash
pnpm --filter @b4run/langchain exec vitest run test/agent-adapter.test.ts
pnpm --filter @b4run/cli typecheck
(cd packages/langchain && pnpm exec biome check --write --config-path ../config-biome/biome.json src/subagent-tool-bridge.ts test/agent-adapter.test.ts)
(cd packages/cli && pnpm exec biome check --write --config-path ../config-biome/biome.json src/lib/runtime/execute-route-core.ts)
git add packages/langchain packages/cli
git commit -m "feat(langchain): subagent.start names its parent call and carries the child's description

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Per-owner tool state and the wrapped child vocabulary

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts`
- Modify: `packages/langchain/test/agent-adapter.test.ts` (`"projects child events exactly once…"` ~line 210, plus new tests)

- [x] **Step 1: Rewrite the native-projection expectation and add the new cases**

In the test at ~line 210, the fixture stays; replace the `expect(chunks).toEqual([...])` block with:

```ts
    expect(chunks).toEqual([
      { type: "token", data: "Parent ", messageId: "parent-model" },
      { type: "subagent.start", data: childIdentity },
      // A child's text is framed like root text: a token with its invocation id…
      { type: "subagent.token", data: { ...childIdentity, data: "Child token", messageId: "child-model" } },
      // …and a child tool runs through the same announce/result pairing. With
      // no model turn announcing it (this fixture has no child
      // on_chat_model_end) the held on_tool_start resolves at on_tool_end under
      // the execution run id, exactly as root does for a resume replay.
      {
        type: "subagent.tool_call",
        data: { ...childIdentity, id: "child-tool-run", name: "readFile", input: { path: "evidence.md" } },
      },
      {
        type: "subagent.tool_result",
        data: { ...childIdentity, id: "child-tool-run", name: "readFile", output: "evidence" },
      },
      { type: "subagent.plan_update", data: { ...childIdentity, todos: ["inspect"] } },
      { type: "subagent.end", data: { ...childIdentity, final_message: "evidence" } },
      {
        type: "tool_call",
        data: { id: "parent-task-run", name: "task", input: { subagent: "researcher", input: "Investigate" } },
      },
      { type: "tool_result", data: { id: "parent-task-run", name: "task", output: "evidence" } },
      { type: "done", data: { root: true } },
    ])
```

Then add, in the same `describe("native subagent event projection")`, reusing its `metadata` constant and `streamAgent` collection pattern:

```ts
  test("a child model turn announces its tool calls under the model's logical id and ends its message", async () => {
    const entry = {
      invoke: vi.fn(),
      async *streamEvents() {
        yield {
          event: "on_chat_model_stream",
          run_id: "child-model",
          name: "child-model",
          data: {
            chunk: {
              content: [
                { type: "thinking", thinking: "look it up", index: 0 },
                { type: "text", text: "Searching", index: 1 },
              ],
              tool_call_chunks: [{ id: "call_search_1", name: "search", args: '{"q":', index: 0 }],
            },
          },
          metadata,
        }
        yield {
          event: "on_chat_model_stream",
          run_id: "child-model",
          name: "child-model",
          data: { chunk: { content: [], tool_call_chunks: [{ args: '"agents"}', index: 0 }] } },
          metadata,
        }
        yield {
          event: "on_chat_model_end",
          run_id: "child-model",
          name: "child-model",
          data: {
            output: {
              content: "Searching",
              tool_calls: [{ id: "call_search_1", name: "search", args: { q: "agents" } }],
              usage_metadata: { input_tokens: 3, output_tokens: 2 },
            },
          },
          metadata,
        }
        yield { event: "on_tool_start", run_id: "search-run", name: "search", data: { input: { q: "agents" } }, metadata }
        yield {
          event: "on_tool_end",
          run_id: "search-run",
          name: "search",
          data: { output: { tool_call_id: "call_search_1", content: "3 hits" } },
          metadata,
        }
        yield { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } }
      },
    }
    const chunks = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push(chunk)
    }
    const id = { call_id: "call-child", subagent: "researcher", route_id: "/planner/researcher", depth: 2 }
    expect(chunks.slice(0, -1)).toEqual([
      { type: "subagent.reasoning", data: { ...id, data: "look it up", messageId: "child-model" } },
      { type: "subagent.token", data: { ...id, data: "Searching", messageId: "child-model" } },
      { type: "subagent.tool_call_args", data: { ...id, id: "call_search_1", name: "search", delta: '{"q":' } },
      { type: "subagent.tool_call_args", data: { ...id, id: "call_search_1", name: "search", delta: '"agents"}' } },
      { type: "subagent.usage", data: { ...id, usage_metadata: { input_tokens: 3, output_tokens: 2 } } },
      { type: "subagent.message_end", data: { ...id, messageId: "child-model" } },
      { type: "subagent.tool_call", data: { ...id, id: "call_search_1", name: "search", input: { q: "agents" } } },
      {
        type: "subagent.tool_result",
        data: { ...id, id: "call_search_1", name: "search", output: { tool_call_id: "call_search_1", content: "3 hits" } },
      },
    ])
  })
```

(`metadata` in this describe is the child `b4.subagent_stack` metadata the existing test uses — the identity above must match what it encodes: `call_id: "call-child"`, `researcher`, `/planner/researcher`, depth 2. Adjust the literal to that fixture.) The exact order of `tool_call_args` vs `token` within one chunk follows the root order (`reasoning`, `token`, then fragments) — if the root emits fragments before tokens, mirror that; the point is parity.

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/langchain exec vitest run test/agent-adapter.test.ts -t "native subagent"`
Expected: FAIL (old shapes emitted).

- [x] **Step 3: Refactor the adapter**

In `packages/langchain/src/agent-adapter.ts`:

(a) Rename the state type and generalize its holder. Replace `interface RootToolProjectionState {` … `}` with:

```ts
/** One owner's (root's, or one subagent's) tool bookkeeping for a stream pass. */
interface ToolProjectionState {
  /** Model invocations with open text or reasoning output, closed by `message_end`. */
  readonly textModelRunIds: Set<string>
  /** Logical/fallback ids whose tool_call chunk was already emitted this stream. */
  readonly announcedToolCallIds: Set<string>
  /** on_tool_start data awaiting resolution at on_tool_end, keyed by execution run id. */
  readonly heldToolStarts: Map<string, { readonly name: string; readonly input: unknown }>
  /**
   * Executions that threw (a non-interrupt `on_tool_error`), awaiting the
   * error ToolMessage LangGraph's ToolNode hands the model. FIFO by tool name.
   */
  readonly pendingToolErrors: Array<{ readonly name: string; readonly input: unknown }>
  /** Argument fragments in flight, keyed by model run id then fragment index. */
  readonly streamingArgs: Map<string, Map<string, ArgumentStreamState>>
}

/**
 * Root and every subagent get the SAME bookkeeping, keyed by the child's
 * `call_id` (root is `undefined`): a child's tool calls are announced from its
 * own model turn under the model's logical id and paired with their results
 * exactly as root's are, so the AG-UI mapper can frame them identically.
 */
interface OwnerToolStates {
  readonly root: ToolProjectionState
  readonly children: Map<string, ToolProjectionState>
}

function newToolProjectionState(): ToolProjectionState {
  return {
    textModelRunIds: new Set(),
    announcedToolCallIds: new Set(),
    heldToolStarts: new Map(),
    pendingToolErrors: [],
    streamingArgs: new Map(),
  }
}

function toolStateFor(owners: OwnerToolStates, child: SubagentContext | undefined): ToolProjectionState {
  if (child === undefined) return owners.root
  let state = owners.children.get(child.callId)
  if (state === undefined) {
    state = newToolProjectionState()
    owners.children.set(child.callId, state)
  }
  return state
}

/**
 * A root-shaped chunk as the child's: the type gains the `subagent.` prefix
 * and the identity joins `data`. A string payload (`token`, `reasoning`)
 * moves under a `data` key beside its `messageId`; an object payload keeps
 * its keys. The identity spreads LAST so it can never be shadowed.
 */
function wrapChild(child: SubagentContext | undefined, chunk: AgentStreamChunk): AgentStreamChunk {
  if (child === undefined) return chunk
  const payload: Record<string, unknown> = isRecord(chunk.data)
    ? { ...chunk.data }
    : { data: chunk.data, ...(chunk.messageId !== undefined ? { messageId: chunk.messageId } : {}) }
  return { type: `subagent.${chunk.type}`, data: { ...payload, ...childIdentity(child) } }
}
```

Rename every `rootTools.heldRootToolStarts` → `tools.heldToolStarts`, `rootTools.pendingRootToolErrors` → `tools.pendingToolErrors`, and the parameter names `rootTools: RootToolProjectionState` → `tools: ToolProjectionState` in `projectToolCallFragments`, `flushToolCallFragments`, `resolveRootToolErrors` (rename to `resolveToolErrors`).

(b) `classifyStreamEvent` signature becomes `(event, toolRuns, owners: OwnerToolStates)`; at its top, after `const child = resolveEventSubagentContext(event, toolRuns)`, add `const tools = toolStateFor(owners, child)`, and define `const wrap = (chunks: AgentStreamChunk[]) => chunks.map((c) => wrapChild(child, c))`. Then:

- `on_chat_model_stream`: delete the `child ?` branches. Both text and reasoning register `tools.textModelRunIds.add(event.run_id)`; text pushes `{ type: "token", data: content, messageId: event.run_id }`; fragments always run (`projectToolCallFragments(tools, …)`); return `chunks: wrap(chunks)`. Remove the "Root only until PR 3" comment from PR 2.
- `on_chat_model_end`: delete the `if (child) { …usage only… }` block; the whole body runs for every owner against `tools`; return `chunks: wrap(chunks)` (usage becomes `subagent.usage` through the wrap — same shape as PR 1 produced).
- `on_tool_start`: delete the child branch; always `tools.heldToolStarts.set(...)`; `break`.
- `on_tool_end`: delete the child branch; the 3-way resolution runs against `tools`; return `chunks: wrap(chunks)`.
- `on_tool_error`: drop `if (!child)` so pending errors are recorded per owner.
- `on_chain_end`: keep the root `LangGraph` capture as is (with `resolveToolErrors(tools, output, true)`); for the child branch, replace `chunks: []` with `chunks: wrap(resolveToolErrors(tools, event.data.output, event.name === "LangGraph"))` while keeping its `interrupts` extraction; the final (root, non-LangGraph) branch is unchanged apart from the rename.
- `on_custom_event` (`b4.capability`): unchanged — `childData` already produces the right shape for capability events.

(c) In `processEventStream`, replace the `rootTools` literal with `const owners: OwnerToolStates = { root: newToolProjectionState(), children: new Map() }` and pass `owners`.

(d) Delete `subagent.message` everywhere in the file (it was only produced in the stream branch). Update the `isCapabilityEventName` reservation comment if it lists chunk names.

- [x] **Step 4: Run the langchain suite and typecheck**

Run: `pnpm --filter @b4run/langchain exec vitest run && pnpm --filter @b4run/langchain typecheck`
Expected: the two tests above PASS; other suites in the package that assert child shapes (`agent-adapter-interrupt.test.ts` asserts only `subagent.end`'s error shape and `interrupt` chunks — unchanged) PASS. Any test that still expects `subagent.message`/`tool:` is updated to the new shape, never the reverse.

- [x] **Step 5: Format and commit**

```bash
(cd packages/langchain && pnpm exec biome check --write --config-path ../config-biome/biome.json src/agent-adapter.ts test/agent-adapter.test.ts)
git add packages/langchain
git commit -m "feat(langchain)!: subagent chunks carry the root shapes — token/message_end/reasoning/tool_call_args, logical tool ids, per-owner state

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: CLI live-turn hub coalesces `subagent.token`

**Files:**
- Modify: `packages/cli/src/lib/dev/live-turn-hub.ts` (~lines 93-110, 130-145)
- Modify: `packages/cli/test/live-turn-hub.test.ts` (~line 244)

- [x] **Step 1: Update the test**

Replace the `message` factory and expectation in the child-attach test:

```ts
  const message = (call_id: string, data: string, messageId = "m1"): StreamChunk =>
    ({
      type: "subagent.token",
      data: { call_id, subagent: "researcher", route_id: "/child", depth: 1, data, messageId },
    }) as StreamChunk
  producer.publish(message("first", "hel"))
  producer.publish(message("second", "other"))
  producer.publish(message("first", "lo"))
  // A new invocation of the same child is a new digest entry, not more of the old one.
  producer.publish(message("first", "again", "m2"))
  const attachment = hub.attach("children")
  if (!attachment) throw new Error("Expected child turn attachment")
  expect(attachment.turn).toEqual([
    message("first", "hello"),
    message("second", "other"),
    message("first", "again", "m2"),
  ])
```

- [x] **Step 2: Run to verify failure**, then **Step 3: implement**

```ts
/** `subagent.token` coalesces per child invocation: same `call_id` AND `messageId`. */
function subagentTokenKey(chunk: StreamChunk): string | undefined {
  if (chunk.type !== "subagent.token") return undefined
  const data = (chunk as { readonly data?: unknown }).data
  if (!data || typeof data !== "object") return undefined
  const { call_id, messageId } = data as { call_id?: unknown; messageId?: unknown }
  if (typeof call_id !== "string") return undefined
  return `${call_id}\u0000${typeof messageId === "string" ? messageId : ""}`
}

function mergeSubagentToken(existing: StreamChunk, incoming: StreamChunk): StreamChunk {
  const ex = (existing as { data?: { data?: unknown } }).data ?? {}
  const inc = (incoming as { data?: { data?: unknown } }).data ?? {}
  return {
    type: "subagent.token",
    data: { ...ex, data: `${String(ex.data ?? "")}${String(inc.data ?? "")}` },
  } as StreamChunk
}
```

replacing `subagentCallId`/`mergeSubagent`, and in `appendCoalesced` replace the `subagent.message` block with a lookup by `subagentTokenKey` that merges only when the **last** digest entry has the same key (adjacent coalescing, like root `chunk`s — a different invocation or an interleaved chunk starts a new entry). Update the comment: `// subagent.token uses the public call_id/messageId/data wire fields.`

- [x] **Step 4: Run, format, commit**

```bash
pnpm --filter @b4run/cli exec vitest run test/live-turn-hub.test.ts test/subagent-delegation.test.ts test/subagent-interrupts.test.ts
(cd packages/cli && pnpm exec biome check --write --config-path ../config-biome/biome.json src/lib/dev/live-turn-hub.ts test/live-turn-hub.test.ts)
git add packages/cli
git commit -m "feat(cli): live-turn digest coalesces subagent.token per child invocation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `@b4run/testing` reads the new child shapes

**Files:**
- Modify: `packages/testing/src/run-result.ts` (`case "subagent.tool_call"` ~line 419)
- Modify: `packages/testing/test/run-result.test.ts` (~lines 86-150), `packages/testing/test/matchers.test.ts` (~line 117)

- [x] **Step 1: Update fixtures**: in both tests change `tool: "webSearch"` → `name: "webSearch"`, and `{ type: "subagent.message", data: { ...child, chunk: "Inspecting" } }` → `{ type: "subagent.token", data: { ...child, data: "Inspecting", messageId: "child-model" } }` (and the matching `subagentEvents` expectation). Add to `run-result.test.ts`'s subagent test: `expect(r.subagents[0]?.toolCalls).toEqual([{ name: "webSearch", args: { q: "x" } }])` stays true only once the source reads `name`.

- [x] **Step 2: Run to verify failure**, **Step 3: implement**: in `run-result.ts` `case "subagent.tool_call"` read `String(d.name ?? "")`. Nothing else in the harness reads `subagent.message`.

- [x] **Step 4: Run, format, commit**

```bash
pnpm --filter @b4run/testing exec vitest run
(cd packages/testing && pnpm exec biome check --write --config-path ../config-biome/biome.json src/run-result.ts test/run-result.test.ts test/matchers.test.ts)
git add packages/testing
git commit -m "fix(testing): subagent tool calls are keyed by name; child text is subagent.token

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `@b4run/ag-ui` follows the two renamed inputs

**Files:**
- Modify: `packages/ag-ui/src/activities.ts` (`B4ActivityChunkType`, `isB4ActivityChunkType`, the `subagent.tool_call` branch reading `"tool"`)
- Modify: `packages/ag-ui/test/activities.test.ts` (~lines 38-54 list, and every `tool:` fixture), `packages/ag-ui/test/outbound.test.ts`, `packages/ag-ui/test/conformance.test.ts` (`CANNED`'s child chunks: `tool: "readDoc"` → `name`, `subagent.message { content }` → `subagent.token { data, messageId }`)

- [x] **Step 1: Update the tests** to the new shapes (`subagent.message` → `subagent.token`; `tool` → `name`). The list test at ~line 38 names the accepted chunk types: replace `"subagent.message"` with `"subagent.token"` and add `"subagent.message_end"`, `"subagent.reasoning"`, `"subagent.tool_call_args"` as **recognized-and-consumed** (they must be swallowed by the activity boundary exactly as `subagent.message` was — the privacy rule "no raw child stream" still holds until 3b).

- [x] **Step 2: Run to verify failure**, **Step 3: implement**: in `activities.ts` the union and `isB4ActivityChunkType` gain `"subagent.token" | "subagent.message_end" | "subagent.reasoning" | "subagent.tool_call_args"` and lose `"subagent.message"`; the projector returns `projectEvent(null)` for the three new consumed types (as it did for `subagent.message`); the `subagent.tool_call` branch reads `readTrimmedNonemptyString(data, "name")`. Keep `"subagent.usage"` **out** of this list (it is routed to the usage collector by `outbound.ts`, PR 1).

- [x] **Step 4: Run, format, commit**

```bash
pnpm --filter @b4run/ag-ui exec vitest run
(cd packages/ag-ui && pnpm exec biome check --write --config-path ../config-biome/biome.json src/activities.ts test/activities.test.ts test/outbound.test.ts test/conformance.test.ts)
git add packages/ag-ui
git commit -m "fix(ag-ui): consume the child's root-shaped chunks at the activity boundary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Docs, upgrading entry, changeset

**Files:**
- Modify: `apps/web/content/docs/recipes/stream-output.mdx` (table ~lines 88-92 and the `default:` comment ~line 69), `apps/web/content/docs/subagents.mdx` (~lines 203-214), `apps/web/content/docs/ag-ui.mdx` (outbound table row for `subagent.start` …), `apps/web/content/docs/upgrading.mdx`
- Create: `.changeset/agui-subagent-stream.md`

- [x] **Step 1: stream-output.mdx** — replace the five `subagent.*` rows with:

```md
| `subagent.start` | `{ call_id, parent_call_id?, subagent, route_id, depth, description? }` | A subagent started. `parent_call_id` names the call that dispatched it when the parent is itself a subagent. |
| `subagent.token` | `{ call_id, …identity, data, messageId }` | Text from the child, framed like root `chunk`s: `messageId` is the child's model invocation. |
| `subagent.reasoning` | `{ call_id, …identity, data, messageId }` | The child's visible reasoning, when its route streams it. |
| `subagent.message_end` | `{ call_id, …identity, messageId }` | The child's invocation ended. |
| `subagent.tool_call` | `{ call_id, …identity, id, name, input }` | Tool call inside a subagent, under the model's tool-call id. |
| `subagent.tool_call_args` | `{ call_id, …identity, id, name, delta }` | Streamed arguments for that call, display only. |
| `subagent.tool_result` | `{ call_id, …identity, id, name, output }` | The result, under the same id. |
| `subagent.usage` | `{ call_id, …identity, provider?, model?, usage_metadata }` | One child model call's token counts. |
| `subagent.end` | `{ call_id, …identity, final_message?, error? }` | Subagent finished or failed. |
```

and fix the `default:` comment list. `…identity` is `subagent, route_id, depth` — say so once above the table.

- [x] **Step 2: subagents.mdx** — the bullet list becomes `subagent.start`, `subagent.token` / `subagent.reasoning` / `subagent.message_end`, `subagent.tool_call` / `subagent.tool_call_args` / `subagent.tool_result`, `subagent.usage`, capability events such as `subagent.plan_update`, `subagent.end`; the paragraph after it: "`subagent.start` also includes the subagent name, route id, depth, its declared description, and — for a nested child — `parent_call_id`." and "While a child runs, its tokens arrive as `subagent.token` with the child's `messageId`, and B4.run drops the duplicate parent message chunks. Child tool calls carry the model's tool-call id, the same id their results carry."

- [x] **Step 3: ag-ui.mdx** — the outbound row `| \`subagent.start\` and matching child plan/tool/result/end chunks | … |` becomes `| \`subagent.start\` and matching child \`token\`/\`reasoning\`/\`message_end\`/\`tool_call\`/\`tool_call_args\`/\`tool_result\`/\`plan_update\`/\`end\` chunks | replacement \`ACTIVITY_SNAPSHOT\` with activity type \`b4.subagent\` (the child stream itself is consumed; AG-UI 1.0 \`SUBAGENT_*\` lifecycle and attribution follow in the next release) |`.

- [x] **Step 4: upgrading.mdx** — first entry under "Changes by version":

```md
### Subagent stream events carry the root shapes

Landed in the first release after **0.13.1**. Action required only if you read `subagent.*` events off `/runs/stream` or the attach digest.

`subagent.message { call_id, chunk }` is now `subagent.token { call_id, …identity, data, messageId }`, and `subagent.tool_call` / `subagent.tool_result` carry `name` (not `tool`) under the model's tool-call `id` (not the execution run id). New: `subagent.reasoning`, `subagent.message_end`, `subagent.tool_call_args`, and `parent_call_id` / `description` on `subagent.start`. `@b4run/testing`'s `RunResult.subagents` reads the new shapes. See [Streaming output](/docs/recipes/stream-output#sse-event-types).
```

- [x] **Step 5: Changeset** `.changeset/agui-subagent-stream.md`:

```md
---
"@b4run/langchain": patch
"@b4run/cli": patch
"@b4run/testing": patch
"@b4run/ag-ui": patch
---

**Breaking (Agent Protocol stream):** a subagent's events now carry the same shapes as the root's. `subagent.message { chunk }` is replaced by `subagent.token { data, messageId }`; `subagent.tool_call` / `subagent.tool_result` carry `name` under the model's tool-call `id` instead of `tool` under an execution run id; new `subagent.reasoning`, `subagent.message_end` and `subagent.tool_call_args`; `subagent.start` gains `parent_call_id` (nested children) and `description`. The langchain adapter announces a child's tool calls from its own model turn with the same per-owner bookkeeping root uses, the dev server's attach digest coalesces `subagent.token` per child invocation, `@b4run/testing` reads the new shapes, and `@b4run/ag-ui` consumes them at the activity boundary unchanged on the wire (the AG-UI `SUBAGENT_*` presentation follows in the next release).
```

- [x] **Step 6: Commit, lastmod, gates**

```bash
git add apps/web/content .changeset/agui-subagent-stream.md
git commit -m "docs: subagent stream events carry the root shapes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod && git add apps/web/app/seo/lastmod.generated.json && git commit -m "chore(web): regenerate SEO lastmod manifest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm build && node scripts/check-docs.mjs && node scripts/check-changesets.mjs && pnpm --filter @b4run/web test
```

---

### Task 7: Validation and PR

- [x] `pnpm --filter @b4run/langchain --filter @b4run/cli --filter @b4run/testing --filter @b4run/ag-ui typecheck` and `test`; `pnpm --filter @b4-example/chat-server test`; `pnpm lint`.
- [x] `pnpm ci:validate` in the background (kill orphans first if a previous run was killed). The known contention flakes: `sandbox/bounded-filesystem`, `cli/vercel-target`, `cli/cli.test` 5s/30s timeouts — confirm in isolation before dismissing.
- [x] Rebase onto `main` once #910 merges (`git rebase --onto origin/main <pr2-tip>`), rebuild, re-run the four packages' tests.
- [x] Push `blove/agui-subagent-stream`, open the PR (title `feat!: subagent stream events carry the root shapes (AG-UI 1.0 sub-project 2, PR 3a)`, body from this plan's header + the changeset), bind it, enable squash auto-merge if the user asked for merge-on-green.

---

## Self-review

- **Spec coverage (§2.1 table, §5.1 start fields):** `subagent.start` extras → Task 1; `subagent.token/message_end/reasoning/tool_call/tool_call_args/tool_result/usage` with root-identical `data` + identity → Task 2 (`wrapChild`); logical ids from the child's `on_chat_model_end` → Task 2; per-owner `RootToolProjectionState` → Task 2; `subagent.message` removed → Task 2; consumers (`live-turn-hub`, `@b4run/testing`, the activity projector) → Tasks 3-5; wire docs → Task 6. §5.1 lifecycle/attribution, §5.3 removals, §5.4 `multiAgent`, §6 React/examples are **3b**.
- **Placeholders:** Task 1 Step 1 asks the engineer to copy the file's own resolver fake (the exact helper varies); the assertion is fully specified. Everything else carries code.
- **Type consistency:** `ToolProjectionState` fields (`heldToolStarts`, `pendingToolErrors`) are renamed consistently in Task 2; `wrapChild(child, chunk)` and `toolStateFor(owners, child)` are used as defined; `subagent.token` data `{ …identity, data, messageId }` matches Tasks 2-6 and the live-turn test.
