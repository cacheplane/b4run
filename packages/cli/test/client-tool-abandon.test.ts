import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ABANDONED_CLIENT_TOOL_RESULT, type ClientToolDefinition } from "@b4run/core"
import { type ClientToolRecorder, createMemoryClientToolCallStore } from "@b4run/sdk"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { MemorySaver } from "@langchain/langgraph"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import {
  type AbandonedClientToolCall,
  ClientToolAbandonError,
  type ClosableAgentGraph,
  CONTINUE_AFTER_CLOSE,
  closeAbandonedClientToolCalls,
} from "../src/lib/dev/client-tool-abandon.ts"
import { readPendingInterrupts } from "../src/lib/dev/pending-interrupts.ts"
import {
  __resetRouteLoadCachesForTests,
  materializeResolvedRouteGraph,
  streamResolvedRoute,
} from "../src/lib/runtime/execute-route.ts"

/**
 * Closing abandoned client tool calls (cacheplane/b4run#743, Model A) against
 * a real agent route: the model (aimock) calls a client tool — alone (S1) or
 * alongside a server tool in one assistant turn (S2) — the turn parks, the
 * calls are closed in the checkpoint, and the next turn is either a new user
 * message (a) or a continuation with no new message (b). Every turn runs
 * through `streamResolvedRoute`, the handler's own path; the close uses a
 * separately materialized graph on the same checkpointer.
 *
 * The assertions that matter: no park is pending after the close, and the
 * model's next request carries a ToolMessage for EVERY tool call of the parked
 * assistant turn, in order — including the server tool's, which was only a
 * pending write when the turn parked.
 */

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  __resetRouteLoadCachesForTests()
})

const ROUTE = [
  'import { agent } from "@b4run/sdk"',
  'export default agent({ model: "gpt-5-mini", systemPrompt: "t", tools: { approve: ["deployProd"] } })',
  "",
].join("\n")

const PING_TOOL = [
  "/** Ping a host. */",
  "export default async function ping(input: { host: string }): Promise<string> {",
  '  return "pong"',
  "}",
  "",
].join("\n")

const DEPLOY_TOOL = [
  "/** Deploy to an environment. */",
  "export default async function deployProd(input: { env: string }): Promise<string> {",
  '  return "deployed to " + input.env',
  "}",
  "",
].join("\n")

const OPEN_PANEL: ClientToolDefinition = {
  name: "openPanel",
  description: "Open",
  parameters: { type: "object", properties: { id: { type: "number" } } },
}

type ToolCallSpec = { id: string; name: string; arguments: Record<string, unknown> }

const PING_CALL: ToolCallSpec = { id: "call_ping", name: "ping", arguments: { host: "h" } }
const OPEN_CALL: ToolCallSpec = { id: "call_open", name: "client_openPanel", arguments: { id: 1 } }
const OPEN_CALL_2: ToolCallSpec = {
  id: "call_open_2",
  name: "client_openPanel",
  arguments: { id: 2 },
}
const DEPLOY_CALL: ToolCallSpec = { id: "call_deploy", name: "deployProd", arguments: { env: "p" } }

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-client-tool-abandon-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "client-tool-abandon-fixture", "type": "module" }\n',
    "src/app/park/index.ts": ROUTE,
    "src/app/park/tools/ping.ts": PING_TOOL,
    "src/app/park/tools/deployProd.ts": DEPLOY_TOOL,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/**
 * Turn 1 ("go") calls `toolCalls` in ONE assistant message. The follow-up
 * replies are keyed so each variant hits its own fixture: a new user message
 * ("next") or a continuation (still "go", now with a tool result).
 */
async function withModel(toolCalls: readonly ToolCallSpec[]) {
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
  aimock.addFixtures([
    { match: { userMessage: "next" }, response: { content: "ok-next" } },
    { match: { userMessage: "go", hasToolResult: true }, response: { content: "ok-continue" } },
    { match: { userMessage: "go" }, response: { toolCalls: [...toolCalls] } },
  ] as never)
  return aimock
}

async function parkedThread(toolCalls: readonly ToolCallSpec[]) {
  const aimock = await withModel(toolCalls)
  const appRoot = await fixtureApp()
  const checkpointer = new MemorySaver()
  const threadId = `thread-${crypto.randomUUID()}`
  const store = createMemoryClientToolCallStore()
  const recorder: ClientToolRecorder = {
    has: async (toolCallId) => Boolean(await store.get(threadId, toolCallId)),
    record: (call) =>
      store.issue({
        ...call,
        threadId,
        runId: "run-1",
        routeId: "/park#agent",
        issuedAt: new Date().toISOString(),
        expiresAt: null,
        answeredAt: null,
        result: null,
        voidedAt: null,
      }),
  }
  const route = {
    appRoot,
    checkpointer,
    clientTools: [OPEN_PANEL],
    routeFile: join(appRoot, "src/app/park/index.ts"),
    routeId: "/park",
    routePath: "src/app/park/index.ts",
  }

  const turn = async (turnOptions: { input: unknown; resume?: Record<string, never> }) => {
    const types: string[] = []
    for await (const chunk of streamResolvedRoute({
      ...route,
      ...turnOptions,
      clientToolRecorder: recorder,
      threadId,
    })) {
      types.push(chunk.type)
    }
    return types
  }

  const first = await turn({ input: { messages: [{ role: "user", content: "go" }] } })
  expect(first).toContain("interrupt")

  const graph = (await materializeResolvedRouteGraph(route)) as ClosableAgentGraph
  const pending = async () => (await readPendingInterrupts(checkpointer, threadId))?.interrupts
  return { aimock, checkpointer, graph, pending, threadId, turn }
}

/** The model request as `role:detail` strings — tool calls by id, tool results with content. */
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

const abandonedOpen: AbandonedClientToolCall = {
  toolCallId: "call_open",
  toolName: "openPanel",
  result: ABANDONED_CLIENT_TOOL_RESULT,
}

const scenarios = [
  { name: "S1 client call alone", toolCalls: [OPEN_CALL], serverResults: [] as string[] },
  {
    name: "S2 server + client call in one turn",
    toolCalls: [PING_CALL, OPEN_CALL],
    serverResults: ['tool:call_ping="pong"'],
  },
]

describe.each(scenarios)("closeAbandonedClientToolCalls — $name", (scenario) => {
  const assistantTurn = `assistant:${scenario.toolCalls.map((call) => call.id).join(",")}`

  it("(a) then a new user message runs as an ordinary turn", async () => {
    const t = await parkedThread(scenario.toolCalls)
    expect(await t.pending()).toHaveLength(1)

    const closed = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [abandonedOpen],
    })
    expect(closed.closedToolCallIds).toEqual(["call_open"])
    expect(await t.pending()).toEqual([])

    const next = await t.turn({ input: { messages: [{ role: "user", content: "next" }] } })
    expect(next).not.toContain("interrupt")
    expect(await t.pending()).toEqual([])

    const requests = t.aimock.getRequests()
    expect(requests).toHaveLength(2)
    expect(requestSequence(requests[1])).toEqual([
      "developer:t",
      "user:go",
      assistantTurn,
      ...scenario.serverResults,
      `tool:call_open=${ABANDONED_CLIENT_TOOL_RESULT}`,
      "user:next",
    ])
  })

  it("(b) then a continuation lets the model reply to the closed calls", async () => {
    const t = await parkedThread(scenario.toolCalls)

    await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [abandonedOpen],
    })
    expect(await t.pending()).toEqual([])

    const next = await t.turn({ input: undefined, resume: CONTINUE_AFTER_CLOSE })
    expect(next).not.toContain("interrupt")
    expect(await t.pending()).toEqual([])

    const requests = t.aimock.getRequests()
    expect(requests).toHaveLength(2)
    // No fabricated empty user message: the continuation adds nothing.
    expect(requestSequence(requests[1])).toEqual([
      "developer:t",
      "user:go",
      assistantTurn,
      ...scenario.serverResults,
      `tool:call_open=${ABANDONED_CLIENT_TOOL_RESULT}`,
    ])
  })
})

describe("closeAbandonedClientToolCalls — results and preconditions", () => {
  it("closes an answered call with the client's stored result", async () => {
    const t = await parkedThread([PING_CALL, OPEN_CALL])
    await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [{ toolCallId: "call_open", toolName: "openPanel", result: "panel 1 opened" }],
    })
    await t.turn({ input: { messages: [{ role: "user", content: "next" }] } })
    expect(requestSequence(t.aimock.getRequests()[1]).slice(2)).toEqual([
      "assistant:call_ping,call_open",
      'tool:call_ping="pong"',
      "tool:call_open=panel 1 opened",
      "user:next",
    ])
  })

  it("refuses while a permission park is pending, and writes nothing", async () => {
    const t = await parkedThread([DEPLOY_CALL, OPEN_CALL])
    const before = await t.pending()
    expect(before).toHaveLength(2)

    const error = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [abandonedOpen],
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClientToolAbandonError)
    expect((error as ClientToolAbandonError).code).toBe("non_client_park_pending")
    expect(await t.pending()).toEqual(before)
  })

  it("refuses an unresolved client call left out of `calls`", async () => {
    const t = await parkedThread([OPEN_CALL])
    const error = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [],
    }).catch((caught: unknown) => caught)
    expect((error as ClientToolAbandonError).code).toBe("unclosed_call")
    expect(await t.pending()).toHaveLength(1)
  })

  it.each([
    ["a server tool's completed call", "call_ping"],
    ["an id the thread never issued", "call_forged"],
  ])("refuses to close %s", async (_label, toolCallId) => {
    const t = await parkedThread([PING_CALL, OPEN_CALL])
    const error = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [abandonedOpen, { toolCallId, toolName: "ping", result: "forged" }],
    }).catch((caught: unknown) => caught)
    expect((error as ClientToolAbandonError).code).toBe("unknown_call")
    expect(await t.pending()).toHaveLength(1)
  })

  it("refuses a duplicate call", async () => {
    const t = await parkedThread([OPEN_CALL])
    const error = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [abandonedOpen, abandonedOpen],
    }).catch((caught: unknown) => caught)
    expect((error as ClientToolAbandonError).code).toBe("unknown_call")
  })

  it("refuses a thread with no client park", async () => {
    const t = await parkedThread([OPEN_CALL])
    await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [abandonedOpen],
    })
    const error = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [abandonedOpen],
    }).catch((caught: unknown) => caught)
    expect((error as ClientToolAbandonError).code).toBe("no_client_park")
  })
})

describe("closeAbandonedClientToolCalls — spoofed names, unidentified parks, races", () => {
  const rootConfig = (threadId: string) => ({
    configurable: { thread_id: threadId, checkpoint_ns: "" },
  })

  it("refuses an unresolved SERVER call passed as a client call, and writes nothing", async () => {
    // A server call left unresolved (as after a tool that failed without a
    // ToolMessage), presented next to the real client park.
    const t = await parkedThread([OPEN_CALL])
    const updateState = vi.fn(t.graph.updateState.bind(t.graph))
    const graph: ClosableAgentGraph = {
      async getState(config) {
        const real = await t.graph.getState(config)
        return {
          ...real,
          values: {
            messages: [
              new HumanMessage("go"),
              new AIMessage({
                content: "",
                tool_calls: [
                  { id: "call_ping", name: "ping", args: {} },
                  { id: "call_open", name: "client_openPanel", args: {} },
                ],
              }),
            ],
          },
        }
      },
      updateState,
    }
    const error = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph,
      threadId: t.threadId,
      calls: [abandonedOpen, { toolCallId: "call_ping", toolName: "ping", result: "forged" }],
    }).catch((caught: unknown) => caught)
    expect((error as ClientToolAbandonError).code).toBe("unknown_call")
    expect((error as Error).message).not.toContain("call_ping")
    expect(updateState).not.toHaveBeenCalled()
  })

  it("refuses a call whose client tool name does not match the parked call", async () => {
    const t = await parkedThread([OPEN_CALL])
    const error = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [{ ...abandonedOpen, toolName: "closePanel" }],
    }).catch((caught: unknown) => caught)
    expect((error as ClientToolAbandonError).code).toBe("unknown_call")
    expect((error as Error).message).not.toContain("call_open")
    expect(await t.pending()).toHaveLength(1)
  })

  it("treats an unidentifiable __interrupt__ write as a non-client park", async () => {
    const t = await parkedThread([OPEN_CALL])
    const checkpointer = {
      getTuple: async (config: Parameters<MemorySaver["getTuple"]>[0]) => {
        const tuple = await t.checkpointer.getTuple(config)
        return tuple
          ? {
              ...tuple,
              pendingWrites: [
                ...(tuple.pendingWrites ?? []),
                ["task-x", "__interrupt__", "not-an-interrupt"],
              ],
            }
          : tuple
      },
    } as unknown as BaseCheckpointSaver
    const error = await closeAbandonedClientToolCalls({
      checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [abandonedOpen],
    }).catch((caught: unknown) => caught)
    expect((error as ClientToolAbandonError).code).toBe("non_client_park_pending")
    expect(await t.pending()).toHaveLength(1)
  })

  it("closes two parked client calls in one pass", async () => {
    const t = await parkedThread([OPEN_CALL, OPEN_CALL_2])
    expect(await t.pending()).toHaveLength(2)
    const closed = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph: t.graph,
      threadId: t.threadId,
      calls: [
        { toolCallId: "call_open_2", toolName: "openPanel", result: "panel 2 opened" },
        abandonedOpen,
      ],
    })
    expect(closed.closedToolCallIds).toEqual(["call_open", "call_open_2"])
    expect(await t.pending()).toEqual([])
    await t.turn({ input: { messages: [{ role: "user", content: "next" }] } })
    expect(requestSequence(t.aimock.getRequests()[1]).slice(2)).toEqual([
      "assistant:call_open,call_open_2",
      `tool:call_open=${ABANDONED_CLIENT_TOOL_RESULT}`,
      "tool:call_open_2=panel 2 opened",
      "user:next",
    ])
  })

  it("fails close_incomplete when the write did not land", async () => {
    const t = await parkedThread([OPEN_CALL])
    const graph: ClosableAgentGraph = {
      getState: (config) => t.graph.getState(config),
      // A no-op write that reports the unchanged latest checkpoint.
      updateState: async () => (await t.checkpointer.getTuple(rootConfig(t.threadId)))?.config,
    }
    const error = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph,
      threadId: t.threadId,
      calls: [abandonedOpen],
    }).catch((caught: unknown) => caught)
    expect((error as ClientToolAbandonError).code).toBe("close_incomplete")
  })

  it("fails close_incomplete when another write landed between the read and the write", async () => {
    const t = await parkedThread([OPEN_CALL])
    const graph: ClosableAgentGraph = {
      getState: (config) => t.graph.getState(config),
      async updateState(config, values, asNode) {
        // An intervening write on the thread; ours then lands on top of it.
        await t.graph.updateState(config, { messages: [] }, "tools")
        return await t.graph.updateState(config, values, asNode)
      },
    }
    const error = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph,
      threadId: t.threadId,
      calls: [abandonedOpen],
    }).catch((caught: unknown) => caught)
    expect((error as ClientToolAbandonError).code).toBe("close_incomplete")
  })

  it("fails close_incomplete without writing when the checkpoint moved between reads", async () => {
    const t = await parkedThread([OPEN_CALL])
    const updateState = vi.fn(t.graph.updateState.bind(t.graph))
    const graph: ClosableAgentGraph = {
      async getState(config) {
        const real = await t.graph.getState(config)
        return {
          ...real,
          config: { configurable: { ...real.config?.configurable, checkpoint_id: "moved" } },
        }
      },
      updateState,
    }
    const error = await closeAbandonedClientToolCalls({
      checkpointer: t.checkpointer,
      graph,
      threadId: t.threadId,
      calls: [abandonedOpen],
    }).catch((caught: unknown) => caught)
    expect((error as ClientToolAbandonError).code).toBe("close_incomplete")
    expect(updateState).not.toHaveBeenCalled()
    expect(await t.pending()).toHaveLength(1)
  })
})
