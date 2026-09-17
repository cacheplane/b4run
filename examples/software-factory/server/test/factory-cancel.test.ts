import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory, type FactoryOptions } from "../src/controller/factory.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
let nowMs = Date.parse("2026-09-16T10:00:00.000Z")

async function boot(
  worker: Omit<FakeWorkerOptions, "outboxDir"> = {},
  overrides: Partial<FactoryOptions> = {},
) {
  dir = mkdtempSync(join(tmpdir(), "factory-cancel-"))
  // Both the worker's receipt write and readdirSync need the directory to exist.
  mkdirSync(join(dir, "outbox"), { recursive: true })
  fake = await createFakeWorker({ outboxDir: join(dir, "outbox"), ...worker })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/fix#agent",
    outboxDir: join(dir, "outbox"),
    now: () => nowMs,
    ...overrides,
  })
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

const cancels = () => fake.requests.filter((r) => r.path.endsWith("/cancel"))
const resumes = () => fake.requests.filter((r) => r.path.endsWith("/resume"))

describe("cancel", () => {
  it("reaches a running worker and ends cancelled only after the run ended", async () => {
    await boot({ run: "hang" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    const outcome = await factory.cancel(id)
    expect(outcome).toEqual({ ok: true, state: "cancelled", message: "Cancelled" })
    expect(cancels()).toHaveLength(1)
    const events = factory
      .events(id)
      .map((e) => `${e.type}:${String(e.payload.event ?? e.payload.result ?? "")}`)
    expect(events.indexOf("worker_cancel:interrupted")).toBeLessThan(
      events.indexOf("transition:run_ended_after_cancel"),
    )
    // The observer journals the worker's cancelled turn even though the cancel command,
    // not the observer, is what settles the row.
    expect(events).toContain("run_cancelled_observed:")
  })

  it("cancels an awaiting_approval work order by denying its gate, and writes nothing", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval")
    expect((await factory.cancel(id)).state).toBe("cancelled")
    expect(cancels()).toHaveLength(0)
    expect(resumes()).toHaveLength(1)
    expect(resumes()[0]?.body).toMatchObject({
      resume: [{ interruptId: row.interruptId, payload: "deny" }],
    })
    expect(readdirSync(join(dir, "outbox"))).toEqual([])
  })

  it("cancels a received work order that has no thread", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    expect((await factory.cancel(id)).state).toBe("cancelled")
    expect(fake.requests).toHaveLength(0)
  })

  it("refuses cancel on a terminal work order and is idempotent per key", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    const first = await factory.cancel(id, "cancel-1")
    expect(await factory.cancel(id, "cancel-1")).toEqual(first)
    expect(await factory.cancel(id, "cancel-2")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/terminal/),
    })
  })

  it("refuses an approve that arrives after the work order was cancelled", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval")
    await factory.cancel(id)
    const outcome = await factory.approve(id, {
      revision: row.revision,
      candidateDigest: fake.digest,
    })
    expect(outcome).toMatchObject({ ok: false, message: "Cannot approve from cancelled" })
  })

  it("lets an approve race a cancel without stranding a command", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval")
    const [approved, cancelled] = await Promise.all([
      factory.approve(id, { revision: row.revision, candidateDigest: fake.digest }),
      factory.cancel(id),
    ])
    expect([approved.ok, cancelled.ok].filter(Boolean)).toHaveLength(1)
    // Whichever lost says so in its outcome; neither is left in flight for a restart to find.
    expect((approved.ok ? cancelled : approved).message).toMatch(
      /changed state while approving|Cannot approve from|terminal/,
    )
    expect(["exported", "cancelled"]).toContain(factory.show(id)?.state)
  })

  it("closes within its timeout even while a run is hanging", async () => {
    await boot({ run: "hang" }, { closeTimeoutMs: 200 })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    const started = Date.now()
    await factory.close()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe("budget", () => {
  it("cancels an over-budget run and blocks it with budget_exhausted", async () => {
    await boot({ run: "hang" }, { maxActiveMs: 1_000, budgetTickMs: 10 })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    nowMs += 5_000
    const row = await factory.waitFor(id, (r) => r.state === "blocked", 5_000)
    expect(row.blockedReason).toBe("budget_exhausted")
    expect(cancels()).toHaveLength(1)
    expect(row.activeMs).toBeGreaterThanOrEqual(5_000)
    const after = fake.requests.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fake.requests.length).toBe(after)
  })

  it("does not count time spent awaiting approval", async () => {
    await boot({}, { maxActiveMs: 1_000, budgetTickMs: 10 })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "awaiting_approval")
    nowMs += 60_000
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(factory.show(id)?.state).toBe("awaiting_approval")
    expect(cancels()).toHaveLength(0)
  })
})
