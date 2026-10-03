import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { MiddlewareAfterRun } from "@b4run/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"

// The real adapter by default; one test substitutes a stream to put a
// subagent's drop through the CLI's chunk switch without a subagent fixture.
const langchainMocks = vi.hoisted(() => ({ streamAgent: vi.fn() }))
vi.mock("@b4run/langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@b4run/langchain")>()
  langchainMocks.streamAgent.mockImplementation(actual.streamAgent)
  return { ...actual, streamAgent: langchainMocks.streamAgent }
})

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// A graph route that echoes the content it was given, so the test can see what
// crossed the handler without a model.
const ECHO_ROUTE =
  "export const graph = async (input) => ({ echoed: input.messages?.[0]?.content ?? null })\n"

const AGENT_ROUTE =
  'import { agent } from "@b4run/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n'

async function fixtureApp(prefix: string, routes: Record<string, string>): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "agui-parts-fixture", "type": "module" }\n',
    ...routes,
  }
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(dirname(join(appRoot, rel)), { recursive: true })
    await writeFile(join(appRoot, rel), src, "utf8")
  }
  return appRoot
}

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock for the test's duration. */
async function withAimock(
  fixtures: ReturnType<ReturnType<typeof script>["build"]>,
): Promise<Awaited<ReturnType<typeof createAimock>>> {
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
  return aimock
}

/**
 * Spy on console.warn, keeping the dropped-parts warnings and forwarding every
 * other warning to the real console so unrelated ones are not silenced.
 */
function captureDropWarnings(): string[] {
  const original = console.warn.bind(console)
  const drops: string[] = []
  const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const [message] = args
    if (typeof message === "string" && message.includes("content part(s)")) drops.push(message)
    else original(...args)
  })
  cleanup.push(() => spy.mockRestore())
  return drops
}

function runRequest(routeKey: string, threadId: string, content: unknown): Request {
  return new Request(`http://localhost/agui/${encodeURIComponent(routeKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      threadId,
      runId: `${threadId}-run`,
      messages: [{ id: "1", role: "user", content }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  })
}

const parts = [
  { type: "text", text: "see" },
  { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
]

describe("content parts through the AG-UI handler", () => {
  it("reaches the route as parts, not as text or [object Object]", async () => {
    const appRoot = await fixtureApp("b4-agui-parts-", { "src/app/echo/index.ts": ECHO_ROUTE })
    const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(runRequest("/echo#graph", "t-1", parts))

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain(JSON.stringify(parts))
    expect(body).not.toContain("[object Object]")
  })

  it("after-middleware sees the parts the client sent", async () => {
    const seen: MiddlewareAfterRun["messages"][number]["content"][] = []
    const appRoot = await fixtureApp("b4-agui-parts-mw-", { "src/app/echo/index.ts": ECHO_ROUTE })
    const handler = await createRuntimeFetchHandler({
      appRoot,
      drainDeadlineMs: 250,
      middleware: {
        handle: () => ({ action: "continue" }),
        after: (run) => {
          seen.push(run.messages[0]?.content ?? "")
        },
      },
    })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(runRequest("/echo#graph", "t-2", parts))
    expect(response.status).toBe(200)
    await response.text()

    expect(seen).toEqual([parts])
  })

  it("logs a dropped part on the server and announces it on the stream", async () => {
    const drops = captureDropWarnings()
    // gpt-5-mini takes the image but not the audio: the audio is the one drop.
    const aimock = await withAimock(script().user("see").replies("I see it.").build())
    const appRoot = await fixtureApp("b4-agui-parts-drop-", {
      "src/app/chat/index.ts": AGENT_ROUTE,
    })
    const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(
      runRequest("/chat#agent", "t-3", [
        ...parts,
        { type: "audio", source: { type: "data", value: "AAAA", mimeType: "audio/wav" } },
      ]),
    )
    expect(response.status).toBe(200)
    const body = await response.text()

    expect(body).toContain('"name":"b4.content_parts_dropped"')
    expect(drops).toHaveLength(1)
    expect(drops[0]).toBe(
      "B4: dropped 1 content part(s) the model cannot use (openai/gpt-5-mini) on route /chat#agent: audio/data (modality_unsupported).",
    )
    // The image was carried: the forwarded OpenAI request has an image_url block.
    const forwarded = JSON.stringify(aimock.getRequests().map((request) => request.body))
    expect(forwarded).toContain('"type":"image_url"')
    expect(forwarded).not.toContain("audio/wav")
  }, 30_000)

  it("logs a subagent's dropped part too, naming the parent route", async () => {
    const drops = captureDropWarnings()
    await withAimock(script().build())
    langchainMocks.streamAgent.mockImplementationOnce(async function* () {
      yield {
        type: "subagent.content_parts_dropped",
        data: {
          provider: "openai",
          model: "gpt-5-mini",
          toolCallId: "child-call-1",
          parts: [
            { index: 0, type: "video", source: "data", reason: "tool_result_media_unsupported" },
          ],
          call_id: "task-1",
          subagent: "researcher",
          route_id: "/researcher",
          depth: 1,
        },
      }
      yield { type: "done", data: {} }
    })
    const appRoot = await fixtureApp("b4-agui-parts-sub-", { "src/app/chat/index.ts": AGENT_ROUTE })
    const handler = await createRuntimeFetchHandler({ appRoot, drainDeadlineMs: 250 })
    cleanup.push(() => handler.close())

    const response = await handler.fetch(runRequest("/chat#agent", "t-4", "hi"))
    expect(response.status).toBe(200)
    await response.text()

    expect(langchainMocks.streamAgent).toHaveBeenCalled()
    expect(drops).toEqual([
      "B4: dropped 1 content part(s) the model cannot use (openai/gpt-5-mini) on route /chat#agent: video/data (tool_result_media_unsupported).",
    ])
  }, 30_000)
})
