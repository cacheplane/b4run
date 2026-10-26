import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import {
  createPostgresClientToolCallStore,
  createPostgresInterruptGrantStore,
  createPostgresPermissionsStore,
  createPostgresPool,
  createPostgresRunAdmission,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "../../postgres-storage/dist/node.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.ts"
import {
  chatFixtureApp,
  fakeMemoryStore,
  inMemoryFilesystem,
} from "./helpers/fetch-entry-fixture.ts"
import {
  buildStaticModulesForFixture,
  cleanup,
  withAimock,
} from "./helpers/static-modules-fixture.ts"

const enabled = process.env.B4_TEST_PGSTORAGE === "1"
let container: StartedPostgreSqlContainer

beforeAll(async () => {
  if (enabled)
    container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
}, 240_000)

afterAll(async () => {
  await container?.stop()
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function barrier() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const resumed = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    wait: async () => {
      enter()
      await resumed
    },
  }
}

const hello = { id: "u1", role: "user", content: "hello" }
const browserTool = {
  name: "openPanel",
  description: "Open a panel",
  parameters: { type: "object", properties: { id: { type: "number" } } },
}
const callbackHistory = [
  hello,
  {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call_panel",
        type: "function",
        function: { name: "openPanel", arguments: '{"id":7}' },
      },
    ],
  },
  { id: "t1", role: "tool", toolCallId: "call_panel", content: "panel opened" },
]

function request(
  threadId: string,
  runId: string,
  messages: readonly unknown[],
  tools: readonly unknown[] = [],
) {
  return new Request(`http://localhost/agui/${encodeURIComponent("/chat#agent")}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      threadId,
      runId,
      messages,
      tools,
      context: [],
      state: {},
      forwardedProps: {},
    }),
  })
}

async function replicas(
  blocking = false,
  observe?: {
    saver: (
      saver: ReturnType<typeof postgresCheckpointer>,
    ) => ReturnType<typeof postgresCheckpointer>
    release: () => Promise<void>
  },
) {
  const tablePrefix = `runtime_${crypto.randomUUID().replaceAll("-", "")}`
  const inspectorPool = createPostgresPool({ connectionString: container.getConnectionUri() })
  cleanup.push(() => inspectorPool.end())
  const base = { pool: inspectorPool, tablePrefix }
  const inspector = postgresCheckpointer(base)
  const clientTools = createPostgresClientToolCallStore(base)
  const migrateAdmission = createPostgresRunAdmission(base)
  await inspector.ready()
  await clientTools.ready()
  await createPostgresThreadsStore(base).ready()
  await createPostgresPermissionsStore(base).ready()
  await createPostgresInterruptGrantStore(base).ready()
  await migrateAdmission.ready()
  await migrateAdmission.close()
  const appRoot = await chatFixtureApp()
  const execution = barrier()
  const executionKey = `__b4PgRuntimeBarrier_${crypto.randomUUID().replaceAll("-", "")}`
  if (blocking) {
    const globals = globalThis as unknown as Record<string, unknown>
    globals[executionKey] = execution
    cleanup.push(() => {
      delete globals[executionKey]
    })
    const routeDir = join(appRoot, "src/app/blocking")
    await mkdir(routeDir, { recursive: true })
    await writeFile(
      join(routeDir, "index.ts"),
      [
        "export const graph = async () => {",
        `  await globalThis[${JSON.stringify(executionKey)}].wait()`,
        "  return { ok: true }",
        "}",
      ].join("\n"),
    )
  }
  const modules = await buildStaticModulesForFixture(appRoot)
  const pools = new Set<ReturnType<typeof createPostgresPool>>()
  const disposed = new Set<ReturnType<typeof createPostgresPool>>()
  let hold: ReturnType<typeof barrier> | undefined
  const handlers = await Promise.all(
    [0, 1].map(() =>
      createRuntimeFetchHandler({
        appRoot,
        modules,
        drainDeadlineMs: 50,
        config: {
          backends: { filesystem: inMemoryFilesystem() },
          server: { agui: { clientTools: ["/chat"] } },
        },
        requestStores: () => {
          const raw = createPostgresPool({ connectionString: container.getConnectionUri() })
          pools.add(raw)
          const admission = createPostgresRunAdmission({
            pool: raw,
            tablePrefix,
            assumeMigrated: true,
          })
          const options = { pool: admission.pool, tablePrefix, assumeMigrated: true }
          let acquired = false
          return {
            checkpointer:
              observe?.saver(postgresCheckpointer(options)) ?? postgresCheckpointer(options),
            threadsStore: createPostgresThreadsStore(options),
            permissionsStore: createPostgresPermissionsStore(options),
            clientToolStore: createPostgresClientToolCallStore(options),
            interruptGrantStore: createPostgresInterruptGrantStore(options),
            memoryStore: fakeMemoryStore(),
            runAdmission: {
              signal: admission.signal,
              tryAcquire: async (threadId) => {
                acquired = await admission.tryAcquire(threadId)
                return acquired
              },
              release: async () => {
                if (acquired && hold) {
                  const active = hold
                  hold = undefined
                  await active.wait()
                }
                if (acquired) await observe?.release()
                await admission.release()
              },
            },
            dispose: async () => {
              try {
                await admission.close()
              } finally {
                await raw.end()
                disposed.add(raw)
              }
            },
          }
        },
      }),
    ),
  )
  cleanup.push(async () => {
    for (const handler of handlers) await handler.close()
  })
  cleanup.push(execution.release)
  const [a, b] = handlers
  if (!a || !b) throw new Error("expected two independent runtime handlers")
  return {
    a,
    b,
    inspector,
    threads: createPostgresThreadsStore(base),
    execution,
    clientTools,
    pools,
    disposed,
    holdNextRelease: () => {
      const active = barrier()
      hold = active
      cleanup.push(active.release)
      return active
    },
  }
}

async function messages(saver: ReturnType<typeof postgresCheckpointer>, threadId: string) {
  const tuple = await saver.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: "" } })
  expect(tuple).toBeDefined()
  if (!tuple) throw new Error(`missing canonical Postgres checkpoint for ${threadId}`)
  return tuple.checkpoint.channel_values.messages as Array<{
    content: unknown
    tool_call_id?: string
  }>
}

test.skipIf(!enabled)(
  "replicas reject same-thread overlap while an independent thread completes against Postgres",
  async () => {
    const mock = await withAimock([
      { match: { userMessage: "hello" }, response: { content: "first response" } },
      { match: { userMessage: "other" }, response: { content: "independent response" } },
      { match: { userMessage: "again" }, response: { content: "second response" } },
    ])
    const r = await replicas()
    const held = r.holdNextRelease()
    const first = r.a
      .fetch(request("same", "run-1", [hello]))
      .then(async (response) => ({ status: response.status, text: await response.text() }))
    await held.entered

    const conflict = await r.b.fetch(request("same", "run-2", [hello]))
    const independent = await r.b.fetch(
      request("other", "run-other", [{ id: "u-other", role: "user", content: "other" }]),
    )
    const independentText = await independent.text()

    expect(conflict.status).toBe(409)
    expect(conflict.headers.get("retry-after")).toBe("1")
    expect(independent.status).toBe(200)
    expect(independentText).toContain("independent response")
    expect(mock.getRequests()).toHaveLength(2)
    held.release()
    expect(await first).toMatchObject({
      status: 200,
      text: expect.stringContaining("first response"),
    })
    const next = await r.b.fetch(
      request("same", "run-3", [
        hello,
        { id: "a1", role: "assistant", content: "first response" },
        { id: "u2", role: "user", content: "again" },
      ]),
    )
    expect(await next.text()).toContain("second response")
    expect(mock.getRequests()).toHaveLength(3)
    expect((await messages(r.inspector, "same")).map((message) => message.content)).toEqual(
      expect.arrayContaining(["first response", "second response"]),
    )
    expect((await messages(r.inspector, "other")).map((message) => message.content)).toContain(
      "independent response",
    )
    expect(r.pools.size).toBe(4)
    await vi.waitFor(() => expect(r.disposed.size).toBe(r.pools.size))
  },
  60_000,
)

for (const competingRunId of ["callback", "fresh-callback"]) {
  test.skipIf(!enabled)(
    `replicas serialize browser callbacks with ${competingRunId === "callback" ? "identical" : "fresh"} run IDs and suppress completed retries`,
    async () => {
      const mock = await withAimock([
        { match: { userMessage: "again" }, response: { content: "second response" } },
        {
          match: { userMessage: "hello", hasToolResult: true },
          response: { content: "panel response" },
        },
        {
          match: { userMessage: "hello" },
          response: {
            toolCalls: [{ id: "call_panel", name: "client_openPanel", arguments: { id: 7 } }],
          },
        },
      ])
      const r = await replicas()
      const parked = await r.a.fetch(request("browser", "initial", [hello], [browserTool]))
      expect(await parked.text()).toContain("call_panel")
      expect((await r.clientTools.get("browser", "call_panel"))?.answeredAt).toBeNull()
      const parkedCheckpoint = await r.inspector.getTuple({
        configurable: { thread_id: "browser", checkpoint_ns: "" },
      })
      expect(parkedCheckpoint?.pendingWrites?.map(([, channel]) => channel)).toContain(
        "__interrupt__",
      )
      const held = r.holdNextRelease()
      const winner = r.a
        .fetch(request("browser", "callback", callbackHistory, [browserTool]))
        .then(async (response) => ({ status: response.status, text: await response.text() }))
      await held.entered

      const loser = await r.b.fetch(
        request("browser", competingRunId, callbackHistory, [browserTool]),
      )

      expect(loser.status).toBe(409)
      expect(mock.getRequests()).toHaveLength(2)
      held.release()
      expect(await winner).toMatchObject({
        status: 200,
        text: expect.stringContaining("panel response"),
      })
      const retry = await r.b.fetch(request("browser", "retry", callbackHistory, [browserTool]))
      expect(retry.status).toBe(200)
      expect(await retry.text()).toContain("RUN_FINISHED")
      expect(mock.getRequests()).toHaveLength(2)
      expect((await r.clientTools.get("browser", "call_panel"))?.answeredAt).not.toBeNull()
      expect(
        (await messages(r.inspector, "browser")).filter(
          (message) => message.tool_call_id === "call_panel",
        ),
      ).toHaveLength(1)
      const next = await r.b.fetch(
        request(
          "browser",
          "next-turn",
          [
            ...callbackHistory,
            { id: "a2", role: "assistant", content: "panel response" },
            { id: "u2", role: "user", content: "again" },
          ],
          [browserTool],
        ),
      )
      expect(await next.text()).toContain("second response")
      expect(mock.getRequests()).toHaveLength(3)
      const canonical = await messages(r.inspector, "browser")
      expect(canonical.map((message) => message.content)).toEqual(
        expect.arrayContaining(["panel response", "second response"]),
      )
      expect(canonical.filter((message) => message.tool_call_id === "call_panel")).toHaveLength(1)
      const providerHistory = mock.getRequests()[2]?.body?.messages as Array<{
        content: unknown
        tool_call_id?: string
      }>
      expect(providerHistory.map((message) => message.content)).toContain("panel response")
      expect(
        providerHistory.filter((message) => message.tool_call_id === "call_panel"),
      ).toHaveLength(1)
      await vi.waitFor(() => expect(r.disposed.size).toBe(r.pools.size))
    },
    60_000,
  )
}

function blockingWaitRequest(threadId: string) {
  return new Request(`http://localhost/threads/${threadId}/runs/wait`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ route: "/blocking#graph", input: {} }),
  })
}

for (const stop of ["cancel", "shutdown"] as const) {
  test.skipIf(!enabled)(
    `Postgres ownership outlives an AP wait response after ${stop} until the graph actually unwinds`,
    async () => {
      const r = await replicas(true)
      const threadId = `noncooperative-${stop}`
      const waiting = r.a.fetch(blockingWaitRequest(threadId))
      await r.execution.entered
      const ownerPool = [...r.pools][0]
      if (!ownerPool) throw new Error("expected the original run's request-owned pool")

      if (stop === "cancel") {
        const cancelled = await r.a.fetch(
          new Request(`http://localhost/threads/${threadId}/cancel`, { method: "POST" }),
        )
        expect(cancelled.status).toBe(200)
      } else {
        await r.a.close()
      }
      const stopped = await waiting
      expect(stopped.status).toBe(stop === "cancel" ? 409 : 503)
      await stopped.text()
      expect(r.disposed.has(ownerPool)).toBe(false)
      const conflict = await r.b.fetch(blockingWaitRequest(threadId))
      expect(conflict.status).toBe(409)
      expect(conflict.headers.get("retry-after")).toBe("1")
      expect(r.disposed.has(ownerPool)).toBe(false)

      r.execution.release()
      await vi.waitFor(() => expect(r.disposed.has(ownerPool)).toBe(true))
      const successor = await r.b.fetch(blockingWaitRequest(threadId))
      expect(successor.status).toBe(200)
      expect(await successor.json()).toEqual({ ok: true })
      expect((await r.threads.getThread(threadId))?.status).toBe("idle")
      await vi.waitFor(() => expect(r.disposed.size).toBe(r.pools.size))
    },
    60_000,
  )
}

test.skipIf(!enabled)(
  "disconnect during final park settlement persists deferred voids and turn end before releasing Postgres ownership",
  async () => {
    const mock = await withAimock([
      { match: { userMessage: "hello" }, response: { content: "final response" } },
      { match: { userMessage: "again" }, response: { content: "successor response" } },
    ])
    const settling = barrier()
    let blocked = false
    let atRelease: { voided: boolean; turn: unknown } | undefined
    const warnings = vi.spyOn(console, "warn")
    cleanup.push(() => warnings.mockRestore())
    const r = await replicas(false, {
      saver: (saver) =>
        new Proxy(saver, {
          get(target, key) {
            if (key === "getTuple")
              return async (...args: Parameters<typeof saver.getTuple>) => {
                const tuple = await target.getTuple(...args)
                const history = tuple?.checkpoint.channel_values.messages as
                  | Array<{ content: unknown }>
                  | undefined
                if (!blocked && history?.some((message) => message.content === "final response")) {
                  blocked = true
                  await settling.wait()
                }
                return tuple
              }
            const value = Reflect.get(target, key)
            return typeof value === "function" ? value.bind(target) : value
          },
        }),
      release: async () => {
        if (atRelease) return
        const tuple = await r.inspector.getTuple({
          configurable: { thread_id: "disconnect-final", checkpoint_ns: "" },
        })
        atRelease = {
          voided: (await r.clientTools.get("disconnect-final", "stray"))?.voidedAt != null,
          turn: (tuple?.metadata as Record<string, unknown> | undefined)?.["b4:turn"],
        }
      },
    })
    cleanup.push(settling.release)
    await r.threads.createThread({
      thread_id: "disconnect-final",
      metadata: { parked_route: "/chat#agent" },
    })
    const response = await r.a.fetch(request("disconnect-final", "final", [hello], [browserTool]))
    expect(response.status).toBe(200)
    await settling.entered
    expect(mock.getRequests()).toHaveLength(1)
    // The terminal was generated; settlement is now held on the canonical head read.
    // Add a stale outstanding call so deferred cleanup must perform a durable void.
    await r.clientTools.issue({
      threadId: "disconnect-final",
      toolCallId: "stray",
      kind: "client",
      interruptId: "client-stray",
      toolName: "openPanel",
      runId: "old",
      routeId: "/chat#agent",
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      answeredAt: null,
      result: null,
      voidedAt: null,
      settledAt: null,
      parentToolCallId: null,
    })

    await response.body?.cancel()
    const conflict = await r.b.fetch(request("disconnect-final", "blocked-successor", [hello]))
    expect(conflict.status).toBe(409)
    expect(atRelease).toBeUndefined()
    settling.release()
    await vi.waitFor(() => expect(atRelease).toBeDefined())

    expect(atRelease).toMatchObject({ voided: true, turn: { status: "stopped" } })
    expect(warnings.mock.calls.map((args) => args.map(String).join(" "))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/could not (void|prune|stamp)/)]),
    )
    await vi.waitFor(() => expect(r.disposed.size).toBe(r.pools.size))
    const successor = await r.b.fetch(
      request("disconnect-final", "successor", [
        hello,
        { id: "a1", role: "assistant", content: "final response" },
        { id: "u2", role: "user", content: "again" },
      ]),
    )
    expect(successor.status).toBe(200)
    expect(await successor.text()).toContain("successor response")
  },
  60_000,
)
