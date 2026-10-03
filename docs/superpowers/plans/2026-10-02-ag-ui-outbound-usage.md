# AG-UI outbound usage (`usage: TokenUsage[]`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every AG-UI terminal event (`RUN_FINISHED` in all three outcomes, `RUN_ERROR`) carries `usage: TokenUsage[]` aggregated from the LangChain `usage_metadata` of every model call the run made, root and subagent alike — and omits the key when nothing was reported.

**Architecture:** The langchain agent adapter emits one `usage` stream chunk per `on_chat_model_end` carrying `{ provider?, model?, usage_metadata }` (labels from LangChain's standard `ls_provider`/`ls_model_name` run metadata). `toAguiEvents` maps each through `@ag-ui/core`'s `tokenUsageFromLangChainMetadata`, keeps the array, and attaches `aggregateTokenUsage(entries)` to whichever terminal event ends the run. Other stream consumers (Agent Protocol SSE, `after` middleware, `@b4run/testing`) already pass unknown chunk types through untouched.

**Tech Stack:** TypeScript (NodeNext ESM; `src/` imports `.js`, `test/` imports `.ts`), vitest, `@ag-ui/core` 1.0.1, `@langchain/core` 1.2.12 `streamEvents` v2.

Spec: `docs/superpowers/specs/2026-10-02-ag-ui-1-0-outbound-richness-design.md` §2.1, §3, §9 (PR 1). This is PR 1 of 4; it is independent of the others.

Conventions (from `AGENTS.md`): run everything from the repo root with Node 24 (`nvm use 24`); never bare `biome check --write` — use `pnpm lint:fix`; `exactOptionalPropertyTypes` is on, so never assign `{ x: undefined }` — use a conditional spread; changesets are `patch`.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/langchain/src/agent-adapter.ts` | **Modify.** `classifyStreamEvent`'s `on_chat_model_end` case emits a `usage` chunk (root and child) before its existing root-only work. Add `readUsageChunk(event)` helper next to `chunkText`. |
| `packages/langchain/test/agent-adapter.test.ts` | **Modify.** New `describe("usage chunks")` with `streamEvents` fixtures. |
| `packages/ag-ui/src/types.ts` | **Modify.** Add the `usage` member to `B4AgentStreamChunk` and `asUsageData()`. |
| `packages/ag-ui/src/usage.ts` | **Create.** `createUsageCollector()` — wraps `tokenUsageFromLangChainMetadata` + `aggregateTokenUsage`; returns the `usage` spread for a terminal event. |
| `packages/ag-ui/src/outbound.ts` | **Modify.** Collect `usage` chunks; spread `...usage.terminal()` into every `RUN_FINISHED`/`RUN_ERROR` literal. |
| `packages/ag-ui/test/usage.test.ts` | **Create.** Unit tests for the collector. |
| `packages/ag-ui/test/outbound.test.ts` | **Modify.** `describe("usage")`: presence on each terminal, omission, children, cancelled, error. |
| `packages/ag-ui/test/conformance.test.ts` | **Modify.** `CANNED` gains `usage` chunks; the full-turn test asserts `usage` on `RUN_FINISHED`; the error and cancelled tests assert it too. |
| `apps/web/content/docs/ag-ui.mdx` | **Modify.** Outbound table rows for `usage`; one paragraph under a new `### Token usage` heading. |
| `apps/web/app/seo/lastmod.generated.json` | **Regenerate** after the docs commit. |
| `.changeset/agui-usage.md` | **Create.** `patch` for `@b4run/ag-ui` and `@b4run/langchain`. |

---

### Task 1: Adapter emits a `usage` chunk per model call

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts` (near `chunkText`, ~line 700; and `case "on_chat_model_end"`, ~line 767)
- Test: `packages/langchain/test/agent-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/langchain/test/agent-adapter.test.ts` (after the `"logical-identity root tool projection"` describe, before EOF):

```ts
describe("usage chunks", () => {
  function streamOf(events: readonly Record<string, unknown>[]) {
    return {
      invoke: vi.fn(),
      async *streamEvents() {
        yield* events
      },
    }
  }

  async function collect(entry: { invoke: unknown; streamEvents: unknown }) {
    const chunks = []
    for await (const chunk of streamAgent({
      checkpointer: new MemorySaver(),
      entry: entry as never,
      input: { question: "hi" },
      routeParamNames: [],
      signal: new AbortController().signal,
      tools: [],
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  const USAGE = {
    input_tokens: 120,
    output_tokens: 30,
    total_tokens: 150,
    input_token_details: { cache_read: 100 },
    output_token_details: { reasoning: 10 },
  }

  test("one usage chunk per on_chat_model_end, labelled from ls_provider/ls_model_name", async () => {
    const entry = streamOf([
      {
        event: "on_chat_model_end",
        run_id: "model-1",
        name: "ChatOpenAI",
        metadata: { ls_provider: "OpenAI", ls_model_name: "gpt-5-mini" },
        data: { output: { content: "hi", usage_metadata: USAGE } },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } },
    ])
    const chunks = await collect(entry)
    expect(chunks.filter((c) => c.type === "usage")).toEqual([
      {
        type: "usage",
        data: { provider: "openai", model: "gpt-5-mini", usage_metadata: USAGE },
      },
    ])
  })

  test("a model call without usage_metadata emits no usage chunk", async () => {
    const entry = streamOf([
      {
        event: "on_chat_model_end",
        run_id: "model-1",
        name: "ChatOpenAI",
        metadata: { ls_provider: "OpenAI", ls_model_name: "gpt-5-mini" },
        data: { output: { content: "hi" } },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } },
    ])
    const chunks = await collect(entry)
    expect(chunks.some((c) => c.type === "usage")).toBe(false)
  })

  test("labels are omitted when LangChain metadata lacks them", async () => {
    const entry = streamOf([
      {
        event: "on_chat_model_end",
        run_id: "model-1",
        name: "model",
        data: { output: { content: "hi", usage_metadata: { input_tokens: 1, output_tokens: 1 } } },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } },
    ])
    const chunks = await collect(entry)
    expect(chunks.filter((c) => c.type === "usage")).toEqual([
      { type: "usage", data: { usage_metadata: { input_tokens: 1, output_tokens: 1 } } },
    ])
  })

  test("a subagent's model call is reported as subagent.usage with its identity", async () => {
    const child = {
      b4: {
        subagent_stack: [{ callId: "c1", name: "researcher", routeId: "/research#researcher" }],
      },
    }
    const entry = streamOf([
      {
        event: "on_chat_model_end",
        run_id: "child-model-1",
        name: "ChatOpenAI",
        metadata: { ...child, ls_provider: "OpenAI", ls_model_name: "gpt-5-nano" },
        data: { output: { content: "child", usage_metadata: { input_tokens: 5, output_tokens: 2 } } },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } },
    ])
    const chunks = await collect(entry)
    expect(chunks.filter((c) => c.type === "subagent.usage")).toEqual([
      {
        type: "subagent.usage",
        data: {
          call_id: "c1",
          subagent: "researcher",
          route_id: "/research#researcher",
          depth: 1,
          provider: "openai",
          model: "gpt-5-nano",
          usage_metadata: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/langchain exec vitest run test/agent-adapter.test.ts -t "usage chunks"`
Expected: 4 failures — `expected [] to deeply equal [...]` / `expected false to be true`-style; no `usage` chunk is produced today.

- [ ] **Step 3: Implement the helper and the emission**

In `packages/langchain/src/agent-adapter.ts`, directly after `function chunkText(...)` (ends ~line 711), add:

```ts
/**
 * The `usage` chunk for one finished model call, or `undefined` when the
 * provider reported nothing. Labels come from LangChain's standard run
 * metadata (`ls_provider` is the chat-model class name minus `Chat`, so it is
 * lower-cased to match B4.run's provider ids); the counts travel as the
 * provider's own `usage_metadata`, untouched — the AG-UI mapper applies the
 * protocol's accounting rules, and other transports pass the chunk through.
 */
function readUsageChunk(event: LangChainStreamEvent): Record<string, unknown> | undefined {
  const output = event.data.output
  if (!isRecord(output) || !isRecord(output.usage_metadata)) return undefined
  const provider = event.metadata?.ls_provider
  const model = event.metadata?.ls_model_name
  return {
    ...(typeof provider === "string" && provider !== ""
      ? { provider: provider.toLowerCase() }
      : {}),
    ...(typeof model === "string" && model !== "" ? { model } : {}),
    usage_metadata: output.usage_metadata,
  }
}
```

Then change the start of `case "on_chat_model_end":` from

```ts
    case "on_chat_model_end": {
      if (child) break
      const output = event.data.output as { tool_calls?: unknown } | undefined
      const calls = Array.isArray(output?.tool_calls) ? output.tool_calls : []
      const chunks: AgentStreamChunk[] = flushToolCallFragments(rootTools, event.run_id)
```

to

```ts
    case "on_chat_model_end": {
      const usage = readUsageChunk(event)
      if (child) {
        if (usage === undefined) break
        return {
          capturesFinalOutput: false,
          child,
          chunks: [{ type: "subagent.usage", data: { ...usage, ...childIdentity(child) } }],
          finalOutput: undefined,
          interrupts: [],
        }
      }
      const output = event.data.output as { tool_calls?: unknown } | undefined
      const calls = Array.isArray(output?.tool_calls) ? output.tool_calls : []
      const chunks: AgentStreamChunk[] = flushToolCallFragments(rootTools, event.run_id)
      if (usage !== undefined) chunks.push({ type: "usage", data: usage })
```

(The rest of the case — `message_end`, the tool-call announces, the `if (chunks.length === 0) break` — is unchanged. Note `childIdentity(child)` spreads last so the identity keys can never be shadowed by provider data.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @b4run/langchain exec vitest run test/agent-adapter.test.ts`
Expected: all tests in the file PASS (the pre-existing `on_chat_model_end` fixtures have no `usage_metadata`, so they are unaffected).

- [ ] **Step 5: Lint and commit**

```bash
pnpm lint:fix
git add packages/langchain/src/agent-adapter.ts packages/langchain/test/agent-adapter.test.ts
git commit -m "feat(langchain): emit a usage chunk per model call, root and subagent

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `usage` chunk type and the collector in `@b4run/ag-ui`

**Files:**
- Modify: `packages/ag-ui/src/types.ts`
- Create: `packages/ag-ui/src/usage.ts`
- Test: `packages/ag-ui/test/usage.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/ag-ui/test/usage.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { asUsageData } from "../src/types.ts"
import { createUsageCollector } from "../src/usage.ts"

describe("asUsageData", () => {
  test("narrows a well-formed payload and drops bad labels", () => {
    expect(
      asUsageData({ provider: "openai", model: "gpt-5-mini", usage_metadata: { input_tokens: 1 } }),
    ).toEqual({ provider: "openai", model: "gpt-5-mini", usage_metadata: { input_tokens: 1 } })
    expect(asUsageData({ provider: 7, usage_metadata: { input_tokens: 1 } })).toEqual({
      usage_metadata: { input_tokens: 1 },
    })
  })

  test("rejects a payload without an object usage_metadata", () => {
    expect(asUsageData({ provider: "openai" })).toBeNull()
    expect(asUsageData({ usage_metadata: "lots" })).toBeNull()
    expect(asUsageData(null)).toBeNull()
  })
})

describe("createUsageCollector", () => {
  test("is empty until something usable arrives: terminal() spreads to nothing", () => {
    const usage = createUsageCollector()
    expect(usage.terminal()).toEqual({})
    usage.add({ usage_metadata: { not_a_count: "x" } })
    expect(usage.terminal()).toEqual({})
  })

  test("maps LangChain accounting through and aggregates per provider+model", () => {
    const usage = createUsageCollector()
    usage.add({
      provider: "openai",
      model: "gpt-5-mini",
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_token_details: { cache_read: 80 },
        output_token_details: { reasoning: 5 },
      },
    })
    usage.add({
      provider: "openai",
      model: "gpt-5-mini",
      usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    })
    usage.add({
      provider: "openai",
      model: "gpt-5-nano",
      usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    expect(usage.terminal()).toEqual({
      usage: [
        {
          provider: "openai",
          model: "gpt-5-mini",
          inputTokens: 110,
          outputTokens: 22,
          totalTokens: 132,
          cachedInputTokens: 80,
          reasoningTokens: 5,
        },
        { provider: "openai", model: "gpt-5-nano", inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      ],
    })
  })

  test("keeps unlabelled entries, and never reports a count nobody returned", () => {
    const usage = createUsageCollector()
    usage.add({ usage_metadata: { input_tokens: 3, output_tokens: 4 } })
    const { usage: entries } = usage.terminal()
    expect(entries).toHaveLength(1)
    expect(entries?.[0]).toMatchObject({ inputTokens: 3, outputTokens: 4 })
    expect(entries?.[0]).not.toHaveProperty("provider")
    expect(entries?.[0]?.totalTokens).toBeUndefined()
    expect(entries?.[0]?.reasoningTokens).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/usage.test.ts`
Expected: FAIL — `Cannot find module '../src/usage.ts'` / `asUsageData is not exported`.

- [ ] **Step 3: Add the chunk type and narrowing to `types.ts`**

In `packages/ag-ui/src/types.ts`, add a union member to `B4AgentStreamChunk` after the `tool_result` member:

```ts
  | { readonly type: "usage"; readonly data: B4UsageData }
```

Add after `B4ToolResultData`:

```ts
/**
 * One finished model call's token accounting, as the langchain adapter reports
 * it: the provider's own LangChain `usage_metadata` plus optional labels. The
 * mapper applies the protocol's rules; this package never invents a count.
 */
export interface B4UsageData {
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly usage_metadata: Readonly<Record<string, unknown>>
}
```

And after `asToolResultData`:

```ts
/** Validates and narrows a `usage` chunk's `data`. Returns null if malformed. */
export function asUsageData(data: unknown): B4UsageData | null {
  if (!isRecord(data) || !isRecord(data.usage_metadata)) return null
  return {
    ...(typeof data.provider === "string" && data.provider !== ""
      ? { provider: data.provider }
      : {}),
    ...(typeof data.model === "string" && data.model !== "" ? { model: data.model } : {}),
    usage_metadata: data.usage_metadata,
  }
}
```

- [ ] **Step 4: Create the collector**

Create `packages/ag-ui/src/usage.ts`:

```ts
import { aggregateTokenUsage, type TokenUsage, tokenUsageFromLangChainMetadata } from "@ag-ui/core"
import type { B4UsageData } from "./types.js"

export interface UsageCollector {
  /** Record one model call. Payloads with no usable count are ignored. */
  add(data: B4UsageData): void
  /**
   * The `usage` key for a terminal event: one entry per provider+model, or
   * nothing at all when no call reported a count (the key is then absent,
   * never `[]`). Spread it into `RUN_FINISHED` / `RUN_ERROR`.
   */
  terminal(): { usage?: TokenUsage[] }
}

/**
 * Run-scoped token usage, collected per model call so a run that fails or is
 * cancelled can still report what it accrued. `tokenUsageFromLangChainMetadata`
 * encodes the protocol's rule that LangChain's `input_tokens`/`output_tokens`
 * already include the cache and reasoning details, and returns `undefined`
 * rather than zeros for a call that reported nothing.
 */
export function createUsageCollector(): UsageCollector {
  const entries: TokenUsage[] = []
  return {
    add(data) {
      const entry = tokenUsageFromLangChainMetadata(data.usage_metadata, {
        ...(data.provider !== undefined ? { provider: data.provider } : {}),
        ...(data.model !== undefined ? { model: data.model } : {}),
      })
      if (entry !== undefined) entries.push(entry)
    },
    terminal() {
      return entries.length > 0 ? { usage: aggregateTokenUsage(entries) } : {}
    },
  }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/usage.test.ts test/types.test.ts`
Expected: PASS. If the aggregation test's expected object differs only in key order or in an extra `undefined`-valued key, the assertion still passes (`toEqual` ignores `undefined` properties); if a *value* differs, read `node_modules/@ag-ui/core/dist/index.d.ts` `tokenUsageFromLangChainMetadata` and fix the fixture, not the collector.

- [ ] **Step 6: Export and commit**

In `packages/ag-ui/src/index.ts` add `B4UsageData` to the `types.js` export line:

```ts
export type { B4AgentStreamChunk, B4UsageData, RunContext } from "./types.js"
```

Run `pnpm --filter @b4run/ag-ui exec vitest run test/public-api.test.ts`; if it pins the export list, add `B4UsageData` to its expectation (type-only exports usually aren't pinned — check the failure message).

```bash
pnpm lint:fix
git add packages/ag-ui/src/types.ts packages/ag-ui/src/usage.ts packages/ag-ui/src/index.ts packages/ag-ui/test/usage.test.ts packages/ag-ui/test/public-api.test.ts
git commit -m "feat(ag-ui): usage chunk type and run-scoped TokenUsage collector

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `toAguiEvents` attaches `usage` to every terminal event

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts`
- Test: `packages/ag-ui/test/outbound.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/ag-ui/test/outbound.test.ts` (it already has `collect`, `toAsync`, `CTX`, `CHILD`):

```ts
describe("usage", () => {
  const CALL = {
    provider: "openai",
    model: "gpt-5-mini",
    usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }
  const ONE = { provider: "openai", model: "gpt-5-mini", inputTokens: 10, outputTokens: 5, totalTokens: 15 }
  const TWO = { ...ONE, inputTokens: 20, outputTokens: 10, totalTokens: 30 }

  test("RUN_FINISHED success aggregates root and child calls", async () => {
    const out = await collect([
      { type: "usage", data: CALL },
      { type: "subagent.usage", data: { ...CHILD, ...CALL } },
      { type: "done", data: { ok: true } },
    ])
    expect(out.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: CTX.threadId,
      runId: CTX.runId,
      result: { ok: true },
      outcome: { type: "success" },
      usage: [TWO],
    })
  })

  test("the key is absent, never [], when no call reported usage", async () => {
    const out = await collect([{ type: "token", data: "hi" }, { type: "done" }])
    expect(out.at(-1)).not.toHaveProperty("usage")
  })

  test("a malformed usage payload is ignored", async () => {
    const out = await collect([
      { type: "usage", data: { provider: "openai" } },
      { type: "usage", data: { usage_metadata: { nothing: true } } },
      { type: "done" },
    ])
    expect(out.at(-1)).not.toHaveProperty("usage")
  })

  test("RUN_FINISHED interrupt carries usage", async () => {
    const out = await collect([
      { type: "usage", data: CALL },
      { type: "interrupt", data: { interruptId: "i-1", kind: "tool", callId: "tc-9" } },
      { type: "done" },
    ])
    expect(out.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "interrupt" },
      usage: [ONE],
    })
  })

  test("RUN_FINISHED cancelled carries the usage accrued before the stop", async () => {
    async function* stream(): AsyncIterable<B4AgentStreamChunk> {
      yield { type: "usage", data: CALL }
      throw new Error("aborted")
    }
    const out = []
    for await (const ev of toAguiEvents(stream(), CTX, {
      idFactory: createCounterIdFactory(),
      cancelled: () => true,
    })) {
      out.push(ev)
    }
    expect(out.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: CTX.threadId,
      runId: CTX.runId,
      outcome: { type: "cancelled" },
      usage: [ONE],
    })
  })

  test("RUN_ERROR carries the usage accrued before the failure", async () => {
    async function* stream(): AsyncIterable<B4AgentStreamChunk> {
      yield { type: "usage", data: CALL }
      throw new Error("boom")
    }
    const out = []
    for await (const ev of toAguiEvents(stream(), CTX, { idFactory: createCounterIdFactory() })) {
      out.push(ev)
    }
    expect(out.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: "boom", usage: [ONE] })
  })

  test("a stream that ends without done still reports usage", async () => {
    const out = await collect([{ type: "usage", data: CALL }])
    expect(out.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, usage: [ONE] })
  })

  test("usage chunks never open or close a text message", async () => {
    const out = await collect([
      { type: "token", data: "a" },
      { type: "usage", data: CALL },
      { type: "token", data: "b" },
      { type: "done" },
    ])
    expect(out.filter((e) => e.type === EventType.TEXT_MESSAGE_START)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/outbound.test.ts -t "usage"`
Expected: FAIL — terminal events lack `usage`; the "never open or close" test fails because the `default:` branch flushes text on an unknown chunk (two `TEXT_MESSAGE_START`s).

- [ ] **Step 3: Wire the collector into `toAguiEvents`**

In `packages/ag-ui/src/outbound.ts`:

Imports — extend the `./types.js` import and add the collector:

```ts
import {
  asToolCallArgsData,
  asToolCallData,
  asToolResultData,
  asUsageData,
  type B4AgentStreamChunk,
  type RunContext,
} from "./types.js"
import { createUsageCollector } from "./usage.js"
```

State — after `const ledger = createOrchestrationLedger()`:

```ts
  const usage = createUsageCollector()
```

Chunk handling — add a case to the `switch (chunk.type)` **before** `case "interrupt":`. The `subagent.usage` spelling is accepted here now (a child's call is part of this run's usage, spec §3) so PR 3's child-owner plumbing has nothing to add for usage:

```ts
        case "usage":
        case "subagent.usage": {
          const data = asUsageData(chunk.data)
          if (data) usage.add(data)
          break
        }
```

`subagent.usage` currently reaches the activity projector first (`isB4ActivityChunkType` is a closed list, so it does **not** match — verify by reading `activities.ts`'s switch; `subagent.usage` is not in it, so it falls through to this `switch`). Good; no change needed there.

Terminal events — add `...usage.terminal(),` to **all six** terminal literals (search for `type: EventType.RUN_FINISHED` and `type: EventType.RUN_ERROR`; there are four `RUN_FINISHED` and two `RUN_ERROR`):

1. Pending-interrupt `done` path:
```ts
          yield {
            type: EventType.RUN_FINISHED,
            threadId: ctx.threadId,
            runId: ctx.runId,
            outcome: { type: "interrupt", interrupts: pendingInterrupts },
            ...usage.terminal(),
          }
```
2. Malformed interrupt `RUN_ERROR`:
```ts
            yield {
              type: EventType.RUN_ERROR,
              message: "Malformed B4.run interrupt: missing interruptId",
              ...usage.terminal(),
            }
```
3. `case "done"` success:
```ts
            outcome: successOutcome(),
            ...usage.terminal(),
          }
```
4. Stream-ended-without-done, interrupt branch and success branch — add `...usage.terminal(),` after `outcome:` in both.
5. `catch` cancelled branch — add after `outcome: { type: "cancelled" },`.
6. `catch` `RUN_ERROR`:
```ts
    yield {
      type: EventType.RUN_ERROR,
      message: err instanceof Error ? err.message : String(err),
      ...(code !== undefined ? { code } : {}),
      ...usage.terminal(),
    }
```

Also widen `AguiOutboundEvent` is unnecessary: `RunFinishedEvent`/`RunErrorEvent` from `@ag-ui/core` 1.0.1 already declare `usage?: TokenUsage[]` — confirm with `grep -n "usage" node_modules/@ag-ui/core/dist/*.d.ts` from `packages/ag-ui`; if the typecheck complains, the `TokenUsage` import in `usage.ts` is the only type you need.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/outbound.test.ts`
Expected: PASS, including every pre-existing test (the `default:` branch is unchanged for other unknown chunks, so the "unknown chunks flush text" behaviour others pin still holds).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm --filter @b4run/ag-ui typecheck
pnpm lint:fix
git add packages/ag-ui/src/outbound.ts packages/ag-ui/test/outbound.test.ts
git commit -m "feat(ag-ui): usage: TokenUsage[] on every RUN_FINISHED and RUN_ERROR

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Conformance — the real 1.0 client accepts `usage`

**Files:**
- Modify: `packages/ag-ui/test/conformance.test.ts`

- [ ] **Step 1: Extend the canned run and the assertions**

In `CANNED`, insert after the first `token` chunk (`{ type: "token", data: "Researching" }`):

```ts
  {
    type: "usage",
    data: {
      provider: "openai",
      model: "gpt-5-mini",
      usage_metadata: { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
    },
  },
```

and after `{ type: "subagent.start", data: childIdentity }`:

```ts
  {
    type: "subagent.usage",
    data: {
      ...childIdentity,
      provider: "openai",
      model: "gpt-5-nano",
      usage_metadata: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    },
  },
```

In `"a full turn passes 1.0 enforcement with nothing stripped"`, replace the final line `expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED)` with:

```ts
  expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED)
  expect(events[events.length - 1]).toMatchObject({
    usage: [
      { provider: "openai", model: "gpt-5-mini", inputTokens: 40, outputTokens: 12, totalTokens: 52 },
      { provider: "openai", model: "gpt-5-nano", inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    ],
  })
```

In `"a cancelled run ends with the cancelled outcome and no RUN_ERROR"`, change the generator to yield usage first and assert it:

```ts
  async function* abortedAfterOneToken(): AsyncIterable<B4AgentStreamChunk> {
    yield {
      type: "usage",
      data: { provider: "openai", model: "gpt-5-mini", usage_metadata: { input_tokens: 4, output_tokens: 1 } },
    }
    yield { type: "token", data: "partial" }
    throw new Error("AG-UI request aborted")
  }
```
and extend the final `toMatchObject` with `usage: [{ provider: "openai", model: "gpt-5-mini", inputTokens: 4, outputTokens: 1 }]`.

In `"an upstream error is RUN_ERROR with its code intact"`, change `failing` to yield usage before throwing (remove the `biome-ignore useYield` comment since it now yields):

```ts
  async function* failing(): AsyncIterable<B4AgentStreamChunk> {
    yield { type: "usage", data: { usage_metadata: { input_tokens: 2, output_tokens: 0 } } }
    throw Object.assign(new Error("after rejected"), { code: "after_rejected" })
  }
```
and extend its `toMatchObject` with `usage: [{ inputTokens: 2, outputTokens: 0 }]`.

- [ ] **Step 2: Run the conformance suite**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/conformance.test.ts`
Expected: PASS with zero `console.warn` — `usage` is schema-defined on both terminal events, so the 1.0 `enforce` stage strips nothing. If it fails with "stripped or translated", read the captured warning: it names the path that was removed, which means a key name is wrong.

- [ ] **Step 3: Commit**

```bash
pnpm lint:fix
git add packages/ag-ui/test/conformance.test.ts
git commit -m "test(ag-ui): conformance covers usage on success, cancelled and error terminals

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Docs, lastmod, changeset

**Files:**
- Modify: `apps/web/content/docs/ag-ui.mdx` (outbound table ~line 372; new section after `### Outbound events`' table)
- Regenerate: `apps/web/app/seo/lastmod.generated.json`
- Create: `.changeset/agui-usage.md`

- [ ] **Step 1: Docs**

In the `### Outbound events` table of `apps/web/content/docs/ag-ui.mdx`, add a row before the `interrupt` row:

```md
| `usage` (one per model call, root or subagent) | none on its own; aggregated into `usage` on the terminal event |
```

Immediately after the table (before `### Activity snapshots`), add:

```md
### Token usage

Every terminal event — `RUN_FINISHED` with a `success`, `interrupt` or `cancelled` outcome, and `RUN_ERROR` — carries `usage: TokenUsage[]` when at least one model call in the run reported token counts, and omits the key otherwise (never `[]`). There is one entry per provider and model, so a coordinator on `gpt-5-mini` with a subagent on `gpt-5-nano` reports two entries; sum them for a run total. Counts follow the protocol's accounting: `inputTokens` and `outputTokens` are inclusive totals, and `cachedInputTokens`, `cacheWriteInputTokens` and `reasoningTokens` are parts of them. A count the provider did not return is absent, not zero. A cancelled or failed run reports what it accrued before the stop; a resumed run reports only its own calls.

The same `usage` chunk reaches the Agent Protocol stream as `event: usage` with the provider's raw LangChain `usage_metadata`; it has no typed API there.
```

Then commit the content **before** regenerating lastmod (the generator dates a route by its newest commit):

```bash
git add apps/web/content/docs/ag-ui.mdx
git commit -m "docs(ag-ui): token usage on terminal events

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod manifest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Changeset**

Create `.changeset/agui-usage.md`:

```md
---
"@b4run/ag-ui": patch
"@b4run/langchain": patch
---

AG-UI terminal events now report token usage. `RUN_FINISHED` (every outcome) and `RUN_ERROR` carry `usage: TokenUsage[]` — one entry per provider and model, aggregated across the run including subagent calls, with the protocol's inclusive totals and no zeros for counts a provider did not return; the key is omitted when nothing was reported. The langchain agent adapter emits a `usage` stream chunk (`{ provider, model, usage_metadata }`, a `subagent.usage` for a child's call) per finished model call, which also reaches the Agent Protocol stream as `event: usage`.
```

```bash
git add .changeset/agui-usage.md
git commit -m "chore: changeset for AG-UI token usage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 3: Docs check**

Run: `node scripts/check-docs.mjs`
Expected: exit 0. (`ag-ui.mdx` has required-phrase pins in `scripts/check-docs.mjs` ~lines 1764 and 2823; adding text does not break them. If a `forbiddenContent` pattern trips, the message names the phrase — reword.)

---

### Task 6: Full validation and PR

- [ ] **Step 1: Build and run the affected packages' gates**

```bash
pnpm build
pnpm --filter @b4run/ag-ui --filter @b4run/langchain typecheck
pnpm --filter @b4run/ag-ui --filter @b4run/langchain --filter @b4run/cli --filter @b4run/testing test
```
Expected: all PASS. `@b4run/cli` and `@b4run/testing` are included because they consume the adapter's stream; a `usage` chunk must not change any of their assertions (their fixtures contain no `usage_metadata`, so none is emitted — if one does appear, a fixture had `usage_metadata` and the test's expected chunk list needs the new chunk added, not the emission removed).

- [ ] **Step 2: Repo gates**

```bash
pnpm lint
node scripts/check-changesets.mjs
pnpm ci:validate
```
Expected: exit 0 each. `ci:validate` is long (tens of minutes); run it in the background and read the tail.

- [ ] **Step 3: Branch, push, PR**

```bash
git checkout -b blove/agui-outbound-usage
git push -u origin blove/agui-outbound-usage
gh pr create --repo cacheplane/b4run --title "feat(ag-ui): usage: TokenUsage[] on RUN_FINISHED and RUN_ERROR (AG-UI 1.0 sub-project 2, PR 1)" --body "$(cat <<'EOF'
Part of #885 (AG-UI 1.0 sub-project 2, outbound richness). Spec: `docs/superpowers/specs/2026-10-02-ag-ui-1-0-outbound-richness-design.md` §3; plan: `docs/superpowers/plans/2026-10-02-ag-ui-outbound-usage.md`.

- The langchain agent adapter emits one `usage` chunk per finished model call (`{ provider, model, usage_metadata }`; `subagent.usage` for a child's call), labels from LangChain's `ls_provider`/`ls_model_name`.
- `toAguiEvents` collects them through `@ag-ui/core`'s `tokenUsageFromLangChainMetadata` and attaches `aggregateTokenUsage(entries)` as `usage` to every `RUN_FINISHED` outcome and to `RUN_ERROR`; the key is omitted when nothing was reported.
- Conformance (real 1.0 client, `console.warn` = failure) covers success, cancelled and error terminals.
- Docs: `/docs/ag-ui` outbound table + "Token usage" section.

No ACTIVITY_DELTA / STEP_* (deferred, spec §8). Reasoning and subagent lifecycle follow in PRs 2–4.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch `validate`; merge on green**

Bind the PR with the app's PR tools (`get_status` / `bind_pr`), read CI there. The merge signal is the required `validate` check (the advisory review check is not). On green: `gh pr merge --squash --repo cacheplane/b4run <number>`.

---

## Self-review

- **Spec coverage (§3):** collect per call → Task 1; aggregate via core helpers → Task 2; every terminal shape → Task 3 (six literals) + Task 4; child calls → Task 1 (`subagent.usage`) + Task 3; labels lower-cased/omitted → Task 1; SSE side effect documented → Task 5; no capability → nothing to do. §2.1 `usage` row → Tasks 1–2. §9 PR 1 → Task 6.
- **Placeholders:** none; every code step has the code.
- **Type consistency:** `B4UsageData` (types.ts) is what `asUsageData` returns and `UsageCollector.add` takes; `terminal()` returns `{ usage?: TokenUsage[] }` and is spread; `readUsageChunk` returns the shape `asUsageData` accepts (`provider`, `model`, `usage_metadata`).
