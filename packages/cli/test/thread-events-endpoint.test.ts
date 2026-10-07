import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { BaseEvent } from "@ag-ui/core"
import type { ThreadAccessPolicy } from "@b4run/sdk"
import { MemorySaver } from "@langchain/langgraph"
import { type BaseCheckpointSaver, emptyCheckpoint } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { TURNS_CHECKPOINT_CAP } from "../src/lib/dev/thread-turns.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Fixture routes (the shapes pending-interrupts-endpoint.test.ts uses, plus a
// search agent whose tool needs no approval, so a run drains to a done turn)
// ---------------------------------------------------------------------------

/** Plain graph route: completes immediately, never parks, never checkpoints. */
const ECHO_ROUTE = ["export const graph = async () => ({ ok: true })", ""].join("\n")

/** Agent route whose `deployProd` tool requires human approval, so the first
 * call to it parks the turn on a real checkpointer-backed HITL interrupt. */
const PARK_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  '  tools: { approve: ["deployProd"] },',
  "})",
  "",
].join("\n")

/** Agent route with one ungated tool: a run through it drains without parking. */
const SEARCH_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  "})",
  "",
].join("\n")

const DEPLOY_TOOL = [
  "/** Deploy to an environment. */",
  "export default async function deployProd(input: { env: string }): Promise<string> {",
  "  return 'deployed to ' + input.env",
  "}",
  "",
].join("\n")

const SEARCH_TOOL = [
  "/** Search the corpus. */",
  "export default async function searchCorpus(input: { query: string }): Promise<string> {",
  "  return '3 hits'",
  "}",
  "",
].join("\n")

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-thread-events-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-events-fixture", "type": "module" }\n',
    "src/app/echo/index.ts": ECHO_ROUTE,
    "src/app/park/index.ts": PARK_ROUTE,
    "src/app/park/tools/deployProd.ts": DEPLOY_TOOL,
    "src/app/search/index.ts": SEARCH_ROUTE,
    "src/app/search/tools/searchCorpus.ts": SEARCH_TOOL,
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock for this test,
 * restoring the previous env afterward. Call BEFORE creating the handler. */
async function withAimock(fixtures: ReturnType<ReturnType<typeof script>["build"]>): Promise<void> {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(fixtures)
}

async function createHandler(
  appRoot: string,
  checkpointer?: BaseCheckpointSaver,
  threadAccess?: ThreadAccessPolicy,
) {
  const handler = await createRuntimeFetchHandler({
    appRoot,
    apSseHeartbeatIntervalMs: 60_000,
    drainDeadlineMs: 250,
    ...(checkpointer ? { checkpointer } : {}),
    ...(threadAccess ? { threadAccess } : {}),
  })
  cleanup.push(() => handler.close())
  return handler
}

type Handler = Awaited<ReturnType<typeof createHandler>>

// ---------------------------------------------------------------------------
// Requests, readers
// ---------------------------------------------------------------------------

function runStreamRequest(threadId: string, route: string, input: unknown = {}): Request {
  return new Request(`http://localhost/threads/${threadId}/runs/stream`, {
    body: JSON.stringify({ input, route }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function agentRunRequest(threadId: string, route: string, message: string): Request {
  return runStreamRequest(threadId, route, { messages: [{ content: message, role: "user" }] })
}

function parkRunRequest(threadId: string, message: string): Request {
  return agentRunRequest(threadId, "/park#agent", message)
}

function resumeRequest(threadId: string, interruptId: string): Request {
  return new Request(`http://localhost/threads/${threadId}/resume`, {
    body: JSON.stringify({
      resume: [{ interruptId, payload: "once", status: "resolved" }],
      route: "/park#agent",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function createThreadRequest(metadata?: Record<string, unknown>): Request {
  return new Request("http://localhost/threads", {
    body: JSON.stringify(metadata ? { metadata } : {}),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function eventsRequest(threadId: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/threads/${threadId}/events`, { headers })
}

function pendingInterruptsRequest(threadId: string): Request {
  return new Request(`http://localhost/threads/${threadId}/pending_interrupts`)
}

interface EventsBody {
  readonly threadId: string
  readonly status: "idle" | "busy" | "interrupted"
  readonly events: readonly BaseEvent[]
  readonly warnings: readonly string[]
  readonly truncated: boolean
}

interface ErrorBody {
  readonly error: { readonly message: string; readonly details?: { readonly code?: string } }
}

async function readSseText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    text += decoder.decode(value, { stream: true })
  }
}

async function drain(response: Response): Promise<void> {
  await readSseText(response)
}

async function readEvents(handler: Handler, threadId: string): Promise<EventsBody> {
  const response = await handler.fetch(eventsRequest(threadId))
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  return (await response.json()) as EventsBody
}

async function createThread(handler: Handler, metadata?: Record<string, unknown>): Promise<string> {
  const created = await handler.fetch(createThreadRequest(metadata))
  expect(created.status).toBe(200)
  return ((await created.json()) as { thread_id: string }).thread_id
}

type Ev = BaseEvent & {
  readonly [key: string]: unknown
  readonly delta?: string
  readonly outcome?: {
    readonly type: string
    readonly interrupts: ReadonlyArray<{
      id: string
      metadata?: { grant?: string }
    }>
  }
  readonly runId?: string
}

function of(body: EventsBody, type: string): Ev[] {
  return body.events.filter((e) => e.type === type) as Ev[]
}

// ---------------------------------------------------------------------------

describe("GET /threads/:thread_id/events", () => {
  it("returns 404 thread_not_found for an unknown thread, same bytes under a denying policy", async () => {
    const open = await createHandler(await fixtureApp())
    const miss = await open.fetch(eventsRequest("t-missing"))
    expect(miss.status).toBe(404)
    expect(((await miss.clone().json()) as ErrorBody).error.details?.code).toBe("thread_not_found")

    const gated = await createHandler(await fixtureApp(), undefined, {
      fallback: () => ({ decision: "deny" }),
    })
    const denied = await gated.fetch(eventsRequest("t-missing"))
    expect(denied.status).toBe(404)
    expect(await denied.text()).toBe(await miss.text())
  })

  it("denies a read of an existing thread with the same 404 bytes as a miss", async () => {
    const miss = await (
      await (await createHandler(await fixtureApp())).fetch(eventsRequest("t-missing"))
    ).text()
    const gated = await createHandler(await fixtureApp(), undefined, {
      fallback: (req) => ({ decision: req.action === "read" ? "deny" : "allow" }),
    })
    await drain(await gated.fetch(runStreamRequest("t-exists", "/echo#graph")))
    const denied = await gated.fetch(eventsRequest("t-exists"))
    expect(denied.status).toBe(404)
    expect(await denied.text()).toBe(miss)
  }, 30_000)

  it("uses the thread.events operation as a read and the parking route's middleware", async () => {
    const seen: Array<{ operation: string; action: string }> = []
    const handler = await createHandler(await fixtureApp(), undefined, {
      fallback: (req) => {
        seen.push({ action: req.action, operation: req.operation })
        return { decision: "allow" }
      },
    })
    await drain(await handler.fetch(runStreamRequest("t-ops", "/echo#graph")))
    const response = await handler.fetch(eventsRequest("t-ops"))
    expect(response.status).toBe(200)
    expect(seen).toContainEqual({ action: "read", operation: "thread.events" })
    // A graph route never checkpoints, so a known thread with no transcript has no events.
    const body = (await response.json()) as EventsBody
    expect(body).toEqual({
      events: [],
      status: "idle",
      threadId: "t-ops",
      truncated: false,
      warnings: [],
    })
  }, 30_000)

  it("runs the route's middleware with a GET", async () => {
    const middleware = [
      'import { defineMiddleware, allow, reject } from "@b4run/sdk"',
      "export default defineMiddleware((req) =>",
      '  req.headers["x-allow"] === "1" ? allow() : reject(403, { method: req.method, routeId: req.routeId }),',
      ")",
      "",
    ].join("\n")
    const handler = await createHandler(await fixtureApp({ "src/middleware.ts": middleware }))
    const threadId = await createThread(handler, { route: "/echo#graph" })
    const rejected = await handler.fetch(eventsRequest(threadId))
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toEqual({ method: "GET", routeId: "/echo" })
    const allowed = await handler.fetch(eventsRequest(threadId, { "x-allow": "1" }))
    expect(allowed.status).toBe(200)
  }, 30_000)

  it("returns a 409 thread_route_unknown for a thread that never ran", async () => {
    const handler = await createHandler(await fixtureApp())
    const threadId = await createThread(handler)
    const response = await handler.fetch(eventsRequest(threadId))
    expect(response.status).toBe(409)
    expect(((await response.json()) as ErrorBody).error.details?.code).toBe("thread_route_unknown")
  })

  it("replays a drained run as its AG-UI events", async () => {
    await withAimock(
      script()
        .user("search")
        .callsTool("searchCorpus", { query: "x" })
        .replies("Found it.")
        .build(),
    )
    const handler = await createHandler(await fixtureApp())
    await drain(await handler.fetch(agentRunRequest("t-done", "/search#agent", "search")))

    const body = await readEvents(handler, "t-done")

    expect(body.warnings).toEqual([])
    expect(body.truncated).toBe(false)
    expect(body.events[0]).toMatchObject({
      input: { messages: [{ content: "search", role: "user" }] },
      type: "RUN_STARTED",
    })
    const last = body.events.at(-1) as Ev
    expect(last.type).toBe("RUN_FINISHED")
    expect(last.outcome?.type).toBe("success")
    expect(of(body, "TOOL_CALL_START")).toContainEqual(
      expect.objectContaining({ toolCallName: "searchCorpus" }),
    )
    expect(of(body, "TOOL_CALL_RESULT")).toHaveLength(1)
    expect(of(body, "TEXT_MESSAGE_CONTENT")).toContainEqual(
      expect.objectContaining({ delta: "Found it." }),
    )
  }, 60_000)

  it("replays a parked run ending on its interrupt, and the resumed run as one run", async () => {
    await withAimock(
      script()
        .user("deploy")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed.")
        .build(),
    )
    const handler = await createHandler(await fixtureApp())
    const text = await readSseText(await handler.fetch(parkRunRequest("t-park", "deploy")))
    expect(text).toContain("event: interrupt")

    const parked = await readEvents(handler, "t-park")
    expect(parked.status).toBe("interrupted")
    const parkedLast = parked.events.at(-1) as Ev
    expect(parkedLast.type).toBe("RUN_FINISHED")
    expect(parkedLast.outcome?.type).toBe("interrupt")

    const pending = (await (await handler.fetch(pendingInterruptsRequest("t-park"))).json()) as {
      interrupts: Array<{ interruptId: string }>
    }
    const interruptId = pending.interrupts[0]?.interruptId ?? ""
    expect(interruptId).not.toBe("")
    expect(parkedLast.outcome?.interrupts[0]?.id).toBe(interruptId)
    await drain(await handler.fetch(resumeRequest("t-park", interruptId)))

    const done = await readEvents(handler, "t-park")
    expect(done.status).toBe("idle")
    const doneLast = done.events.at(-1) as Ev
    expect(doneLast.type).toBe("RUN_FINISHED")
    expect(doneLast.outcome?.type).toBe("success")
    expect(of(done, "RUN_STARTED")).toHaveLength(1)
  }, 90_000)

  it("carries the minted grant on the parked interrupt when the app discloses grants", async () => {
    await withAimock(script().user("deploy").callsTool("deployProd", { env: "staging" }).build())
    const handler = await createHandler(
      await fixtureApp({
        "b4.config.ts": 'export default { approvals: { grants: "optional" } }\n',
      }),
    )
    await readSseText(await handler.fetch(parkRunRequest("t-grant", "deploy")))

    const parked = await readEvents(handler, "t-grant")

    const last = parked.events.at(-1) as Ev
    expect(last.type).toBe("RUN_FINISHED")
    const pending = (await (await handler.fetch(pendingInterruptsRequest("t-grant"))).json()) as {
      interrupts: Array<{ grant?: string }>
    }
    expect(typeof pending.interrupts[0]?.grant).toBe("string")
    expect(last.outcome?.interrupts[0]?.metadata?.grant).toBe(pending.interrupts[0]?.grant)
  }, 60_000)

  it("caps decoding and reports truncated", async () => {
    const saver = new MemorySaver()
    const handler = await createHandler(await fixtureApp(), saver)
    // The route is recorded on the row, as a server restart leaves it.
    const threadId = await createThread(handler, { route: "/echo#graph" })
    // 2001 trivial root checkpoints: one user message each, ids in time order.
    const total = TURNS_CHECKPOINT_CAP + 1
    const base = Date.parse("2026-10-05T00:00:00.000Z")
    let parent: string | undefined
    for (let i = 0; i < total; i++) {
      const id = `0000000${i}`.slice(-7)
      const checkpoint = {
        ...emptyCheckpoint(),
        channel_values: {
          messages: [
            {
              lc: 1,
              type: "constructor",
              id: ["langchain_core", "messages", "HumanMessage"],
              kwargs: { content: `hello ${i}`, id: `u-${id}` },
            },
          ],
        },
        id: `1efd0000-0000-6000-8000-00000${id}`,
        ts: new Date(base + i * 1000).toISOString(),
      }
      await saver.put(
        {
          configurable: {
            checkpoint_ns: "",
            thread_id: threadId,
            ...(parent !== undefined ? { checkpoint_id: parent } : {}),
          },
        },
        checkpoint,
        { parents: {}, source: "loop", step: i },
      )
      parent = checkpoint.id
    }

    const body = await readEvents(handler, threadId)

    expect(body.truncated).toBe(true)
    // The cap keeps the NEWEST checkpoints: the last run is the last user message.
    expect(of(body, "RUN_STARTED").at(-1)?.runId).toBe(`u-${`0000000${total - 1}`.slice(-7)}`)
  }, 60_000)
})
