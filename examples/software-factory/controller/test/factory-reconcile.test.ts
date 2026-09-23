import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterEach, describe, expect, it } from "vitest"
import type { ControllerContext } from "../src/lib/controller/context.ts"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import { reconcileWorkOrder } from "../src/lib/controller/reconcile.ts"
import { exportApproved } from "../src/lib/delivery/export.ts"
import { nextState, type TransitionEvent } from "../src/lib/domain/states.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { createCommandLog } from "../src/lib/registry/commands.ts"
import { openRegistry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore, type WorkOrderPatch } from "../src/lib/registry/work-orders.ts"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import type { Verifier } from "../src/lib/verification/verifier.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
let reader: FakeWorkspaceReader
const registryPath = () => join(dir, "registry.sqlite")
const out = () => join(dir, "out")

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
/** A workspace identical to the baseline: the thread exists but produced nothing. */
const untouched = () => ({ ...repaired(), "src/cli.ts": "broken\n" })

async function bootWorker(options: Omit<FakeWorkerOptions, "outboxDir"> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-reconcile-"))
  // readdirSync asserts on this directory before anything is written to it.
  mkdirSync(out(), { recursive: true })
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), ...options })
  // The reader outlives each factory, exactly as the builder's sandbox outlives a restart.
  reader = createFakeWorkspaceReader({})
}
async function bootFactory(overrides: Partial<FactoryOptions> = {}) {
  factory = await createFactory({
    registryPath: registryPath(),
    generatedTasksDir: join(dir, "tasks"),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/build#agent",
    exportDir: out(),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ verdict: "pass" }),
    workspaceReader: reader,
    captureBaseline: captureRepairable,
    ...overrides,
  })
  return factory
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  // A test that needs no worker and no factory (the controller rules exercised directly
  // against a stub context) never makes a directory to remove.
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined as unknown as string
  fake = undefined as unknown as FakeWorker
  factory = undefined as unknown as Factory
  reader = undefined as unknown as FakeWorkspaceReader
})
/** Simulate a crash: drop the in-memory factory without letting it finish anything. */
const crash = () => factory.close()
const now = () => new Date().toISOString()
const posts = () => fake.requests.filter((r) => r.method === "POST").length
const threadPosts = () => fake.requests.filter((r) => r.path === "/threads").length
const runPosts = () =>
  fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/runs/stream")).length

/** Drive a work order through the verifying phase to the frozen bundle. */
async function awaiting(files: Readonly<Record<string, string>> = repaired()) {
  const { id } = await factory.create({ taskId: "cli-flags" })
  await factory.dispatch(id)
  const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
  reader.set(dispatched.workerThreadId as string, files)
  const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
  return { id, row, threadId: dispatched.workerThreadId as string }
}

/** Rewrite the row directly, the way a crash mid-phase would leave it. */
function forceRow(id: string, patch: WorkOrderPatch): void {
  const registry = openRegistry(registryPath())
  const rows = createWorkOrderStore(registry.db)
  const row = rows.get(id)
  if (!row) throw new Error(`no work order ${id}`)
  rows.update(id, row.revision, patch, now())
  registry.close()
}
describe("reconciliation", () => {
  it("leaves awaiting_approval untouched across a restart and approve still works", async () => {
    await bootWorker({ run: "edits_only" })
    await bootFactory()
    const { id, row } = await awaiting()
    await crash()
    const writesBefore = posts()
    await bootFactory()
    // Rung 1's gate is the controller's own frozen bundle: there is nothing to ask the
    // worker about, so reconciliation asks it nothing.
    expect(posts()).toBe(writesBefore)
    expect(threadPosts()).toBe(1)
    expect(factory.show(id)).toMatchObject({
      state: "awaiting_approval",
      revision: row.revision,
      bundleDigest: row.bundleDigest,
      candidateDigest: row.candidateDigest,
    })
    const outcome = await factory.approve(id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest as string,
    })
    expect(outcome.state).toBe("exported")
  })

  it("re-verifies a work order found in verifying rather than resuming it", async () => {
    await bootWorker({ run: "edits_only" })
    await bootFactory()
    const { id } = await awaiting()
    await crash()
    forceRow(id, { state: "verifying", bundleDigest: null })

    await bootFactory()
    const settled = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
    expect(settled.bundleDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(factory.events(id).filter((e) => e.type === "reconciled").length).toBeGreaterThan(0)
    // Verification has no durable external effect, so it is run again — never resumed, and
    // never re-dispatched: the worker is asked for no second run.
    expect(runPosts()).toBe(1)
    expect(readdirSync(out())).toEqual([])
  })

  it("blocks a verifying work order whose candidate can no longer be reproduced", async () => {
    await bootWorker({ run: "edits_only" })
    await bootFactory()
    const { id, threadId } = await awaiting()
    await crash()
    forceRow(id, { state: "verifying", bundleDigest: null })
    // The builder's workspace is gone, as it would be after a sandbox reap.
    reader.forget(threadId)

    await bootFactory()
    const settled = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    // Nothing is known about the builder's work once its workspace is gone, which is what
    // `inconclusive` says. `scope_violation` would assert an assembly that never happened.
    expect(settled.blockedReason).toBe("verification_inconclusive")
    expect(factory.events(id).map((e) => e.type)).toContain("workspace_unreadable")
    expect(runPosts()).toBe(1)
    // The phase reads the workspace itself: reconciliation adds no second read of its own.
    expect(reader.reads.filter((t) => t === threadId)).toHaveLength(2)
  })

  it("boots while a re-verification is still in its container, and a cancel ends it", async () => {
    // Re-verification is container work with a deadline of its own. A boot that waits for it
    // has nothing listening — no HTTP, no budget ticker — so nothing could cancel a verifier
    // that hangs, and the factory would be down for as long as the container ran.
    await bootWorker({ run: "edits_only" })
    await bootFactory()
    const { id } = await awaiting()
    await crash()
    forceRow(id, { state: "verifying", bundleDigest: null })

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
    const booted = bootFactory({ verifier })
    const outcome = await Promise.race([
      booted.then(() => "booted" as const),
      entry.then(() => sleep(2_000)).then(() => "verifier still holds boot" as const),
    ])
    expect(outcome).toBe("booted")
    await booted
    expect(factory.show(id)?.state).toBe("verifying")
    // Boot came back first; the phase is still on its way into the verifier. Cancel only once
    // it is inside, or the state guards ahead of the verifier return before it is ever called.
    await entry

    expect((await factory.cancel(id)).state).toBe("cancelled")
    expect((observed as AbortSignal | null)?.aborted).toBe(true)
    await factory.waitFor(
      id,
      () => factory.events(id).some((e) => e.type === "verification_aborted"),
      20_000,
    )
    expect(factory.show(id)).toMatchObject({ state: "cancelled", bundleDigest: null })
  })

  it("blocks a verifying work order with no worker thread instead of stranding it", async () => {
    await bootWorker({ run: "edits_only" })
    await bootFactory()
    const { id } = await awaiting()
    await crash()
    // The verifying phase returns without deciding when there is no thread to read, and a
    // row it leaves in `verifying` would be rediscovered, untouched, by every later boot.
    forceRow(id, { state: "verifying", bundleDigest: null, workerThreadId: null })

    await bootFactory()
    const settled = await factory.waitFor(id, (r) => r.state === "blocked", 20_000)
    expect(settled.blockedReason).toBe("verification_inconclusive")
    expect(factory.events(id).map((e) => e.type)).toContain("verification_undecided")
    expect(runPosts()).toBe(1)
  })

  it("blocks a verifying work order when the phase returns without deciding at all", async () => {
    // Any future early return from the verifying phase looks like this one: the phase came
    // back and the row it was handed is still `verifying`. The post-condition is about the
    // row, not about today's single cause, so the phase here simply decides nothing.
    let row = {
      id: "wo-undecided",
      state: "verifying",
      workerThreadId: "th-1",
      blockedReason: null,
    } as unknown as WorkOrderRow
    const seen: string[] = []
    const tracked: Promise<void>[] = []
    const ctx = {
      signal: new AbortController().signal,
      track: (_id: string, run: Promise<void>) => {
        tracked.push(run)
      },
      mustGet: () => row,
      recordEvent: (_id: string, type: string) => {
        seen.push(type)
      },
      transition: (_id: string, event: TransitionEvent, patch: Partial<WorkOrderRow> = {}) => {
        seen.push(event)
        row = { ...row, ...patch, state: nextState(row.state, event) }
        return row
      },
      runVerification: async () => {},
    } as unknown as ControllerContext

    await reconcileWorkOrder(ctx, row.id)
    // The phase is a tracked background run now, not something the walk awaits.
    await Promise.all(tracked)
    expect(row).toMatchObject({ state: "blocked", blockedReason: "verification_inconclusive" })
    expect(seen).toEqual(["reconciled", "verification_undecided", "receipt_inconclusive"])
  })

  it("marks a dispatch that died before committing a thread as failed and keeps the work order received", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await crash()
    const registry = openRegistry(registryPath())
    createCommandLog(registry.db).begin(
      "dispatch-crashed",
      id,
      { command: "dispatch", args: {} },
      now(),
    )
    registry.close()
    await bootFactory()
    expect(factory.show(id)?.state).toBe("received")
    expect(await factory.dispatch(id, "dispatch-crashed")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/dispatch again/),
    })
    expect(threadPosts()).toBe(0)
  })

  it("adopts the orphan thread a crashed dispatch journalled instead of creating a second one", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await crash()
    // The exact window dispatch leaves open: the thread exists on the worker and is journalled,
    // but the process died before `dispatch_committed` reached the row.
    const created = await fetch(`${fake.baseUrl}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { factoryWorkOrderId: id } }),
    })
    const threadId = ((await created.json()) as { thread_id: string }).thread_id
    const registry = openRegistry(registryPath())
    createCommandLog(registry.db).begin(
      "dispatch-orphan",
      id,
      { command: "dispatch", args: {} },
      now(),
    )
    createWorkOrderStore(registry.db).appendEvent(id, "thread_created", { threadId }, now())
    registry.close()
    // The adopted thread never ran, so its workspace is still the baseline.
    reader.set(threadId, untouched())
    const threadsBefore = threadPosts()
    await bootFactory()
    expect(threadPosts()).toBe(threadsBefore)
    expect(factory.show(id)).toMatchObject({ workerThreadId: threadId })
    expect(
      factory.events(id).find((e) => e.payload.resolution === "thread_adopted")?.payload,
    ).toMatchObject({ threadId })
    // The controller cannot tell a thread that never ran from one that did: it reads the
    // workspace and finds nothing changed, which is what settles the row.
    const settledRow = await factory.waitFor(id, (r) => r.state === "failed", 20_000)
    expect(settledRow.failureReason).toBe("ended_without_candidate")
    expect(await factory.dispatch(id, "dispatch-orphan")).toMatchObject({
      ok: true,
      message: expect.stringMatching(/Adopted thread/),
    })
    expect(threadPosts()).toBe(threadsBefore)
  })

  it("fails a run found with no thread recorded", async () => {
    await bootWorker({ run: "hang" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    await crash()
    // There is no workspace to read and no turn to wait for: the row names no thread at all.
    forceRow(id, { workerThreadId: null })
    await bootFactory()
    const settled = await factory.waitFor(id, (r) => r.state === "failed", 20_000)
    expect(settled.failureReason).toBe("ended_without_candidate")
    expect(
      factory.events(id).find((e) => e.payload.event === "turn_ended_without_changes")?.payload,
    ).toMatchObject({
      from: "running",
      to: "failed",
      reconciled: true,
      reason: "no thread recorded",
    })
    // Nothing was asked of the worker about a thread the row cannot name.
    expect(threadPosts()).toBe(1)
  })

  it("fails a run whose thread the worker no longer knows", async () => {
    await bootWorker({ run: "hang" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    await crash()
    // The thread is gone from the worker, so the row is left in a run state naming one that
    // cannot be asked anything — no workspace behind it and no turn still to end.
    forceRow(id, { state: "dispatched", workerThreadId: "th-forgotten" })
    await bootFactory()
    const settled = await factory.waitFor(id, (r) => r.state === "failed", 20_000)
    expect(settled.failureReason).toBe("ended_without_candidate")
    expect(
      factory.events(id).find((e) => e.payload.event === "turn_ended_without_changes")?.payload,
    ).toMatchObject({
      from: "dispatched",
      to: "failed",
      reconciled: true,
      reason: "thread not found on worker",
    })
    expect(runPosts()).toBe(1)
  })

  it("reattaches to a live run once even when the row also has an open command intent", async () => {
    await bootWorker({ run: "hang" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    await crash()
    // An open intent puts this row through the command loop as well as the work-order walk.
    const registry = openRegistry(registryPath())
    createCommandLog(registry.db).begin(
      "cancel-crashed",
      id,
      { command: "cancel", args: {} },
      now(),
    )
    registry.close()
    await bootFactory()
    const reattaches = fake.requests.filter(
      (r) => r.method === "GET" && r.path.endsWith("/runs/stream"),
    )
    expect(reattaches).toHaveLength(1)
    expect(factory.events(id).filter((e) => e.type === "reattached")).toHaveLength(1)
  })

  it("marks exporting as exported from the bytes it already wrote", async () => {
    await bootWorker({ run: "edits_only" })
    await bootFactory()
    const { id, row } = await awaiting()
    const { bundle, candidate } = factory.evidence(id)
    if (!bundle || !candidate) throw new Error("no frozen evidence")
    const changes = JSON.parse(
      await createArtifactStore(join(dir, "artifacts")).read(candidate.artifactDigest),
    ) as Record<string, string>
    await crash()
    const registry = openRegistry(registryPath())
    const rows = createWorkOrderStore(registry.db)
    rows.recordApproval({
      id: "ap-forged",
      workOrderId: id,
      bundleDigest: row.bundleDigest as string,
      candidateDigest: row.candidateDigest as string,
      decision: "approved",
      decidedBy: "operator",
      decidedAt: now(),
      expiresAt: now(),
    })
    rows.update(id, row.revision, { state: "exporting", activeStartedAt: now() }, now())
    registry.close()
    // The write the crashed export had already made: named by the bundle digest, by the
    // controller itself, holding the approved bundle and bytes.
    await exportApproved({ directory: out(), bundle, changes })
    const before = posts()
    await bootFactory()
    expect(factory.show(id)?.state).toBe("exported")
    expect(factory.events(id).map((e) => e.type)).toContain("delivery_observed")
    // The worker has no part in an export: nothing was asked of it.
    expect(posts()).toBe(before)
  })

  it("blocks exporting when the file under the bundle's name is not the approved bundle", async () => {
    // A name is not a delivery. `exportApproved` compares content before it will call an
    // existing file its own; reconciliation must hold the same standard, or a stray file
    // under the right name is enough to mark approved bytes as delivered when they never were.
    await bootWorker({ run: "edits_only" })
    await bootFactory()
    const { id, row } = await awaiting()
    await crash()
    forceRow(id, { state: "exporting", activeStartedAt: now() })
    writeFileSync(join(out(), `${row.bundleDigest}.json`), "{}")
    await bootFactory()
    expect(factory.show(id)).toMatchObject({
      state: "blocked",
      blockedReason: "export_unconfirmed",
    })
    const types = factory.events(id).map((e) => e.type)
    expect(types).toContain("export_mismatch")
    expect(types).not.toContain("delivery_observed")
    // The stray file is left for the operator; reconciliation writes and removes nothing.
    expect(readdirSync(out())).toEqual([`${row.bundleDigest}.json`])
  })

  it("blocks exporting with export_unconfirmed when no bytes were written", async () => {
    await bootWorker({ run: "edits_only" })
    await bootFactory()
    const { id, row } = await awaiting()
    await crash()
    forceRow(id, { state: "exporting", activeStartedAt: now() })
    expect(row.bundleDigest).toMatch(/^[a-f0-9]{64}$/)
    await bootFactory()
    expect(factory.show(id)).toMatchObject({
      state: "blocked",
      blockedReason: "export_unconfirmed",
    })
    // Reconciliation never writes the approved bytes itself: only an approval may do that.
    expect(readdirSync(out())).toEqual([])
  })

  it("finishes a cancel that was requested before the crash", async () => {
    await bootWorker({ run: "hang" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    await crash()
    forceRow(id, { state: "cancel_requested" })
    await bootFactory()
    expect(factory.show(id)?.state).toBe("cancelled")
    expect(fake.requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(1)
  })

  it("re-inserts a work order whose create key was spent before the row landed", async () => {
    await bootWorker()
    // Forged directly: the crash window is between the command log and the insert, so the
    // key carries an outcome for a work order that does not exist.
    const id = `wo-${createHash("sha256").update("create-1").digest("hex").slice(0, 16)}`
    const registry = openRegistry(registryPath())
    const commands = createCommandLog(registry.db)
    commands.begin("create-1", id, { command: "create", args: { taskId: "cli-flags" } }, now())
    commands.complete("create-1", { ok: true, state: "received", message: "Created" })
    registry.close()
    await bootFactory()
    const row = await factory.create({ taskId: "cli-flags", operationKey: "create-1" })
    expect(row).toMatchObject({ id, state: "received" })
    expect(factory.show(id)).toMatchObject({ id, state: "received" })
    // And still idempotent afterwards: the second call reads the row, not a second insert.
    expect((await factory.create({ taskId: "cli-flags", operationKey: "create-1" })).id).toBe(id)
    expect(factory.list()).toHaveLength(1)
  })

  it("finishes a budget cancel as blocked rather than cancelled", async () => {
    await bootWorker({ run: "hang" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    await crash()
    // The shape the budget ticker leaves behind when it dies mid-cancel.
    forceRow(id, { state: "cancel_requested", blockedReason: "budget_exhausted" })
    await bootFactory()
    expect(factory.show(id)).toMatchObject({
      state: "blocked",
      blockedReason: "budget_exhausted",
    })
    expect(fake.requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(1)
  })

  it("reattaches at most once when the run stays live after the reattached stream ends", async () => {
    await bootWorker({ run: "reattach_ends_busy" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, () => factory.events(id).some((e) => e.type === "run_still_live"))
    expect(factory.events(id).filter((e) => e.type === "reattached")).toHaveLength(1)
    expect(factory.events(id).filter((e) => e.type === "run_still_live")).toHaveLength(1)
    expect(
      fake.requests.filter((r) => r.method === "GET" && r.path.endsWith("/runs/stream")),
    ).toHaveLength(1)
    // The bound stops the cycle; it does not invent a verdict the worker never gave.
    expect(factory.show(id)?.state).toBe("running")
  })

  it("does not reattach to a run a live observer already owns", async () => {
    await bootWorker({ run: "hang" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const running = await factory.waitFor(id, (r) => r.state === "running")
    expect(running.workerThreadId).not.toBeNull()

    // What every command does before it acts. The dispatch's observer is live on this thread,
    // so the pass must leave it alone: a reattach here would track a SECOND observer, evict
    // the first from the runs map, and leave close(), settleRun and cancel awaiting nothing.
    const before = fake.requests.length
    await factory.reconcileWorkOrder(id)

    // Not one worker round trip: the guard is checked before the thread read and the
    // pending-interrupt read, so a cancel or deny on a running row pays nothing for it.
    expect(fake.requests.slice(before)).toEqual([])
    expect(
      fake.requests.filter((r) => r.method === "GET" && r.path.endsWith("/runs/stream")),
    ).toHaveLength(0)
    expect(factory.events(id).filter((e) => e.type === "reattached")).toHaveLength(0)
    const skipped = factory.events(id).filter((e) => e.type === "reconcile_skipped")
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.payload).toMatchObject({ reason: "observer_live" })
    expect(factory.show(id)?.state).toBe("running")

    // The observer is still the tracked one: the cancel it is owed settles the work order.
    await factory.cancel(id)
    await factory.waitFor(id, (r) => r.state === "cancelled", 20_000)
  })

  // The fake ends the turn 50 ms after destroying the socket, so the reconciliation the lost
  // stream triggers normally sees a live run, reattaches, and finds the turn over on the pass
  // that follows the reattached stream. On a machine slow enough for the turn to end first,
  // the same pass finds it over directly. Either way the work order is judged on the workspace
  // the turn left behind, which is the only thing the lost stream could not carry away.
  it("recovers a lost stream: the workspace is read and the work order awaits approval", async () => {
    await bootWorker({ run: "edits_only_close_midway" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
    expect(row.candidateDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(row.bundleDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(factory.events(id).map((e) => e.type)).toContain("stream_lost")
    expect(runPosts()).toBe(1)
  })
})
