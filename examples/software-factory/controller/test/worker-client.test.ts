import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createHttpWorkerClient,
  type WorkerClient,
  type WorkerHttpError,
} from "../src/lib/worker/client.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

let dir: string
let fake: FakeWorker
let client: WorkerClient
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-client-"))
  fake = await createFakeWorker({ outboxDir: dir })
  client = createHttpWorkerClient(fake.baseUrl, { token: TEST_WORKER_TOKEN })
})
afterEach(async () => {
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
})

async function drain<T>(frames: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const frame of frames) out.push(frame)
  return out
}

describe("http worker client", () => {
  it("never follows a redirect, which would carry the token elsewhere", async () => {
    const seen: Request[] = []
    const capturing = createHttpWorkerClient("http://worker", {
      token: TEST_WORKER_TOKEN,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(input, init))
        return Response.json({
          thread_id: "t",
          created_at: "",
          updated_at: "",
          metadata: {},
          status: "idle",
        })
      }) as typeof fetch,
    })
    await capturing.createThread({})
    await capturing.getThread("t")
    await capturing.cancel("t").catch(() => undefined)
    expect(seen.map((request) => request.redirect)).toEqual(["error", "error", "error"])
  })

  it("sends the worker token on every call, cancel and getThread included", async () => {
    const threadId = await client.createThread({})
    await client.getThread(threadId)
    await client.cancel(threadId)
    await drain(await client.startRun(threadId, "/fix#agent", "go"))
    await client.pendingInterrupts(threadId)
    const gate = (await client.pendingInterrupts(threadId))[0]
    if (gate)
      await drain(
        await client.resume(threadId, "/fix#agent", [
          { interruptId: gate.interruptId, payload: "once" },
        ]),
      )
    expect(fake.requests.map((logged) => logged.path)).toEqual(
      expect.arrayContaining([
        "/threads",
        `/threads/${threadId}`,
        `/threads/${threadId}/cancel`,
        `/threads/${threadId}/runs/stream`,
        `/threads/${threadId}/pending_interrupts`,
        `/threads/${threadId}/resume`,
      ]),
    )
    for (const logged of fake.requests)
      expect(logged.authorization).toBe(`Bearer ${TEST_WORKER_TOKEN}`)
  })

  it("never puts the token in an error it raises", async () => {
    const failing = createHttpWorkerClient("http://worker", {
      token: TEST_WORKER_TOKEN,
      fetch: (async () =>
        Response.json({ error: { message: "denied" } }, { status: 403 })) as typeof fetch,
    })
    const error = await failing.createThread({}).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: "WorkerHttpError", status: 403 })
    expect(String(error)).not.toContain(TEST_WORKER_TOKEN)
    expect(JSON.stringify(error)).not.toContain(TEST_WORKER_TOKEN)
  })

  it("uploads a source, then creates a thread naming it", async () => {
    const bundle = createSourceBundle([
      { path: "a.txt", bytes: new TextEncoder().encode("a"), executable: false },
    ])
    expect(await client.uploadSource(bundle)).toBe("created")
    expect(await client.uploadSource(bundle)).toBe("held")
    const threadId = await client.createThread(
      { factoryWorkOrderId: "wo-1" },
      { sourceDigest: bundle.digest, environmentLinks: [], baseline: "git" },
    )
    expect(threadId).toMatch(/^fake-thread-/)
    const upload = fake.requests.find((r) => r.method === "PUT")
    expect(upload?.path).toBe(`/workspace/sources/${bundle.digest}`)
    expect(upload?.authorization).toBe(`Bearer ${TEST_WORKER_TOKEN}`)
    expect(upload?.body).toEqual(JSON.parse(JSON.stringify(bundle)))
    expect(fake.requests.at(-1)?.body).toEqual({
      metadata: { factoryWorkOrderId: "wo-1" },
      workspace: { sourceDigest: bundle.digest, environmentLinks: [], baseline: "git" },
    })
  })

  it("creates a thread with no workspace key when none is given", async () => {
    await client.createThread({ a: 1 })
    expect(fake.requests.at(-1)?.body).toEqual({ metadata: { a: 1 } })
  })

  it("refuses an upload the worker says it staged under another digest", async () => {
    const bundle = createSourceBundle([
      { path: "a.txt", bytes: new TextEncoder().encode("a"), executable: false },
    ])
    const lying = createHttpWorkerClient("http://worker", {
      token: TEST_WORKER_TOKEN,
      fetch: (async () =>
        Response.json(
          { digest: "f".repeat(64), status: "created" },
          { status: 201 },
        )) as typeof fetch,
    })
    await expect(lying.uploadSource(bundle)).rejects.toMatchObject({
      name: "WorkerHttpError",
      code: "digest_mismatch",
    })
  })

  it("retries a busy worker's 429 a bounded number of times, upload and create alike", async () => {
    const bundle = createSourceBundle([
      { path: "b.txt", bytes: new TextEncoder().encode("b"), executable: false },
    ])
    const patient = createHttpWorkerClient(fake.baseUrl, {
      token: TEST_WORKER_TOKEN,
      busyRetry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    })
    fake.failNext("PUT", 429, "upload_in_flight")
    fake.failNext("PUT", 429, "upload_in_flight")
    expect(await patient.uploadSource(bundle)).toBe("created")
    fake.failNext("POST", 429, "workspace_create_in_flight")
    const threadId = await patient.createThread(
      { factoryWorkOrderId: "wo-1" },
      { sourceDigest: bundle.digest, environmentLinks: [] },
    )
    expect(threadId).toMatch(/^fake-thread-/)
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(3)
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(2)

    // Past the bound, the last answer is the error, and nothing more is sent.
    for (let i = 0; i < 4; i++) fake.failNext("PUT", 429, "upload_in_flight")
    const before = fake.requests.length
    await expect(patient.uploadSource(bundle)).rejects.toMatchObject({
      name: "WorkerHttpError",
      status: 429,
      code: "upload_in_flight",
    })
    expect(fake.requests.length - before).toBe(4)
  })

  it("stops waiting out a busy worker the moment the request's signal aborts", async () => {
    const bundle = createSourceBundle([
      { path: "d.txt", bytes: new TextEncoder().encode("d"), executable: false },
    ])
    const patient = createHttpWorkerClient(fake.baseUrl, {
      token: TEST_WORKER_TOKEN,
      busyRetry: { attempts: 5, baseDelayMs: 60_000, maxDelayMs: 60_000 },
    })
    for (const method of ["PUT", "POST"]) {
      fake.failNext(
        method,
        429,
        method === "PUT" ? "upload_in_flight" : "workspace_create_in_flight",
      )
      const controller = new AbortController()
      const started = Date.now()
      const pending =
        method === "PUT"
          ? patient.uploadSource(bundle, controller.signal)
          : patient.createThread({}, { sourceDigest: bundle.digest }, controller.signal)
      setTimeout(() => controller.abort(new Error("dispatch cancelled")), 50)
      await expect(pending).rejects.toThrow("dispatch cancelled")
      // Well inside the minute-long backoff, and nothing was sent after the abort.
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(fake.requests.filter((r) => r.method === method)).toHaveLength(1)
    }
  })

  it("deletes a thread idempotently, and throws on a thread with a turn in flight", async () => {
    const threadId = await client.createThread({})
    expect(await client.deleteThread(threadId)).toBe("deleted")
    expect(await client.getThread(threadId)).toBeNull()
    // The runtime answers 204 again for a thread it no longer has.
    expect(await client.deleteThread(threadId)).toBe("deleted")
    const answering = (status: number) =>
      createHttpWorkerClient("http://worker", {
        token: TEST_WORKER_TOKEN,
        fetch: (async () =>
          status === 409
            ? Response.json(
                { error: { message: "busy", details: { code: "run_in_flight" } } },
                { status },
              )
            : new Response(null, { status })) as typeof fetch,
      })
    expect(await answering(404).deleteThread("t")).toBe("not_found")
    await expect(answering(409).deleteThread("t")).rejects.toMatchObject({
      status: 409,
      code: "run_in_flight",
    })
    const deletes = fake.requests.filter((r) => r.method === "DELETE")
    expect(deletes.map((r) => r.authorization)).toEqual([
      `Bearer ${TEST_WORKER_TOKEN}`,
      `Bearer ${TEST_WORKER_TOKEN}`,
    ])
  })

  it("never retries a refusal that is not the worker being busy", async () => {
    const bundle = createSourceBundle([
      { path: "c.txt", bytes: new TextEncoder().encode("c"), executable: false },
    ])
    const patient = createHttpWorkerClient(fake.baseUrl, {
      token: TEST_WORKER_TOKEN,
      busyRetry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    })
    fake.failNext("PUT", 507, "staged_quota_exceeded")
    await expect(patient.uploadSource(bundle)).rejects.toMatchObject({ status: 507 })
    fake.failNext("PUT", 429, "rate_limited")
    await expect(patient.uploadSource(bundle)).rejects.toMatchObject({ status: 429 })
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(2)
  })

  it("creates a thread with metadata and reads it back", async () => {
    const threadId = await client.createThread({ factoryWorkOrderId: "wo-1" })
    expect(threadId).toMatch(/^fake-thread-/)
    expect(await client.getThread(threadId)).toEqual({ threadId, status: "idle" })
    expect(await client.getThread("nope")).toBeNull()
    expect(fake.requests[0]?.body).toEqual({ metadata: { factoryWorkOrderId: "wo-1" } })
  })

  it("streams the turn, reads the parked gate, resumes, and cancels with the documented codes", async () => {
    const threadId = await client.createThread({})
    expect(await client.cancel(threadId)).toBe("no_run_in_flight")
    const turn = await drain(await client.startRun(threadId, "/fix#agent", "go"))
    expect(turn.map((f) => f.event)).toEqual(["tool_result", "tool_result", "interrupt", "done"])
    expect(fake.requests.at(-1)?.body).toEqual({
      route: "/fix#agent",
      input: { messages: [{ role: "user", content: "go" }] },
    })
    const pending = await client.pendingInterrupts(threadId)
    expect(pending).toHaveLength(1)
    const gate = pending[0]
    if (!gate) throw new Error("expected a pending interrupt")
    expect(gate.detail.toolName).toBe("exportForReview")
    const resumed = await drain(
      await client.resume(threadId, "/fix#agent", [
        { interruptId: gate.interruptId, payload: "once" },
      ]),
    )
    expect(resumed.at(-1)?.event).toBe("done")
    expect(fake.requests.at(-1)?.body).toEqual({
      resume: [{ interruptId: gate.interruptId, status: "resolved", payload: "once" }],
      route: "/fix#agent",
    })
    expect(await client.pendingInterrupts(threadId)).toEqual([])
    expect(await client.cancel("nope")).toBe("thread_not_found")
  })

  it("surfaces other errors with status and code", async () => {
    const threadId = await client.createThread({})
    await drain(await client.startRun(threadId, "/fix#agent", "go"))
    await expect(client.resume(threadId, "/fix#agent", [])).rejects.toMatchObject({
      name: "WorkerHttpError",
      status: 409,
      code: "interrupt_mismatch",
    } satisfies Partial<WorkerHttpError>)
  })

  it("cancels a live run", async () => {
    const hangDir = mkdtempSync(join(tmpdir(), "worker-client-hang-"))
    const hangFake = await createFakeWorker({ outboxDir: hangDir, run: "hang" })
    const hangClient = createHttpWorkerClient(hangFake.baseUrl, { token: TEST_WORKER_TOKEN })
    try {
      const threadId = await hangClient.createThread({})
      const framesPromise = drain(await hangClient.startRun(threadId, "/fix#agent", "go"))
      await hangFake.waitForRunStart(threadId)
      expect(await hangClient.cancel(threadId)).toBe("interrupted")
      await framesPromise
    } finally {
      await hangFake.close()
      rmSync(hangDir, { recursive: true, force: true })
    }
  })

  it("reattaches to a live run and observes its terminal frame", async () => {
    const hangDir = mkdtempSync(join(tmpdir(), "worker-client-reattach-"))
    const hangFake = await createFakeWorker({ outboxDir: hangDir, run: "hang" })
    const hangClient = createHttpWorkerClient(hangFake.baseUrl, { token: TEST_WORKER_TOKEN })
    try {
      const threadId = await hangClient.createThread({})
      const framesPromise = drain(await hangClient.startRun(threadId, "/fix#agent", "go"))
      await hangFake.waitForRunStart(threadId)
      const reattached = await hangClient.reattach(threadId)
      const iterator = reattached[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.done).toBe(false)
      expect(first.value?.event).toBe("state")
      expect(await hangClient.cancel(threadId)).toBe("interrupted")
      const rest: unknown[] = []
      for (let next = await iterator.next(); !next.done; next = await iterator.next())
        rest.push(next.value)
      expect(rest.at(-1)).toMatchObject({ event: "done" })
      await framesPromise
    } finally {
      await hangFake.close()
      rmSync(hangDir, { recursive: true, force: true })
    }
  })
})
