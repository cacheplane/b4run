import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/controller/factory.ts"
import type { WorkOrderRow } from "../src/domain/work-order.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
let nowMs = Date.parse("2026-09-16T10:00:00.000Z")

async function boot(options: Omit<FakeWorkerOptions, "outboxDir"> = {}) {
  dir = mkdtempSync(join(tmpdir(), "factory-approve-"))
  // The worker writes its receipt here; both it and readdirSync need the directory to exist.
  mkdirSync(join(dir, "outbox"), { recursive: true })
  fake = await createFakeWorker({ outboxDir: join(dir, "outbox"), ...options })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    worker: createHttpWorkerClient(fake.baseUrl),
    workerRoute: "/fix#agent",
    outboxDir: join(dir, "outbox"),
    approvalTtlMs: 60_000,
    receiptWaitMs: 2_000,
    now: () => nowMs,
  })
}
afterEach(async () => {
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Dispatch a work order and wait for the gate, with the observed digest narrowed to a string. */
async function awaiting(): Promise<WorkOrderRow & { candidateDigest: string }> {
  const { id } = await factory.create({ taskId: "cli-flags" })
  await factory.dispatch(id)
  const row = await factory.waitFor(id, (r) => r.state === "awaiting_approval")
  if (row.candidateDigest === null) throw new Error(`${id} reached the gate with no candidate`)
  return row as WorkOrderRow & { candidateDigest: string }
}

const resumes = () => fake.requests.filter((r) => r.path.endsWith("/resume"))

describe("approve", () => {
  it("resolves the recorded gate with once and confirms the receipt", async () => {
    await boot()
    const row = await awaiting()
    const outcome = await factory.approve(row.id, {
      revision: row.revision,
      candidateDigest: row.candidateDigest,
    })
    expect(outcome).toEqual({ ok: true, state: "exported", message: "Exported" })
    expect(resumes()).toHaveLength(1)
    expect(resumes()[0]?.body).toEqual({
      resume: [{ interruptId: row.interruptId, status: "resolved", payload: "once" }],
      route: "/fix#agent",
    })
    expect(readdirSync(join(dir, "outbox"))).toEqual([`${fake.digest}.json`])
    expect(factory.show(row.id)).toMatchObject({ state: "exported", activeStartedAt: null })
    expect(factory.events(row.id).map((e) => e.type)).toContain("delivery_observed")
  })

  it("refuses a stale revision, a wrong digest, and an expired candidate without touching the worker", async () => {
    await boot()
    const row = await awaiting()
    const before = fake.requests.length
    expect(
      await factory.approve(row.id, {
        revision: row.revision - 1,
        candidateDigest: row.candidateDigest,
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/revision/),
    })
    expect(
      await factory.approve(row.id, { revision: row.revision, candidateDigest: "f".repeat(64) }),
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/digest/),
    })
    nowMs += 61_000
    expect(
      await factory.approve(row.id, {
        revision: row.revision,
        candidateDigest: row.candidateDigest,
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/expired/),
    })
    expect(fake.requests.length).toBe(before)
    expect(factory.show(row.id)).toMatchObject({
      state: "awaiting_approval",
      revision: row.revision,
    })
  })

  it("is idempotent per operation key", async () => {
    await boot()
    const row = await awaiting()
    const input = {
      revision: row.revision,
      candidateDigest: row.candidateDigest,
      operationKey: "approve-1",
    }
    const first = await factory.approve(row.id, input)
    const second = await factory.approve(row.id, input)
    expect(second).toEqual(first)
    expect(resumes()).toHaveLength(1)
  })

  it("refuses when the gate is no longer pending on the worker", async () => {
    await boot()
    const row = await awaiting()
    // Something else resolved the worker's prompt behind the factory's back.
    await fetch(`${fake.baseUrl}/threads/${row.workerThreadId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: [{ interruptId: row.interruptId, status: "resolved", payload: "deny" }],
        route: "/fix#agent",
      }),
    }).then((r) => r.text())
    const outcome = await factory.approve(row.id, {
      revision: row.revision,
      candidateDigest: row.candidateDigest,
    })
    expect(outcome).toMatchObject({ ok: false, state: "blocked" })
    expect(factory.show(row.id)?.blockedReason).toBe("interrupt_vanished")
  })

  it("blocks with export_unconfirmed when the resume fails or no receipt appears", async () => {
    await boot({ resume: "route_error" })
    const a = await awaiting()
    expect(
      await factory.approve(a.id, { revision: a.revision, candidateDigest: a.candidateDigest }),
    ).toMatchObject({ ok: false, state: "blocked" })
    expect(factory.show(a.id)?.blockedReason).toBe("export_unconfirmed")

    fake.behaviour.resume = "no_receipt"
    const b = await awaiting()
    expect(
      await factory.approve(b.id, { revision: b.revision, candidateDigest: b.candidateDigest }),
    ).toMatchObject({ ok: false, state: "blocked" })
    expect(factory.show(b.id)?.blockedReason).toBe("export_unconfirmed")
  })
})

describe("deny", () => {
  it("denies from awaiting_approval by resolving the gate with deny", async () => {
    await boot()
    const row = await awaiting()
    const outcome = await factory.deny(row.id)
    expect(outcome).toEqual({ ok: true, state: "denied", message: "Denied" })
    expect(resumes()).toHaveLength(1)
    expect(resumes()[0]?.body).toMatchObject({
      resume: [{ interruptId: row.interruptId, payload: "deny" }],
    })
    expect(readdirSync(join(dir, "outbox"))).toEqual([])
  })

  it("denies from blocked, resolving whatever is pending", async () => {
    await boot({ run: "unexpected_interrupt" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "blocked")
    expect((await factory.deny(id)).state).toBe("denied")
    expect(resumes()).toHaveLength(1)
    expect(resumes()[0]?.body).toMatchObject({ resume: [{ payload: "deny" }] })
  })

  it("blocks rather than denies when the gate was resolved behind the factory's back", async () => {
    await boot()
    const row = await awaiting()
    await fetch(`${fake.baseUrl}/threads/${row.workerThreadId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: [{ interruptId: row.interruptId, status: "resolved", payload: "deny" }],
        route: "/fix#agent",
      }),
    }).then((r) => r.text())
    const before = resumes().length
    expect(await factory.deny(row.id)).toMatchObject({
      ok: false,
      state: "blocked",
      message: "The worker's approval prompt is no longer pending",
    })
    expect(factory.show(row.id)?.blockedReason).toBe("interrupt_vanished")
    expect(resumes()).toHaveLength(before)
  })

  it("refuses deny on a blocked work order with nothing pending", async () => {
    await boot({ resume: "route_error" })
    const row = await awaiting()
    await factory.approve(row.id, { revision: row.revision, candidateDigest: row.candidateDigest })
    const blocked = await factory.waitFor(row.id, (r) => r.state === "blocked")
    expect(blocked.blockedReason).toBe("export_unconfirmed")
    const before = resumes().length
    expect(await factory.deny(row.id)).toMatchObject({
      ok: false,
      state: "blocked",
      message: "Nothing is pending to deny; cancel the work order instead",
    })
    expect(factory.show(row.id)).toMatchObject({
      state: "blocked",
      blockedReason: "export_unconfirmed",
      revision: blocked.revision,
    })
    expect(resumes()).toHaveLength(before)
  })

  it("refuses deny from running", async () => {
    await boot({ run: "hang" })
    const { id } = await factory.create({ taskId: "cli-flags" })
    await factory.dispatch(id)
    await factory.waitFor(id, (r) => r.state === "running")
    expect(await factory.deny(id)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Cannot deny from running/),
    })
    expect(resumes()).toHaveLength(0)
  })
})
