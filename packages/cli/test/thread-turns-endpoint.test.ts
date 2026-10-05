import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { TurnsView } from "@b4run/ag-ui/view"
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
  const appRoot = await mkdtemp(join(tmpdir(), "b4-thread-turns-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-turns-fixture", "type": "module" }\n',
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

function turnsRequest(threadId: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/threads/${threadId}/turns`, { headers })
}

function pendingInterruptsRequest(threadId: string): Request {
  return new Request(`http://localhost/threads/${threadId}/pending_interrupts`)
}

interface TurnsBody {
  readonly threadId: string
  readonly status: "idle" | "busy" | "interrupted"
  readonly turns: TurnsView
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

async function readTurns(handler: Handler, threadId: string): Promise<TurnsBody> {
  const response = await handler.fetch(turnsRequest(threadId))
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  return (await response.json()) as TurnsBody
}

async function createThread(handler: Handler, metadata?: Record<string, unknown>): Promise<string> {
  const created = await handler.fetch(createThreadRequest(metadata))
  expect(created.status).toBe(200)
  return ((await created.json()) as { thread_id: string }).thread_id
}

/** The parked prompt's interrupt id, as the awaiting step's approval carries it. */
function interruptIdOf(body: TurnsBody): string | undefined {
  const step = body.turns.turns[0]?.steps[0]
  return step?.kind === "tool" ? step.approval?.interruptId : undefined
}

// ---------------------------------------------------------------------------

describe("GET /threads/:thread_id/turns", () => {
  it("returns 404 thread_not_found for an unknown thread, same bytes under a denying policy", async () => {
    const open = await createHandler(await fixtureApp())
    const miss = await open.fetch(turnsRequest("t-missing"))
    expect(miss.status).toBe(404)
    expect(((await miss.clone().json()) as ErrorBody).error.details?.code).toBe("thread_not_found")

    const gated = await createHandler(await fixtureApp(), undefined, {
      fallback: () => ({ decision: "deny" }),
    })
    const denied = await gated.fetch(turnsRequest("t-missing"))
    expect(denied.status).toBe(404)
    expect(await denied.text()).toBe(await miss.text())
  })

  it("denies a read of an existing thread with the same 404 bytes as a miss", async () => {
    const miss = await (
      await (await createHandler(await fixtureApp())).fetch(turnsRequest("t-missing"))
    ).text()
    const gated = await createHandler(await fixtureApp(), undefined, {
      fallback: (req) => ({ decision: req.action === "read" ? "deny" : "allow" }),
    })
    await drain(await gated.fetch(runStreamRequest("t-exists", "/echo#graph")))
    const denied = await gated.fetch(turnsRequest("t-exists"))
    expect(denied.status).toBe(404)
    expect(await denied.text()).toBe(miss)
  }, 30_000)

  it("uses the thread.turns operation as a read and the parking route's middleware", async () => {
    const seen: Array<{ operation: string; action: string }> = []
    const handler = await createHandler(await fixtureApp(), undefined, {
      fallback: (req) => {
        seen.push({ action: req.action, operation: req.operation })
        return { decision: "allow" }
      },
    })
    await drain(await handler.fetch(runStreamRequest("t-ops", "/echo#graph")))
    const response = await handler.fetch(turnsRequest("t-ops"))
    expect(response.status).toBe(200)
    expect(seen).toContainEqual({ action: "read", operation: "thread.turns" })
    // A graph route never checkpoints, so a known thread with no transcript has no turns.
    const body = (await response.json()) as TurnsBody
    expect(body).toEqual({
      status: "idle",
      threadId: "t-ops",
      truncated: false,
      turns: { threadId: "t-ops", turns: [] },
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
    const rejected = await handler.fetch(turnsRequest(threadId))
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toEqual({ method: "GET", routeId: "/echo" })
    const allowed = await handler.fetch(turnsRequest(threadId, { "x-allow": "1" }))
    expect(allowed.status).toBe(200)
  }, 30_000)

  it("returns a 409 thread_route_unknown for a thread that never ran", async () => {
    const handler = await createHandler(await fixtureApp())
    const threadId = await createThread(handler)
    const response = await handler.fetch(turnsRequest(threadId))
    expect(response.status).toBe(409)
    expect(((await response.json()) as ErrorBody).error.details?.code).toBe("thread_route_unknown")
  })

  it("rebuilds a drained run: one done turn with its tool step, text and end time", async () => {
    await withAimock(
      script()
        .user("search")
        .callsTool("searchCorpus", { query: "x" })
        .replies("Found it.")
        .build(),
    )
    const handler = await createHandler(await fixtureApp())
    await drain(await handler.fetch(agentRunRequest("t-done", "/search#agent", "search")))

    const body = await readTurns(handler, "t-done")

    expect(body.threadId).toBe("t-done")
    expect(body.status).toBe("idle")
    expect(body.warnings).toEqual([])
    expect(body.truncated).toBe(false)
    expect(body.turns.threadId).toBe("t-done")
    expect(body.turns.turns).toHaveLength(1)
    const turn = body.turns.turns[0]
    expect(turn).toBeDefined()
    expect(turn?.status).toBe("done")
    expect(typeof turn?.endedAt).toBe("number")
    expect(turn?.text).toBe("Found it.")
    // `result` is the ToolMessage's own content — the converter's JSON of the
    // tool's return, which is also what the live TOOL_CALL_RESULT carries.
    expect(turn?.steps).toEqual([
      expect.objectContaining({
        kind: "tool",
        name: "searchCorpus",
        result: expect.any(String),
        status: "done",
      }),
    ])
    expect(turn?.steps[0]).toMatchObject({ args: '{"query":"x"}' })
    const step = turn?.steps[0]
    if (step?.kind === "tool") {
      expect(step.settledAt).toBeGreaterThanOrEqual(step.startedAt)
      expect(turn?.endedAt).toBeGreaterThanOrEqual(step.settledAt ?? 0)
    }
  }, 60_000)

  it("rebuilds a parked run as awaiting with the approval on its step, and the resumed run as the same done turn", async () => {
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

    const parked = await readTurns(handler, "t-park")
    expect(parked.status).toBe("interrupted")
    expect(parked.truncated).toBe(false)
    expect(parked.turns.turns).toHaveLength(1)
    expect(parked.turns.turns[0]).toMatchObject({ status: "awaiting" })
    expect(parked.turns.turns[0]?.steps[0]).toMatchObject({
      approval: expect.objectContaining({ kind: "tool" }),
      kind: "tool",
      name: "deployProd",
      status: "awaiting",
    })
    const step = parked.turns.turns[0]?.steps[0]
    if (step?.kind === "tool") {
      // The app runs with the default `approvals.grants: "off"`, so no grant was minted.
      expect(step.approval?.grant).toBeUndefined()
      expect(step.approval?.detail).toMatchObject({ toolName: "deployProd" })
    }

    const pending = (await (await handler.fetch(pendingInterruptsRequest("t-park"))).json()) as {
      interrupts: Array<{ interruptId: string }>
    }
    const interruptId = pending.interrupts[0]?.interruptId ?? ""
    expect(interruptId).not.toBe("")
    // The awaiting step names the same prompt /pending_interrupts lists: what a
    // client resumes with is readable from the turns view alone.
    expect(interruptIdOf(parked)).toBe(interruptId)
    await drain(await handler.fetch(resumeRequest("t-park", interruptId)))

    const done = await readTurns(handler, "t-park")
    expect(done.status).toBe("idle")
    expect(done.turns.turns).toHaveLength(1)
    expect(done.turns.turns[0]).toMatchObject({ status: "done", text: "Deployed." })
    expect(done.turns.turns[0]?.steps[0]).toMatchObject({
      kind: "tool",
      name: "deployProd",
      result: JSON.stringify("deployed to staging"),
      status: "done",
    })
    expect(done.warnings).toEqual([])
  }, 90_000)

  it("carries the minted grant on the awaiting step when the app discloses grants", async () => {
    await withAimock(script().user("deploy").callsTool("deployProd", { env: "staging" }).build())
    const handler = await createHandler(
      await fixtureApp({
        "b4.config.ts": 'export default { approvals: { grants: "optional" } }\n',
      }),
    )
    await readSseText(await handler.fetch(parkRunRequest("t-grant", "deploy")))

    const parked = await readTurns(handler, "t-grant")

    const step = parked.turns.turns[0]?.steps[0]
    expect(step).toMatchObject({ kind: "tool", status: "awaiting" })
    const pending = (await (await handler.fetch(pendingInterruptsRequest("t-grant"))).json()) as {
      interrupts: Array<{ grant?: string }>
    }
    // The same grant /pending_interrupts discloses, so a reloaded client can
    // answer the prompt from the turns view alone.
    expect(typeof pending.interrupts[0]?.grant).toBe("string")
    if (step?.kind === "tool") expect(step.approval?.grant).toBe(pending.interrupts[0]?.grant)
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

    const body = await readTurns(handler, threadId)

    expect(body.truncated).toBe(true)
    expect(body.turns.turns.length).toBeGreaterThanOrEqual(1)
    // The cap keeps the NEWEST checkpoints: the last turn is the last user message.
    expect(body.turns.turns.at(-1)?.runId).toBe(`u-${`0000000${total - 1}`.slice(-7)}`)
  }, 60_000)
})
