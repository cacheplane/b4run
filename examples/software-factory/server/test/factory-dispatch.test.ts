import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/controller/factory.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory

async function boot(options: Omit<FakeWorkerOptions, "outboxDir"> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-dispatch-"))
  fake = await createFakeWorker({ outboxDir: join(dir, "outbox"), ...options })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/fix#agent",
    outboxDir: join(dir, "outbox"),
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
})

const settled = (state: string) => !["received", "dispatched", "running"].includes(state)

describe("create and dispatch", () => {
  it("runs the worker turn to awaiting_approval and journals the order of events", async () => {
    await boot()
    const created = await factory.create({ taskId: "cli-flags" })
    expect(created.state).toBe("received")
    const outcome = await factory.dispatch(created.id)
    expect(outcome).toEqual({ ok: true, state: "dispatched", message: "Dispatched" })
    const row = await factory.waitFor(created.id, (r) => settled(r.state))
    expect(row.state).toBe("awaiting_approval")
    expect(row.candidateDigest).toBe(fake.digest)
    expect(row.candidateVerified).toBe(true)
    expect(row.interruptId).toMatch(/^perm-export-/)
    expect(row.awaitingSince).not.toBeNull()
    expect(row.activeStartedAt).toBeNull()
    const types = factory
      .events(created.id)
      .map((e) => `${e.type}:${String(e.payload.event ?? "")}`)
    expect(types).toEqual([
      "created:",
      "thread_created:",
      "transition:dispatch_committed",
      "transition:run_started",
      "candidate_observed:",
      "transition:candidate_interrupt",
    ])
    expect(fake.requests.at(-1)?.body).toMatchObject({
      route: "/fix#agent",
      input: { messages: [{ role: "user", content: expect.stringContaining("prepareReview") }] },
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
    await factory.waitFor(created.id, (r) => settled(r.state))
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
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => settled(r.state))
    expect(row).toMatchObject({ state: "failed", failureReason: "route_error" })
  })

  it("fails when the turn ends without a candidate", async () => {
    await boot({ run: "no_candidate" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => settled(r.state))
    expect(row).toMatchObject({ state: "failed", failureReason: "ended_without_candidate" })
  })

  it("blocks when the gate arrives before any prepareReview result", async () => {
    await boot({ run: "gate_before_prepare" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => settled(r.state))
    expect(row).toMatchObject({ state: "blocked", blockedReason: "candidate_digest_unknown" })
    expect(row.interruptId).toMatch(/^perm-export-/)
    expect(fake.requests.some((r) => r.path.endsWith("/resume"))).toBe(false)
  })

  it("blocks on an unexpected interrupt kind and never resolves it", async () => {
    await boot({ run: "unexpected_interrupt" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => settled(r.state))
    expect(row).toMatchObject({ state: "blocked", blockedReason: "unexpected_interrupt" })
    expect(fake.requests.some((r) => r.path.endsWith("/resume"))).toBe(false)
  })

  it("accumulates active time when the run leaves a run state", async () => {
    // A clock that advances on every read: active time is then strictly positive by
    // construction, so this exercises the accumulate branch rather than asserting >= 0.
    let clock = Date.parse("2026-09-16T10:00:00.000Z")
    dir = mkdtempSync(join(tmpdir(), "factory-dispatch-"))
    fake = await createFakeWorker({ outboxDir: join(dir, "outbox") })
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      worker: createHttpWorkerClient(fake.baseUrl),
      workerRoute: "/fix#agent",
      outboxDir: join(dir, "outbox"),
      now: () => (clock += 1_000),
    })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval")
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
      workerRoute: "/fix#agent",
      outboxDir: join(dir, "outbox"),
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

  it("records a lost stream without changing state", async () => {
    await boot({ run: "close_midway" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, () => factory.events(id).some((e) => e.type === "stream_lost"))
    expect(factory.show(id)).toMatchObject({ state: "running", candidateDigest: fake.digest })
  })
})
