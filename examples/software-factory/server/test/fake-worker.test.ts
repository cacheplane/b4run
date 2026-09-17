import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"

let dir: string
let fake: FakeWorker
afterEach(async () => {
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

async function sseEvents(response: Response): Promise<string[]> {
  const text = await response.text()
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event:"))
    .map((block) => block.split("\n")[0]?.slice("event: ".length) ?? "")
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("fake worker", () => {
  it("parks on the export gate and writes the receipt on resume once", async () => {
    dir = mkdtempSync(join(tmpdir(), "fake-worker-"))
    fake = await createFakeWorker({ outboxDir: dir })
    const created = await post(`${fake.baseUrl}/threads`, {})
    const { thread_id } = (await created.json()) as { thread_id: string }

    const run = await post(`${fake.baseUrl}/threads/${thread_id}/runs/stream`, {
      route: "/fix#agent",
      input: { messages: [{ role: "user", content: "go" }] },
    })
    expect(await sseEvents(run)).toEqual(["tool_result", "tool_result", "interrupt", "done"])

    const thread = (await (await fetch(`${fake.baseUrl}/threads/${thread_id}`)).json()) as {
      status: string
    }
    expect(thread.status).toBe("interrupted")
    const pending = (await (
      await fetch(`${fake.baseUrl}/threads/${thread_id}/pending_interrupts`)
    ).json()) as {
      interrupts: { interruptId: string; kind: string; detail: { toolName: string } }[]
    }
    expect(pending.interrupts).toHaveLength(1)
    expect(pending.interrupts[0]?.detail.toolName).toBe("exportForReview")

    const resumed = await post(`${fake.baseUrl}/threads/${thread_id}/resume`, {
      resume: [
        { interruptId: pending.interrupts[0]?.interruptId, status: "resolved", payload: "once" },
      ],
      route: "/fix#agent",
    })
    expect(resumed.status).toBe(200)
    await resumed.text()
    expect(readdirSync(dir)).toEqual([`${fake.digest}.json`])
    expect(fake.requests.filter((r) => r.path.endsWith("/resume"))).toHaveLength(1)
  })

  it("returns the documented errors", async () => {
    dir = mkdtempSync(join(tmpdir(), "fake-worker-"))
    fake = await createFakeWorker({ outboxDir: dir })
    expect((await fetch(`${fake.baseUrl}/threads/nope`)).status).toBe(404)
    expect((await fetch(`${fake.baseUrl}/threads/nope/cancel`, { method: "POST" })).status).toBe(
      404,
    )
    const created = await post(`${fake.baseUrl}/threads`, {})
    const { thread_id } = (await created.json()) as { thread_id: string }
    const idleCancel = await fetch(`${fake.baseUrl}/threads/${thread_id}/cancel`, {
      method: "POST",
    })
    expect(idleCancel.status).toBe(409)
    expect(
      ((await idleCancel.json()) as { error: { details: { code: string } } }).error.details.code,
    ).toBe("no_run_in_flight")
    const badResume = await post(`${fake.baseUrl}/threads/${thread_id}/resume`, {
      resume: [],
      route: "/fix#agent",
    })
    expect(badResume.status).toBe(409)
    expect(
      ((await badResume.json()) as { error: { details: { code: string } } }).error.details.code,
    ).toBe("interrupt_mismatch")
  })

  it("cancels a hanging run in band", async () => {
    dir = mkdtempSync(join(tmpdir(), "fake-worker-"))
    fake = await createFakeWorker({ outboxDir: dir, run: "hang" })
    const created = await post(`${fake.baseUrl}/threads`, {})
    const { thread_id } = (await created.json()) as { thread_id: string }
    const streamPromise = post(`${fake.baseUrl}/threads/${thread_id}/runs/stream`, {
      route: "/fix#agent",
      input: {},
    }).then((r) => r.text())
    await fake.waitForRunStart(thread_id)
    const cancel = await fetch(`${fake.baseUrl}/threads/${thread_id}/cancel`, { method: "POST" })
    expect(cancel.status).toBe(200)
    expect(await streamPromise).toContain('"cancelled":true')
  })
})
