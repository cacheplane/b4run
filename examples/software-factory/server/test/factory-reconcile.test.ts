import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory, type FactoryOptions } from "../src/controller/factory.ts"
import { createCommandLog } from "../src/registry/commands.ts"
import { openRegistry } from "../src/registry/db.ts"
import { createWorkOrderStore } from "../src/registry/work-orders.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
const registryPath = () => join(dir, "registry.sqlite")
const outbox = () => join(dir, "outbox")

async function bootWorker(options: Omit<FakeWorkerOptions, "outboxDir"> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-reconcile-"))
  // The worker writes its receipt here; both it and readdirSync need the directory to exist.
  mkdirSync(outbox(), { recursive: true })
  fake = await createFakeWorker({ outboxDir: outbox(), ...options })
}
async function bootFactory(overrides: Partial<FactoryOptions> = {}) {
  factory = await createFactory({
    registryPath: registryPath(),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/fix#agent",
    outboxDir: outbox(),
    receiptWaitMs: 500,
    ...overrides,
  })
  return factory
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
  dir = undefined as unknown as string
  fake = undefined as unknown as FakeWorker
  factory = undefined as unknown as Factory
})
/** Simulate a crash: drop the in-memory factory without letting it finish anything. */
const crash = () => factory.close()
const now = () => new Date().toISOString()
const posts = () => fake.requests.filter((r) => r.method === "POST").length
const threadPosts = () => fake.requests.filter((r) => r.path === "/threads").length

describe("reconciliation", () => {
  it("restores awaiting_approval from the worker's pending prompt and approve still works", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval")
    await crash()
    const writesBefore = posts()
    await bootFactory()
    expect(posts()).toBe(writesBefore)
    expect(threadPosts()).toBe(1)
    expect(factory.show(id)).toMatchObject({
      state: "awaiting_approval",
      revision: row.revision,
      interruptId: row.interruptId,
    })
    const outcome = await factory.approve(id, {
      revision: row.revision,
      candidateDigest: row.candidateDigest as string,
    })
    expect(outcome.state).toBe("exported")
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
    const threadsBefore = threadPosts()
    await bootFactory()
    expect(threadPosts()).toBe(threadsBefore)
    expect(factory.show(id)).toMatchObject({ workerThreadId: threadId })
    expect(
      factory.events(id).find((e) => e.payload.resolution === "thread_adopted")?.payload,
    ).toMatchObject({ threadId })
    // The adopted thread never ran, so the run rules settle it rather than leaving it dispatched.
    expect(factory.show(id)).toMatchObject({
      state: "failed",
      failureReason: "ended_without_candidate",
    })
    expect(await factory.dispatch(id, "dispatch-orphan")).toMatchObject({
      ok: true,
      message: expect.stringMatching(/Adopted thread/),
    })
    expect(threadPosts()).toBe(threadsBefore)
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

  it("blocks with interrupt_vanished when the prompt is gone while awaiting approval", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval")
    await crash()
    await fetch(`${fake.baseUrl}/threads/${row.workerThreadId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: [{ interruptId: row.interruptId, status: "resolved", payload: "deny" }],
        route: "/fix#agent",
      }),
    }).then((r) => r.text())
    await bootFactory()
    expect(factory.show(id)).toMatchObject({
      state: "blocked",
      blockedReason: "interrupt_vanished",
    })
  })

  it("marks exporting as exported from an existing receipt without a worker write", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval")
    await crash()
    const registry = openRegistry(registryPath())
    const store = createWorkOrderStore(registry.db)
    store.recordApproval({
      id: "ap-forged",
      workOrderId: id,
      interruptId: row.interruptId as string,
      candidateDigest: row.candidateDigest as string,
      decision: "approved",
      decidedBy: "operator",
      decidedAt: now(),
      expiresAt: now(),
    })
    store.update(id, row.revision, { state: "exporting", activeStartedAt: now() }, now())
    registry.close()
    writeFileSync(join(outbox(), `${fake.digest}.json`), "{}")
    const before = posts()
    await bootFactory()
    expect(factory.show(id)?.state).toBe("exported")
    expect(posts()).toBe(before)
  })

  it("blocks exporting with export_unconfirmed when no receipt exists", async () => {
    await bootWorker()
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval")
    await crash()
    const registry = openRegistry(registryPath())
    createWorkOrderStore(registry.db).update(
      id,
      row.revision,
      { state: "exporting", activeStartedAt: now() },
      now(),
    )
    registry.close()
    await bootFactory()
    expect(factory.show(id)).toMatchObject({
      state: "blocked",
      blockedReason: "export_unconfirmed",
    })
    expect(readdirSync(outbox())).toEqual([])
  })

  it("finishes a cancel that was requested before the crash", async () => {
    await bootWorker({ run: "hang" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    await crash()
    const registry = openRegistry(registryPath())
    const store = createWorkOrderStore(registry.db)
    store.update(id, store.get(id)?.revision ?? 0, { state: "cancel_requested" }, now())
    registry.close()
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
    const registry = openRegistry(registryPath())
    const store = createWorkOrderStore(registry.db)
    store.update(
      id,
      store.get(id)?.revision ?? 0,
      { state: "cancel_requested", blockedReason: "budget_exhausted" },
      now(),
    )
    registry.close()
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

  // The fake parks 50 ms after destroying the socket, so the reconciliation the lost stream
  // triggers normally sees a live run, reattaches, and finds the gate on the pass that follows
  // the reattached stream (stream_lost, reattached, reattached_turn_ended, then the gate). On a
  // machine slow enough for the park to land first, the same pass finds the gate directly.
  // Either way the work order ends up awaiting approval on the digest the lost stream carried.
  it("recovers a lost stream: the parked prompt is found and the work order awaits approval", async () => {
    await bootWorker({ run: "close_midway" })
    await bootFactory()
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval")
    expect(row.candidateDigest).toBe(fake.digest)
    expect(factory.events(id).map((e) => e.type)).toContain("stream_lost")
  })
})
