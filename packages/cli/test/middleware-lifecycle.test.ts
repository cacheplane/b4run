import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MiddlewareDefinition, reject } from "@b4run/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

// ---------------------------------------------------------------------------
// The runtime half of middleware lifecycle hooks (issue #683): a request is
// what triggers `setup`, and the fetch handler's `close()` — the one shutdown
// path `b4 dev`, `b4 start` and the generated server.mjs all funnel into — is
// what triggers `dispose`. The pure single-flight/retry semantics live in
// middleware.test.ts; this file proves the wiring.
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixtureApp(): Promise<string> {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "b4-middleware-lifecycle-")))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "middleware-lifecycle-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@b4run/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** A gated request that never reaches a model: the middleware answers it. */
function aguiRequest(threadId: string): Request {
  const routeKey = encodeURIComponent("/chat#agent")
  return new Request(`http://localhost/agui/${routeKey}`, {
    body: JSON.stringify({
      context: [],
      forwardedProps: {},
      messages: [{ id: "1", role: "user", content: "hello" }],
      runId: `run-${threadId}`,
      state: {},
      threadId,
      tools: [],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

describe("middleware lifecycle — runtime wiring", () => {
  it("runs setup on the first gated request, not at boot, and dispose on close()", async () => {
    const appRoot = await fixtureApp()
    const events: string[] = []
    const middleware: MiddlewareDefinition = {
      setup: (ctx) => {
        events.push(`setup:${ctx.appRoot}`)
      },
      dispose: () => {
        events.push("dispose")
      },
      handle: () => {
        events.push("handle")
        return { action: "reject", body: { error: "nope" }, status: 401 }
      },
    }

    const handler = await createRuntimeFetchHandler({ appRoot, middleware })
    expect(events).toEqual([])

    const first = await handler.fetch(aguiRequest("th-1"))
    expect(first.status).toBe(401)
    const second = await handler.fetch(aguiRequest("th-2"))
    expect(second.status).toBe(401)
    expect(events).toEqual([`setup:${appRoot}`, "handle", "handle"])

    await handler.close()
    expect(events).toEqual([`setup:${appRoot}`, "handle", "handle", "dispose"])

    // close() is idempotent, and so is the dispose it drives.
    await handler.close()
    expect(events.filter((e) => e === "dispose")).toHaveLength(1)
  })

  it("a failed setup answers that request with 500 and is retried on the next", async () => {
    const appRoot = await fixtureApp()
    let attempts = 0
    const middleware: MiddlewareDefinition = {
      setup: () => {
        attempts++
        if (attempts === 1) throw new Error("db down")
      },
      handle: () => ({ action: "reject", body: { error: "nope" }, status: 401 }),
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    cleanup.push(async () => errorSpy.mockRestore())

    const handler = await createRuntimeFetchHandler({ appRoot, middleware })
    cleanup.push(() => handler.close())

    const failed = await handler.fetch(aguiRequest("th-1"))
    expect(failed.status).toBe(500)
    // Opaque to the caller, named on stderr for the operator.
    expect(await failed.text()).not.toContain("db down")
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("db down")

    const retried = await handler.fetch(aguiRequest("th-2"))
    expect(retried.status).toBe(401)
    expect(attempts).toBe(2)
  })

  it("does not invoke dispose when no request ever triggered setup", async () => {
    const appRoot = await fixtureApp()
    const dispose = vi.fn()
    const handler = await createRuntimeFetchHandler({
      appRoot,
      middleware: { setup: () => undefined, dispose, handle: () => ({ action: "continue" }) },
    })
    await handler.close()
    expect(dispose).not.toHaveBeenCalled()
  })

  it("a dispose that throws is logged and does not fail close()", async () => {
    const appRoot = await fixtureApp()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    cleanup.push(async () => errorSpy.mockRestore())
    const handler = await createRuntimeFetchHandler({
      appRoot,
      middleware: {
        dispose: () => {
          throw new Error("pool.end exploded")
        },
        handle: () => ({ action: "continue" }),
      },
    })
    await expect(handler.close()).resolves.toBeUndefined()
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("pool.end exploded")
  })
})

// ---------------------------------------------------------------------------
// A body-less reject must reach the wire as the status the app asked for.
// `reject(403)` with the body omitted is documented in the middleware docs;
// it used to answer 500 because `Response.json(undefined)` throws.
// ---------------------------------------------------------------------------

describe("middleware reject with no body", () => {
  /** The three endpoints an app gates: AG-UI, and both AP run endpoints. */
  function gatedRequests(threadId: string): Array<{ label: string; request: Request }> {
    const apBody = JSON.stringify({ input: {}, route: "/chat#agent" })
    const apInit = {
      body: apBody,
      headers: { "content-type": "application/json" },
      method: "POST",
    } as const
    return [
      { label: "AG-UI", request: aguiRequest(threadId) },
      {
        label: "AP runs/stream",
        request: new Request(`http://localhost/threads/${threadId}/runs/stream`, apInit),
      },
      {
        label: "AP runs/wait",
        request: new Request(`http://localhost/threads/${threadId}/runs/wait`, apInit),
      },
    ]
  }

  it("answers the requested status, not a 500, on every gated endpoint", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({
      appRoot,
      middleware: () => reject(401),
    })
    cleanup.push(() => handler.close())

    let index = 0
    for (const { label, request } of gatedRequests("th-no-body")) {
      const response = await handler.fetch(request)
      expect(`${label}:${response.status}`).toBe(`${label}:401`)
      // Empty payload under the JSON content-type, matching `reject(401, body)`
      // minus the body — never an "Unexpected runtime server failure" page.
      expect(await response.text()).toBe("")
      expect(response.headers.get("content-type")).toBe("application/json")
      index++
    }
    expect(index).toBe(3)
  })

  it("still carries a body when the middleware supplies one", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({
      appRoot,
      middleware: () => reject(403, { error: "nope" }),
    })
    cleanup.push(() => handler.close())

    for (const { label, request } of gatedRequests("th-with-body")) {
      const response = await handler.fetch(request)
      expect(`${label}:${response.status}`).toBe(`${label}:403`)
      expect(await response.json()).toEqual({ error: "nope" })
    }
  })
})
