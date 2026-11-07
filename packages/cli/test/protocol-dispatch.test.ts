import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { fixture } from "./fixtures/protocol-admission.ts"

async function executor() {
  return import("../src/lib/runtime/executor.ts")
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function setup() {
  const f = await fixture()
  const directory = mkdtempSync(join(tmpdir(), "b4-dispatch-counter-"))
  const counter = join(directory, "effects")
  cleanups.push(async () => {
    await f.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { f, counter }
}
it("dispatches an accepted never-started Run after reopening the execution host", async () => {
  const { f, counter } = await setup()
  const accepted = await f.admit()
  const { createExecutionHost } = await executor()
  const host = createExecutionHost({
    storage: f.storage,
    async invoke({ run, store }) {
      const snapshot = await store.snapshot()
      expect(snapshot.runs[0]?.metadata).toMatchObject({
        phase: "running",
        startedAt: expect.any(String),
      })
      expect(snapshot.runs[0]?.execution).toMatchObject({
        ownerId: host.ownerId,
        fence: snapshot.scope.fence,
      })
      expect(run.run.run_id).toBe(accepted.runId)
      appendFileSync(counter, "effect\n")
      return { values: { answer: 42 } }
    },
  })
  cleanups.push(() => host.close())
  await host.tick()
  await host.idle()
  await host.tick()
  await host.idle()
  const snapshot = await f.snapshot(accepted.threadId)
  expect(readFileSync(counter, "utf8")).toBe("effect\n")
  expect(snapshot.runs[0]).toMatchObject({
    run: { status: "success" },
    metadata: { phase: "settled", reason: "completed", effectsUncertain: false },
    result: { values: { answer: 42 } },
  })
  expect(snapshot.inbox[0]?.status).toBe("applied")
  expect(snapshot.thread?.thread.status).toBe("idle")
})
it("uses durable polling after a missed wakeup with unchanged product intervals", async () => {
  const { f, counter } = await setup()
  const { createExecutionHost } = await executor()
  const scheduled = new Map<unknown, { delay: number; callback: () => void }>()
  const host = createExecutionHost({
    storage: f.storage,
    clock: {
      now: () => new Date().toISOString(),
      setInterval(callback, delay) {
        const handle = {}
        scheduled.set(handle, { callback, delay })
        return handle
      },
      clearInterval: (handle) => {
        scheduled.delete(handle)
      },
    },
    async invoke() {
      appendFileSync(counter, "effect\n")
      return {}
    },
  })
  cleanups.push(() => host.close())
  await host.start()
  const accepted = await f.admit()
  expect(existsSync(counter)).toBe(false)
  expect([...scheduled.values()].map((timer) => timer.delay)).toContain(1_000)
  for (const timer of scheduled.values()) if (timer.delay === 1_000) timer.callback()
  await host.idle()
  expect(readFileSync(counter, "utf8")).toBe("effect\n")
  expect((await f.snapshot(accepted.threadId)).runs[0]?.metadata.phase).toBe("settled")
})
it("preserves the committed terminal winner when an invocation reports a late error", async () => {
  const { f } = await setup()
  const accepted = await f.admit()
  const { createExecutionHost, settleExecution } = await executor()
  const host = createExecutionHost({
    storage: f.storage,
    async invoke({ run, store }) {
      await store.transaction(async (tx) => {
        const row = await tx.runs.get(run.run.run_id)
        if (!row) throw new Error("Missing executing Run")
        await tx.runs.put({ ...row, result: { values: { partial: true } } })
        await settleExecution(tx, run.run.run_id, {
          status: "success",
          reason: "completed",
          result: { values: { winner: true } },
        })
      })
      throw new Error("late observer failure")
    },
  })
  cleanups.push(() => host.close())
  await host.tick()
  await host.idle()
  expect((await f.snapshot(accepted.threadId)).runs[0]).toMatchObject({
    run: { status: "success" },
    metadata: { reason: "completed", effectsUncertain: false },
    result: { values: { winner: true } },
  })
  expect((await f.snapshot(accepted.threadId)).runs[0]?.result?.values).toEqual({ winner: true })
})
