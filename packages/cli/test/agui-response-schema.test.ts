import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadsStore } from "@b4run/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { handleAgUiRequest } from "../src/lib/dev/agui-handler.js"
import { createLiveTurnHub } from "../src/lib/dev/live-turn-hub.js"
import { createPendingResumeClaims } from "../src/lib/dev/pending-interrupts.js"
import { readResponseFormat } from "../src/lib/dev/response-schema.js"
import { createRunRegistry } from "../src/lib/dev/run-registry.js"
import { createRuntimeRequestListener } from "../src/lib/dev/runtime-server.js"
import type { streamResolvedRoute } from "../src/lib/runtime/execute-route.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** The shape Hashbrown's AG-UI client sends (its `ui: true` runs). */
const uiSchema = {
  type: "object",
  properties: { ui: { type: "array", items: { type: "string" } } },
  required: ["ui"],
  additionalProperties: false,
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

async function postRun(
  port: number,
  routeKey: string,
  body: Record<string, unknown>,
): Promise<{ events: Record<string, unknown>[]; json: () => unknown; response: Response }> {
  const response = await fetch(`http://127.0.0.1:${port}/agui/${encodeURIComponent(routeKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
      messages: [{ id: "1", role: "user", content: "hello" }],
      ...body,
    }),
  })
  const text = await response.text()
  return { events: parseSseEvents(text), json: () => JSON.parse(text), response }
}

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-agui-schema-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "agui-schema-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@b4run/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    const p = join(appRoot, rel)
    await mkdir(join(p, ".."), { recursive: true })
    await writeFile(p, body, "utf8")
  }
  return appRoot
}

/** The real node runtime over a fixture app, with OpenAI pointed at aimock. */
async function setupRuntime(overrides: Record<string, string> = {}) {
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

  const appRoot = await fixtureApp(overrides)
  const { listener, close } = await createRuntimeRequestListener({ appRoot })
  cleanup.push(() => close())
  const server: Server = createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { aimock, port: (server.address() as AddressInfo).port }
}

/** The handler alone, with route execution replaced by a capturing stream. */
async function setupControlledServer(streamRoute: typeof streamResolvedRoute) {
  const appRoot = await fixtureApp()
  const threads = new Map<string, { metadata: Record<string, unknown>; status: string }>()
  const resumeClaims = createPendingResumeClaims()
  const runRegistry = createRunRegistry()
  const server: Server = createServer((request, response) => {
    void handleAgUiRequest({
      appRoot,
      checkpointer: { getTuple: async () => undefined } as unknown as BaseCheckpointSaver,
      liveTurnHub: createLiveTurnHub(),
      middleware: undefined,
      registry: {
        appRoot,
        entries: [],
        lookup: () => ({
          assistantId: "/chat#agent",
          mode: "agent" as const,
          routeFile: join(appRoot, "src/app/chat/index.ts"),
          routeId: "/chat",
          routePath: "src/app/chat/index.ts",
        }),
      },
      resumeClaims,
      runRegistry,
      request,
      response,
      routeKey: "/chat#agent",
      signal: new AbortController().signal,
      streamRoute,
      threadAccess: undefined,
      threadsStore: {
        createThread: async ({ thread_id }: { thread_id?: string }) => {
          const threadId = thread_id ?? "generated"
          const now = new Date().toISOString()
          threads.set(threadId, { metadata: {}, status: "idle" })
          return {
            thread_id: threadId,
            created_at: now,
            updated_at: now,
            metadata: {},
            status: "idle",
          }
        },
        getThread: async (threadId: string) => {
          const thread = threads.get(threadId)
          if (!thread) return undefined
          const now = new Date().toISOString()
          return {
            thread_id: threadId,
            created_at: now,
            updated_at: now,
            metadata: thread.metadata,
            status: thread.status as "idle" | "busy" | "interrupted",
          }
        },
        updateMetadata: async (threadId: string, patch: Record<string, unknown>) => {
          const thread = threads.get(threadId)
          if (thread) thread.metadata = { ...thread.metadata, ...patch }
        },
        updateStatus: async (threadId: string, status: string) => {
          const thread = threads.get(threadId)
          if (thread) thread.status = status
        },
      } as unknown as ThreadsStore,
    }).catch((error) => {
      response.statusCode = 500
      response.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { port: (server.address() as AddressInfo).port, threads }
}

describe("readResponseFormat", () => {
  it("is absent when the envelope carries no hashbrown block or no schema", () => {
    expect(readResponseFormat({ threadId: "t" })).toEqual({ ok: true, responseFormat: undefined })
    expect(readResponseFormat({ hashbrown: { ui: true } })).toEqual({
      ok: true,
      responseFormat: undefined,
    })
  })

  it("names the schema as a strict json_schema response format", () => {
    expect(readResponseFormat({ hashbrown: { ui: true, responseSchema: uiSchema } })).toEqual({
      ok: true,
      responseFormat: { type: "json_schema", name: "hashbrown_response", schema: uiSchema },
    })
  })

  it("rejects a hashbrown block or schema that is not a JSON object", () => {
    for (const hashbrown of ["nope", [], 1]) {
      const result = readResponseFormat({ hashbrown })
      expect(result).toMatchObject({ ok: false, code: "invalid_response_schema" })
    }
    for (const responseSchema of [null, "object", 1, true, []]) {
      const result = readResponseFormat({ hashbrown: { responseSchema } })
      expect(result).toMatchObject({ ok: false, code: "invalid_response_schema" })
      if (!result.ok) expect(result.message).toContain("hashbrown.responseSchema")
    }
  })
})

describe("POST /agui/:route with hashbrown.responseSchema", () => {
  it("forwards the schema to route execution as the root model's response format", async () => {
    const seen: unknown[] = []
    const { port } = await setupControlledServer(async function* (options) {
      seen.push(options.responseFormat)
      yield { type: "done", data: {} }
    })

    const { response } = await postRun(port, "/chat#agent", {
      threadId: "schema-forwarded",
      runId: "r1",
      hashbrown: { ui: true, responseSchema: uiSchema },
    })

    expect(response.status).toBe(200)
    expect(seen).toEqual([{ type: "json_schema", name: "hashbrown_response", schema: uiSchema }])
  })

  it("leaves a run without the field exactly as before", async () => {
    const seen: unknown[] = []
    const { port } = await setupControlledServer(async function* (options) {
      seen.push("responseFormat" in options ? options.responseFormat : "absent")
      yield { type: "done", data: {} }
    })

    const plain = await postRun(port, "/chat#agent", { threadId: "plain", runId: "r1" })
    const uiOnly = await postRun(port, "/chat#agent", {
      threadId: "ui-only",
      runId: "r2",
      hashbrown: { ui: true },
    })

    expect(plain.response.status).toBe(200)
    expect(uiOnly.response.status).toBe(200)
    expect(seen).toEqual(["absent", "absent"])
  })

  it("rejects a malformed schema with 422 before touching the thread", async () => {
    let executed = 0
    const { port, threads } = await setupControlledServer(async function* () {
      executed += 1
      yield { type: "done", data: {} }
    })

    const { response, json } = await postRun(port, "/chat#agent", {
      threadId: "bad-schema",
      runId: "r1",
      hashbrown: { ui: true, responseSchema: "not a schema" },
    })

    expect(response.status).toBe(422)
    expect(json()).toMatchObject({
      error: {
        kind: "request_error",
        code: "B4_E5402",
        details: { code: "invalid_response_schema" },
        message: expect.stringContaining("hashbrown.responseSchema"),
      },
    })
    expect(executed).toBe(0)
    expect(threads.has("bad-schema")).toBe(false)
  })

  it("applies the schema as a strict OpenAI json_schema response_format on the root model", async () => {
    const { aimock, port } = await setupRuntime()
    aimock.addFixtures(script().user("hello").replies('{"ui":[]}').build())

    const { events, response } = await postRun(port, "/chat#agent", {
      threadId: "openai-applied",
      runId: "r1",
      hashbrown: { ui: true, responseSchema: uiSchema },
    })

    expect(response.status).toBe(200)
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } })
    const requests = aimock.getRequests() as ReadonlyArray<{
      body: { response_format?: unknown } | null
    }>
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "hashbrown_response", schema: uiSchema, strict: true },
    })
  }, 60_000)

  it("sends no response_format when the client sends no schema", async () => {
    const { aimock, port } = await setupRuntime()
    aimock.addFixtures(script().user("hello").replies("Hi there!").build())

    const { response } = await postRun(port, "/chat#agent", { threadId: "plain", runId: "r1" })

    expect(response.status).toBe(200)
    const requests = aimock.getRequests() as ReadonlyArray<{
      body: { response_format?: unknown } | null
    }>
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).not.toHaveProperty("response_format")
  }, 60_000)

  it("rejects the run with 422 when the route's provider cannot constrain its output", async () => {
    const { aimock, port } = await setupRuntime({
      "src/app/chat/index.ts":
        'import { agent } from "@b4run/sdk"\nexport default agent({ model: "gemini-2.5-flash", systemPrompt: "You are helpful." })\n',
    })

    const { response, json } = await postRun(port, "/chat#agent", {
      threadId: "google-rejected",
      runId: "r1",
      hashbrown: { ui: true, responseSchema: uiSchema },
    })

    expect(response.status).toBe(422)
    expect(json()).toMatchObject({
      error: {
        kind: "request_error",
        code: "B4_E5402",
        details: { code: "response_schema_not_supported" },
        message: expect.stringContaining('"google"'),
      },
    })
    expect(aimock.getRequests()).toHaveLength(0)
    const thread = await fetch(`http://127.0.0.1:${port}/threads/google-rejected`)
    expect(thread.status).toBe(404)
  }, 60_000)

  it("rejects the run with 422 on a route that is not an agent", async () => {
    const { port } = await setupRuntime({
      "src/app/echo/index.ts": "export const graph = async (input) => input\n",
    })

    const { response, json } = await postRun(port, "/echo#graph", {
      threadId: "graph-rejected",
      runId: "r1",
      hashbrown: { ui: true, responseSchema: uiSchema },
    })

    expect(response.status).toBe(422)
    expect(json()).toMatchObject({
      error: {
        code: "B4_E5402",
        details: { code: "response_schema_not_supported" },
        message: expect.stringContaining("agent"),
      },
    })
  }, 60_000)
})
