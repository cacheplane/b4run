import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Agent, get } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test, vi } from "vitest"

import { VERCEL_RUNTIME_ROUTE_SRC } from "../src/lib/build/targets/vercel-compose.js"
import { serve, shutdownServe } from "../src/lib/dev/serve.js"
import {
  isRuntimeOwnedPath,
  RUNTIME_ROUTE_SEGMENTS,
  RUNTIME_ROUTE_SRC,
} from "../src/lib/runtime-routes.js"

const tempDirs: string[] = []
const handles: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("runtime route definition", () => {
  test("the Vercel route table and the path test come from one definition", () => {
    expect(VERCEL_RUNTIME_ROUTE_SRC).toBe(RUNTIME_ROUTE_SRC)
    expect(RUNTIME_ROUTE_SRC).toBe("/(healthz|readyz|agui|threads|memory)(/.*)?")
  })

  test("every runtime segment is owned, rooted and nested", () => {
    for (const segment of RUNTIME_ROUTE_SEGMENTS) {
      expect(isRuntimeOwnedPath(`/${segment}`)).toBe(true)
      expect(isRuntimeOwnedPath(`/${segment}/deep/path`)).toBe(true)
    }
  })

  test("a path that merely starts with a segment's letters is not owned", () => {
    expect(isRuntimeOwnedPath("/threadsafe")).toBe(false)
    expect(isRuntimeOwnedPath("/memorial")).toBe(false)
    expect(isRuntimeOwnedPath("/api/threads")).toBe(false)
    expect(isRuntimeOwnedPath("/")).toBe(false)
  })
})

describe("serve route split", () => {
  test("sends the runtime's own surfaces to the runtime, never to the fallback", async () => {
    const fallbackPaths: string[] = []
    const handle = await startServe(recordingFallback(fallbackPaths))

    const response = await fetch(new URL("/healthz", handle.url))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ready" })

    for (const segment of RUNTIME_ROUTE_SEGMENTS) {
      // Status varies per surface (some need a method or a body); what matters
      // is that the fallback never sees it.
      await fetch(new URL(`/${segment}`, handle.url)).catch(() => undefined)
      await fetch(new URL(`/${segment}/nested`, handle.url)).catch(() => undefined)
    }

    expect(fallbackPaths).toEqual([])
  })

  test("sends everything else to the fallback, query string and all", async () => {
    const fallbackPaths: string[] = []
    const handle = await startServe(recordingFallback(fallbackPaths))

    const response = await fetch(new URL("/api/invoices?status=open", handle.url))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("fallback")

    // A near-miss on a runtime segment belongs to the app, not the runtime.
    expect((await fetch(new URL("/threadsafe", handle.url))).status).toBe(200)

    expect(fallbackPaths).toEqual(["/api/invoices?status=open", "/threadsafe"])
  })

  test("without a fallback the runtime answers every path", async () => {
    const handle = await startServe(undefined)

    expect((await fetch(new URL("/healthz", handle.url))).status).toBe(200)
    expect((await fetch(new URL("/not-a-runtime-route", handle.url))).status).toBe(404)
  })
})

describe("serve lifecycle", () => {
  test("logs the address once it is listening", async () => {
    const logged: string[] = []
    const handle = await startServe(undefined, { onListening: (url) => logged.push(url) })

    expect(logged).toEqual([handle.url])
  })

  test("installs signal handlers by default and removes them on close", async () => {
    const sigintBefore = process.listenerCount("SIGINT")
    const sigtermBefore = process.listenerCount("SIGTERM")

    const handle = await startServe(undefined, { defaultSignalHandlers: true })

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1)
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1)

    await handle.close()

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore)
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore)
  })

  test("close() is idempotent and stops accepting new connections", async () => {
    const handle = await startServe(undefined)

    await handle.close()
    await handle.close()

    await expect(fetch(new URL("/healthz", handle.url))).rejects.toThrow()
  })

  test("close() resolves even while a connection is still held open", async () => {
    // A fallback that never answers: the socket stays attached to the server,
    // so `server.close()` alone never settles. Dropping the connections is the
    // step that makes a dev-server Ctrl-C terminate instead of hang.
    let received: ServerResponse | undefined
    const handle = await startServe((_request, response) => {
      received = response
    })
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })

    const inFlight = keepAliveGet(handle.url, "/api/never", agent).catch(() => undefined)
    await vi.waitUntil(() => received !== undefined, { timeout: 5_000 })

    await expect(handle.close()).resolves.toBeUndefined()
    await inFlight
    agent.destroy()
  }, 15_000)
})

describe("shutdownServe ordering", () => {
  test("stops accepting, then closes the runtime, then drops connections", async () => {
    const order: string[] = []
    let resolveServerClosed: (() => void) | undefined

    await shutdownServe({
      closeRuntime: async () => {
        order.push("closeRuntime")
      },
      dropConnections: () => {
        order.push("dropConnections")
        resolveServerClosed?.()
      },
      stopAccepting: () => {
        order.push("stopAccepting")
        // The server only finishes closing once its sockets are gone, which is
        // what dropConnections is for: awaiting this first would deadlock.
        return new Promise<void>((resolve) => {
          resolveServerClosed = resolve
        })
      },
    })

    expect(order).toEqual(["stopAccepting", "closeRuntime", "dropConnections"])
  })

  test("waits for the server to finish closing before resolving", async () => {
    let serverClosed = false

    await shutdownServe({
      closeRuntime: async () => undefined,
      dropConnections: () => undefined,
      stopAccepting: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        serverClosed = true
      },
    })

    expect(serverClosed).toBe(true)
  })
})

async function keepAliveGet(baseUrl: string, path: string, agent: Agent): Promise<void> {
  const target = new URL(path, baseUrl)
  await new Promise<void>((resolve, reject) => {
    const request = get(
      { agent, host: target.hostname, path: target.pathname, port: target.port },
      (response) => {
        response.resume()
        response.once("end", resolve)
      },
    )
    request.once("error", reject)
  })
}

function recordingFallback(paths: string[]) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    paths.push(request.url ?? "")
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("fallback")
  }
}

async function startServe(
  fallback: ((request: IncomingMessage, response: ServerResponse) => void) | undefined,
  overrides: {
    readonly onListening?: (url: string) => void
    /** Omit `installSignalHandlers` entirely, to exercise the default. */
    readonly defaultSignalHandlers?: boolean
  } = {},
) {
  const appRoot = await createFixtureApp({
    "b4.config.ts": "export default {};\n",
    "package.json": '{"type":"module"}\n',
    "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
  })

  const handle = await serve({
    appRoot,
    host: "127.0.0.1",
    ...(overrides.defaultSignalHandlers === true ? {} : { installSignalHandlers: false }),
    onListening: overrides.onListening ?? (() => undefined),
    port: 0,
    ...(fallback ? { fallback } : {}),
  })
  handles.push(handle)
  return handle
}

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-cli-serve-helper-"))
  tempDirs.push(appRoot)

  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(join(filePath, ".."), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )

  return appRoot
}
