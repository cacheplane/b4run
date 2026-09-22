import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createHttpApi, type HttpApi } from "../src/http.ts"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

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

describe("http api", () => {
  it("drives a work order end to end over JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-http-"))
    mkdirSync(join(dir, "out"), { recursive: true })
    fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
    const reader = createFakeWorkspaceReader({})
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
    const dispatched = await factory.waitFor(id, (r) => r.workerThreadId !== null)
    reader.set(dispatched.workerThreadId as string, repaired())
    const ready = await factory.waitFor(id, (r) => r.state === "awaiting_approval", 20_000)
    if (ready.bundleDigest === null) throw new Error("reached the gate with no frozen bundle")

    const list = (await (await fetch(`${api.baseUrl}/work-orders`)).json()) as { id: string }[]
    expect(list.map((w) => w.id)).toEqual([id])

    // The evidence behind the gate is readable before anyone consents to it.
    const evidence = (await (await fetch(`${api.baseUrl}/work-orders/${id}/evidence`)).json()) as {
      candidate: { digest: string } | null
      receipt: { verdict: string } | null
      bundle: { digest: string } | null
    }
    expect(evidence.candidate?.digest).toBe(ready.candidateDigest)
    expect(evidence.receipt?.verdict).toBe("pass")
    expect(evidence.bundle?.digest).toBe(ready.bundleDigest)

    const refused = await post(`/work-orders/${id}/approve`, {
      revision: 0,
      bundleDigest: ready.bundleDigest,
    })
    expect(refused.status).toBe(409)

    // A well-formed digest that names no frozen bundle is refused, not exported.
    const wrongBundle = await post(`/work-orders/${id}/approve`, {
      revision: ready.revision,
      bundleDigest: "0".repeat(64),
    })
    expect(wrongBundle.status).toBe(409)

    // The rung 0 field name no longer satisfies the body.
    const rungZero = await post(`/work-orders/${id}/approve`, {
      revision: ready.revision,
      candidateDigest: ready.candidateDigest,
    })
    expect(rungZero.status).toBe(400)

    const approved = await post(`/work-orders/${id}/approve`, {
      revision: ready.revision,
      bundleDigest: ready.bundleDigest,
    })
    expect(approved.status).toBe(200)
    expect(((await approved.json()) as { state: string }).state).toBe("exported")

    const events = (await (await fetch(`${api.baseUrl}/work-orders/${id}/events`)).json()) as {
      type: string
    }[]
    expect(events.some((e) => e.type === "delivery_written")).toBe(true)
    expect((await fetch(`${api.baseUrl}/work-orders/nope`)).status).toBe(404)
    expect((await fetch(`${api.baseUrl}/work-orders/nope/evidence`)).status).toBe(404)
    expect((await post("/work-orders", { taskId: 42 })).status).toBe(400)

    expect((await fetch(`${api.baseUrl}/work-orders/${id}/dispatch`)).status).toBe(405)
    // Evidence is read-only: a POST to it is a method error, not a silent 404.
    expect((await post(`/work-orders/${id}/evidence`)).status).toBe(405)
    expect((await post(`/work-orders/${id}/bogus`)).status).toBe(404)
    expect((await fetch(`${api.baseUrl}/work-orders/`)).status).toBe(200)
  }, 40_000)
})
