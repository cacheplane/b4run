import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import { ACTIVE_STATES } from "../src/lib/domain/states.ts"
import { taskPrompt } from "../src/lib/prompts.ts"
import { openRegistry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore } from "../src/lib/registry/work-orders.ts"
import {
  configureCatalog,
  loadTask,
  loadTaskRecipe,
  resetCatalogForTests,
  tasksDir,
} from "../src/lib/targets/catalog.ts"
import { type ImageRegistry, openImageRegistry } from "../src/lib/targets/images.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { fakeImageBuilder } from "./fake-image-builder.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { fakeBuilderHandoff, fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { useImages } from "./static-images.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

let dir: string
/** Where a test's generated tasks live; created before `boot()` when the test needs that. */
let generated: string | undefined
let fake: FakeWorker
let factory: Factory
let reader: FakeWorkspaceReader
/** The tag each builder handoff capture was asked to name (`(none)` when none was bound). */
let handoffTags: string[] = []

const REPAIRED = "export const fixed = true\n"

/** The baseline the controller captures, injected so this layer needs no container. */
const captureRepairable = async () => ({
  digest: "a".repeat(64),
  files: new Map([
    ["src/cli.ts", "broken\n"],
    ["test/cli.test.ts", "spec\n"],
    ["TASK.md", "task\n"],
  ]),
})
/** What the builder is deemed to have left behind: a repair and two untouched files. */
const repaired = () => ({
  "src/cli.ts": REPAIRED,
  "test/cli.test.ts": "spec\n",
  "TASK.md": "task\n",
})
/** A workspace identical to the baseline: the builder ran and changed nothing. */
const untouched = () => ({ ...repaired(), "src/cli.ts": "broken\n" })

async function boot(
  options: Omit<FakeWorkerOptions, "outboxDir"> = {},
  overrides: Partial<FactoryOptions> = {},
) {
  dir = mkdtempSync(join(tmpdir(), "factory-dispatch-"))
  mkdirSync(join(dir, "out"), { recursive: true })
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", ...options })
  reader = createFakeWorkspaceReader({})
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "tasks"),
    captureRoot: dir,
    workers: fakeWorkerMap({
      builder: {
        client: createHttpWorkerClient(fake.baseUrl, { token: TEST_WORKER_TOKEN }),
        reader,
      },
    }),
    captureBuilderHandoff: async (input) => {
      handoffTags.push(input.tag ?? "(none)")
      return fakeBuilderHandoff(input)
    },
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ verdict: "pass" }),
    captureBaseline: captureRepairable,
    ...overrides,
  })
}

/** Append one event to the journal directly, as an earlier phase (or a crash) left it. */
function journal(id: string, type: string, payload: Record<string, unknown>): void {
  const registry = openRegistry(join(dir, "registry.sqlite"))
  createWorkOrderStore(registry.db).appendEvent(id, type, payload, new Date().toISOString())
  registry.close()
}

/** A registry over a fake builder, configured process-wide for this test (the factory builds through it). */
function fakeImages(): {
  builder: ReturnType<typeof fakeImageBuilder>
  registry: ImageRegistry
  restore(): void
} {
  const builder = fakeImageBuilder()
  const registry = openImageRegistry({
    path: join(dir, "images.sqlite"),
    builder,
    platform: "linux/arm64",
  })
  const restore = useImages(registry)
  return {
    builder,
    registry,
    restore: () => {
      restore()
      registry.close()
    },
  }
}
const eventsOf = (id: string, type: string) => factory.events(id).filter((e) => e.type === type)
async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error("condition never held")
    await new Promise((r) => setTimeout(r, 10))
  }
}
afterEach(async () => {
  resetCatalogForTests()
  handoffTags = []
  await factory?.close()
  await fake?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  if (generated) rmSync(generated, { recursive: true, force: true })
  generated = undefined
  // Cleared so a boot() that throws cannot hand the next test the previous test's worker.
  dir = undefined as unknown as string
  fake = undefined as unknown as FakeWorker
  factory = undefined as unknown as Factory
  reader = undefined as unknown as FakeWorkspaceReader
})

const settled = (state: string) =>
  !["received", "dispatched", "running", "verifying"].includes(state)

/** Dispatch, then script what the builder's workspace will be found to contain. */
async function dispatchWith(
  id: string,
  files: Readonly<Record<string, string>> = repaired(),
): Promise<string> {
  await factory.dispatch(id)
  const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
  const threadId = dispatched.workerThreadId as string
  reader.set(threadId, files)
  return threadId
}

describe("create and dispatch", () => {
  it("runs the worker turn into the verifying phase and journals the order of events", async () => {
    await boot()
    const created = await factory.create({ taskId: "cli-flags" })
    expect(created.state).toBe("received")
    const outcome = await factory.dispatch(created.id)
    expect(outcome).toEqual({ ok: true, state: "dispatched", message: "Dispatched" })
    const dispatched = await factory.waitFor(created.id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(created.id, (r) => settled(r.state), 20_000)
    expect(row.state).toBe("awaiting_approval")
    expect(row.candidateDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(row.bundleDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(row.awaitingSince).not.toBeNull()
    expect(row.activeStartedAt).toBeNull()
    // The digest is the controller's own, computed from the bytes it read: the worker never
    // claimed one, and the turn ended with no prompt parked on it.
    expect(row.candidateDigest).not.toBe(fake.digest)
    expect(row.interruptId).toBeNull()
    const types = factory
      .events(created.id)
      .map((e) => `${e.type}:${String(e.payload.event ?? "")}`)
    expect(types).toEqual([
      "created:",
      "image_bound:",
      "builder_source_staged:",
      "thread_created:",
      "transition:dispatch_committed",
      "transition:run_started",
      "transition:turn_ended_with_workspace",
      "candidate_assembled:",
      "receipt_issued:",
      "bundle_frozen:",
      "transition:receipt_passed",
    ])
    expect(reader.reads).toEqual([dispatched.workerThreadId])
    expect(fake.requests.at(-1)?.body).toMatchObject({
      route: "/build#agent",
      input: { messages: [{ role: "user", content: taskPrompt(loadTask("cli-flags")) }] },
    })
  })

  it("is idempotent per operation key and refuses dispatch from the wrong state", async () => {
    await boot()
    const created = await factory.create({ taskId: "cli-flags", operationKey: "create-1" })
    const again = await factory.create({ taskId: "cli-flags", operationKey: "create-1" })
    expect(again.id).toBe(created.id)
    const first = await factory.dispatch(created.id, "dispatch-1")
    const second = await factory.dispatch(created.id, "dispatch-1")
    expect(second).toEqual(first)
    expect(fake.requests.filter((r) => r.method === "POST" && r.path === "/threads")).toHaveLength(
      1,
    )
    const dispatched = await factory.waitFor(created.id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    await factory.waitFor(created.id, (r) => settled(r.state), 20_000)
    const refused = await factory.dispatch(created.id, "dispatch-2")
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/Cannot dispatch from awaiting_approval/)
  })

  it("rejects unknown tasks", async () => {
    await boot()
    await expect(factory.create({ taskId: "nope" })).rejects.toThrow(/Unknown task/)
  })

  it("fails on a route error", async () => {
    await boot({ run: "route_error" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await dispatchWith(id)
    const row = await factory.waitFor(id, (r) => settled(r.state), 20_000)
    expect(row).toMatchObject({ state: "failed", failureReason: "route_error" })
  })

  it("fails when the turn left the baseline unchanged", async () => {
    await boot({ run: "no_candidate" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await dispatchWith(id, untouched())
    const row = await factory.waitFor(id, (r) => settled(r.state), 20_000)
    expect(row).toMatchObject({ state: "failed", failureReason: "ended_without_candidate" })
  })

  it("blocks on an unexpected interrupt kind and never resolves it", async () => {
    await boot({ run: "unexpected_interrupt" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await dispatchWith(id)
    const row = await factory.waitFor(id, (r) => settled(r.state), 20_000)
    expect(row).toMatchObject({ state: "blocked", blockedReason: "unexpected_interrupt" })
    expect(fake.requests.some((r) => r.path.endsWith("/resume"))).toBe(false)
    // Nothing was read and nothing was assembled: a parked prompt is a turn that has not ended.
    expect(reader.reads).toEqual([])
    expect(row.candidateDigest).toBeNull()
  })

  it("accumulates active time when the run leaves a run state", async () => {
    // A clock that advances on every read: active time is then strictly positive by
    // construction, so this exercises the accumulate branch rather than asserting >= 0.
    let clock = Date.parse("2026-09-16T10:00:00.000Z")
    dir = mkdtempSync(join(tmpdir(), "factory-dispatch-"))
    mkdirSync(join(dir, "out"), { recursive: true })
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    reader = createFakeWorkspaceReader({})
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      generatedTasksDir: join(dir, "tasks"),
      captureRoot: dir,
      workers: fakeWorkerMap({
        builder: {
          client: createHttpWorkerClient(fake.baseUrl, { token: TEST_WORKER_TOKEN }),
          reader,
        },
      }),
      captureBuilderHandoff: fakeBuilderHandoff,
      exportDir: join(dir, "out"),
      artifactsDir: join(dir, "artifacts"),
      verifier: createFakeVerifier({ verdict: "pass" }),
      captureBaseline: captureRepairable,
      now: () => (clock += 1_000),
    })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await dispatchWith(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
    expect(row.activeMs).toBeGreaterThan(0)
    expect(row.activeStartedAt).toBeNull()
  })

  it("warns at create and refuses dispatch when the budget is below twice the verifier deadline", async () => {
    // The shipped `cli` target verifies for up to an hour; the default budget is 20 minutes.
    const deadline = loadTask("cli-runs-wait-undefined").target.resources.verifierDeadlineMs
    expect(2 * deadline).toBeGreaterThan(1_200_000)
    await boot()
    const { id } = await factory.create({ taskId: "cli-runs-wait-undefined" })
    const shortfall = { maxActiveMs: 1_200_000, verifierDeadlineMs: deadline, targetId: "cli" }
    expect(factory.events(id).at(-1)).toMatchObject({
      type: "budget_below_verifier_deadline",
      payload: { phase: "create", ...shortfall },
    })
    const refused = await factory.dispatch(id)
    expect(refused).toMatchObject({ ok: false, state: "received" })
    expect(refused.message).toContain(`FACTORY_MAX_ACTIVE_MS=${2 * deadline}`)
    expect(factory.events(id).at(-1)).toMatchObject({
      type: "budget_below_verifier_deadline",
      payload: { phase: "dispatch", ...shortfall },
    })
    expect(factory.show(id)?.state).toBe("received")
    expect(fake.requests.some((r) => r.path === "/threads")).toBe(false)
    // A small target's task under the same budget is not warned about.
    const small = await factory.create({ taskId: "cli-flags" })
    expect(factory.events(small.id).some((e) => e.type === "budget_below_verifier_deadline")).toBe(
      false,
    )
  })

  it("dispatches a slow target's task once the budget covers twice its verifier deadline", async () => {
    const deadline = loadTask("cli-runs-wait-undefined").target.resources.verifierDeadlineMs
    await boot({}, { maxActiveMs: 2 * deadline })
    const { id } = await factory.create({ taskId: "cli-runs-wait-undefined" })
    expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
    expect(factory.events(id).some((e) => e.type === "budget_below_verifier_deadline")).toBe(false)
  })

  it("refuses to dispatch a task with no prompt instead of sending an empty one", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    // create validates the task id, so a prompt table that lost the task between create and
    // dispatch is the only way to reach the guard — which is exactly the upgrade case.
    const starved = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      generatedTasksDir: join(dir, "tasks"),
      captureRoot: dir,
      workers: fakeWorkerMap({
        builder: {
          client: createHttpWorkerClient(fake.baseUrl, { token: TEST_WORKER_TOKEN }),
          reader,
        },
      }),
      captureBuilderHandoff: fakeBuilderHandoff,
      exportDir: join(dir, "out"),
      artifactsDir: join(dir, "artifacts"),
      verifier: createFakeVerifier({ verdict: "pass" }),
      captureBaseline: captureRepairable,
      tasks: { other: "something else" },
    })
    try {
      expect(await starved.dispatch(id)).toMatchObject({
        ok: false,
        state: "received",
        message: "Unknown task cli-flags",
      })
      expect(starved.show(id)?.state).toBe("received")
      expect(fake.requests.some((r) => r.path === "/threads")).toBe(false)
    } finally {
      await starved.close()
    }
  })

  it("records a lost stream and recovers through reconciliation", async () => {
    await boot({ run: "edits_only_close_midway" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await dispatchWith(id)
    const row = await factory.waitFor(id, (r) => settled(r.state), 20_000)
    // The stream died before the turn ended, so nothing the controller saw on it decided
    // anything: the workspace the turn left behind is still what the verdict comes from.
    expect(row).toMatchObject({ state: "awaiting_approval" })
    expect(row.candidateDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(factory.events(id).map((e) => e.type)).toContain("stream_lost")
  })

  it("settle waits for the tracked run and returns the settled row", async () => {
    await boot()
    const row = await factory.create({ taskId: "cli-flags" })
    expect((await factory.dispatch(row.id)).ok).toBe(true)
    const dispatched = await factory.waitFor(row.id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const settled = await factory.settle(row.id, 10_000)
    expect(ACTIVE_STATES.has(settled.state)).toBe(false)
    expect(settled.state).toBe("awaiting_approval")
  })

  it("reconcileWorkOrder is exposed and leaves a received row alone", async () => {
    await boot()
    const row = await factory.create({ taskId: "cli-flags" })
    await factory.reconcileWorkOrder(row.id)
    expect(factory.show(row.id)?.state).toBe("received")
  })
})

/**
 * A generated task: a shipped task's directory copied under a work-order-shaped id, minus
 * the reference patch nothing has proven yet.
 */
function materialiseGeneratedTask(id: string): string {
  generated ??= mkdtempSync(join(tmpdir(), "factory-generated-"))
  const generatedTasksDir = join(generated, "tasks")
  cpSync(join(tasksDir, "cli-flags"), join(generatedTasksDir, id), { recursive: true })
  rmSync(join(generatedTasksDir, id, "reference.patch"))
  const manifest = JSON.parse(readFileSync(join(generatedTasksDir, id, "task.json"), "utf8"))
  writeFileSync(join(generatedTasksDir, id, "task.json"), JSON.stringify({ ...manifest, id }))
  return generatedTasksDir
}

describe("generated tasks", () => {
  it("refuses to create a catalog work order over a generated task the search path resolves", async () => {
    // A draft left on disk (refused, or never approved) is a task `loadTask` serves, and it
    // would carry no digest for the gate to bind: the only way to a generated task is
    // `createFromIssue` + `intake` + `approveIntake` (proved in factory-intake.test).
    configureCatalog({ generatedTasksDir: materialiseGeneratedTask("wo-0123456789abcdef") })
    await boot()
    expect(loadTask("wo-0123456789abcdef").id).toBe("wo-0123456789abcdef")
    await expect(factory.create({ taskId: "wo-0123456789abcdef" })).rejects.toThrow(/Unknown task/)
    expect(factory.list()).toEqual([])
  })

  it("resolves a shipped task at the point of use, not at boot", async () => {
    // The laziness the runtime relies on, expressed through the shipped catalog itself: the
    // factory's prompt catalog names a tasks directory that is empty at boot, and a task
    // that lands there afterwards is creatable the moment its directory does. (The same
    // directory doubles as the search path's generated root, so dispatch resolves it too.)
    generated = mkdtempSync(join(tmpdir(), "factory-generated-"))
    const tasks = join(generated, "tasks")
    configureCatalog({ generatedTasksDir: tasks })
    await boot({}, { promptCatalog: { tasksDir: tasks } })
    await expect(factory.create({ taskId: "wo-fedcba9876543210" })).rejects.toThrow(/Unknown task/)
    materialiseGeneratedTask("wo-fedcba9876543210")
    const created = await factory.create({ taskId: "wo-fedcba9876543210" })
    expect(created.state).toBe("received")
    expect(await factory.dispatch(created.id)).toMatchObject({ ok: true, state: "dispatched" })
  })
})

describe("the task's image at dispatch", () => {
  it("builds it while the row waits in received, binds it, and hands the builder its tag", async () => {
    await boot()
    const images = fakeImages()
    images.builder.hold()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      const dispatching = factory.dispatch(id)
      await until(() => eventsOf(id, "image_prepare_started").length === 1)
      expect(factory.show(id)?.state).toBe("received")
      images.builder.release()
      expect(await dispatching).toEqual({ ok: true, state: "dispatched", message: "Dispatched" })
      expect(images.builder.requests).toHaveLength(1)
      const [bound] = eventsOf(id, "image_bound")
      expect(bound?.payload).toMatchObject({ targetId: "cli-flags" })
      const types = factory.events(id).map((e) => e.type)
      expect(types.indexOf("image_bound")).toBeLessThan(types.indexOf("builder_source_staged"))
      expect(handoffTags).toEqual([bound?.payload.tag])
    } finally {
      images.builder.release()
      images.restore()
    }
  })

  it("refuses a failed build before the key is spent, and builds again on the next dispatch", async () => {
    await boot()
    const images = fakeImages()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      images.builder.failNext("docker build failed", "#7 ERROR: failed to solve\n")
      const refused = await factory.dispatch(id)
      expect(refused).toMatchObject({ ok: false, state: "received" })
      expect(refused.message).toMatch(
        /^the image of target cli-flags at [0-9a-f]{40} could not be built: .*docker build failed \(build log: artifact [0-9a-f]{64}\)$/,
      )
      expect(fake.requests.filter((r) => r.path === "/threads")).toHaveLength(0)
      expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
      expect(images.builder.requests).toHaveLength(2)
    } finally {
      images.restore()
    }
  })

  it("abandons the build when the work order is cancelled while it waits", async () => {
    await boot()
    const images = fakeImages()
    images.builder.hold()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      const dispatching = factory.dispatch(id)
      await until(() => eventsOf(id, "image_prepare_started").length === 1)
      expect((await factory.cancel(id)).ok).toBe(true)
      expect(await dispatching).toMatchObject({ ok: false, state: "cancelled" })
      await until(() => images.builder.aborted === 1)
    } finally {
      images.builder.release()
      images.restore()
    }
  })

  it("cancels the work order when the caller's signal aborts during the build", async () => {
    await boot()
    const images = fakeImages()
    images.builder.hold()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      const route = new AbortController()
      const dispatching = factory.dispatch(id, undefined, { signal: route.signal })
      await until(() => eventsOf(id, "image_prepare_started").length === 1)
      route.abort(new Error("the runtime cancelled the dispatch run"))
      expect(await dispatching).toMatchObject({ ok: false, state: "cancelled" })
      await until(() => images.builder.aborted === 1)
      const cancel = factory
        .events(id)
        .find((e) => e.type === "transition" && e.payload.event === "cancel")
      expect(cancel?.payload.operationKey).toBe(`cancel:${id}:aborted-dispatch`)
    } finally {
      images.builder.release()
      images.restore()
    }
  })

  it("keeps a binding whose image the daemon holds, and refuses one it no longer holds", async () => {
    await boot()
    const images = fakeImages()
    try {
      const { id } = await factory.create({ taskId: "cli-flags" })
      const recipe = loadTaskRecipe("cli-flags").target
      const built = await images.registry.ensure(recipe, { signal: AbortSignal.timeout(5_000) })
      // Bound earlier to an image a later build of the same key superseded, still on the daemon.
      const earlier = { ...built.image, localId: `sha256:${"7".repeat(64)}` }
      images.builder.daemon.set(earlier.localId, [])
      journal(id, "image_bound", {
        targetId: "cli-flags",
        pin: recipe.pin,
        key: built.key,
        tag: built.tag,
        image: earlier,
      })
      expect(await factory.dispatch(id)).toMatchObject({ ok: true, state: "dispatched" })
      expect(images.builder.requests).toHaveLength(1)
      expect(eventsOf(id, "image_bound")).toHaveLength(1)

      const { id: other } = await factory.create({ taskId: "cli-flags", operationKey: "other" })
      const gone = { ...built.image, localId: `sha256:${"6".repeat(64)}` }
      journal(other, "image_bound", {
        targetId: "cli-flags",
        pin: recipe.pin,
        key: built.key,
        tag: built.tag,
        image: gone,
      })
      const refused = await factory.dispatch(other)
      expect(refused).toMatchObject({ ok: false, state: "received" })
      expect(refused.message).toMatch(
        /is bound to image sha256:6{64} .* no longer holds it: .* Cancel it and create a new work order$/,
      )
      expect(eventsOf(other, "image_changed")[0]?.payload).toEqual({
        bound: gone.localId,
        boundKey: built.key,
        reason: "gone",
      })
    } finally {
      images.restore()
    }
  })
})
