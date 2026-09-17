import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadsStore } from "@b4run/sqlite-storage"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"
import { createRuntimeFetchHandler as createNodeRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import type { RequestStores } from "../src/lib/dev/runtime-server.js"
import {
  fakeMemoryStore,
  fakePermissionsStore,
  memoryThreadsStore,
} from "./helpers/fetch-entry-fixture.js"
import { cleanup } from "./helpers/static-modules-fixture.js"

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  vi.restoreAllMocks()
})

interface ReadinessBody {
  readonly status: "ready" | "not_ready"
  readonly checks: Record<
    string,
    | { readonly status: "ok" }
    | { readonly status: "failed"; readonly error: string; readonly code?: string }
  >
}

function healthyStores(): RequestStores {
  return {
    checkpointer: new MemorySaver(),
    memoryStore: fakeMemoryStore(),
    permissionsStore: fakePermissionsStore(),
    threadsStore: memoryThreadsStore().store,
  }
}

/** The edge shape: no filesystem fallback, so the factory is the only source of stores. */
async function edgeHandler(
  requestStores: (request: Request) => RequestStores | Promise<RequestStores>,
) {
  const handler = await createRuntimeFetchHandler({
    appRoot: "/ns",
    modules: { routes: [] },
    requestStores,
  })
  cleanup.push(() => handler.close())
  return handler
}

/**
 * `/healthz` is process liveness and `/readyz` is dependency readiness (#688).
 * On the vercel target the per-request store factory used to run for EVERY
 * request, health checks included, so a deployment with `DATABASE_URL` unset
 * looked completely down instead of "up, not ready".
 */
describe("liveness: GET /healthz", () => {
  it("answers 200 without ever calling the per-request store factory", async () => {
    const factory = vi.fn(() => {
      throw new Error("vercel target: DATABASE_URL is not set in the Vercel runtime environment")
    })
    const handler = await edgeHandler(factory)

    const response = await handler.fetch(new Request("http://x/healthz"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ready" })
    expect(factory).not.toHaveBeenCalled()
  })
})

describe("readiness: GET /readyz", () => {
  it("answers 200 when every store answers, and disposes them afterwards", async () => {
    const disposed: number[] = []
    const ready = vi.fn(async () => {})
    const handler = await edgeHandler(async () => {
      const stores = healthyStores()
      // A store that can migrate (the Postgres trio) exposes `ready()`; the
      // probe must exercise it so a fresh database reports ready only once its
      // schema is in place.
      Object.assign(stores.threadsStore as ThreadsStore, { ready })
      return { ...stores, dispose: async () => void disposed.push(1) }
    })

    const response = await handler.fetch(new Request("http://x/readyz"))

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = (await response.json()) as ReadinessBody
    expect(body).toEqual({
      checks: {
        checkpointer: { status: "ok" },
        permissionsStore: { status: "ok" },
        threadsStore: { status: "ok" },
      },
      status: "ready",
    })
    expect(ready).toHaveBeenCalledTimes(1)
    expect(disposed).toEqual([1])
  })

  it("reports a throwing store factory by name, with connection credentials redacted", async () => {
    const errors: string[] = []
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    const handler = await edgeHandler(() => {
      throw new Error("connect to postgres://app:s3cret@db.internal:5432/b4 failed: ECONNREFUSED")
    })

    const response = await handler.fetch(new Request("http://x/readyz"))

    expect(response.status).toBe(503)
    const body = (await response.json()) as ReadinessBody
    expect(body.status).toBe("not_ready")
    const check = body.checks.requestStores
    expect(check?.status).toBe("failed")
    if (check?.status !== "failed") throw new Error("unreachable")
    expect(check.error).toContain("postgres://***@db.internal:5432/b4")
    expect(check.error).toContain("ECONNREFUSED")
    expect(check.error).not.toContain("s3cret")
    expect(JSON.stringify(body)).not.toContain("s3cret")
    // The operator still gets the cause on stderr, redacted the same way and
    // once per distinct failure — a probe fires every few seconds.
    await handler.fetch(new Request("http://x/readyz"))
    const logged = errors.filter((line) => line.includes("ECONNREFUSED"))
    expect(logged).toHaveLength(1)
    expect(logged[0]).not.toContain("s3cret")
  })

  it("names the host behind an ErrorEvent instead of reporting [object ErrorEvent]", async () => {
    // `@neondatabase/serverless` rejects a failed WebSocket connect with the
    // socket's ErrorEvent — not an Error, with the real cause on `.error` and
    // `String(event)` equal to "[object ErrorEvent]" (#689). That is the single
    // most likely thing `/readyz` has to report, so it must not be the one
    // failure the probe cannot name.
    class ErrorEvent {
      readonly type = "error"
      constructor(
        readonly message: string,
        readonly error: unknown,
      ) {}
    }
    const socketError = Object.assign(
      new Error("connect ECONNREFUSED postgres://app:s3cret@10.0.0.7:5432/b4"),
      { code: "ECONNREFUSED" },
    )
    const handler = await edgeHandler(() => {
      throw new ErrorEvent("WebSocket connection failed", socketError)
    })

    const response = await handler.fetch(new Request("http://x/readyz"))

    expect(response.status).toBe(503)
    const body = (await response.json()) as ReadinessBody
    const check = body.checks.requestStores
    if (check?.status !== "failed") throw new Error("unreachable")
    expect(check.error).not.toContain("[object")
    expect(check.error).toContain("ErrorEvent: WebSocket connection failed")
    expect(check.error).toContain("caused by: connect ECONNREFUSED")
    expect(check.error).toContain("(ECONNREFUSED)")
    // Redaction runs over the whole rendered chain, not just a top-level message.
    expect(check.error).toContain("postgres://***@10.0.0.7:5432/b4")
    expect(JSON.stringify(body)).not.toContain("s3cret")
  })

  it("names the one store that fails and still reports the others", async () => {
    const handler = await edgeHandler(() => {
      const stores = healthyStores()
      const threadsStore: ThreadsStore = {
        ...(stores.threadsStore as ThreadsStore),
        getThread: async () => {
          throw new Error('relation "b4_threads" does not exist')
        },
      }
      return { ...stores, threadsStore }
    })

    const response = await handler.fetch(new Request("http://x/readyz"))

    expect(response.status).toBe(503)
    const body = (await response.json()) as ReadinessBody
    expect(body.status).toBe("not_ready")
    expect(body.checks.checkpointer).toEqual({ status: "ok" })
    expect(body.checks.permissionsStore).toEqual({ status: "ok" })
    expect(body.checks.threadsStore).toEqual({
      error: 'relation "b4_threads" does not exist',
      status: "failed",
    })
  })

  it("names a store the factory omitted, with its registry code", async () => {
    const handler = await edgeHandler(() => ({ checkpointer: new MemorySaver() }))

    const response = await handler.fetch(new Request("http://x/readyz"))

    expect(response.status).toBe(503)
    const body = (await response.json()) as ReadinessBody
    expect(body.checks.checkpointer).toEqual({ status: "ok" })
    expect(body.checks.threadsStore).toMatchObject({ code: "B4_E5301", status: "failed" })
    expect(body.checks.permissionsStore).toMatchObject({ code: "B4_E5301", status: "failed" })
  })

  it("answers 200 on the node runtime, against its boot-resolved stores", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-health-probes-"))
    cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
    const files: Record<string, string> = {
      "b4.config.ts": "export default {}\n",
      "package.json": '{ "name": "health-probes-fixture", "type": "module" }\n',
      "src/app/noop/index.ts": "export const graph = async () => ({ ok: true })\n",
    }
    for (const [rel, body] of Object.entries(files)) {
      const filePath = join(appRoot, rel)
      await mkdir(join(filePath, ".."), { recursive: true })
      await writeFile(filePath, body, "utf8")
    }
    const handler = await createNodeRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    expect((await handler.fetch(new Request("http://x/healthz"))).status).toBe(200)
    const response = await handler.fetch(new Request("http://x/readyz"))
    expect(response.status).toBe(200)
    expect((await response.json()) as ReadinessBody).toEqual({
      checks: {
        checkpointer: { status: "ok" },
        permissionsStore: { status: "ok" },
        threadsStore: { status: "ok" },
      },
      status: "ready",
    })
  }, 60_000)
})
