import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import type { CommandOutcome, WorkOrderRow } from "../src/lib/domain/work-order.ts"
import type { Verifier } from "../src/lib/verification/verifier.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
let reader: FakeWorkspaceReader
const BASE_MS = Date.parse("2026-09-16T10:00:00.000Z")
let nowMs = BASE_MS

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

const out = () => join(dir, "out")

async function boot(
  worker: Omit<FakeWorkerOptions, "outboxDir"> = {},
  overrides: Partial<FactoryOptions> = {},
) {
  dir = mkdtempSync(join(tmpdir(), "factory-cancel-"))
  // readdirSync asserts on this directory before anything is written to it.
  mkdirSync(out(), { recursive: true })
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only", ...worker })
  reader = createFakeWorkspaceReader({})
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "tasks"),
    workers: fakeWorkerMap({
      builder: { client: createHttpWorkerClient(fake.baseUrl), reader },
    }),
    exportDir: out(),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ verdict: "pass" }),
    captureBaseline: captureRepairable,
    now: () => nowMs,
    ...overrides,
  })
}
// The clock is shared state a test may have advanced: every test starts from the same now.
beforeEach(() => {
  nowMs = BASE_MS
})
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

const cancels = () => fake.requests.filter((r) => r.path.endsWith("/cancel"))
const resumes = () => fake.requests.filter((r) => r.path.endsWith("/resume"))

/** Drive a work order through the verifying phase to the frozen bundle. */
async function awaiting(): Promise<WorkOrderRow & { bundleDigest: string }> {
  const { id } = await factory.create({ taskId: "cli-flags" })
  await factory.dispatch(id)
  const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
  reader.set(dispatched.workerThreadId as string, repaired())
  const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
  if (row.bundleDigest === null) throw new Error(`${id} reached the gate with no frozen bundle`)
  return row as WorkOrderRow & { bundleDigest: string }
}

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
    const cancelled = events.indexOf("worker_cancel:interrupted")
    const ended = events.indexOf("transition:run_ended_after_cancel")
    // Both present, and in that order: indexOf's -1 would satisfy a bare `toBeLessThan`.
    expect(cancelled).toBeGreaterThanOrEqual(0)
    expect(ended).toBeGreaterThanOrEqual(0)
    expect(cancelled).toBeLessThan(ended)
    // The observer journals the worker's cancelled turn even though the cancel command,
    // not the observer, is what settles the row.
    expect(events).toContain("run_cancelled_observed:")
  })

  it("cancels an awaiting_approval work order without asking the worker for anything", async () => {
    await boot()
    const row = await awaiting()
    expect((await factory.cancel(row.id)).state).toBe("cancelled")
    // The turn is long over and rung 1 parks no gate on the worker: there is nothing to
    // cancel and nothing to deny, and the approved bytes were never written.
    expect(cancels()).toHaveLength(0)
    expect(resumes()).toHaveLength(0)
    expect(readdirSync(out())).toEqual([])
  })

  it("cancels a work order that is still being verified, and freezes no bundle", async () => {
    // A verifier that parks inside the phase: the only way to hold a row in `verifying`
    // long enough to cancel it deterministically.
    const inner = createFakeVerifier({ verdict: "pass" })
    let release = () => {}
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    // Announced as well as parked. Waiting for the row to reach `verifying` is NOT enough
    // to know the phase is inside the verifier: the transition happens first, and the
    // baseline capture, the workspace read and the assembly all follow it, each with a
    // `state !== "verifying"` guard that returns early on a cancelled row. Under load the
    // cancel below can land in one of those windows, the verifier is then never called,
    // `release()` frees nothing and the wait for `receipt_issued` times out — a false red
    // over the controller behaving correctly.
    let entered = () => {}
    const entry = new Promise<void>((resolve) => {
      entered = resolve
    })
    const verifier: Verifier = {
      async verify(input, signal) {
        entered()
        await parked
        return inner.verify(input, signal)
      },
    }
    await boot({}, { verifier })
    const { id } = await factory.create({ taskId: "cli-flags" })
    try {
      await factory.dispatch(id)
      const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
      reader.set(dispatched.workerThreadId as string, repaired())
      await factory.waitFor(id, (r) => r.state === "verifying", 20_000)
      await entry

      const outcome = await factory.cancel(id)
      expect(outcome).toEqual({ ok: true, state: "cancelled", message: "Cancelled" })
      const events = factory.events(id).map((e) => `${e.type}:${String(e.payload.event ?? "")}`)
      const requested = events.indexOf("transition:cancel")
      const ended = events.indexOf("transition:run_ended_after_cancel")
      expect(requested).toBeGreaterThanOrEqual(0)
      expect(ended).toBeGreaterThan(requested)
      // The turn had already ended, so there was no run to interrupt.
      expect(cancels()).toHaveLength(0)
    } finally {
      release()
    }
    // The phase runs to its end against a cancelled row and freezes nothing: a bundle is an
    // offer of consent, and there is no longer anyone to offer it to.
    await factory.waitFor(
      id,
      () => factory.events(id).some((e) => e.type === "receipt_issued"),
      20_000,
    )
    expect(factory.show(id)).toMatchObject({ state: "cancelled", bundleDigest: null })
    expect(factory.events(id).map((e) => e.type)).not.toContain("bundle_frozen")
    expect(readdirSync(out())).toEqual([])
  })

  it("aborts a verifier still running when the work order is cancelled", async () => {
    // The verifier parks until its own signal aborts. Only a per-work-order signal can free
    // it: the factory-wide one aborts on close(), long after the operator asked.
    let entered = () => {}
    const entry = new Promise<void>((resolve) => {
      entered = resolve
    })
    let observed: AbortSignal | null = null
    const verifier: Verifier = {
      verify(_input, signal) {
        observed = signal
        entered()
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
    }
    await boot({}, { verifier })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    await entry

    const outcome = await factory.cancel(id)
    expect(outcome).toEqual({ ok: true, state: "cancelled", message: "Cancelled" })
    const aborted = new Promise<boolean>((resolve) => {
      const signal = observed as AbortSignal | null
      if (!signal) return resolve(false)
      if (signal.aborted) return resolve(true)
      signal.addEventListener("abort", () => resolve(true), { once: true })
      setTimeout(() => resolve(false), 5_000).unref()
    })
    expect(await aborted).toBe(true)
    await factory.waitFor(
      id,
      () => factory.events(id).some((e) => e.type === "verification_aborted"),
      20_000,
    )
    expect(factory.show(id)).toMatchObject({ state: "cancelled", bundleDigest: null })
    const types = factory.events(id).map((e) => e.type)
    expect(types).not.toContain("bundle_frozen")
    expect(types).not.toContain("verifier_unavailable")
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
    const row = await awaiting()
    await factory.cancel(row.id)
    const outcome = await factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
    })
    expect(outcome).toMatchObject({ ok: false, message: "Cannot approve from cancelled" })
  })

  it("lets an approve race a cancel without stranding a command", async () => {
    await boot()
    const row = await awaiting()
    const [approved, cancelled] = await Promise.all([
      factory.approve(row.id, { revision: row.revision, bundleDigest: row.bundleDigest }),
      factory.cancel(row.id),
    ])
    expect([approved.ok, cancelled.ok].filter(Boolean)).toHaveLength(1)
    // Whichever lost says so in its outcome; neither is left in flight for a restart to find.
    expect((approved.ok ? cancelled : approved).message).toMatch(
      /changed state while approving|Cannot approve from|terminal/,
    )
    expect(["exported", "cancelled"]).toContain(factory.show(row.id)?.state)
  })

  it("lets a deny race a cancel without stranding a command", async () => {
    await boot()
    const row = await awaiting()
    const settled = await Promise.allSettled([
      factory.deny(row.id, "deny-1"),
      factory.cancel(row.id, "cancel-1"),
    ])
    // Both commands answer: the loser says why rather than rejecting or leaving its key open.
    expect(settled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"])
    const outcomes = settled.map((r) => (r as PromiseFulfilledResult<CommandOutcome>).value)
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1)
    expect(outcomes.find((o) => !o.ok)?.message).toMatch(
      /changed state while denying|Cannot deny from|terminal|no longer pending/,
    )
    expect(["denied", "cancelled"]).toContain(factory.show(row.id)?.state)
    // Replaying either key reads its recorded outcome; neither is in flight for a restart.
    expect(await factory.deny(row.id, "deny-1")).toEqual(outcomes[0])
    expect(await factory.cancel(row.id, "cancel-1")).toEqual(outcomes[1])
  })

  it("refuses an unconfirmed cancel and lets reconciliation finish it", async () => {
    await boot({ run: "hang" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    // The worker is gone before the cancel is even attempted: nothing may record `cancelled`.
    await fake.close()
    const outcome = await factory.cancel(id, "cancel-1")
    expect(outcome).toMatchObject({
      ok: false,
      state: "cancel_requested",
      message: expect.stringMatching(/Cancel not confirmed/),
    })
    expect(factory.show(id)?.state).toBe("cancel_requested")
    await factory.close()

    // A fresh factory over the same registry, against a worker that has never heard of the
    // thread: the 404 is the evidence that the run is over, and there is no prompt to deny.
    const replacement = await createFakeWorker({ outboxDir: join(dir, "unused") })
    const revived = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      generatedTasksDir: join(dir, "tasks"),
      workers: fakeWorkerMap({
        builder: { client: createHttpWorkerClient(replacement.baseUrl), reader },
      }),
      exportDir: out(),
      artifactsDir: join(dir, "artifacts"),
      verifier: createFakeVerifier({ verdict: "pass" }),
      captureBaseline: captureRepairable,
      now: () => nowMs,
    })
    try {
      expect(revived.show(id)?.state).toBe("cancelled")
      expect(replacement.requests.filter((r) => r.path.endsWith("/resume"))).toHaveLength(0)
      expect(replacement.requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(0)
    } finally {
      await revived.close()
      await replacement.close()
    }
  })

  it("does not strand a key when a dispatch races a cancel", async () => {
    await boot()
    const { id } = await factory.create({ taskId: "cli-flags" })
    const settled = await Promise.allSettled([
      factory.dispatch(id, "dispatch-1"),
      factory.cancel(id, "cancel-1"),
    ])
    expect(settled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"])
    const outcomes = settled.map((r) => (r as PromiseFulfilledResult<CommandOutcome>).value)
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1)
    // The thread the losing dispatch created is journalled and ended rather than leaked.
    if (!outcomes[0]?.ok) {
      expect(outcomes[0]?.message).toBe("Work order changed state while dispatching")
      const orphaned = factory.events(id).find((e) => e.type === "thread_orphaned")
      expect(orphaned?.payload.threadId).toEqual(expect.any(String))
      expect(cancels()).toHaveLength(1)
    }
    expect(await factory.dispatch(id, "dispatch-1")).toEqual(outcomes[0])
    expect(await factory.cancel(id, "cancel-1")).toEqual(outcomes[1])
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
    const row = await awaiting()
    nowMs += 60_000
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(factory.show(row.id)?.state).toBe("awaiting_approval")
    expect(cancels()).toHaveLength(0)
  })
})
