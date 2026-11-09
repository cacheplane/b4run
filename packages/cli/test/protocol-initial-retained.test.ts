import { afterEach, expect, it } from "vitest"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

// New integration cases use30s, selected before their first run.
const budget = 30_000
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
it(
  "replays the original creation when actual cleanup wins between live discovery and exact bind",
  async () => {
    const s = await initialTransition()
    const result = await s.f.admit(s.input)
    expect(result).toMatchObject({
      runId: s.initial.runId,
      responseMeta: { b4: { receipt: { replayed: true } } },
    })
    expect(s.binds()).toEqual([[s.initial.threadId, false, s.generation]])
    expect(s.reads()).toBe(1)
    expect(s.invocations()).toBe(1)
    expect(await s.backend.readThread(s.initial.threadId)).toBeUndefined()
    expect((await s.backend.temporary?.readRun(s.initial.runId))?.record.result).toMatchObject({
      values: { answer: 42 },
    })
    expect(await s.f.admit(s.input)).toMatchObject({ runId: s.initial.runId })
    expect(s.invocations()).toBe(1)
  },
  budget,
)
it.each(["root", "thread"] as const)(
  "reauthorizes refreshed initial %s before the full retained operation read",
  async (authority) => {
    const s = await initialTransition({
      afterCleanup: async ({ f }) => {
        if (authority === "root") f.removeAgent("/chat#agent")
        else f.deny()
      },
    })
    await expect(s.f.admit(s.input)).rejects.toMatchObject({ code: "not_found" })
    expect(s.reads()).toBe(0)
    expect(s.invocations()).toBe(1)
    expect(s.binds()).toEqual([[s.initial.threadId, false, s.generation]])
  },
  budget,
)
it.each(["root", "thread"] as const)(
  "reauthorizes actual initial %s after the full retained cut",
  async (authority) => {
    const s = await initialTransition({
      afterRead: async (f) => {
        if (authority === "root") f.removeAgent("/chat#agent")
        else f.deny()
      },
    })
    await expect(s.f.admit(s.input)).rejects.toMatchObject({ code: "not_found" })
    expect(s.reads()).toBe(1)
    expect(s.invocations()).toBe(1)
  },
  budget,
)
it.each(["missing-authority", "cross-run"] as const)(
  "fails closed on %s exact refreshed operation facts without a full read",
  async (fault) => {
    const s = await initialTransition(),
      search = s.backend.searchOperations
    let searches = 0
    Object.assign(s.backend, {
      async searchOperations(...args: Parameters<typeof search>) {
        searches++
        return (await search(...args)).map((row) => {
          if (searches !== 2) return row
          const changed = { ...row, operationAuthority: { ...row.operationAuthority } }
          if (fault === "missing-authority") Reflect.deleteProperty(changed, "operationAuthority")
          else changed.operationAuthority.runId = crypto.randomUUID()
          return changed
        })
      },
    })
    cleanups.push(async () => {
      Object.assign(s.backend, { searchOperations: search })
    })
    await expect(s.f.admit(s.input)).rejects.toMatchObject({ code: "storage_unavailable" })
    expect(searches).toBe(2)
    expect(s.reads()).toBe(0)
    expect(s.invocations()).toBe(1)
  },
  budget,
)
it.each(["absent", "other-generation", "other-receipt"] as const)(
  "refuses %s refresh instead of selecting another initial target",
  async (fault) => {
    const s = await initialTransition(),
      search = s.backend.searchOperations
    let searches = 0
    Object.assign(s.backend, {
      async searchOperations(...args: Parameters<typeof search>) {
        searches++
        const rows = await search(...args)
        if (searches !== 2) return rows
        if (fault === "absent") return []
        return rows.map((row) =>
          fault === "other-generation"
            ? { ...row, scope: { ...row.scope, generation: crypto.randomUUID() } }
            : { ...row, receiptId: crypto.randomUUID() },
        )
      },
    })
    cleanups.push(async () => {
      Object.assign(s.backend, { searchOperations: search })
    })
    await expect(s.f.admit(s.input)).rejects.toMatchObject({ code: "submission_target_gone" })
    expect(searches).toBe(2)
    expect(s.reads()).toBe(0)
    expect(s.invocations()).toBe(1)
    expect(await s.backend.temporary?.readRun(s.initial.runId)).toBeDefined()
  },
  budget,
)
it(
  "preserves genuine Run-gone evaluation after authorizing the exact refreshed original operation",
  async () => {
    const s = await initialTransition({
      afterCleanup: async ({ f, initial, generation }) => {
        await f.native.removeRetainedRun(initial.threadId, generation, initial.runId)
      },
    })
    await expect(s.f.admit(s.input)).rejects.toMatchObject({ code: "submission_target_gone" })
    expect(s.reads()).toBe(1)
    expect(s.invocations()).toBe(1)
    expect(await s.backend.temporary?.readRun(s.initial.runId)).toBeUndefined()
  },
  budget,
)
it.each(["subject-id", "lineage"] as const)(
  "rechecks actual initial retained %s after refreshed minimal authorization",
  async (fault) => {
    const s = await initialTransition({
      beforeRead: async ({ f, initial, generation }) => {
        await f.native.corruptRetainedControlFacts(
          initial.threadId,
          generation,
          initial.runId,
          fault,
          crypto.randomUUID(),
        )
      },
    })
    await expect(s.f.admit(s.input)).rejects.toMatchObject({
      code: fault === "subject-id" ? "not_found" : "storage_unavailable",
    })
    expect(s.reads()).toBe(1)
    expect(s.invocations()).toBe(1)
  },
  budget,
)
it(
  "replays the old receipt without renewing a real replacement generation",
  async () => {
    let replacementRunId = "",
      before: unknown
    const s = await initialTransition({
      afterCleanup: async ({ f, initial }) => {
        const replacement = await f.admit(
          body({
            thread_id: initial.threadId,
            if_not_exists: "create",
            on_completion: "keep",
            metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
          }),
        )
        replacementRunId = replacement.runId
        before = orderedScopes(await f.native.scopeRecord(initial.threadId))
      },
    })
    expect(await s.f.admit(s.input)).toMatchObject({
      runId: s.initial.runId,
      responseMeta: { b4: { receipt: { replayed: true } } },
    })
    expect(s.binds()).toEqual([[s.initial.threadId, false, s.generation]])
    expect(orderedScopes(await s.f.native.scopeRecord(s.initial.threadId))).toEqual(before)
    expect((await s.backend.readThread(s.initial.threadId))?.currentRunId).toBe(replacementRunId)
    expect(s.reads()).toBe(1)
    expect(s.invocations()).toBe(1)
  },
  budget,
)
function orderedScopes(
  rows: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["native"]["scopeRecord"]>>,
) {
  return rows.sort((a, b) => String(a.generation).localeCompare(String(b.generation)))
}
type TransitionContext = {
  f: Awaited<ReturnType<typeof fixture>>
  initial: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["admit"]>>
  generation: string
}
async function initialTransition(
  options: {
    afterCleanup?: (value: TransitionContext) => Promise<void>
    beforeRead?: (value: TransitionContext) => Promise<void>
    afterRead?: (f: TransitionContext["f"]) => Promise<void>
  } = {},
) {
  const f = await fixture()
  cleanups.push(() => f.close())
  const input = body(),
    initial = await f.admit(input)
  const backend = runtimeStorageRegistration(f.storage),
    open = backend.openThread
  const original = await backend.readThread(initial.threadId)
  if (!original) throw new Error("Missing actual initial scope")
  const temporary = backend.temporary
  if (!temporary) throw new Error("Missing actual native temporary capability")
  const read = temporary.readOperation
  let invocations = 0,
    reads = 0,
    transitioned = false
  const binds: Parameters<typeof open>[] = []
  const host = createExecutionHost({
    ...f.authority,
    async invoke() {
      invocations++
      return { values: { answer: 42 } }
    },
  })
  cleanups.push(() => host.close())
  Object.assign(backend, {
    async openThread(...args: Parameters<typeof open>) {
      if (!transitioned && args[0] === initial.threadId && !args[1]) {
        transitioned = true
        binds.push(args)
        await host.tick()
        await host.idle()
        await options.afterCleanup?.({ f, initial, generation: original.generation })
      }
      return open(...args)
    },
  })
  Object.assign(temporary, {
    async readOperation(...args: Parameters<typeof read>) {
      reads++
      await options.beforeRead?.({ f, initial, generation: original.generation })
      const actual = await read(...args)
      await options.afterRead?.(f)
      return actual
    },
  })
  cleanups.push(async () => {
    Object.assign(backend, { openThread: open })
    Object.assign(temporary, { readOperation: read })
  })
  return {
    f,
    input,
    initial,
    backend,
    generation: original.generation,
    binds: () => binds,
    reads: () => reads,
    invocations: () => invocations,
  }
}
