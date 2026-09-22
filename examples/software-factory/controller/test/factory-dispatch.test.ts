import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { taskPrompt } from "../src/lib/prompts.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
let reader: FakeWorkspaceReader

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

async function boot(options: Omit<FakeWorkerOptions, "outboxDir"> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-dispatch-"))
  mkdirSync(join(dir, "out"), { recursive: true })
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", ...options })
  reader = createFakeWorkspaceReader({})
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/build#agent",
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ verdict: "pass" }),
    workspaceReader: reader,
    captureBaseline: captureRepairable,
  })
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
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
      worker: createHttpWorkerClient(fake.baseUrl),
      workerRoute: "/build#agent",
      exportDir: join(dir, "out"),
      artifactsDir: join(dir, "artifacts"),
      verifier: createFakeVerifier({ verdict: "pass" }),
      workspaceReader: reader,
      captureBaseline: captureRepairable,
      now: () => (clock += 1_000),
    })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await dispatchWith(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
    expect(row.activeMs).toBeGreaterThan(0)
    expect(row.activeStartedAt).toBeNull()
  })

  it("refuses to dispatch a task with no prompt instead of sending an empty one", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    // create validates the task id, so a prompt table that lost the task between create and
    // dispatch is the only way to reach the guard — which is exactly the upgrade case.
    const starved = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      worker: createHttpWorkerClient(fake.baseUrl),
      workerRoute: "/build#agent",
      exportDir: join(dir, "out"),
      artifactsDir: join(dir, "artifacts"),
      verifier: createFakeVerifier({ verdict: "pass" }),
      workspaceReader: reader,
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
})
