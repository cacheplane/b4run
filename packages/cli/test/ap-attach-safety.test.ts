import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { B4Middleware, ThreadAccessPolicy } from "@b4run/sdk"
import { createThreadsStore } from "@b4run/sqlite-storage"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as liveTurns from "../src/lib/dev/live-turn-hub.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { buildStaticRouteModule } from "../src/lib/runtime/static-modules-core.js"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  vi.restoreAllMocks()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const request = (signal?: AbortSignal) =>
  new Request("http://localhost/threads/t/runs/stream", signal ? { signal } : {})
const allow: B4Middleware = () => ({ action: "continue" })

async function setup(
  options: {
    middleware?: B4Middleware
    threadAccess?: ThreadAccessPolicy
    metadata?: Record<string, unknown>
    graph?: () => Promise<unknown>
  } = {},
) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-attach-safety-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const hub = liveTurns.createLiveTurnHub({ subscriberMaxFrames: 2 })
  vi.spyOn(liveTurns, "createLiveTurnHub").mockReturnValue(hub)
  const threadsStore = createThreadsStore({ path: join(appRoot, "threads.sqlite") })
  await threadsStore.createThread({
    thread_id: "t",
    metadata: options.metadata ?? { route: "/public#graph" },
  })
  const handler = await createRuntimeFetchHandler({
    appRoot,
    config: {},
    threadsStore,
    middleware: options.middleware ?? allow,
    ...(options.threadAccess ? { threadAccess: options.threadAccess } : {}),
    apAttachMaxViewers: 1,
    apSseHeartbeatIntervalMs: 60_000,
    drainDeadlineMs: 10,
    modules: {
      routes: ["public", "admin"].map((name) =>
        buildStaticRouteModule({
          kind: "graph",
          routeId: `/${name}`,
          routeFile: `${appRoot}/src/app/${name}/index.ts`,
          routePath: `src/app/${name}/index.ts`,
          routeModule: { graph: options.graph ?? (async () => ({ ok: true })) },
          tools: [],
        }),
      ),
    },
  })
  cleanup.push(() => handler.close())
  const open = (
    routeKey = "/public#graph",
    input = "public input",
    anchorRouteKeys: string[] = [],
  ) =>
    hub.open({
      threadId: "t",
      routeKey,
      anchorRouteKeys,
      anchorCheckpointId: null,
      input,
      resume: false,
      runStartedAt: "2020-01-01T00:00:00.000Z",
    })
  return { handler, hub, open, threadsStore }
}

async function firstFrame(response: Response) {
  const reader = response.body!.getReader()
  const value = await reader.read()
  expect(new TextDecoder().decode(value.value)).toContain("event: state")
  return reader
}

describe("attach authorization binds the selected turn", () => {
  it("records the producing route on an actual POST turn independently of parked metadata", async () => {
    const entered = deferred()
    const release = deferred()
    const { handler } = await setup({
      metadata: { parked_route: "/public#graph", route: "/public#graph" },
      graph: async () => {
        entered.resolve()
        await release.promise
        return { ok: true }
      },
      middleware: (r) =>
        r.method === "GET" && r.routeId === "/admin"
          ? { action: "reject", status: 403, body: "denied" }
          : { action: "continue" },
    })
    const primary = await handler.fetch(
      new Request("http://localhost/threads/t/runs/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "/admin#graph", input: "private input" }),
      }),
    )
    try {
      await entered.promise
      expect((await handler.fetch(request())).status).toBe(403)
    } finally {
      release.resolve()
      await primary.text()
    }
  })

  it("fails closed for a known anchor without recorded pre-run route metadata", async () => {
    const { handler, hub } = await setup()
    hub.open({
      threadId: "t",
      routeKey: "/public#graph",
      anchorRouteKeys: [],
      anchorCheckpointId: "unknown-owner",
      runStartedAt: "x",
      resume: false,
      input: null,
    })
    const response = await handler.fetch(request())
    expect(response.status).toBe(409)
    expect(await response.text()).toContain("thread_route_unknown")
  })

  it("gates a live admin turn even when the parked route is public", async () => {
    const { handler, open } = await setup({
      metadata: { parked_route: "/public#graph", route: "/admin#graph" },
      middleware: (r) =>
        r.routeId === "/admin"
          ? { action: "reject", status: 403, body: "denied" }
          : { action: "continue" },
    })
    open("/admin#graph", "admin secret")
    const response = await handler.fetch(request())
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain("admin secret")
  })

  it("requires the captured anchor route as well as the producing route", async () => {
    const { handler, open } = await setup({
      middleware: (r) =>
        r.routeId === "/admin"
          ? { action: "reject", status: 403, body: "denied" }
          : { action: "continue" },
    })
    open("/public#graph", "public input", ["/admin#graph"])
    expect((await handler.fetch(request())).status).toBe(403)
  })

  it("requires both parked and last-run route middleware", async () => {
    const { handler } = await setup({
      metadata: { parked_route: "/public#graph", route: "/admin#graph" },
      middleware: (r) =>
        r.routeId === "/admin"
          ? { action: "reject", status: 403, body: "denied" }
          : { action: "continue" },
    })
    expect((await handler.fetch(request())).status).toBe(403)
  })

  it("does not switch to a new route while selected-turn middleware is awaiting", async () => {
    const entered = deferred()
    const release = deferred()
    const { handler, open } = await setup({
      middleware: async () => {
        entered.resolve()
        await release.promise
        return { action: "continue" }
      },
    })
    open()
    const pending = handler.fetch(request())
    await entered.promise
    const admin = open("/admin#graph", "admin secret")
    admin.publish({ type: "chunk", data: "admin frame" })
    release.resolve()
    const response = await pending
    admin.close({ type: "done", output: null })
    const text = await response.text()
    expect(text).toContain("public input")
    expect(text).not.toContain("admin secret")
    expect(text).not.toContain("admin frame")
  })

  it("makes a denied read indistinguishable from a missing thread before route middleware", async () => {
    const middleware = vi.fn(allow)
    const read = vi.fn(() => ({ decision: "deny" as const }))
    const { handler } = await setup({ middleware, threadAccess: { fallback: read } })
    const denied = await handler.fetch(request())
    const missing = await handler.fetch(new Request("http://localhost/threads/missing/runs/stream"))
    expect(denied.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await denied.text()).toBe(await missing.text())
    expect(middleware).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("does not let an allowed thread read bypass route middleware", async () => {
    const { handler, open } = await setup({
      threadAccess: { fallback: () => ({ decision: "allow" }) },
      middleware: () => ({ action: "reject", status: 403, body: "route denied" }),
    })
    open()
    expect((await handler.fetch(request())).status).toBe(403)
  })
})

describe("attach disconnect and backpressure", () => {
  it("cancel frees the viewer and heartbeat while leaving the producer alive", async () => {
    const { handler, open } = await setup()
    const producer = open()
    const response = await handler.fetch(request())
    const reader = await firstFrame(response)
    const clear = vi.spyOn(globalThis, "clearInterval")
    await reader.cancel()
    expect(clear).toHaveBeenCalled()
    const next = await handler.fetch(request())
    const nextReader = await firstFrame(next)
    producer.publish({ type: "chunk", data: "still running" })
    expect(new TextDecoder().decode((await nextReader.read()).value)).toContain("still running")
    await nextReader.cancel()
  })

  it("request abort wakes a pending read and releases the viewer without stopping the producer", async () => {
    const { handler, open } = await setup()
    const producer = open()
    const abort = new AbortController()
    const reader = await firstFrame(await handler.fetch(request(abort.signal)))
    const waiting = reader.read()
    abort.abort()
    expect(await Promise.race([waiting.then((r) => r.done), tick().then(() => "blocked")])).toBe(
      true,
    )
    const next = await handler.fetch(request())
    const nextReader = await firstFrame(next)
    producer.publish({ type: "chunk", data: "alive" })
    expect(new TextDecoder().decode((await nextReader.read()).value)).toContain("alive")
    await nextReader.cancel()
  })

  it.each([false, true])(
    "bounds a lagging viewer after reading the initial state: %s",
    async (readState) => {
      const { handler, open } = await setup()
      const producer = open()
      const response = await handler.fetch(request())
      const reader = readState ? await firstFrame(response) : undefined
      reader?.releaseLock()
      for (let i = 0; i < 12; i++) {
        producer.publish({ type: "chunk", data: `frame-${i}` })
        await tick()
      }
      producer.close({ type: "done", output: null })
      let text = ""
      const tail = response.body!.getReader()
      for (;;) {
        const next = await tail.read()
        if (next.done) break
        text += new TextDecoder().decode(next.value)
      }
      expect(text).toContain('event: detached\ndata: {"reason":"overflow"}')
      expect((text.match(/event: chunk/g) ?? []).length).toBeLessThan(6)
    },
  )
})
