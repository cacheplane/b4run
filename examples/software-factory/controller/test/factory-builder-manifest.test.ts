import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BuilderManifestSchema } from "../src/lib/builder-manifest.ts"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import { createCommandLog } from "../src/lib/registry/commands.ts"
import { openRegistry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore, type WorkOrderPatch } from "../src/lib/registry/work-orders.ts"
import { createHttpWorkerClient, type WorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"

/**
 * The builder manifest's lifetime (plan Task 6): `dispatch` writes `<manifestDir>/<id>.json`
 * into the target worker's directory BEFORE it creates the thread, because the builder's
 * resolver reads it at the thread's first admission; and the controller removes it once that
 * admission has happened or never will — when the row leaves `dispatched`/`running` (the
 * turn ended, the run failed) and, for a cancel, once `finishCancel` has settled the thread.
 * The writer here is the real one over the shipped `cli-flags` task: the file on disk is
 * the file the builder would read.
 */

let dir: string
let manifestDir: string
let fake: FakeWorker
let factory: Factory
let reader: FakeWorkspaceReader

const REPAIRED = "export const fixed = true\n"
const captureRepairable = async () => ({
  digest: "a".repeat(64),
  files: new Map([
    ["src/cli.ts", "broken\n"],
    ["test/cli.test.ts", "spec\n"],
    ["TASK.md", "task\n"],
  ]),
})
const repaired = () => ({
  "src/cli.ts": REPAIRED,
  "test/cli.test.ts": "spec\n",
  "TASK.md": "task\n",
})

async function boot(
  worker: Omit<FakeWorkerOptions, "outboxDir"> = {},
  overrides: Partial<FactoryOptions> = {},
  wrapClient: (client: WorkerClient) => WorkerClient = (client) => client,
) {
  dir = mkdtempSync(join(tmpdir(), "factory-builder-manifest-"))
  manifestDir = join(dir, "builder-manifests")
  mkdirSync(join(dir, "out"), { recursive: true })
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", ...worker })
  reader = createFakeWorkspaceReader({})
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "tasks"),
    workers: fakeWorkerMap({
      builder: { client: wrapClient(createHttpWorkerClient(fake.baseUrl)), reader, manifestDir },
    }),
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ verdict: "pass" }),
    captureBaseline: captureRepairable,
    ...overrides,
  })
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined as unknown as string
})

const types = (id: string) => factory.events(id).map((e) => e.type)
const event = (id: string, type: string) => factory.events(id).find((e) => e.type === type)
const transitionIndex = (id: string, name: string) =>
  factory.events(id).findIndex((e) => e.type === "transition" && e.payload.event === name)
const manifestPath = (id: string) => join(manifestDir, `${id}.json`)

describe("the builder manifest at dispatch", () => {
  it("is written into the target worker's directory, named by the work order, before the thread", async () => {
    await boot({ run: "hang" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    await factory.waitFor(id, (r) => r.state === "running")
    // Still there while the turn runs: this is the file the resolver reads at admission.
    const manifest = BuilderManifestSchema.parse(JSON.parse(readFileSync(manifestPath(id), "utf8")))
    expect(manifest).toMatchObject({ workOrderId: id, taskId: "cli-flags", targetId: "cli-flags" })
    const written = event(id, "builder_manifest_written")?.payload
    expect(written).toEqual({
      path: manifestPath(id),
      sourceDigest: (manifest.workspace as { source: { digest: string } }).source.digest,
    })
    // Journalled before the thread exists, and the thread carries the key the resolver reads.
    expect(types(id).indexOf("builder_manifest_written")).toBeLessThan(
      types(id).indexOf("thread_created"),
    )
    expect(fake.requests.find((r) => r.path === "/threads")?.body).toEqual({
      metadata: { factoryWorkOrderId: id },
    })
    await factory.cancel(id)
  })

  it("is removed once the turn has ended and the row is verifying", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
    expect(row.state).toBe("awaiting_approval")
    expect(existsSync(manifestPath(id))).toBe(false)
    expect(readdirSync(manifestDir)).toEqual([])
    // Removed on leaving the build states, right after the transition that left them, and
    // before verification read anything: the reader, not the resolver, is what reads a
    // verifying thread.
    const removed = types(id).indexOf("builder_manifest_removed")
    expect(removed).toBe(transitionIndex(id, "turn_ended_with_workspace") + 1)
    expect(removed).toBeLessThan(types(id).indexOf("candidate_assembled"))
    expect(event(id, "builder_manifest_removed")?.payload).toEqual({ path: manifestPath(id) })
    expect(types(id).filter((t) => t === "builder_manifest_removed")).toHaveLength(1)
  })

  it("is removed when the run fails", async () => {
    await boot({ run: "route_error" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "failed", 20_000)
    expect(row.failureReason).toBe("route_error")
    expect(existsSync(manifestPath(id))).toBe(false)
    expect(types(id).indexOf("builder_manifest_removed")).toBe(
      transitionIndex(id, "run_failed") + 1,
    )
  })

  it("is removed by a cancel of a running build only once the thread is settled", async () => {
    await boot({ run: "hang" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    expect(existsSync(manifestPath(id))).toBe(true)
    expect(await factory.cancel(id)).toMatchObject({ ok: true, state: "cancelled" })
    expect(existsSync(manifestPath(id))).toBe(false)
    // Not at `cancel_requested` (the turn may still be being admitted), but after the worker
    // confirmed the cancel and before the terminal row.
    const removed = types(id).indexOf("builder_manifest_removed")
    expect(removed).toBeGreaterThan(types(id).indexOf("worker_cancel"))
    expect(removed).toBeGreaterThan(transitionIndex(id, "cancel"))
    expect(removed).toBeLessThan(transitionIndex(id, "run_ended_after_cancel"))
  })

  it("refuses under the key when the manifest cannot be written, and creates no thread", async () => {
    await boot(
      {},
      {
        writeBuilderManifest: async () => {
          throw new Error("disk full")
        },
      },
    )
    const { id } = await factory.create({ taskId: "cli-flags" })
    const refused = await factory.dispatch(id)
    expect(refused).toEqual({
      ok: false,
      state: "received",
      message: "builder manifest could not be written: Error: disk full",
    })
    expect(event(id, "builder_manifest_failed")?.payload).toEqual({ error: "Error: disk full" })
    expect(fake.requests.some((r) => r.path === "/threads")).toBe(false)
    expect(factory.show(id)?.state).toBe("received")
    // Spent: the same call replays the refusal rather than writing again.
    expect(await factory.dispatch(id)).toEqual(refused)
    expect(types(id).filter((t) => t === "builder_manifest_failed")).toHaveLength(1)
  })

  it("is removed again when the thread cannot be created", async () => {
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
    // No thread will ever be admitted with it: nothing is left for the next dispatch to trip on.
    expect(types(id)).toEqual(["created", "builder_manifest_written", "builder_manifest_removed"])
    expect(readdirSync(manifestDir)).toEqual([])
  })

  it("is kept by a failed dispatch when another dispatch's thread holds the row by then", async () => {
    // Two dispatches under two keys: the first's thread creation hangs until the second has
    // committed its own thread (whose manifest is the same file), then fails. The failed one
    // must not remove a manifest the committed thread's first run is about to be admitted with.
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    await boot({ run: "hang" }, {}, (client) => ({
      ...client,
      createThread: async (metadata) => {
        calls += 1
        if (calls === 1) {
          await released
          throw new Error("worker down")
        }
        return client.createThread(metadata)
      },
    }))
    const { id } = await factory.create({ taskId: "cli-flags" })
    const first = factory.dispatch(id, "dispatch-a")
    await factory.waitFor(id, () => calls === 1)
    expect(await factory.dispatch(id, "dispatch-b")).toMatchObject({ ok: true })
    const holder = (await factory.waitFor(id, (r) => r.state === "running")).workerThreadId
    release()
    expect(await first).toMatchObject({
      ok: false,
      message: expect.stringContaining("worker down"),
    })
    expect(existsSync(manifestPath(id))).toBe(true)
    expect(event(id, "builder_manifest_kept")?.payload).toEqual({ threadId: holder })
    expect(types(id)).not.toContain("builder_manifest_removed")
    await factory.cancel(id)
    // The cancel settled the committed thread: now it is removed.
    expect(existsSync(manifestPath(id))).toBe(false)
  })

  it("is removed by a dispatch whose own thread was orphaned by a cancel", async () => {
    let cancelled: Promise<unknown> | undefined
    let rowId = ""
    await boot({}, {}, (client) => ({
      ...client,
      createThread: async (metadata) => {
        // The cancel lands while the worker is making the thread: the row cannot take it.
        cancelled = factory.cancel(rowId)
        await cancelled
        return client.createThread(metadata)
      },
    }))
    rowId = (await factory.create({ taskId: "cli-flags" })).id
    expect(await factory.dispatch(rowId)).toMatchObject({
      ok: false,
      message: "Work order changed state while dispatching",
    })
    expect(factory.show(rowId)?.state).toBe("cancelled")
    expect(types(rowId)).toContain("thread_orphaned")
    expect(existsSync(manifestPath(rowId))).toBe(false)
    expect(types(rowId)).toContain("builder_manifest_removed")
  })

  it("is removed at the path the journal recorded, not one recomputed from the map", async () => {
    // A writer that puts the file somewhere other than the worker's directory: removal
    // follows the journal, so it still finds it once the turn has ended.
    const elsewhere = () => join(dir, "elsewhere")
    await boot(
      {},
      {
        writeBuilderManifest: async ({ workOrderId }) => {
          mkdirSync(elsewhere(), { recursive: true })
          const path = join(elsewhere(), `${workOrderId}.json`)
          writeFileSync(path, "{}\n")
          return { path, sourceDigest: "f".repeat(64) }
        },
      },
    )
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
    expect(event(id, "builder_manifest_removed")?.payload).toEqual({
      path: join(elsewhere(), `${id}.json`),
    })
    expect(readdirSync(elsewhere())).toEqual([])
  })
})

/** Rewrite the row directly: the shape an approved intake, or a crash, leaves it in. */
function forceRow(id: string, patch: WorkOrderPatch): void {
  const registry = openRegistry(join(dir, "registry.sqlite"))
  const rows = createWorkOrderStore(registry.db)
  const row = rows.get(id)
  if (!row) throw new Error(`no work order ${id}`)
  rows.update(id, row.revision, patch, new Date().toISOString())
  registry.close()
}

/** Write what a command that crashed after its manifest write leaves behind. */
function crashedAfterManifest(
  id: string,
  role: "builder" | "drafter",
  command: "dispatch" | "intake" | null,
): string {
  const manifests = join(dir, `${role}-crashed`)
  mkdirSync(manifests, { recursive: true })
  const path = join(manifests, `${id}.json`)
  writeFileSync(path, "{}\n")
  const registry = openRegistry(join(dir, "registry.sqlite"))
  const now = new Date().toISOString()
  createWorkOrderStore(registry.db).appendEvent(id, `${role}_manifest_written`, { path }, now)
  if (command !== null)
    createCommandLog(registry.db).begin(`${command}-crashed`, id, { command, args: {} }, now)
  registry.close()
  return path
}

/** A second controller over the same registry: the restart after a crash. */
async function reboot(): Promise<void> {
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "tasks"),
    workers: fakeWorkerMap({
      builder: { client: createHttpWorkerClient(fake.baseUrl), reader, manifestDir },
    }),
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ verdict: "pass" }),
    captureBaseline: captureRepairable,
  })
}

describe("the builder manifest of an approved issue work order (the row still holds its intake thread)", () => {
  it("is removed when the thread cannot be created", async () => {
    await boot({}, {}, (client) => ({
      ...client,
      createThread: async () => {
        throw new Error("worker down")
      },
    }))
    const { id } = await factory.create({ taskId: "cli-flags" })
    forceRow(id, { workerThreadId: "intake-thread-1" })
    expect(await factory.dispatch(id)).toMatchObject({
      ok: false,
      message: expect.stringContaining("Thread creation failed"),
    })
    // The intake thread is no builder's: it does not keep the file.
    expect(types(id)).toContain("builder_manifest_removed")
    expect(types(id)).not.toContain("builder_manifest_kept")
    expect(readdirSync(manifestDir)).toEqual([])
  })

  it("is removed, not kept, when a cancel moves the row while the thread is being made", async () => {
    let rowId = ""
    await boot({}, {}, (client) => ({
      ...client,
      createThread: async (metadata) => {
        await factory.cancel(rowId)
        return client.createThread(metadata)
      },
    }))
    rowId = (await factory.create({ taskId: "cli-flags" })).id
    forceRow(rowId, { workerThreadId: "intake-thread-1" })
    expect(await factory.dispatch(rowId)).toMatchObject({
      ok: false,
      message: "Work order changed state while dispatching",
    })
    expect(types(rowId)).not.toContain("builder_manifest_kept")
    expect(existsSync(manifestPath(rowId))).toBe(false)
  })
})

describe("a manifest a crashed command never handed to a thread", () => {
  it("is removed when reconcile settles the incomplete dispatch", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.close()
    const path = crashedAfterManifest(id, "builder", "dispatch")
    await reboot()
    expect(existsSync(path)).toBe(false)
    expect(event(id, "builder_manifest_removed")?.payload).toEqual({ path })
    expect(factory.show(id)?.state).toBe("received")
  })

  it("is removed when reconcile finds the open intake that wrote the drafter's", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.close()
    const path = crashedAfterManifest(id, "drafter", "intake")
    await reboot()
    expect(existsSync(path)).toBe(false)
    expect(event(id, "drafter_manifest_removed")?.payload).toEqual({ path })
  })

  it("is removed by a cancel from received", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.close()
    const path = crashedAfterManifest(id, "builder", null)
    await reboot()
    expect(existsSync(path)).toBe(true)
    await factory.cancel(id)
    expect(factory.show(id)?.state).toBe("cancelled")
    expect(existsSync(path)).toBe(false)
  })

  it("is kept once a thread was created after it", async () => {
    await boot({ run: "hang" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect(await factory.dispatch(id)).toMatchObject({ ok: true })
    await factory.waitFor(id, (r) => r.state === "running")
    await factory.close()
    await reboot()
    // Reconcile adopts the running thread; the manifest it was admitted with is its own.
    expect(types(id)).not.toContain("builder_manifest_removed")
    await factory.cancel(id)
  })
})
