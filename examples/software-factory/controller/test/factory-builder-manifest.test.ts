import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BuilderManifestSchema } from "../src/lib/builder-manifest.ts"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
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
})
