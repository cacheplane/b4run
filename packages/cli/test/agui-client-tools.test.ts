import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { CLIENT_TOOL_UNAVAILABLE_RESULT } from "@b4run/core"
import { type ClientToolCallStore, createMemoryClientToolCallStore } from "@b4run/sdk"
import { createClientToolCallStore } from "@b4run/sqlite-storage"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import {
  AGUI_BODY_MAX_BYTES,
  ClientToolConfigError,
  DEFAULT_CLIENT_TOOL_TTL_MS,
  MAX_CLIENT_TOOL_RESULT,
  MAX_CLIENT_TOOL_TTL_MS,
  resolveClientToolTtlMs,
  validateClientToolStore,
} from "../src/lib/dev/client-tool-runtime.ts"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.ts"
import { nodeBootFallbacks, resolveClientToolCallStore } from "../src/lib/runtime/execute-route.ts"

/**
 * Client-provided tools over `POST /agui/:routeId`, end to end
 * (cacheplane/b4run#743, Model A): the node runtime over a fixture app, the
 * model played by aimock. What the model SAW is asserted on aimock's journal.
 */

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
})

const STORE_KEY = "__b4AguiClientToolsTestStore"

const PARK_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  'export default agent({ model: "gpt-5-mini", systemPrompt: "t" })',
  "",
].join("\n")

const ECHO_ROUTE = "export const graph = async () => ({ ok: true })\n"

const OPEN_PANEL = {
  name: "openPanel",
  description: "Open a panel",
  parameters: { type: "object", properties: { id: { type: "number" } } },
}

type ToolCallSpec = { id: string; name: string; arguments: Record<string, unknown> }

const CALL_A: ToolCallSpec = { id: "call_a", name: "client_openPanel", arguments: { id: 7 } }
const CALL_B: ToolCallSpec = { id: "call_b", name: "client_openPanel", arguments: { id: 8 } }

interface AppOptions {
  /** Inject a store through `server.agui.clientToolStore` (else the node sqlite default). */
  readonly store?: ClientToolCallStore
  readonly config?: string
}

async function fixtureApp(options: AppOptions = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-agui-client-tools-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  if (options.store) (globalThis as Record<string, unknown>)[STORE_KEY] = options.store
  const config =
    options.config ??
    (options.store
      ? `export default { server: { agui: { clientTools: ["/park"], clientToolStore: globalThis.${STORE_KEY} } } }\n`
      : 'export default { server: { agui: { clientTools: ["/park"] } } }\n')
  const files: Record<string, string> = {
    "b4.config.ts": config,
    "package.json": '{ "name": "agui-client-tools-fixture", "type": "module" }\n',
    "src/app/park/index.ts": PARK_ROUTE,
    "src/app/other/index.ts": PARK_ROUTE,
    "src/app/echo/index.ts": ECHO_ROUTE,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

async function withModel(fixtures: unknown[]) {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = prevKey ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(fixtures as never)
  return aimock
}

/** Turn 1 ("hello") calls `toolCalls`; once a tool result is present it replies "Opened.". */
function toolTurnFixtures(toolCalls: readonly ToolCallSpec[]): unknown[] {
  return [
    { match: { userMessage: "again" }, response: { content: "Again." } },
    { match: { userMessage: "hello", hasToolResult: true }, response: { content: "Opened." } },
    { match: { userMessage: "hello" }, response: { toolCalls: [...toolCalls] } },
  ]
}

type HandlerOptions = Parameters<typeof createRuntimeFetchHandler>[0]

async function createHandler(
  appRoot: string,
  bootFallbacks?: HandlerOptions["bootFallbacks"],
  extra: Partial<Pick<HandlerOptions, "checkpointer" | "threadAccess">> = {},
) {
  const handler = await createRuntimeFetchHandler({
    appRoot,
    apSseHeartbeatIntervalMs: 60_000,
    drainDeadlineMs: 250,
    ...(bootFallbacks ? { bootFallbacks } : {}),
    ...extra,
  })
  cleanup.push(() => handler.close())
  return handler
}

type Handler = Awaited<ReturnType<typeof createHandler>>

type AguiMessage = Record<string, unknown>

function aguiRequest(
  threadId: string,
  runId: string,
  messages: readonly AguiMessage[],
  options: { tools?: readonly unknown[]; route?: string } = {},
): Request {
  return new Request(
    `http://localhost/agui/${encodeURIComponent(options.route ?? "/park#agent")}`,
    {
      body: JSON.stringify({
        context: [],
        forwardedProps: {},
        messages,
        runId,
        state: {},
        threadId,
        tools: options.tools ?? [OPEN_PANEL],
      }),
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      method: "POST",
    },
  )
}

function parseSseEvents(text: string): Record<string, unknown>[] {
  return text.split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length)
    return data ? [JSON.parse(data) as Record<string, unknown>] : []
  })
}

async function run(handler: Handler, request: Request) {
  const response = await handler.fetch(request)
  const text = await response.text()
  const isSse = response.headers.get("content-type")?.includes("text/event-stream") ?? false
  return {
    events: isSse ? parseSseEvents(text) : [],
    /** `code` is the endpoint's own code (`error.details.code`); `b4Code` the registry code. */
    json: () => {
      const body = JSON.parse(text) as {
        error?: { code?: string; details?: { code?: string } }
      }
      return { code: body.error?.details?.code, b4Code: body.error?.code }
    },
    status: response.status,
    text,
  }
}

function finished(events: readonly Record<string, unknown>[]) {
  return events.find((event) => event.type === "RUN_FINISHED") as
    | { outcome?: { type?: string } }
    | undefined
}

/** The model request's messages as `role:detail` strings. */
function requestSequence(request: { body: { messages?: unknown[] } | null } | undefined): string[] {
  return (request?.body?.messages ?? []).map((raw) => {
    const message = raw as {
      role: string
      content: unknown
      tool_calls?: Array<{ id: string }>
      tool_call_id?: string
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      return `assistant:${message.tool_calls.map((call) => call.id).join(",")}`
    }
    if (message.role === "tool") return `tool:${message.tool_call_id}=${String(message.content)}`
    return `${message.role}:${String(message.content)}`
  })
}

const USER_HELLO: AguiMessage = { id: "m1", role: "user", content: "hello" }

function assistantCalls(ids: readonly string[]): AguiMessage {
  return {
    id: "m2",
    role: "assistant",
    content: "",
    toolCalls: ids.map((id) => ({
      id,
      type: "function",
      function: { name: "openPanel", arguments: "{}" },
    })),
  }
}

function toolResult(id: string, toolCallId: string, content: string): AguiMessage {
  return { id, role: "tool", toolCallId, content }
}

/** Run 1: the model calls `toolCalls`, the turn parks invisibly. */
async function parkedRun(toolCalls: readonly ToolCallSpec[], options: AppOptions = {}) {
  const aimock = await withModel(toolTurnFixtures(toolCalls))
  const store = options.store ?? createMemoryClientToolCallStore()
  const appRoot = await fixtureApp({ ...options, store })
  const handler = await createHandler(appRoot)
  const threadId = `thread-${crypto.randomUUID()}`
  const first = await run(handler, aguiRequest(threadId, "run-1", [USER_HELLO]))
  return { aimock, first, handler, store, threadId }
}

describe("POST /agui/:route with client-provided tools", () => {
  it("round trip: the call parks invisibly and the result reaches the model on the next run", async () => {
    const t = await parkedRun([CALL_A])
    expect(t.first.status).toBe(200)
    const start = t.first.events.find((event) => event.type === "TOOL_CALL_START") as
      | { toolCallName?: string; toolCallId?: string }
      | undefined
    expect(start?.toolCallName).toBe("openPanel")
    expect(finished(t.first.events)?.outcome?.type).toBe("success")
    expect(t.first.text).not.toContain("client-tool-call")
    const toolCallId = start?.toolCallId as string
    expect(toolCallId).toBe("call_a")
    expect(await t.store.get(t.threadId, toolCallId)).toMatchObject({
      toolName: "openPanel",
      runId: "run-1",
      answeredAt: null,
    })

    const second = await run(
      t.handler,
      aguiRequest(t.threadId, "run-2", [
        USER_HELLO,
        assistantCalls([toolCallId]),
        toolResult("m3", toolCallId, "panel opened"),
      ]),
    )
    expect(second.status).toBe(200)
    expect(second.text).toContain("Opened.")
    const requests = t.aimock.getRequests()
    expect(requests).toHaveLength(2)
    expect(requestSequence(requests[1])).toContain(`tool:${toolCallId}=panel opened`)
    expect((await t.store.get(t.threadId, toolCallId))?.answeredAt).not.toBeNull()
  })

  it("resent history is not a replay: a new user message after the round trip is a normal turn", async () => {
    const t = await parkedRun([CALL_A])
    const history = [
      USER_HELLO,
      assistantCalls(["call_a"]),
      toolResult("m3", "call_a", "panel opened"),
    ]
    expect((await run(t.handler, aguiRequest(t.threadId, "run-2", history))).status).toBe(200)

    const third = await run(
      t.handler,
      aguiRequest(t.threadId, "run-3", [
        ...history,
        { id: "m4", role: "assistant", content: "Opened." },
        { id: "m5", role: "user", content: "again" },
      ]),
    )
    expect(third.status).toBe(200)
    expect(third.text).toContain("Again.")
    const requests = t.aimock.getRequests()
    expect(requests).toHaveLength(3)
    // The answered result is in the model's history exactly once — from the
    // checkpoint — never re-fed from the resent message.
    expect(
      requestSequence(requests[2]).filter((entry) => entry.startsWith("tool:call_a=")),
    ).toEqual(["tool:call_a=panel opened"])
  })

  it("parallel calls answered in two envelopes: the first records and finishes, the second resumes both", async () => {
    const t = await parkedRun([CALL_A, CALL_B])
    expect(t.first.status).toBe(200)
    expect(
      t.first.events.filter((event) => event.type === "TOOL_CALL_START").map((e) => e.toolCallId),
    ).toEqual(["call_a", "call_b"])
    const before = t.aimock.getRequests().length

    const partial = await run(
      t.handler,
      aguiRequest(t.threadId, "run-2", [
        USER_HELLO,
        assistantCalls(["call_a", "call_b"]),
        toolResult("m3", "call_a", "A done"),
      ]),
    )
    expect(partial.status).toBe(200)
    expect(partial.events.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"])
    expect(finished(partial.events)?.outcome?.type).toBe("success")
    expect(t.aimock.getRequests()).toHaveLength(before)
    expect((await t.store.get(t.threadId, "call_a"))?.result).toBe("A done")

    const second = await run(
      t.handler,
      aguiRequest(t.threadId, "run-3", [
        USER_HELLO,
        assistantCalls(["call_a", "call_b"]),
        toolResult("m3", "call_a", "A done"),
        toolResult("m4", "call_b", "B done"),
      ]),
    )
    expect(second.status).toBe(200)
    expect(second.text).toContain("Opened.")
    const sequence = requestSequence(t.aimock.getRequests().at(-1))
    expect(sequence).toContain("tool:call_a=A done")
    expect(sequence).toContain("tool:call_b=B done")
  })

  it("a follow-up that omits `tools` still resumes the parked stub (default sqlite store)", async () => {
    const aimock = await withModel(toolTurnFixtures([CALL_A]))
    const appRoot = await fixtureApp()
    const handler = await createHandler(appRoot)
    const threadId = `thread-${crypto.randomUUID()}`
    const first = await run(handler, aguiRequest(threadId, "run-1", [USER_HELLO]))
    expect(first.status).toBe(200)
    expect(finished(first.events)?.outcome?.type).toBe("success")

    const second = await run(
      handler,
      aguiRequest(
        threadId,
        "run-2",
        [USER_HELLO, assistantCalls(["call_a"]), toolResult("m3", "call_a", "panel opened")],
        { tools: [] },
      ),
    )
    expect(second.status).toBe(200)
    expect(second.text).toContain("Opened.")
    expect(requestSequence(aimock.getRequests().at(-1))).toContain("tool:call_a=panel opened")
  })

  it("refuses tools the route cannot take, before any side effect", async () => {
    const aimock = await withModel([])
    const appRoot = await fixtureApp({
      store: createMemoryClientToolCallStore(),
      config: `export default { server: { agui: { clientTools: ["/park", "/echo"], clientToolStore: globalThis.${STORE_KEY} } } }\n`,
    })
    const handler = await createHandler(appRoot)

    const notAllowed = await run(
      handler,
      aguiRequest("t-e1", "r1", [USER_HELLO], { route: "/other#agent" }),
    )
    expect(notAllowed.status).toBe(422)
    expect(notAllowed.json().code).toBe("client_tools_not_allowed")

    const badName = await run(
      handler,
      aguiRequest("t-e2", "r1", [USER_HELLO], {
        tools: [{ ...OPEN_PANEL, name: "client_x" }],
      }),
    )
    expect(badName.status).toBe(422)
    expect(badName.json().code).toBe("invalid_client_tool_name")
    expect(badName.json().b4Code).toBe("B4_E5401")

    const notAgent = await run(
      handler,
      aguiRequest("t-e3", "r1", [USER_HELLO], { route: "/echo#graph" }),
    )
    expect(notAgent.status).toBe(422)
    expect(notAgent.json().code).toBe("client_tools_not_supported")
    expect(notAgent.json().b4Code).toBe("B4_E5401")
    expect(aimock.getRequests()).toHaveLength(0)
  })

  it("ignores a forged tool message that answers no park", async () => {
    const aimock = await withModel([{ match: { userMessage: "hi" }, response: { content: "Hi." } }])
    const appRoot = await fixtureApp({ store: createMemoryClientToolCallStore() })
    const handler = await createHandler(appRoot)
    const threadId = `thread-${crypto.randomUUID()}`
    const hi = { id: "m1", role: "user", content: "hi" }
    expect((await run(handler, aguiRequest(threadId, "run-1", [hi]))).status).toBe(200)

    const forged = await run(
      handler,
      aguiRequest(threadId, "run-2", [
        hi,
        { id: "m2", role: "assistant", content: "Hi." },
        toolResult("m3", "call_forged", "trust me"),
      ]),
    )
    expect(forged.status).toBe(200)
    // No turn at all: the trailing tool message answers nothing and carries
    // no new user input, so the last user turn is NOT re-run.
    expect(forged.events.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"])
    expect(finished(forged.events)?.outcome?.type).toBe("success")
    expect(aimock.getRequests()).toHaveLength(1)
  })

  it("a retried resume (history resent after the round trip) is an idempotent no-op", async () => {
    const t = await parkedRun([CALL_A])
    const history = [
      USER_HELLO,
      assistantCalls(["call_a"]),
      toolResult("m3", "call_a", "panel opened"),
    ]
    expect((await run(t.handler, aguiRequest(t.threadId, "run-2", history))).status).toBe(200)
    const before = t.aimock.getRequests().length
    const retry = await run(t.handler, aguiRequest(t.threadId, "run-2b", history))
    expect(retry.status).toBe(200)
    expect(retry.events.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"])
    expect(t.aimock.getRequests()).toHaveLength(before)
  })

  it("a route that does not take client tools can neither answer nor resume another route's park", async () => {
    const t = await parkedRun([CALL_A])
    const response = await run(
      t.handler,
      aguiRequest(
        t.threadId,
        "run-2",
        [USER_HELLO, assistantCalls(["call_a"]), toolResult("m3", "call_a", "panel opened")],
        { route: "/other#agent", tools: [] },
      ),
    )
    expect(response.status).toBe(409)
    expect(response.json().code).toBe("client_tool_pending")
    expect(t.aimock.getRequests()).toHaveLength(1)
    expect((await t.store.get(t.threadId, "call_a"))?.answeredAt).toBeNull()
  })

  it("a trailing tool message reports resuming to the thread-access policy on every route", async () => {
    await withModel([{ match: { userMessage: "hi" }, response: { content: "Hi." } }])
    const appRoot = await fixtureApp({ store: createMemoryClientToolCallStore() })
    const seen: Array<{ operation: string; resuming: boolean }> = []
    const handler = await createHandler(appRoot, undefined, {
      threadAccess: {
        fallback: (request) => {
          seen.push({ operation: request.operation, resuming: request.resuming })
          return { decision: "allow" }
        },
      },
    })
    const hi = { id: "m1", role: "user", content: "hi" }
    await run(
      handler,
      aguiRequest("t-resuming", "r1", [hi, toolResult("m2", "call_x", "x")], {
        route: "/other#agent",
        tools: [],
      }),
    )
    expect(seen.filter((entry) => entry.operation === "run.agui").map((e) => e.resuming)).toContain(
      true,
    )
    expect(
      seen.filter((entry) => entry.operation === "run.agui").every((entry) => entry.resuming),
    ).toBe(true)
  })

  it("a rebuilt stub replays its park but never parks a NEW call the client did not offer", async () => {
    const CALL_C: ToolCallSpec = { id: "call_c", name: "client_openPanel", arguments: { id: 9 } }
    const aimock = await withModel([
      { match: { toolCallId: "call_c" }, response: { content: "Done." } },
      { match: { toolCallId: "call_a" }, response: { toolCalls: [CALL_C] } },
      { match: { userMessage: "hello" }, response: { toolCalls: [CALL_A] } },
      { match: { userMessage: "again" }, response: { content: "Again." } },
    ])
    const store = createMemoryClientToolCallStore()
    const appRoot = await fixtureApp({ store })
    const handler = await createHandler(appRoot)
    const threadId = `thread-${crypto.randomUUID()}`
    expect((await run(handler, aguiRequest(threadId, "run-1", [USER_HELLO]))).status).toBe(200)

    const second = await run(
      handler,
      aguiRequest(
        threadId,
        "run-2",
        [USER_HELLO, assistantCalls(["call_a"]), toolResult("m3", "call_a", "panel opened")],
        { tools: [] },
      ),
    )
    expect(second.status).toBe(200)
    expect(second.text).toContain("Done.")
    // A string tool result reaches the model JSON-encoded.
    expect(requestSequence(aimock.getRequests().at(-1))).toContain(
      `tool:call_c=${JSON.stringify(CLIENT_TOOL_UNAVAILABLE_RESULT)}`,
    )
    expect(await store.get(threadId, "call_c")).toBeUndefined()

    // Nothing is parked: a new user message is an ordinary turn, not a 409.
    const third = await run(
      handler,
      aguiRequest(threadId, "run-3", [USER_HELLO, { id: "m9", role: "user", content: "again" }]),
    )
    expect(third.status).toBe(200)
    expect(third.text).toContain("Again.")
  })

  it("a client park that appears after the decision is caught under the run slot", async () => {
    const aimock = await withModel([
      { match: { userMessage: "hello" }, response: { content: "Hi." } },
    ])
    const appRoot = await fixtureApp({ store: createMemoryClientToolCallStore() })
    const saver = new MemorySaver()
    const parkedTuple = {
      config: { configurable: { thread_id: "t-race", checkpoint_ns: "" } },
      checkpoint: { channel_values: {}, id: "cp-1" },
      metadata: {},
      pendingWrites: [
        [
          "33a12321-3ec2-56a7-b4d7-0337886c4386",
          "__interrupt__",
          {
            id: "3336d0e0a2d4f198ef9aecd09cd7ac27",
            value: {
              type: "client-tool-call",
              interruptId: "client-call_race",
              toolCallId: "call_race",
              name: "openPanel",
              input: {},
            },
          },
        ],
      ],
    }
    // Armed per request: the first read (the unclaimed decision) sees no
    // park; every later read — the recheck under the run slot — sees one.
    let reads: number | undefined
    const checkpointer = new Proxy(saver, {
      get(target, key, receiver) {
        if (key === "getTuple") {
          return async (config: Parameters<MemorySaver["getTuple"]>[0]) => {
            if (reads === undefined) return target.getTuple(config)
            reads += 1
            return reads === 1 ? undefined : parkedTuple
          }
        }
        return Reflect.get(target, key, receiver)
      },
    })
    const handler = await createHandler(appRoot, undefined, { checkpointer })

    reads = 0
    const raced = await run(handler, aguiRequest("t-race", "r1", [USER_HELLO]))
    expect(raced.status).toBe(409)
    expect(raced.json().code).toBe("client_tool_pending")
    expect(aimock.getRequests()).toHaveLength(0)

    // The run slot was released: the next request on the thread runs.
    reads = undefined
    const next = await run(handler, aguiRequest("t-race", "r2", [USER_HELLO]))
    expect(next.status).toBe(200)
    expect(next.text).toContain("Hi.")
  })

  it("an operator deny on the client tool never parks; the model sees the denial", async () => {
    const aimock = await withModel(toolTurnFixtures([CALL_A]))
    const store = createMemoryClientToolCallStore()
    const appRoot = await fixtureApp({
      store,
      config: `export default { permissions: { deny: { clientTool: ["openPanel"] } }, server: { agui: { clientTools: ["/park"], clientToolStore: globalThis.${STORE_KEY} } } }\n`,
    })
    const handler = await createHandler(appRoot)
    const threadId = `thread-${crypto.randomUUID()}`
    const first = await run(handler, aguiRequest(threadId, "run-1", [USER_HELLO]))
    expect(first.status).toBe(200)
    expect(first.text).toContain("Opened.")
    const requests = aimock.getRequests()
    expect(requests).toHaveLength(2)
    expect(
      requestSequence(requests[1]).some(
        (entry) => entry.startsWith("tool:call_a=") && entry.includes("B4_E3001"),
      ),
    ).toBe(true)
    expect(await store.listForThread(threadId)).toEqual([])
  })

  it("refuses an over-cap result with 413 and records nothing", async () => {
    const t = await parkedRun([CALL_A])
    const big = "x".repeat(MAX_CLIENT_TOOL_RESULT + 1)
    const response = await run(
      t.handler,
      aguiRequest(t.threadId, "run-2", [
        USER_HELLO,
        assistantCalls(["call_a"]),
        toolResult("m3", "call_a", big),
      ]),
    )
    expect(response.status).toBe(413)
    expect(response.json().code).toBe("client_tool_result_too_large")
    expect((await t.store.get(t.threadId, "call_a"))?.answeredAt).toBeNull()
  })

  it("fails closed with 503 when no client tool store can be resolved", async () => {
    const aimock = await withModel([])
    const appRoot = await fixtureApp()
    const handler = await createHandler(appRoot, {
      ...nodeBootFallbacks,
      resolveClientToolCallStore: async () => undefined,
    })
    const response = await run(handler, aguiRequest("t-no-store", "r1", [USER_HELLO]))
    expect(response.status).toBe(503)
    expect(response.json().code).toBe("client_tool_store_unavailable")
    expect(aimock.getRequests()).toHaveLength(0)
  })

  it("INTERIM (12a): a new user message while a call is parked is refused with 409", async () => {
    const t = await parkedRun([CALL_A])
    const response = await run(
      t.handler,
      aguiRequest(t.threadId, "run-2", [
        USER_HELLO,
        assistantCalls(["call_a"]),
        { id: "m3", role: "user", content: "again" },
      ]),
    )
    expect(response.status).toBe(409)
    expect(response.json().code).toBe("client_tool_pending")
  })
})

describe("client tool boot settings and request bounds", () => {
  it("clientToolTtlMs defaults, and a mistyped value fails rather than reads as configured", () => {
    expect(resolveClientToolTtlMs(undefined)).toBe(DEFAULT_CLIENT_TOOL_TTL_MS)
    expect(DEFAULT_CLIENT_TOOL_TTL_MS).toBe(600_000)
    expect(resolveClientToolTtlMs(1)).toBe(1)
    expect(resolveClientToolTtlMs(MAX_CLIENT_TOOL_TTL_MS)).toBe(MAX_CLIENT_TOOL_TTL_MS)
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "600000", null]) {
      expect(() => resolveClientToolTtlMs(bad)).toThrow(ClientToolConfigError)
    }
    expect(() => resolveClientToolTtlMs(MAX_CLIENT_TOOL_TTL_MS + 1)).toThrow(ClientToolConfigError)
  })

  it("clientToolStore must be a store", () => {
    expect(validateClientToolStore(undefined)).toBeUndefined()
    const store = createMemoryClientToolCallStore()
    expect(validateClientToolStore(store)).toBe(store)
    expect(() => validateClientToolStore({ issue() {} })).toThrow(/missing get/)
    expect(() => validateClientToolStore("sqlite")).toThrow(ClientToolConfigError)
  })

  it("the node fallback reopens an existing store after the opt-in is removed", async () => {
    const appRoot = await fixtureApp({ config: "export default {}\n" })
    expect(await resolveClientToolCallStore(appRoot)).toBeUndefined()
    const path = join(appRoot, ".b4/client-tool-calls.sqlite")
    await mkdir(dirname(path), { recursive: true })
    const seeded = createClientToolCallStore({ path })
    await seeded.issue({
      threadId: "t",
      toolCallId: "call_1",
      interruptId: "client-call_1",
      toolName: "openPanel",
      runId: "r",
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      answeredAt: null,
      result: null,
      voidedAt: null,
    })
    const reopened = await resolveClientToolCallStore(appRoot)
    expect((await reopened?.listOutstanding("t"))?.map((row) => row.toolCallId)).toEqual(["call_1"])
  })

  it("a bad clientToolTtlMs fails the boot", async () => {
    const appRoot = await fixtureApp({
      config:
        'export default { server: { agui: { clientTools: ["/park"], clientToolTtlMs: 0 } } }\n',
    })
    await expect(createHandler(appRoot)).rejects.toThrow(/clientToolTtlMs/)
  })

  it("an AG-UI body over the ceiling is refused with 413 before it is parsed", async () => {
    await withModel([])
    const appRoot = await fixtureApp({ store: createMemoryClientToolCallStore() })
    const handler = await createHandler(appRoot)
    const response = await handler.fetch(
      new Request(`http://localhost/agui/${encodeURIComponent("/park#agent")}`, {
        body: "x".repeat(AGUI_BODY_MAX_BYTES + 1),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(response.status).toBe(413)
    const body = (await response.json()) as { error?: { details?: { code?: string } } }
    expect(body.error?.details?.code).toBe("payload_too_large")
  })
})
