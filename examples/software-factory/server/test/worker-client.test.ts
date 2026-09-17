import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createHttpWorkerClient,
  type WorkerClient,
  type WorkerHttpError,
} from "../src/worker/client.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let client: WorkerClient
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "worker-client-"))
  fake = await createFakeWorker({ outboxDir: dir })
  client = createHttpWorkerClient(fake.baseUrl)
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
    const hangClient = createHttpWorkerClient(hangFake.baseUrl)
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
    const hangClient = createHttpWorkerClient(hangFake.baseUrl)
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
