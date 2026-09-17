import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/controller/factory.ts"
import { createHttpApi, type HttpApi } from "../src/http.ts"
import { createHttpWorkerClient } from "../src/worker/client.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
let factory: Factory
let api: HttpApi
afterEach(async () => {
  await api?.close()
  await factory?.close()
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("http api", () => {
  it("drives a work order end to end over JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-http-"))
    mkdirSync(join(dir, "outbox"), { recursive: true })
    fake = await createFakeWorker({ outboxDir: join(dir, "outbox") })
    factory = await createFactory({
      registryPath: join(dir, "registry.sqlite"),
      worker: createHttpWorkerClient(fake.baseUrl),
      workerRoute: "/fix#agent",
      outboxDir: join(dir, "outbox"),
      receiptWaitMs: 2_000,
    })
    api = await createHttpApi(factory).listen(0)
    const post = (path: string, body: unknown = {}) =>
      fetch(`${api.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })

    const created = await post("/work-orders", { taskId: "cli-flags" })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    expect((await post(`/work-orders/${id}/dispatch`)).status).toBe(200)
    const ready = await factory.waitFor(id, (r) => r.state === "awaiting_approval")

    const list = (await (await fetch(`${api.baseUrl}/work-orders`)).json()) as { id: string }[]
    expect(list.map((w) => w.id)).toEqual([id])

    const refused = await post(`/work-orders/${id}/approve`, {
      revision: 0,
      candidateDigest: ready.candidateDigest,
    })
    expect(refused.status).toBe(409)

    const approved = await post(`/work-orders/${id}/approve`, {
      revision: ready.revision,
      candidateDigest: ready.candidateDigest,
    })
    expect(approved.status).toBe(200)
    expect(((await approved.json()) as { state: string }).state).toBe("exported")

    const events = (await (await fetch(`${api.baseUrl}/work-orders/${id}/events`)).json()) as {
      type: string
    }[]
    expect(events.some((e) => e.type === "delivery_observed")).toBe(true)
    expect((await fetch(`${api.baseUrl}/work-orders/nope`)).status).toBe(404)
    expect((await post("/work-orders", { taskId: 42 })).status).toBe(400)

    expect((await fetch(`${api.baseUrl}/work-orders/${id}/dispatch`)).status).toBe(405)
    expect((await post(`/work-orders/${id}/bogus`)).status).toBe(404)
    expect((await fetch(`${api.baseUrl}/work-orders/`)).status).toBe(200)
  })
})
