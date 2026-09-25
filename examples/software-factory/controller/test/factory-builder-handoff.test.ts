import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BuilderHandoffSchema } from "../src/lib/builder-handoff.ts"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import { createCommandLog } from "../src/lib/registry/commands.ts"
import { openRegistry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore } from "../src/lib/registry/work-orders.ts"
import { createHttpWorkerClient, type WorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

/**
 * How `dispatch` hands the builder its workspace: it captures the task's workspace, uploads
 * the source to the builder (`PUT /workspace/sources/<digest>`), and only then creates the
 * thread naming it, with the work order's target in `factoryBuilder`. Nothing is written for
 * the builder to read, so nothing is left for the controller to remove: an upload no thread
 * names is the builder's to reclaim after its retention window. The capture here is the real
 * one over the shipped `cli-flags` task: the source uploaded is the source a builder would run.
 */

let dir: string
let fake: FakeWorker
let factory: Factory
let reader: FakeWorkspaceReader

const captureRepairable = async () => ({
  digest: "a".repeat(64),
  files: new Map([
    ["src/cli.ts", "broken\n"],
    ["test/cli.test.ts", "spec\n"],
    ["TASK.md", "task\n"],
  ]),
})

async function boot(
  worker: Omit<FakeWorkerOptions, "outboxDir"> = {},
  overrides: Partial<FactoryOptions> = {},
  wrapClient: (client: WorkerClient) => WorkerClient = (client) => client,
) {
  dir = mkdtempSync(join(tmpdir(), "factory-builder-handoff-"))
  mkdirSync(join(dir, "out"), { recursive: true })
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", ...worker })
  reader = createFakeWorkspaceReader({})
  factory = await createFactory(options(wrapClient, overrides))
}

function options(
  wrapClient: (client: WorkerClient) => WorkerClient = (client) => client,
  overrides: Partial<FactoryOptions> = {},
): FactoryOptions {
  return {
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "tasks"),
    captureRoot: dir,
    workers: fakeWorkerMap({
      builder: {
        client: wrapClient(
          createHttpWorkerClient(fake.baseUrl, {
            token: TEST_WORKER_TOKEN,
            busyRetry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
          }),
        ),
        reader,
      },
    }),
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ verdict: "pass" }),
    captureBaseline: captureRepairable,
    ...overrides,
  }
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined as unknown as string
})

const types = (id: string) => factory.events(id).map((e) => e.type)
const event = (id: string, type: string) => factory.events(id).find((e) => e.type === type)
const creates = () => fake.requests.filter((r) => r.method === "POST" && r.path === "/threads")

describe("the builder's workspace at dispatch", () => {
  it("stages the workspace, then creates the thread with the handoff and the reference", async () => {
    await boot({ run: "hang" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    const staged = event(id, "builder_source_staged")?.payload
    expect(staged).toMatchObject({
      sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      status: "created",
    })
    // Uploaded under its own digest, with the token, before the thread was created.
    const upload = fake.requests.findIndex((r) => r.method === "PUT")
    expect(fake.requests[upload]?.path).toBe(`/workspace/sources/${staged?.sourceDigest}`)
    expect(fake.requests[upload]?.authorization).toBe(`Bearer ${TEST_WORKER_TOKEN}`)
    expect(upload).toBeLessThan(fake.requests.findIndex((r) => r.path === "/threads"))
    expect(types(id).indexOf("builder_source_staged")).toBeLessThan(
      types(id).indexOf("thread_created"),
    )
    const create = creates()[0]?.body as {
      metadata: { factoryWorkOrderId: string; factoryBuilder: unknown }
      workspace: { sourceDigest: string; baseline?: string }
    }
    expect(Object.keys(create.metadata).sort()).toEqual(["factoryBuilder", "factoryWorkOrderId"])
    expect(create.metadata.factoryWorkOrderId).toBe(id)
    const handoff = BuilderHandoffSchema.parse(create.metadata.factoryBuilder)
    expect(handoff).toMatchObject({ workOrderId: id, taskId: "cli-flags", targetId: "cli-flags" })
    // The handoff carries exactly the reference the thread is created with.
    expect(handoff.workspace).toEqual(create.workspace)
    expect(create.workspace).toMatchObject({ sourceDigest: staged?.sourceDigest, baseline: "git" })
    const threadId = factory.show(id)?.workerThreadId
    expect(fake.thread(threadId as string)?.workspace).toEqual(create.workspace)
    expect(types(id).filter((t) => t.includes("manifest"))).toEqual([])
    await factory.cancel(id)
  })

  it("stages a source the worker already holds as held, and creates a thread naming it", async () => {
    await boot({ run: "route_error" })
    const first = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(first.id)
    await factory.waitFor(first.id, (r) => r.state === "failed", 20_000)
    const second = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(second.id)
    // Two work orders of one task: the same bytes, uploaded once and named twice.
    expect(event(second.id, "builder_source_staged")?.payload).toEqual({
      sourceDigest: event(first.id, "builder_source_staged")?.payload.sourceDigest,
      status: "held",
    })
    expect(creates()).toHaveLength(2)
  })

  it("waits out a busy builder rather than refusing the dispatch", async () => {
    await boot({ run: "hang" })
    fake.failNext("PUT", 429, "upload_in_flight")
    fake.failNext("POST", 429, "workspace_create_in_flight")
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(2)
    expect(creates()).toHaveLength(2)
    await factory.cancel(id)
  })

  it("refuses the dispatch, with no thread, when the upload fails", async () => {
    await boot()
    fake.failNext("PUT", 500)
    const { id } = await factory.create({ taskId: "cli-flags" })
    const refused = await factory.dispatch(id)
    expect(refused).toMatchObject({
      ok: false,
      state: "received",
      message: expect.stringMatching(/^builder workspace could not be staged: .*500/),
    })
    expect(event(id, "builder_source_failed")?.payload.error).toMatch(/500/)
    expect(creates()).toEqual([])
    // Spent: the same call replays the refusal rather than staging again.
    expect(await factory.dispatch(id)).toEqual(refused)
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1)
  })

  it("refuses under the key when the capture fails, and sends nothing", async () => {
    await boot(
      {},
      {
        captureBuilderHandoff: async () => {
          throw new Error("disk full")
        },
      },
    )
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.dispatch(id)).toEqual({
      ok: false,
      state: "received",
      message: "builder workspace could not be staged: Error: disk full",
    })
    expect(event(id, "builder_source_failed")?.payload).toEqual({ error: "Error: disk full" })
    expect(fake.requests).toEqual([])
  })

  it("leaves nothing to remove when the thread cannot be created", async () => {
    await boot({}, {}, (client) => ({
      ...client,
      createThread: async () => {
        throw new Error("worker down")
      },
    }))
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.dispatch(id)).toMatchObject({
      ok: false,
      message: expect.stringContaining("Thread creation failed"),
    })
    // The upload stays on the builder, unnamed, until its retention window reclaims it.
    expect(types(id)).toEqual(["created", "builder_source_staged"])
    expect(factory.show(id)?.state).toBe("received")
  })

  /** A dispatch whose thread a cancel orphans while the worker is making it. */
  async function orphanedDispatch(
    beforeDispatch: () => void = () => {},
  ): Promise<{ rowId: string; threadId: string }> {
    let rowId = ""
    await boot({}, {}, (client) => ({
      ...client,
      createThread: async (metadata, workspace, signal) => {
        // The cancel lands while the worker is making the thread: the row cannot take it.
        await factory.cancel(rowId)
        return client.createThread(metadata, workspace, signal)
      },
    }))
    rowId = (await factory.create({ taskId: "cli-flags" })).id
    beforeDispatch()
    expect(await factory.dispatch(rowId)).toMatchObject({
      ok: false,
      message: "Work order changed state while dispatching",
    })
    expect(factory.show(rowId)?.state).toBe("cancelled")
    const threadId = event(rowId, "thread_orphaned")?.payload.threadId as string
    expect(threadId).toMatch(/^fake-thread-/)
    return { rowId, threadId }
  }

  it("cancels and deletes its own thread when a cancel orphaned it mid-create", async () => {
    // Deleted, not only cancelled: an undeleted thread keeps its staged source referenced, and
    // referenced sources are never reclaimed, so orphans would fill the builder's quota.
    const { rowId, threadId } = await orphanedDispatch()
    const deletes = fake.requests.filter((r) => r.method === "DELETE")
    expect(deletes).toEqual([
      expect.objectContaining({
        path: `/threads/${threadId}`,
        authorization: `Bearer ${TEST_WORKER_TOKEN}`,
      }),
    ])
    expect(fake.thread(threadId)).toBeUndefined()
    expect(event(rowId, "thread_deleted")?.payload).toEqual({ threadId, result: "deleted" })
    expect(types(rowId).indexOf("thread_deleted")).toBeGreaterThan(
      types(rowId).indexOf("thread_orphaned"),
    )
    expect(types(rowId).filter((t) => t.includes("manifest"))).toEqual([])
  })

  it("journals a delete the builder refused, and answers the dispatch all the same", async () => {
    // Best-effort: the thread is the builder's either way; the journal says it is left.
    const { rowId, threadId } = await orphanedDispatch(() => fake.failNext("DELETE", 500))
    expect(event(rowId, "thread_delete_failed")?.payload).toMatchObject({
      threadId,
      error: expect.stringContaining("500"),
    })
    expect(types(rowId)).not.toContain("thread_deleted")
  })
})

describe("a dispatch that crashed after staging", () => {
  it("is settled by reconcile as incomplete, with nothing to remove", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.close()
    const registry = openRegistry(join(dir, "registry.sqlite"))
    const now = new Date().toISOString()
    createWorkOrderStore(registry.db).appendEvent(
      id,
      "builder_source_staged",
      { sourceDigest: "f".repeat(64), status: "created" },
      now,
    )
    createCommandLog(registry.db).begin(
      "dispatch-crashed",
      id,
      { command: "dispatch", args: {} },
      now,
    )
    registry.close()
    factory = await createFactory(options())
    expect(factory.show(id)?.state).toBe("received")
    expect(event(id, "reconciled")?.payload).toMatchObject({ resolution: "dispatch_incomplete" })
    expect(types(id).filter((t) => t.includes("manifest"))).toEqual([])
  })
})
