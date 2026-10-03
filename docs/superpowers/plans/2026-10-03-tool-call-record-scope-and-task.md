# Tool-Call Record: Recording Gate and `task` Call Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record server tool calls only when config says so (a route in `server.agui.clientTools` or a configured `server.agui.clientToolStore`), warn once about a leftover default store file, and record the parent `task` call through the same issue/settle discipline as every other tool.

**Architecture:** A boot-resolved `recordsServerCalls` flag on `ClientToolRuntime` decides whether the per-run recorder carries `issue`/`settle` (now optional on the SDK type). The issue/settle/park discipline moves out of the converter into one helper, `recordToolCall`, in `@b4run/langchain`; the converter and the subagent bridge both call it.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, LangChain/LangGraph, pnpm + Turbo, Node 24. Run from the repo root. Never bare `biome check --write`; format touched files only with `npx biome format --config-path ../config-biome/biome.json --write <files>` from inside the package.

**Spec:** `docs/superpowers/specs/2026-10-03-tool-call-record-scope-and-task-design.md`. **Branch:** `blove/tool-call-record-scope-and-task` (cut from main after #909).

**Conventions that bite:** `src/` imports use `.js`, tests import `../src/...js` or `.ts` as the file already does; `exactOptionalPropertyTypes` is on (conditional spreads, never `{ x: undefined }`); 2-space, no semicolons; sibling `dist/` must be built before cross-package tests (`pnpm build`).

---

## File map

| File | Change |
|---|---|
| `packages/sdk/src/client-tool-calls.ts` | `ClientToolRecorder.issue`/`settle` become optional, documented. |
| `packages/langchain/src/tool-call-recording.ts` | New: `recordToolCall` helper (reads the recorder, issue/body/settle, park guard). |
| `packages/langchain/test/tool-call-recording.test.ts` | New: helper unit tests. |
| `packages/langchain/src/tool-converter.ts` | Calls the helper; `readRecorder` and the inline discipline removed. |
| `packages/langchain/src/subagent-tool-bridge.ts` | Calls the helper around depth check + resolver + invoke. |
| `packages/langchain/test/subagent-tool-bridge.test.ts` | Recording cases. |
| `packages/cli/src/lib/dev/client-tool-runtime.ts` | `recordsServerCalls` on `ClientToolRuntime`; `resolveRecordsServerCalls(config)`. |
| `packages/cli/src/lib/dev/runtime-fetch-core.ts` | Resolve the flag; leftover-file warning. |
| `packages/cli/src/lib/dev/agui-handler.ts` | `issue`/`settle` on the recorder only when the flag is on; default literal gains the flag. |
| `packages/cli/test/agui-client-tools.test.ts` | Gate tests. |
| `apps/web/content/docs/ag-ui.mdx`, `configuration.mdx` | Rule, warning, no `task` exception. |
| `docs/superpowers/specs/2026-10-02-tool-call-record-generalization-design.md` | Two pointer notes. |
| `.changeset/tool-call-record-scope-and-task.md` | Patch: sdk, langchain, cli. |
| `apps/web/app/seo/lastmod.generated.json` | Regenerated after the docs commit. |

---

### Task 1: SDK — `issue` and `settle` become optional on the recorder

**Files:**
- Modify: `packages/sdk/src/client-tool-calls.ts` (the `ClientToolRecorder` interface, ~line 138)

- [ ] **Step 1: Change the interface**

Replace the two members:

```ts
  /**
   * Writes a server row for one of the server's own tool calls, before it
   * runs. Idempotent on the id. Absent when the runtime does not record
   * server calls (no route opted into client tools and no configured store);
   * a writer that finds it absent records nothing.
   */
  issue?(call: { readonly toolCallId: string; readonly toolName: string }): Promise<void>
  /** Stamps the server row once the tool returned or threw. Idempotent. Absent together with `issue`. */
  settle?(toolCallId: string): Promise<void>
```

Also update the interface's leading doc comment (the one naming both writers) to end with: "A recorder always carries `has`/`record`; it carries `issue`/`settle` only on runs that record server calls."

- [ ] **Step 2: Typecheck the SDK and its dependents' fakes**

Run: `pnpm --filter @b4run/sdk typecheck && pnpm --filter @b4run/sdk test`
Expected: clean; 151 tests pass. (Fakes in core/langchain/cli tests define both methods, which stays valid.)

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/client-tool-calls.ts
git commit -m "feat(sdk): a recorder carries issue/settle only when server calls are recorded

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: LangChain — the `recordToolCall` helper, and the converter uses it

**Files:**
- Create: `packages/langchain/src/tool-call-recording.ts`
- Create: `packages/langchain/test/tool-call-recording.test.ts`
- Modify: `packages/langchain/src/tool-converter.ts` (lines ~94–170: the recorder block, `try`/`catch`/`finally`; `readRecorder` at ~264; imports at 14 and 19)

- [ ] **Step 1: Write the failing helper tests**

`packages/langchain/test/tool-call-recording.test.ts`:

```ts
import { CLIENT_TOOL_RECORDER_KEY } from "@b4run/sdk"
import { GraphInterrupt } from "@langchain/langgraph"
import { describe, expect, it, vi } from "vitest"
import { recordToolCall } from "../src/tool-call-recording.js"

function recorder() {
  const log: string[] = []
  return {
    log,
    recorder: {
      has: vi.fn(async () => false),
      record: vi.fn(async () => {}),
      issue: async (call: { toolCallId: string; toolName: string }) => {
        log.push(`issue:${call.toolName}:${call.toolCallId}`)
      },
      settle: async (toolCallId: string) => {
        log.push(`settle:${toolCallId}`)
      },
    },
  }
}
const CALL = { toolCallId: "call_1", toolName: "probe" }
const configWith = (rec: unknown) => ({ configurable: { [CLIENT_TOOL_RECORDER_KEY]: rec } })

describe("recordToolCall", () => {
  it("issues before the body and settles after it returns; has/record untouched", async () => {
    const { log, recorder: rec } = recorder()
    const result = await recordToolCall(configWith(rec), CALL, async () => {
      log.push("body")
      return "ok"
    })
    expect(result).toBe("ok")
    expect(log).toEqual(["issue:probe:call_1", "body", "settle:call_1"])
    expect(rec.has).not.toHaveBeenCalled()
    expect(rec.record).not.toHaveBeenCalled()
  })

  it("does not settle when the body parks on a GraphInterrupt, and rethrows it", async () => {
    const { log, recorder: rec } = recorder()
    const park = new GraphInterrupt([])
    await expect(
      recordToolCall(configWith(rec), CALL, async () => {
        throw park
      }),
    ).rejects.toBe(park)
    expect(log).toEqual(["issue:probe:call_1"])
  })

  it("settles when the body throws an ordinary error, and rethrows it", async () => {
    const { log, recorder: rec } = recorder()
    await expect(
      recordToolCall(configWith(rec), CALL, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(log).toEqual(["issue:probe:call_1", "settle:call_1"])
  })

  it("runs the body untouched with no recorder, a recorder without issue/settle, or an empty id", async () => {
    const { log, recorder: rec } = recorder()
    const { issue: _i, settle: _s, ...clientOnly } = rec
    const body = vi.fn(async () => "ok")
    expect(await recordToolCall({ configurable: {} }, CALL, body)).toBe("ok")
    expect(await recordToolCall(undefined, CALL, body)).toBe("ok")
    expect(await recordToolCall(configWith(clientOnly), CALL, body)).toBe("ok")
    expect(await recordToolCall(configWith(rec), { ...CALL, toolCallId: "" }, body)).toBe("ok")
    expect(body).toHaveBeenCalledTimes(4)
    expect(log).toEqual([])
  })

  it("an issue failure propagates before the body runs", async () => {
    const { log, recorder: rec } = recorder()
    rec.issue = async () => {
      throw new Error("store down")
    }
    const body = vi.fn(async () => "ok")
    await expect(recordToolCall(configWith(rec), CALL, body)).rejects.toThrow("store down")
    expect(body).not.toHaveBeenCalled()
    expect(log).toEqual([])
  })

  it("a settle failure is warned and swallowed; the result stands", async () => {
    const { recorder: rec } = recorder()
    rec.settle = async () => {
      throw new Error("store down")
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await recordToolCall(configWith(rec), CALL, async () => "ok")).toBe("ok")
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not settle tool call call_1 for probe"),
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })
})
```

Run from `packages/langchain`: `npx vitest run test/tool-call-recording.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 2: Write the helper**

`packages/langchain/src/tool-call-recording.ts`:

```ts
/**
 * The tool-call record's server-row discipline, shared by every writer of
 * server rows (the tool converter and the subagent bridge): issue before the
 * body runs, settle in `finally`, and never settle a park.
 */
import { CLIENT_TOOL_RECORDER_KEY, type ClientToolRecorder } from "@b4run/sdk"
import { isGraphInterrupt } from "@langchain/langgraph"

/** A recorder that records server calls: both `issue` and `settle` present. */
type ServerCallRecorder = ClientToolRecorder &
  Required<Pick<ClientToolRecorder, "issue" | "settle">>

/**
 * The per-run recorder the runtime injected, when it records server calls.
 * Present only on AG-UI runs where a route opted into client tools or a store
 * is configured; a recorder without `issue`/`settle` (a leftover default store
 * kept to close old parks) records nothing here.
 */
function readServerCallRecorder(config: unknown): ServerCallRecorder | undefined {
  if (typeof config !== "object" || config === null) return undefined
  const configurable = (config as { configurable?: Record<string, unknown> }).configurable
  const candidate = configurable?.[CLIENT_TOOL_RECORDER_KEY] as ClientToolRecorder | undefined
  return candidate && typeof candidate.issue === "function" && typeof candidate.settle === "function"
    ? (candidate as ServerCallRecorder)
    : undefined
}

/**
 * Run `body` as one recorded server tool call. With no server-call recorder on
 * `config`, or no provider tool-call id, the body runs untouched. Otherwise
 * `issue` runs first — a call the server cannot account for must not run, so
 * an issue failure is the call's error — and `settle` runs in `finally` for a
 * return, a throw and an abort, but NOT for a `GraphInterrupt`: a park is not
 * completion. The resumed re-execution issues again (a no-op on the key) and
 * settles when the body really returns or throws. A settle failure is warned
 * and swallowed: the body already ran, and an unsettled server row is never
 * answerable and only delays pruning.
 */
export async function recordToolCall<T>(
  config: unknown,
  call: { readonly toolCallId: string; readonly toolName: string },
  body: () => Promise<T>,
): Promise<T> {
  const recorder = call.toolCallId === "" ? undefined : readServerCallRecorder(config)
  if (!recorder) return body()
  await recorder.issue(call)
  let parked = false
  try {
    return await body()
  } catch (error) {
    parked = isGraphInterrupt(error)
    throw error
  } finally {
    if (!parked) {
      try {
        await recorder.settle(call.toolCallId)
      } catch (error) {
        console.warn(`B4: could not settle tool call ${call.toolCallId} for ${call.toolName}.`, error)
      }
    }
  }
}
```

Run: `npx vitest run test/tool-call-recording.test.ts` → PASS.

- [ ] **Step 3: Make the converter a caller**

In `packages/langchain/src/tool-converter.ts`:
- Replace the import `import { CLIENT_TOOL_RECORDER_KEY, type ClientToolRecorder } from "@b4run/sdk"` with nothing (remove it) and change `import { Command, isGraphInterrupt } from "@langchain/langgraph"` to `import { Command } from "@langchain/langgraph"`; add `import { recordToolCall } from "./tool-call-recording.js"`.
- Delete the `readRecorder` function.
- Replace the block from the `// Server-kind row in the tool-call record:` comment through the end of the `finally` with:

```ts
      // Server-kind row in the tool-call record, around the whole body (see
      // `recordToolCall` for the park rule). The client stub records its own
      // client-kind row and is skipped via its marker.
      const recorded = tool.clientTool === true ? undefined : { toolCallId, toolName: tool.name }
      const body = async () => {
        ...the existing body from `const rawResult = await tool.run(...)` through `return convertedResult`, unchanged...
      }
      return recorded ? recordToolCall(liveConfig, recorded, body) : body()
```

(Re-indent the moved body by one level inside `body`; do not otherwise change it. `recordToolCall` itself skips an empty id, so the `toolCallId === ""` check is no longer needed here.)

- [ ] **Step 4: Run the converter suite, typecheck, lint, commit**

From `packages/langchain`: `npx vitest run test/tool-converter.test.ts test/tool-converter-runtime.test.ts test/tool-call-recording.test.ts` → all pass (the converter's eight recorder tests keep passing through the helper).
`pnpm --filter @b4run/langchain typecheck && pnpm --filter @b4run/langchain lint` → clean for touched files.

```bash
git add packages/langchain/src/tool-call-recording.ts packages/langchain/test/tool-call-recording.test.ts packages/langchain/src/tool-converter.ts
git commit -m "refactor(langchain): one recordToolCall helper carries the server-row discipline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: LangChain — the subagent bridge records the `task` call

**Files:**
- Modify: `packages/langchain/src/subagent-tool-bridge.ts` (`func`, lines ~53–137)
- Test: `packages/langchain/test/subagent-tool-bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/langchain/test/subagent-tool-bridge.test.ts` (add `import { CLIENT_TOOL_RECORDER_KEY } from "@b4run/sdk"` and `GraphInterrupt` to the langgraph import):

```ts
describe("convertSubagentTaskToLangChain — the tool-call record", () => {
  function recorder() {
    const log: string[] = []
    return {
      log,
      recorder: {
        has: vi.fn(async () => false),
        record: vi.fn(async () => {}),
        issue: async (call: { toolCallId: string; toolName: string }) => {
          log.push(`issue:${call.toolName}:${call.toolCallId}`)
        },
        settle: async (toolCallId: string) => {
          log.push(`settle:${toolCallId}`)
        },
      },
    }
  }
  const withRecorder = (rec: unknown, extra: Record<string, unknown> = {}): RunnableConfig =>
    ({
      configurable: { thread_id: "thread-rec", [CLIENT_TOOL_RECORDER_KEY]: rec },
      toolCall: { id: "call_task_1" },
      ...extra,
    }) as RunnableConfig
  const INPUT = { subagent: "researcher", input: "Go" }

  it("issues before the child runs and settles after it returns", async () => {
    const { log, recorder: rec } = recorder()
    const child = {
      invoke: vi.fn(async () => {
        log.push("child")
        return childResult("Done.")
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    expect(await tool.func(INPUT, undefined, withRecorder(rec))).toBe("Done.")
    expect(log).toEqual(["issue:task:call_task_1", "child", "settle:call_task_1"])
  })

  it("stays open across a child park (GraphInterrupt rethrown)", async () => {
    const { log, recorder: rec } = recorder()
    const park = new GraphInterrupt([])
    const child = {
      invoke: vi.fn(async () => {
        throw park
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    await expect(tool.func(INPUT, undefined, withRecorder(rec))).rejects.toBe(park)
    expect(log).toEqual(["issue:task:call_task_1"])
  })

  it("stays open across the resolver's own approval interrupt", async () => {
    const { log, recorder: rec } = recorder()
    const park = new GraphInterrupt([])
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => {
      throw park
    })
    await expect(tool.func(INPUT, undefined, withRecorder(rec))).rejects.toBe(park)
    expect(log).toEqual(["issue:task:call_task_1"])
  })

  it("settles a depth refusal and a resolver denial like any refused tool", async () => {
    const { log, recorder: rec } = recorder()
    const resolver = vi.fn<SubagentResolver>(async () => ({ ok: false, message: "denied" }))
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)
    expect(await tool.func(INPUT, undefined, withRecorder(rec))).toBe("denied")
    expect(log).toEqual(["issue:task:call_task_1", "settle:call_task_1"])
    log.length = 0
    const deep = withRecorder(rec, {
      metadata: { b4: { subagent_depth: 3, subagent_stack: [] } },
    })
    expect(await tool.func(INPUT, undefined, deep)).toMatch(/B4_E5003/)
    expect(log).toEqual(["issue:task:call_task_1", "settle:call_task_1"])
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it("settles a subagent_failed result", async () => {
    const { log, recorder: rec } = recorder()
    const child = {
      invoke: vi.fn(async () => {
        throw new Error("child blew up")
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    expect(await tool.func(INPUT, undefined, withRecorder(rec))).toMatch(/^subagent_failed: /)
    expect(log).toEqual(["issue:task:call_task_1", "settle:call_task_1"])
  })

  it("records nothing without a provider tool-call id, and still runs under the fallback id", async () => {
    const { log, recorder: rec } = recorder()
    let seenCallId: string | undefined
    const resolver = vi.fn<SubagentResolver>(async ({ callId }) => {
      seenCallId = callId
      return allowedChild({ invoke: async () => childResult("Done.") })
    })
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)
    const config = {
      configurable: { thread_id: "thread-rec", [CLIENT_TOOL_RECORDER_KEY]: rec },
    } as RunnableConfig
    expect(await tool.func(INPUT, undefined, config)).toBe("Done.")
    expect(seenCallId).toMatch(/^task-/)
    expect(log).toEqual([])
  })
})
```

Check how the depth check reads `metadata.b4.subagent_depth` (`readDepth`) and adjust the `deep` config's shape if the key differs; the existing E5003 test at ~line 106 shows the right shape.

Run from `packages/langchain`: `npx vitest run test/subagent-tool-bridge.test.ts` → the new cases FAIL (empty log).

- [ ] **Step 2: Implement in the bridge**

Add `import { recordToolCall } from "./tool-call-recording.js"`. In `func`, after the `callId`/`toolRunId`/`input` lines, wrap everything from `const parentB4 = readB4Metadata(liveConfig)` to the final `return finalText` in a body passed to the helper:

```ts
      // The provider's id when there is one; the random fallback is never
      // recorded (it is drawn afresh on every re-execution, so a row keyed on
      // it would be orphaned by each child park and, unsettled, never pruned).
      const providerCallId = readCallId(liveConfig) ?? ""
      return recordToolCall(liveConfig, { toolCallId: providerCallId, toolName: tool.name }, async () => {
        ...existing body from `const parentB4 = readB4Metadata(liveConfig)` through `return finalText`, unchanged...
      })
```

`callId` keeps its current definition (provider id or `task-<uuid>`) for the resolver, the stack entry and the stream events. The helper covers the depth refusal and the resolver call, so those paths settle, and a resolver `interrupt()` or a child `GraphInterrupt` leaves the row open.

- [ ] **Step 3: Run, typecheck, lint, commit**

`npx vitest run test/subagent-tool-bridge.test.ts test/subagent-interrupts.test.ts` (from `packages/langchain`) → PASS, old and new.
`pnpm --filter @b4run/langchain test` → whole package green. `typecheck` and `lint` clean.

```bash
git add packages/langchain/src/subagent-tool-bridge.ts packages/langchain/test/subagent-tool-bridge.test.ts
git commit -m "feat(langchain): the task call that launches a subagent is recorded as a server row

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: CLI — the recording gate

**Files:**
- Modify: `packages/cli/src/lib/dev/client-tool-runtime.ts` (`ClientToolRuntime`, ~line 36)
- Modify: `packages/cli/src/lib/dev/runtime-fetch-core.ts` (~lines 636–660)
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (recorder block ~928–992; the `clientTools` default literal ~367)
- Test: `packages/cli/test/agui-client-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the describe "the tool-call record covers every tool call on a run with a store" in `packages/cli/test/agui-client-tools.test.ts` (add `resolveRecordsServerCalls` to the import from `../src/lib/dev/client-tool-runtime.ts`, and `writeFile` is already imported from `node:fs/promises`):

```ts
  it("a leftover default store file keeps client parks answerable but records no server calls, and boot says so", async () => {
    await withModel([
      { match: { userMessage: "hello", hasToolResult: true }, response: { content: "Done." } },
      { match: { userMessage: "hello" }, response: { toolCalls: [DEPLOY_CALL] } },
    ])
    // No opt-in and no configured store, but the default file exists.
    const appRoot = await fixtureApp({ config: "export default {}\n" })
    await mkdir(join(appRoot, ".b4"), { recursive: true })
    createClientToolCallStore({ path: join(appRoot, ".b4/client-tool-calls.sqlite") })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const handler = await createHandler(appRoot)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("client-tool-calls.sqlite exists but no route is listed"))
      const threadId = `thread-${crypto.randomUUID()}`
      const first = await run(handler, aguiRequest(threadId, "run-1", [USER_HELLO], { route: "/plain#agent", tools: [] }))
      expect(first.status).toBe(200)
      const store = await resolveClientToolCallStore(appRoot)
      expect(store).toBeDefined()
      expect(await store?.listForThread(threadId)).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it("a configured store with no route opted in records server calls", async () => {
    const store = createMemoryClientToolCallStore()
    await withModel([
      { match: { userMessage: "hello", hasToolResult: true }, response: { content: "Done." } },
      { match: { userMessage: "hello" }, response: { toolCalls: [DEPLOY_CALL] } },
    ])
    const appRoot = await fixtureApp({
      store,
      config: `export default { server: { agui: { clientToolStore: globalThis.${STORE_KEY} } } }\n`,
    })
    const handler = await createHandler(appRoot)
    const threadId = `thread-${crypto.randomUUID()}`
    const first = await run(handler, aguiRequest(threadId, "run-1", [USER_HELLO], { route: "/plain#agent", tools: [] }))
    expect(first.status).toBe(200)
    expect((await store.listForThread(threadId)).map((r) => [r.kind, r.toolName])).toEqual([["server", "deployProd"]])
  })

  it("resolveRecordsServerCalls reads config alone", () => {
    expect(resolveRecordsServerCalls(undefined)).toBe(false)
    expect(resolveRecordsServerCalls({})).toBe(false)
    expect(resolveRecordsServerCalls({ server: { agui: { clientTools: [] } } })).toBe(false)
    expect(resolveRecordsServerCalls({ server: { agui: { clientTools: ["/park"] } } })).toBe(true)
    expect(resolveRecordsServerCalls({ server: { agui: { clientToolStore: createMemoryClientToolCallStore() } } })).toBe(true)
  })
```

(The existing "an app with no store records nothing" test stays. If `fixtureApp` writes `.b4/` itself or the sqlite file must exist before `createHandler`, the order above is right: file first, then handler.)

Run from `packages/cli`: `npx vitest run test/agui-client-tools.test.ts -t "tool-call record covers"` → the new cases FAIL.

- [ ] **Step 2: Implement the flag**

`packages/cli/src/lib/dev/client-tool-runtime.ts`: add to `ClientToolRuntime`:

```ts
  /**
   * Whether server tool calls are recorded on this app's AG-UI runs: some
   * route is listed in `server.agui.clientTools`, or `server.agui.clientToolStore`
   * is configured. From config alone — a leftover default store file keeps
   * client parks answerable but never turns this on.
   */
  readonly recordsServerCalls: boolean
```

and the resolver next to `anyRouteOptsInToClientTools`:

```ts
/** `ClientToolRuntime.recordsServerCalls`, from config alone. */
export function resolveRecordsServerCalls(config: B4Config | undefined): boolean {
  return anyRouteOptsInToClientTools(config) || config?.server?.agui?.clientToolStore !== undefined
}
```

`packages/cli/src/lib/dev/runtime-fetch-core.ts`: import `resolveRecordsServerCalls`; after the existing "names routes but no store" warning:

```ts
  const recordsServerCalls = resolveRecordsServerCalls(bootConfig)
  if (clientToolStore && !recordsServerCalls) {
    // Only the node fallback can get here: the default file is left over from
    // an earlier opt-in. It still closes calls parked back then; it does not
    // record server calls.
    console.warn(
      `B4: ${options.appRoot}/.b4/client-tool-calls.sqlite exists but no route is listed in ` +
        `server.agui.clientTools and no server.agui.clientToolStore is set. It is kept so calls ` +
        `parked before the opt-in was removed can still be closed; server tool calls are not ` +
        `recorded. Delete the file to drop it.`,
    )
  }
  const clientTools: ClientToolRuntime = {
    ...(clientToolStore ? { store: clientToolStore } : {}),
    ttlMs: clientToolTtlMs,
    retentionMs: clientToolRetentionMs,
    recordsServerCalls,
  }
```

`packages/cli/src/lib/dev/agui-handler.ts`: the default literal gains `recordsServerCalls: false`. In the recorder block, move `issue` and `settle` into a conditional spread:

```ts
          ...(clientToolRuntime.recordsServerCalls
            ? {
                // Server-kind rows: identity only, written by the backend
                // converter and the subagent bridge around every server tool
                // call. Idempotent on the key, so the replay of a resumed tool
                // node is a no-op. Absent when the gate is off, so the writers
                // record nothing.
                issue: async (call: { readonly toolCallId: string; readonly toolName: string }) => {
                  ...unchanged issue body...
                },
                settle: async (toolCallId: string) => {
                  ...unchanged settle body...
                },
              }
            : {}),
```

Grep `packages/cli/src packages/cli/test` for other `ClientToolRuntime` literals (`grep -rn "retentionMs:" packages/cli/src packages/cli/test`) and add `recordsServerCalls: true` to each test literal that exercises recording (or `false` where the test is about client parks only — pick per test, default `true` to keep existing behavior).

- [ ] **Step 3: Run, typecheck, lint, commit**

`pnpm build` (root) if dists are stale, then from `packages/cli`: `npx vitest run test/agui-client-tools.test.ts test/client-tool-park-visibility.test.ts test/client-tool-abandon.test.ts test/client-tool-turn.test.ts test/client-tools-command.test.ts test/client-tools-command-parsing.test.ts` → PASS.
`pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli lint` → clean.

```bash
git add packages/cli
git commit -m "feat(cli): record server tool calls only when a route opts in or a store is configured

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Docs, spec notes, changeset, lastmod

**Files:**
- Modify: `apps/web/content/docs/ag-ui.mdx` (~lines 233–242)
- Modify: `apps/web/content/docs/configuration.mdx` (~lines 677–686)
- Modify: `docs/superpowers/specs/2026-10-02-tool-call-record-generalization-design.md` (§2 "Subagents" ~line 149; §5 "Store present, route not opted in" ~line 253)
- Create: `.changeset/tool-call-record-scope-and-task.md`
- Regenerate: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: ag-ui.mdx**

Replace the first paragraph of "### The tool-call record" with:

```md
When some route is listed in `server.agui.clientTools`, or
`server.agui.clientToolStore` is set, every tool call the model makes on an
AG-UI run is recorded, not only client ones, on every route. A server tool's
row is identity only: thread, route, run, tool name, when it was issued and
when it returned or threw. No result text is stored; the checkpoint holds the
tool message. A tool whose permission gate parks the turn is issued but not
settled until it actually runs. The `task` call that launches a subagent is
recorded like any other tool, open while the subagent is parked; the
subagent's own tool calls are recorded against the parent thread.

A default `.b4/client-tool-calls.sqlite` left over after every route dropped
its opt-in is still opened, so calls parked back then can be closed, but it
records no server calls; boot logs one warning saying so. Delete the file to
drop it.
```

- [ ] **Step 2: configuration.mdx**

In the `clientToolStore` paragraph, after "(or when the file already exists, so calls parked before the opt-in was removed can still be closed)", add the sentence: "Listing a route in `clientTools`, or setting `clientToolStore`, is also what turns on recording of server tool calls; a leftover file alone does not, and boot warns about it."

- [ ] **Step 3: Spec pointer notes in the #909 spec**

Under "### Subagents" (§2), append: "> Superseded 2026-10-03: the `task` call is now recorded; see `2026-10-03-tool-call-record-scope-and-task-design.md`." Under §5's "Store present, route not opted in" bullet, append: "*(Narrowed 2026-10-03: a store that resolved only because the default file exists no longer records server calls; same spec.)*"

- [ ] **Step 4: Changeset**

`.changeset/tool-call-record-scope-and-task.md`:

```md
---
"@b4run/sdk": patch
"@b4run/langchain": patch
"@b4run/cli": patch
---

Server tool calls are recorded in the tool-call record only when a route is listed in `server.agui.clientTools` or `server.agui.clientToolStore` is set. A default `.b4/client-tool-calls.sqlite` left over after the opt-in was removed is still opened so calls parked back then can be closed, but it no longer records server calls, and boot logs one warning naming it. `ClientToolRecorder.issue` and `settle` are optional: absent on runs that do not record server calls.

The `task` call that launches a subagent is now recorded as a server row like any other tool: issued before the subagent runs, open while it is parked, settled when it returns, fails or is refused. A `role: "tool"` message carrying a task id is dropped as a server row. The issue/settle discipline lives in one `@b4run/langchain` helper used by the tool converter and the subagent bridge.
```

- [ ] **Step 5: Check, commit, regenerate lastmod, commit**

```bash
node scripts/check-docs.mjs && node scripts/check-changesets.mjs
git add apps/web/content/docs/ag-ui.mdx apps/web/content/docs/configuration.mdx docs/superpowers/specs/2026-10-02-tool-call-record-generalization-design.md .changeset/tool-call-record-scope-and-task.md
git commit -m "docs: the recording gate and the recorded task call

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod for the AG-UI and configuration docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod:check
```

---

### Task 6: Full verification and PR

- [ ] **Step 1:** `pnpm lint && pnpm build && pnpm typecheck && pnpm test` from the repo root → green (the `k8s-compat` Docker smoke timing test is a known load flake, #535; rerun it in isolation if it is the only failure).
- [ ] **Step 2:** `git push -u origin blove/tool-call-record-scope-and-task`, then `gh pr create --base main` with a body that links the spec, lists the two behavior changes (gate; `task` recorded), the leftover-file warning, and the test plan, ending with the attribution line.

---

## Self-review

**Spec coverage.** §1 gate: flag + resolver + handler conditional + warning + docs → Tasks 4, 5. SDK optional methods → Task 1. §2 helper + converter + bridge, provider-id-only, parks open, refusals settled → Tasks 2, 3. §3 edge cases: no provider id (Task 3 test), gate off with recorder present (Task 2 test "recorder without issue/settle"), nested subagents (same rule, no code), operator recorders (none). §4 tests → each task. §5 docs, spec notes, changeset → Task 5. §6 out of scope → nothing added.

**Type consistency.** `recordToolCall(config, { toolCallId, toolName }, body)` in Tasks 2 and 3; `recordsServerCalls` / `resolveRecordsServerCalls(config)` in Task 4 and its test; `issue?`/`settle?` on `ClientToolRecorder` in Task 1 match the `typeof` checks in Task 2.

**Placeholders.** The two "…existing body unchanged…" markers in Tasks 2 and 3 refer to code the implementer moves verbatim from lines quoted in the task's file ranges; they are moves, not gaps.
