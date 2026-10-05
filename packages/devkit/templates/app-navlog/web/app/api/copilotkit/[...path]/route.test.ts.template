import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The CopilotKit route forwards the visitor id (and, when deployed, the
 * internal token) on EVERY upstream call, including the ones CopilotKit makes
 * after the handler has returned its streaming response. The agent is shared
 * across requests, so the id travels through `AsyncLocalStorage`; this pins
 * that it survives into the run and the capabilities read.
 */
const seen: { method: string; headers: IncomingHttpHeaders }[] = []
let server: Server
let route: typeof import("./route")

function runRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://navlog.test/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      threadId: "t-1",
      runId: "r-1",
      state: {},
      messages: [{ id: "m-1", role: "user", content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  })
}

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({ method: request.method ?? "", headers: request.headers })
    request.resume()
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ tools: { supported: true } }))
      return
    }
    const events = [
      { type: "RUN_STARTED", threadId: "t-1", runId: "r-1" },
      { type: "RUN_FINISHED", threadId: "t-1", runId: "r-1" },
    ]
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  vi.stubEnv("B4_SERVER_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  route = await import("./route")
})

afterAll(async () => {
  vi.unstubAllEnvs()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  seen.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("copilotkit proxy route", () => {
  test("a run carries the visitor id from the cookie, and the token when deployed", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "server-secret")
    const response = await route.POST(runRequest({ cookie: "__Host-b4_visitor=v-returning01" }))
    await response.text()

    expect(response.status).toBe(200)
    expect(seen.map((entry) => entry.method)).toEqual(["POST"])
    expect(seen[0]?.headers["x-b4-visitor"]).toBe("v-returning01")
    expect(seen[0]?.headers["x-internal-token"]).toBe("server-secret")
  })

  test("a first visit mints the cookie and forwards that same id, with no token in development", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "")
    const response = await route.POST(runRequest())
    await response.text()

    const minted = /b4_visitor=(v-[A-Za-z0-9_-]+)/.exec(
      response.headers.get("set-cookie") ?? "",
    )?.[1]
    expect(minted).toBeDefined()
    expect(seen[0]?.headers["x-b4-visitor"]).toBe(minted)
    expect(seen[0]?.headers["x-internal-token"]).toBeUndefined()
  })

  test("the capabilities read behind /info carries the visitor id too", async () => {
    const response = await route.GET(
      new Request("http://navlog.test/api/copilotkit/info", {
        headers: { cookie: "b4_visitor=v-returning01" },
      }),
    )
    await response.text()

    expect(response.status).toBe(200)
    expect(seen.map((entry) => entry.method)).toEqual(["GET"])
    expect(seen[0]?.headers["x-b4-visitor"]).toBe("v-returning01")
  })

  test("a cross-origin call is refused before anything reaches the server", async () => {
    vi.stubEnv("B4_DEMO_ORIGINS", "https://navlog.b4.run")
    const response = await route.POST(runRequest({ origin: "https://evil.example" }))

    expect(response.status).toBe(403)
    expect(seen).toHaveLength(0)
  })
})
