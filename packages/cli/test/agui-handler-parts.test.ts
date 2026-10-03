import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { MiddlewareAfterRun } from "@b4run/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    cleanup.push(() => warn.mockRestore())
    // gpt-5-mini takes the image but not the audio: the audio is the one drop.
    await withAimock(script().user("see").replies("I see it.").build())
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
    const dropWarnings = warn.mock.calls.filter(
      ([message]) => typeof message === "string" && message.includes("content part(s)"),
    )
    expect(dropWarnings).toHaveLength(1)
    expect(dropWarnings[0]?.[0]).toContain(
      "dropped 1 content part(s) the model cannot use (openai/gpt-5-mini): audio/data (modality_unsupported)",
    )
    expect(dropWarnings[0]?.[0]).toContain("GET /agui/")
  }, 30_000)
})
