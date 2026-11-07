import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@b4run/permissions/node"
import { sqliteRuntimeStorage } from "@b4run/sqlite-storage"
import { afterEach, expect, it } from "vitest"
import {
  protocolAspError,
  protocolErrorResponse,
  protocolRestError,
} from "../src/lib/dev/protocol/errors.ts"
import { createExecutionHost, settleExecution } from "../src/lib/runtime/executor.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"
import { runtimeWorker } from "./fixtures/protocol-owned-worker.ts"

const budget = 30_000
const cleanups: (() => Promise<void>)[] = []
it(
  "aborts and awaits owned providers before rethrowing another candidate's actual preparation failure",
  async () => {
    const f = await fixture(),
      entered = barrier(),
      release = barrier(),
      unwind = barrier()
    let aborted = false,
      finished = false,
      invocations = 0
    const second = await f.admit(
      body({
        thread_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        if_not_exists: "create",
        on_completion: "keep",
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
      }),
    )
    const parker = createExecutionHost({
      ...f.authority,
      async invoke({ run, store }) {
        await store.transaction((tx) =>
          parkPermissions(tx, run.run.run_id, [
            {
              interruptId: "effect",
              namespace: [],
              request: { kind: "tool", detail: { toolName: "effect", suggestedPattern: "effect" } },
              protectedProposal: {},
            },
          ]),
        )
        return {}
      },
    })
    let owner: ReturnType<typeof createExecutionHost> | undefined
    try {
      await parker.tick()
      await parker.idle()
      const permissions = createPermissionService({ ...f.authority })
      const resumed = await permissions.respond(f.request(), second.threadId, second.runId, {
        type: "command",
        id: 1,
        method: "input.respond",
        params: {
          responses: [{ namespace: [], interruptId: "effect", response: { decision: "once" } }],
        },
      })
      const first = await f.admit(
        body({
          thread_id: "00000000-0000-4000-8000-000000000001",
          if_not_exists: "create",
          on_completion: "keep",
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        }),
      )
      mkdirSync(join(f.directory, ".b4", "permissions.json"), { recursive: true })
      const rules = createPermissionsStore({
        appRoot: f.directory,
        config: undefined,
        mode: "interactive",
      })
      owner = createExecutionHost({
        ...f.authority,
        permissions: createPermissionService({
          ...f.authority,
          async resolvePermissions() {
            entered.release()
            await release.promise
            return rules
          },
        }),
        async invoke({ run, signal }) {
          expect(run.run.run_id).toBe(first.runId)
          invocations++
          signal.addEventListener(
            "abort",
            () => {
              aborted = true
              unwind.release()
            },
            { once: true },
          )
          await unwind.promise
          finished = true
          return {}
        },
      })
      const ticking = owner.tick().then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      )
      await entered.promise
      const closing = owner.close().then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      )
      release.release()
      const tickResult = await ticking,
        closeResult = await closing
      expect(tickResult).toMatchObject({ ok: false })
      expect(closeResult).toMatchObject({ ok: false })
      if ("error" in tickResult && "error" in closeResult)
        expect(closeResult.error).toBe(tickResult.error)
      expect(aborted).toBe(true)
      expect(finished).toBe(true)
      expect(invocations).toBe(1)
      const row = (await f.snapshot(second.threadId)).runs.find(
        (r) => r.run.run_id === resumed.runId,
      )
      expect(row?.metadata.phase).toBe("accepted")
      expect(row?.metadata.startedAt).toBeUndefined()
      expect(row?.unwoundAt).toBeUndefined()
    } finally {
      release.release()
      unwind.release()
      await owner?.idle()
      await owner?.close().catch(() => {})
      await parker.close()
      await f.close()
    }
  },
  budget,
)
it(
  "aborts every actual owned provider and waits for unwind when one durable shutdown control fails",
  async () => {
    const f = await fixture(),
      both = barrier(),
      release = barrier()
    const first = await f.admit(body({ on_completion: "keep" })),
      second = await f.admit(
        body({
          thread_id: crypto.randomUUID(),
          if_not_exists: "create",
          on_completion: "keep",
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        }),
      )
    const aborted = new Set<string>(),
      finished = new Set<string>()
    let invoked = 0
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ run, signal }) {
        invoked++
        signal.addEventListener(
          "abort",
          () => {
            aborted.add(run.run.run_id)
            if (aborted.size === 2) release.release()
          },
          { once: true },
        )
        if (invoked === 2) both.release()
        await release.promise
        finished.add(run.run.run_id)
        return {}
      },
    })
    let restore: (() => Promise<void>) | undefined
    try {
      await host.tick()
      await both.promise
      restore = await f.native.rejectControlInsert(first.runId)
      await expect(host.close()).rejects.toThrow("r7-owned-control-failure")
      expect([...aborted].sort()).toEqual([first.runId, second.runId].sort())
      expect([...finished].sort()).toEqual([first.runId, second.runId].sort())
      expect(invoked).toBe(2)
      for (const target of [first, second]) {
        const snapshot = await f.snapshot(target.threadId)
        expect(snapshot.runs[0]?.unwoundAt).toEqual(expect.any(String))
        expect(snapshot.runs[0]?.metadata.continuation).toBe("closed")
      }
    } finally {
      release.release()
      await restore?.()
      await host.idle()
      await host.close().catch(() => {})
      await f.close()
    }
  },
  budget,
)
it(
  "signals shutdown to a settled but still-unwinding provider and preserves its committed winner",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const initial = await f.admit(body({ on_completion: "keep" })),
      settled = barrier(),
      unwind = barrier()
    let aborted = false
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ run, store, signal }) {
        await store.transaction((tx) =>
          settleExecution(tx, run.run.run_id, {
            status: "success",
            reason: "completed",
            result: { values: { winner: true } },
          }),
        )
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
            unwind.release()
          },
          { once: true },
        )
        settled.release()
        await unwind.promise
        throw new Error("late shutdown unwind")
      },
    })
    cleanups.push(
      () => host.close(),
      async () => unwind.release(),
    )
    await host.tick()
    await settled.promise
    const closing = host.close()
    // This barrier resolves only when the actual provider sees the abort.
    await unwind.promise
    await closing
    expect(aborted).toBe(true)
    expect((await f.snapshot(initial.threadId)).runs[0]).toMatchObject({
      run: { status: "success" },
      metadata: { reason: "completed" },
      result: { values: { winner: true } },
      unwoundAt: expect.any(String),
    })
  },
  budget,
)
it(
  "rejects a continuation paused at commit when its host closes admission",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const initial = await f.admit(body({ on_completion: "keep" })),
      entered = barrier(),
      commit = barrier()
    const permissions = createPermissionService({
      ...f.authority,
      async failpoint(point) {
        if (point === "beforeCommit") {
          entered.release()
          await commit.promise
        }
      },
    })
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ run, store }) {
        await store.transaction((tx) =>
          parkPermissions(tx, run.run.run_id, [
            {
              interruptId: "commit",
              namespace: [],
              request: { kind: "tool", detail: { toolName: "effect", suggestedPattern: "effect" } },
              protectedProposal: {},
            },
          ]),
        )
        return {}
      },
    })
    cleanups.push(
      () => host.close(),
      async () => commit.release(),
    )
    await host.tick()
    await host.idle()
    const before = await f.snapshot(initial.threadId)
    const operation = permissions.respond(f.request(), initial.threadId, initial.runId, {
      type: "command",
      id: 1,
      method: "input.respond",
      params: {
        responses: [{ namespace: [], interruptId: "commit", response: { decision: "once" } }],
      },
    })
    const rejected = expect(operation).rejects.toMatchObject({ code: "storage_unavailable" })
    await entered.promise
    await host.close()
    commit.release()
    await rejected
    expect(await f.snapshot(initial.threadId)).toEqual(before)
  },
  budget,
)
it(
  "reconciles an accepted continuation receipt after shutdown without reopening admission",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const initial = await f.admit(body({ on_completion: "keep" })),
      permissions = createPermissionService({ ...f.authority })
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ run, store }) {
        await store.transaction((tx) =>
          parkPermissions(tx, run.run.run_id, [
            {
              interruptId: "answer",
              namespace: [],
              request: { kind: "tool", detail: { toolName: "effect", suggestedPattern: "effect" } },
              protectedProposal: {},
            },
          ]),
        )
        return {}
      },
    })
    cleanups.push(() => host.close())
    await host.tick()
    await host.idle()
    const command = {
      type: "command",
      id: 1,
      method: "input.respond",
      params: {
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        responses: [{ namespace: [], interruptId: "answer", response: { decision: "once" } }],
      },
    }
    const accepted = await permissions.respond(
      f.request(),
      initial.threadId,
      initial.runId,
      command,
    )
    await host.close()
    expect(
      (await permissions.respond(f.request(), initial.threadId, initial.runId, command)).runId,
    ).toBe(accepted.runId)
    expect((await f.admit(body({ on_completion: "keep" }))).runId).toBe(initial.runId)
    const snapshot = await f.snapshot(initial.threadId)
    expect(snapshot.runs).toHaveLength(2)
    expect(snapshot.runs.find((r) => r.run.run_id === accepted.runId)?.metadata.phase).toBe(
      "accepted",
    )
  },
  budget,
)
it(
  "closes new permission continuation admission on the shared host while preserving the parked records",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const accepted = await f.admit(body({ on_completion: "keep" })),
      permissions = createPermissionService({ ...f.authority })
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ run, store }) {
        await store.transaction((tx) =>
          parkPermissions(tx, run.run.run_id, [
            {
              interruptId: "stop",
              namespace: [],
              request: { kind: "tool", detail: { toolName: "effect", suggestedPattern: "effect" } },
              protectedProposal: {},
            },
          ]),
        )
        return {}
      },
    })
    cleanups.push(() => host.close())
    await host.tick()
    await host.idle()
    await host.close()
    const before = await f.snapshot(accepted.threadId)
    await expect(
      permissions.respond(f.request(), accepted.threadId, accepted.runId, {
        type: "command",
        id: 1,
        method: "input.respond",
        params: {
          responses: [{ namespace: [], interruptId: "stop", response: { decision: "once" } }],
        },
      }),
    ).rejects.toMatchObject({ code: "storage_unavailable" })
    expect(await f.snapshot(accepted.threadId)).toEqual(before)
  },
  budget,
)
it.each(["park-gap", "park-released"] as const)(
  "recovers actual process loss at %s without replaying a permission graph",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "b4-r7-park-loss-")),
      counter = join(root, "effects")
    cleanups.push(async () => {
      rmSync(root, { recursive: true, force: true })
    })
    const pg = process.env.B4_ADMISSION_POSTGRES === "1"
    const f = await fixture(pg ? undefined : sqliteRuntimeStorage(root))
    cleanups.push(() => f.close())
    const accepted = await f.admit()
    if (!pg) await f.close()
    const processOwner = runtimeWorker({ root, counter, mode, ...f.native.workerBoot })
    cleanups.push(() => processOwner.kill())
    await processOwner.wait("ready")
    processOwner.child.send("tick")
    await processOwner.wait("parked")
    if (mode === "park-released") await processOwner.wait("ticked")
    await processOwner.kill()
    if (pg) await f.native.expireOwner(accepted.threadId)
    const recovered = pg ? f : await fixture(sqliteRuntimeStorage(root))
    if (!pg) cleanups.push(() => recovered.close())
    let invocations = 0
    const host = createExecutionHost({
      ...recovered.authority,
      invoke: async () => {
        invocations++
        return {}
      },
    })
    cleanups.push(() => host.close())
    await host.tick()
    await host.idle()
    const snapshot = await recovered.snapshot(accepted.threadId),
      row = snapshot.runs[0]
    expect(invocations).toBe(0)
    expect(existsSync(counter)).toBe(false)
    expect(row?.metadata.reason).toBe("permission")
    expect(row?.metadata.continuation).toBe(mode === "park-gap" ? "closed" : "waiting")
    if (mode === "park-gap") {
      expect(row?.ownershipLoss).toMatchObject({ effectsUncertain: true })
      expect(row?.unwoundAt).toBeUndefined()
      expect(snapshot.pending[0]).toMatchObject({ disposition: "retired", decision: null })
      const failure = await host
        .cancel(recovered.request(), accepted.threadId, accepted.runId, { wait: true })
        .then(
          () => undefined,
          (error) => error,
        )
      expect(failure).toMatchObject({ code: "storage_unavailable" })
      const diagnostic = {
        v: 1,
        code: "storage_unavailable",
        reason: "execution_lost",
        effectsUncertain: true,
      }
      expect(protocolRestError(failure)).toEqual({
        code: "storage_unavailable",
        message: "Storage unavailable",
        metadata: { b4: diagnostic },
      })
      expect(protocolAspError(failure, 1)).toEqual({
        type: "error",
        id: 1,
        error: "unknown_error",
        message: "Storage unavailable",
        meta: { b4: diagnostic },
      })
      const response = protocolErrorResponse(failure)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual(protocolRestError(failure))
      // A later successful segment can clean the Thread, but cannot erase the
      // predecessor's proved loss or make its exact wait a clean completion.
      await recovered.admit(
        body({
          thread_id: accepted.threadId,
          on_completion: "delete",
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        }),
      )
      await host.tick()
      await host.idle()
      const backend = runtimeStorageRegistration(recovered.storage),
        retained = await backend.temporary?.readRun(accepted.runId)
      expect(await backend.readThread(accepted.threadId)).toBeUndefined()
      expect(retained?.record.ownershipLoss).toMatchObject({ effectsUncertain: true })
      expect(retained?.record.metadata).toMatchObject({
        reason: "permission",
        continuation: "closed",
      })
      expect(retained?.record.unwoundAt).toBeUndefined()
      expect(
        await backend.execution?.controlProgress?.(
          { threadId: accepted.threadId, generation: snapshot.scope.generation },
          crypto.randomUUID(),
          accepted.runId,
        ),
      ).toBe("execution_lost")
      const retainedFailure = await host
        .cancel(recovered.request(), accepted.threadId, accepted.runId, { wait: true })
        .then(
          () => undefined,
          (error) => error,
        )
      expect(protocolRestError(retainedFailure)).toEqual({
        code: "storage_unavailable",
        message: "Storage unavailable",
        metadata: { b4: diagnostic },
      })
      expect(protocolAspError(retainedFailure, 1).meta?.b4).toEqual(diagnostic)
    } else {
      expect(row?.ownershipLoss).toBeUndefined()
      expect(row?.unwoundAt).toEqual(expect.any(String))
      expect(snapshot.pending[0]?.disposition).toBe("pending")
    }
  },
  budget,
)
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
it(
  "closes admission, drains the configured budget, then waits for clean server shutdown unwind",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const accepted = await f.admit(body({ on_completion: "keep" }))
    const entered = barrier(),
      aborting = barrier(),
      unwind = barrier()
    const timers = new Map<unknown, { callback: () => void; delay: number }>()
    const host = createExecutionHost({
      ...f.authority,
      admission: f.service,
      clock: {
        now: () => new Date().toISOString(),
        setInterval(callback, delay) {
          const h = {}
          timers.set(h, { callback, delay })
          return h
        },
        clearInterval(h) {
          timers.delete(h)
        },
      },
      async invoke({ signal }) {
        signal.addEventListener("abort", () => aborting.release(), { once: true })
        entered.release()
        await unwind.promise
        return {}
      },
    })
    cleanups.push(
      () => host.close(),
      async () => {
        unwind.release()
      },
    )
    await host.tick()
    await entered.promise
    let finished = false
    const closing = host.close({ drainMs: 250 }).then(() => {
      finished = true
    })
    await expect(
      f.admit(body({ thread_id: crypto.randomUUID(), if_not_exists: "create" })),
    ).rejects.toMatchObject({ code: "storage_unavailable" })
    expect(finished).toBe(false)
    expect([...timers.values()].some((t) => t.delay === 250)).toBe(true)
    for (const timer of timers.values()) if (timer.delay === 250) timer.callback()
    await aborting.promise
    expect((await f.snapshot(accepted.threadId)).runs[0]?.metadata.phase).toBe("running")
    expect(finished).toBe(false)
    unwind.release()
    await closing
    expect((await f.snapshot(accepted.threadId)).runs[0]).toMatchObject({
      run: { status: "interrupted" },
      metadata: { reason: "server_shutdown", effectsUncertain: false },
    })
  },
  budget,
)
it(
  "finishes work that unwinds during drain without rewriting its committed success",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const accepted = await f.admit(body({ on_completion: "keep" }))
    const entered = barrier(),
      unwind = barrier()
    let aborted = false
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ signal }) {
        signal.addEventListener("abort", () => {
          aborted = true
        })
        entered.release()
        await unwind.promise
        return { values: { answer: 42 } }
      },
    })
    cleanups.push(
      () => host.close(),
      async () => {
        unwind.release()
      },
    )
    await host.tick()
    await entered.promise
    const closing = host.close({ drainMs: 1000 })
    unwind.release()
    await closing
    expect(aborted).toBe(false)
    expect((await f.snapshot(accepted.threadId)).runs[0]).toMatchObject({
      run: { status: "success" },
      metadata: { reason: "completed" },
      result: { values: { answer: 42 } },
    })
  },
  budget,
)
it(
  "keeps already parked durable permission waits on shutdown",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const accepted = await f.admit(body({ on_completion: "keep" }))
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ run, store }) {
        await store.transaction((tx) =>
          parkPermissions(tx, run.run.run_id, [
            {
              interruptId: "permission",
              namespace: [],
              request: { kind: "tool", detail: { toolName: "effect", suggestedPattern: "effect" } },
              protectedProposal: {},
            },
          ]),
        )
        return {}
      },
    })
    cleanups.push(() => host.close())
    await host.tick()
    await host.idle()
    const before = await f.snapshot(accepted.threadId)
    await host.close()
    const after = await f.snapshot(accepted.threadId)
    expect(after).toEqual(before)
    expect(after.runs[0]?.metadata).toMatchObject({ reason: "permission", continuation: "waiting" })
  },
  budget,
)
it(
  "records deadline only after actual provider unwind, including late provider success",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const accepted = await f.admit(body({ on_completion: "keep" }))
    const entered = barrier(),
      aborting = barrier(),
      unwind = barrier()
    const timers = new Map<unknown, { callback: () => void; delay: number }>()
    const host = createExecutionHost({
      ...f.authority,
      deadlineMs: 250,
      clock: {
        now: () => new Date().toISOString(),
        setInterval(callback, delay) {
          const h = {}
          timers.set(h, { callback, delay })
          return h
        },
        clearInterval(h) {
          timers.delete(h)
        },
      },
      async invoke({ signal }) {
        signal.addEventListener("abort", () => aborting.release(), { once: true })
        entered.release()
        await unwind.promise
        return { values: { tooLate: true } }
      },
    })
    cleanups.push(
      () => host.close(),
      async () => {
        unwind.release()
      },
    )
    await host.tick()
    await entered.promise
    for (const timer of timers.values()) if (timer.delay === 250) timer.callback()
    await aborting.promise
    expect((await f.snapshot(accepted.threadId)).runs[0]?.metadata.phase).toBe("running")
    unwind.release()
    await host.idle()
    expect((await f.snapshot(accepted.threadId)).runs[0]).toMatchObject({
      run: { status: "timeout" },
      metadata: { reason: "deadline", effectsUncertain: false },
    })
  },
  budget,
)
it(
  "preserves the first durable stop reason through a later shutdown",
  async () => {
    const f = await fixture()
    cleanups.push(() => f.close())
    const accepted = await f.admit(body({ on_completion: "keep" }))
    const entered = barrier(),
      unwind = barrier()
    const host = createExecutionHost({
      ...f.authority,
      async invoke() {
        entered.release()
        await unwind.promise
        throw new Error("provider aborted")
      },
    })
    cleanups.push(
      () => host.close(),
      async () => {
        unwind.release()
      },
    )
    await host.tick()
    await entered.promise
    await host.cancel(f.request(), accepted.threadId, accepted.runId, {})
    const closing = host.close()
    unwind.release()
    await closing
    const snapshot = await f.snapshot(accepted.threadId)
    expect(snapshot.runs[0]?.metadata.reason).toBe("user_stop")
    expect(snapshot.inbox.filter((e) => e.kind === "control")).toHaveLength(1)
  },
  budget,
)
