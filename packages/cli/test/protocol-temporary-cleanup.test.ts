import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createPermissionsStore } from "@b4run/permissions/node"
import { afterEach, expect, it } from "vitest"
import { setRequestPrincipal } from "../src/lib/dev/auth.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

const budget = 30_000
const cleanups: (() => Promise<void>)[] = []
it(
  "keeps the exact current delete Stop pending through inspection and a stale intent until retry hands off cleanup",
  async () => {
    const entered = barrier(),
      unwind = barrier(),
      preparing = barrier(),
      releasePreparation = barrier(),
      inspectionEntered = barrier(),
      inspectionUnwind = barrier()
    const f = await setup(async ({ installationId, threadId, generation }) => {
        preparing.release()
        await releasePreparation.promise
        return { kind: "none", installationId, threadId, generation }
      }),
      initial = await f.admit()
    const host = createExecutionHost({
      ...f.authority,
      async invoke() {
        entered.release()
        await unwind.promise
        return {}
      },
    })
    let inspection: Promise<void> | undefined
    cleanups.push(
      () => host.close(),
      async () => {
        unwind.release()
        releasePreparation.release()
        inspectionUnwind.release()
        await inspection
      },
    )
    await host.tick()
    await entered.promise
    await host.cancel(f.request(), initial.threadId, initial.runId, { wait: false })
    const controller = new AbortController(),
      request = new Request("http://local/runs/cancel", {
        method: "POST",
        signal: controller.signal,
      })
    setRequestPrincipal(request, { id: "alice" })
    let completed = false
    const waiting = host.cancel(request, initial.threadId, initial.runId, { wait: true }).then(
      () => {
        completed = true
        return { ok: true }
      },
      (error) => ({ ok: false, error }),
    )
    cleanups.push(async () => {
      controller.abort(new Error("owned test waiter cleanup"))
      await waiting
    })
    unwind.release()
    await preparing.promise
    const store = await f.store(initial.threadId),
      backend = runtimeStorageRegistration(f.storage)
    const nextIntent = crypto.randomUUID()
    await store.transaction(async (tx) => {
      expect(await tx.executionOwner()).toBeNull()
      const thread = await tx.thread.get()
      if (!thread) throw new Error("Missing stopped target")
      await tx.thread.put({
        ...thread,
        revision: thread.revision + 1,
        cleanupIntent: { intentId: nextIntent, onCompletion: "delete" },
      })
    })
    inspection = store.withReadLease(async () => {
      inspectionEntered.release()
      await inspectionUnwind.promise
    })
    await inspectionEntered.promise
    releasePreparation.release()
    expect(completed).toBe(false)
    expect(await backend.readThread(initial.threadId)).toBeDefined()
    inspectionUnwind.release()
    await inspection
    await host.idle()
    const stalled = await f.snapshot(initial.threadId),
      control = stalled.inbox.find(
        (entry) => entry.kind === "control" && entry.runId === initial.runId,
      )
    if (!control) throw new Error("Missing exact accepted control")
    expect(stalled.thread?.cleanupIntent).toEqual({ intentId: nextIntent, onCompletion: "delete" })
    expect(control.status).toBe("accepted")
    expect(
      await backend.execution?.controlProgress?.(stalled.scope, control.entryId, initial.runId),
    ).toBe("pending")
    expect(completed).toBe(false)
    await host.tick()
    await host.idle()
    expect(await waiting).toEqual({ ok: true })
    expect(await backend.readThread(initial.threadId)).toBeUndefined()
    expect((await backend.temporary?.readRun(initial.runId))?.record.metadata.reason).toBe(
      "user_stop",
    )
  },
  budget,
)
it.each(["refused", "deferred"] as const)(
  "proves only terminal never-started permission work clean when current rules are %s",
  async (mode) => {
    const f = await setup(),
      initial = await f.admit(),
      rules = createPermissionsStore({
        appRoot: f.directory,
        config: undefined,
        mode: "interactive",
      })
    const permissions = createPermissionService({
      ...f.authority,
      grants: "required",
      resolvePermissions: async () => rules,
    })
    let invocations = 0,
      effects = 0
    const host = createExecutionHost({
      ...f.authority,
      permissions,
      async invoke({ run, store }) {
        invocations++
        if (run.run.run_id === initial.runId)
          await store.transaction((tx) =>
            parkPermissions(
              tx,
              run.run.run_id,
              [
                {
                  interruptId: "effect",
                  namespace: [],
                  request: {
                    kind: "tool",
                    detail: { toolName: "effect", suggestedPattern: "effect" },
                  },
                  protectedProposal: {},
                },
              ],
              "required",
            ),
          )
        else effects++
        return { values: { effects } }
      },
    })
    cleanups.push(() => host.close())
    await host.tick()
    await host.idle()
    const pending = (await f.snapshot(initial.threadId)).pending[0]
    if (!pending) throw new Error("Missing protected prompt")
    const resumed = await permissions.respond(f.request(), initial.threadId, initial.runId, {
      type: "command",
      id: 1,
      method: "input.respond",
      params: {
        responses: [
          {
            namespace: [],
            interruptId: "effect",
            response: { decision: "once", grant: pending.input.data.b4.grant },
          },
        ],
      },
    })
    const path = join(f.directory, ".b4", "permissions.json"),
      backend = runtimeStorageRegistration(f.storage)
    mkdirSync(join(f.directory, ".b4"), { recursive: true })
    if (mode === "refused")
      writeFileSync(path, JSON.stringify({ version: 1, allow: {}, deny: { tool: ["effect"] } }))
    else mkdirSync(path)
    if (mode === "deferred") {
      await expect(host.tick()).rejects.toThrow()
      const snapshot = await f.snapshot(initial.threadId),
        row = snapshot.runs.find((r) => r.run.run_id === resumed.runId)
      expect(row?.metadata.phase).toBe("accepted")
      expect(row?.metadata.startedAt).toBeUndefined()
      expect(row?.unwoundAt).toBeUndefined()
      expect(
        snapshot.inbox.find((r) => r.kind === "dispatch" && r.runId === resumed.runId)?.status,
      ).toBe("accepted")
      expect(await backend.temporary?.readRun(resumed.runId)).toBeUndefined()
      expect(
        await (await f.store(initial.threadId)).transaction((tx) => tx.executionOwner()),
      ).toBeNull()
      expect(invocations).toBe(1)
      expect(effects).toBe(0)
      rmSync(path, { recursive: true })
      writeFileSync(path, JSON.stringify({ version: 1, allow: {}, deny: {} }))
      await host.tick()
      await host.idle()
      expect(invocations).toBe(2)
      expect(effects).toBe(1)
    } else {
      await host.tick()
      await host.idle()
      await host.tick()
      await host.idle()
      expect(invocations).toBe(1)
      expect(effects).toBe(0)
      expect(await backend.readThread(initial.threadId)).toBeUndefined()
      const retained = await backend.temporary?.readRun(resumed.runId)
      expect(retained?.record).toMatchObject({
        run: { status: "error" },
        metadata: {
          phase: "settled",
          continuation: "closed",
          reason: "execution_error",
          effectsUncertain: false,
        },
        unwoundAt: expect.any(String),
      })
      expect(retained?.record.metadata.startedAt).toBeUndefined()
      expect((await backend.temporary?.readRun(initial.runId))?.record.metadata.reason).toBe(
        "permission",
      )
    }
  },
  budget,
)
// Review-correction cases use the existing30s real-native integration budget,
// selected before their first run; all original budgets remain unchanged.
it.each(["keep", "delete"] as const)(
  "completes the exact old Stop after a %s successor supersedes its blocked finalizer",
  async (onCompletion) => {
    const preparing = barrier(),
      releasePreparation = barrier(),
      entered = barrier(),
      unwind = barrier()
    const f = await setup(async ({ installationId, threadId, generation }) => {
      preparing.release()
      await releasePreparation.promise
      return { kind: "none", installationId, threadId, generation }
    })
    const initial = await f.admit(),
      waitAbort = new AbortController()
    let invocations = 0
    const host = createExecutionHost({
      ...f.authority,
      async invoke() {
        invocations++
        entered.release()
        await unwind.promise
        return {}
      },
    })
    cleanups.push(
      () => host.close(),
      async () => {
        unwind.release()
        releasePreparation.release()
      },
    )
    await host.tick()
    await entered.promise
    await host.cancel(f.request(), initial.threadId, initial.runId, { wait: false })
    const request = new Request("http://local/runs/cancel", {
      method: "POST",
      signal: waitAbort.signal,
    })
    setRequestPrincipal(request, { id: "alice" })
    const waiting = host.cancel(request, initial.threadId, initial.runId, { wait: true }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    )
    cleanups.push(async () => {
      waitAbort.abort(new Error("owned test waiter cleanup"))
      await waiting
    })
    unwind.release()
    await preparing.promise
    const released = await f.snapshot(initial.threadId)
    expect(released.runs[0]?.unwoundAt).toEqual(expect.any(String))
    expect(
      await (await f.store(initial.threadId)).transaction((tx) => tx.executionOwner()),
    ).toBeNull()
    const successor = await f.admit(
      body({
        thread_id: initial.threadId,
        on_completion: onCompletion,
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
      }),
    )
    releasePreparation.release()
    await host.idle()
    const snapshot = await f.snapshot(initial.threadId),
      control = snapshot.inbox.find((r) => r.kind === "control" && r.runId === initial.runId)
    expect(snapshot.thread?.currentRunId).toBe(successor.runId)
    expect(control?.status).toBe("applied")
    expect(await waiting).toEqual({ ok: true })
    expect(snapshot.runs.find((r) => r.run.run_id === initial.runId)?.metadata.reason).toBe(
      "user_stop",
    )
    expect(snapshot.runs.find((r) => r.run.run_id === successor.runId)?.metadata).toMatchObject({
      phase: "accepted",
    })
    expect(
      snapshot.runs.find((r) => r.run.run_id === successor.runId)?.metadata.startedAt,
    ).toBeUndefined()
    expect(invocations).toBe(1)
  },
  budget,
)
it(
  "hands off an exact owned-resource obligation durably without claiming physical erasure",
  async () => {
    const f = await setup(async ({ installationId, threadId, generation }) => ({
      kind: "owned",
      installationId,
      threadId,
      generation,
      resources: [
        {
          associationId: "controlled-association",
          revision: "revision-1",
          reference: "controlled-resource",
          exclusiveOwnershipProof: "server-verified-association-revision",
        },
      ],
    }))
    const accepted = await f.admit(),
      before = await f.snapshot(accepted.threadId)
    let invocations = 0
    const host = createExecutionHost({
      ...f.authority,
      invoke: async () => {
        invocations++
        return {}
      },
    })
    cleanups.push(() => host.close())
    await host.cancel(f.request(), accepted.threadId, accepted.runId, { wait: true })
    expect(invocations).toBe(0)
    const jobs = await f.native.maintenance(accepted.threadId, before.scope.generation)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      jobId: `temporary:${before.thread?.cleanupIntent?.intentId}`,
      kind: "provider_teardown",
      status: "pending",
      payload: {
        provider: {
          installationId: f.storage.installationId,
          threadId: accepted.threadId,
          generation: before.scope.generation,
          resources: [{ associationId: "controlled-association", revision: "revision-1" }],
        },
      },
    })
    expect(
      await runtimeStorageRegistration(f.storage).readThread(accepted.threadId),
    ).toBeUndefined()
  },
  budget,
)
it(
  "refuses delete before admission without explicit trusted resource preparation",
  async () => {
    const f = await fixture(undefined, undefined, { prepareTemporaryCleanup: false })
    cleanups.push(() => f.close())
    await expect(f.admit()).rejects.toMatchObject({ code: "not_supported" })
    expect(await runtimeStorageRegistration(f.storage).listThreads()).toEqual([])
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
async function setup(
  prepareTemporaryCleanup?: import("../src/lib/runtime/storage-host.ts").TemporaryCleanupPreparation,
) {
  const f = await fixture(
    undefined,
    undefined,
    prepareTemporaryCleanup ? { prepareTemporaryCleanup } : {},
  )
  cleanups.push(() => f.close())
  return f
}

it(
  "removes an omitted-thread default delete and independently retains authorized result and original receipt",
  async () => {
    const f = await setup(),
      accepted = await f.admit()
    const backend = runtimeStorageRegistration(f.storage)
    const host = createExecutionHost({
      ...f.authority,
      invoke: async () => ({ values: { answer: 42 } }),
    })
    cleanups.push(() => host.close())
    await host.tick()
    await host.idle()
    expect(await backend.readThread(accepted.threadId)).toBeUndefined()
    const retained = await backend.temporary?.readRun(accepted.runId)
    expect(retained?.record).toMatchObject({
      run: { status: "success" },
      metadata: { reason: "completed" },
      result: { values: { answer: 42 } },
    })
    if (!retained) throw new Error("Missing independent retained Run")
    expect(Date.parse(retained.retainedUntil) - Date.parse(retained.retainedAt)).toBe(
      7 * 24 * 60 * 60 * 1000,
    )
    expect(retained?.subject.thread).not.toHaveProperty("values")
    expect(retained?.subject.thread).not.toHaveProperty("messages")
    expect((await f.admit()).runId).toBe(accepted.runId)
    expect((await f.lookup())[0]?.run_id).toBe(accepted.runId)
    expect((await f.search({}))[0]?.run_id).toBe(accepted.runId)
    f.deny()
    await expect(f.admit()).rejects.toMatchObject({ code: "not_found" })
    expect(await f.search({})).toEqual([])
  },
  budget,
)
it(
  "keeps a temporary Thread parked and carries its binding intent through permission continuation",
  async () => {
    const f = await setup(),
      accepted = await f.admit()
    const permissions = createPermissionService({ ...f.authority, grants: "required" })
    let invocations = 0
    const host = createExecutionHost({
      ...f.authority,
      permissions,
      async invoke({ run, store }) {
        invocations++
        if (run.run.run_id === accepted.runId)
          await store.transaction((tx) =>
            parkPermissions(
              tx,
              run.run.run_id,
              [
                {
                  agentId: "/other#agent",
                  interruptId: "effect",
                  namespace: [],
                  request: {
                    kind: "tool",
                    detail: { toolName: "effect", suggestedPattern: "effect" },
                  },
                  protectedProposal: {},
                },
              ],
              "required",
            ),
          )
        return { values: { continued: true } }
      },
    })
    cleanups.push(() => host.close())
    await host.tick()
    await host.idle()
    const parked = await f.snapshot(accepted.threadId),
      prompt = parked.pending[0]
    expect(parked.thread?.cleanupIntent?.onCompletion).toBe("delete")
    if (!prompt) throw new Error("missing parked prompt")
    const command = {
      type: "command",
      id: 1,
      method: "input.respond",
      params: {
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        responses: [
          {
            namespace: [],
            interruptId: "effect",
            response: { decision: "once", grant: prompt.input.data.b4.grant },
          },
        ],
      },
    }
    const resumed = await permissions.respond(
      f.request(),
      accepted.threadId,
      accepted.runId,
      command,
    )
    expect((await f.snapshot(accepted.threadId)).thread?.cleanupIntent).toEqual(
      parked.thread?.cleanupIntent,
    )
    await host.tick()
    await host.idle()
    const backend = runtimeStorageRegistration(f.storage)
    expect(await backend.readThread(accepted.threadId)).toBeUndefined()
    expect((await backend.temporary?.readRun(accepted.runId))?.record.metadata).toMatchObject({
      reason: "permission",
      continuation: "closed",
    })
    expect((await backend.temporary?.readRun(resumed.runId))?.record.result?.values).toEqual({
      continued: true,
    })
    expect(invocations).toBe(2)
    expect(
      (await permissions.respond(f.request(), accepted.threadId, accepted.runId, command)).runId,
    ).toBe(resumed.runId)
    f.removeAgent("/other#agent")
    expect((await f.search({})).some((r) => r.run_id === resumed.runId)).toBe(false)
    await expect(
      host.cancel(f.request(), accepted.threadId, resumed.runId, {}),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      permissions.respond(f.request(), accepted.threadId, accepted.runId, command),
    ).rejects.toMatchObject({ code: "not_found" })
  },
  budget,
)
it(
  "stops a parked temporary Run without another graph invocation or permission answer",
  async () => {
    const f = await setup(),
      accepted = await f.admit()
    let invocations = 0
    const host = createExecutionHost({
      ...f.authority,
      async invoke({ run, store }) {
        invocations++
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
    cleanups.push(() => host.close())
    await host.tick()
    await host.idle()
    await host.cancel(f.request(), accepted.threadId, accepted.runId, { wait: true })
    expect(invocations).toBe(1)
    const backend = runtimeStorageRegistration(f.storage)
    expect(await backend.readThread(accepted.threadId)).toBeUndefined()
    expect((await backend.temporary?.readRun(accepted.runId))?.record.metadata).toMatchObject({
      reason: "permission",
      continuation: "closed",
    })
  },
  budget,
)
it(
  "re-evaluates explicit and omitted REST completion defaults on the supplied Thread",
  async () => {
    const f = await setup(),
      accepted = await f.admit(body({ on_completion: "keep" }))
    const host = createExecutionHost({ ...f.authority, invoke: async () => ({}) })
    cleanups.push(() => host.close())
    await host.tick()
    await host.idle()
    const first = await f.snapshot(accepted.threadId)
    expect(first.thread?.cleanupIntent?.onCompletion).toBe("keep")
    const second = await f.admit(
      body({
        thread_id: accepted.threadId,
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
      }),
    )
    expect((await f.snapshot(accepted.threadId)).thread?.cleanupIntent?.onCompletion).toBe("keep")
    expect((await f.snapshot(accepted.threadId)).thread?.cleanupIntent?.intentId).not.toBe(
      first.thread?.cleanupIntent?.intentId,
    )
    await host.tick()
    await host.idle()
    const third = await f.admit(
      body({
        thread_id: accepted.threadId,
        on_completion: "delete",
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
      }),
    )
    await host.tick()
    await host.idle()
    const backend = runtimeStorageRegistration(f.storage)
    expect(await backend.readThread(accepted.threadId)).toBeUndefined()
    for (const id of [accepted.runId, second.runId, third.runId])
      expect((await backend.temporary?.readRun(id))?.record.run.run_id).toBe(id)
  },
  budget,
)
it(
  "guards a late finalizer against the next Run",
  async () => {
    const preparing = barrier(),
      finalize = barrier()
    const f = await setup(async ({ installationId, threadId, generation }) => {
        preparing.release()
        await finalize.promise
        return { kind: "none", installationId, threadId, generation }
      }),
      accepted = await f.admit()
    const host = createExecutionHost({ ...f.authority, invoke: async () => ({}) })
    cleanups.push(
      () => host.close(),
      async () => {
        finalize.release()
      },
    )
    await host.tick()
    await preparing.promise
    const old = await f.snapshot(accepted.threadId)
    if (!old.thread?.cleanupIntent) throw new Error("Missing captured cleanup intent")
    const backend = runtimeStorageRegistration(f.storage)
    const plan = {
      threadId: accepted.threadId,
      generation: old.scope.generation,
      runId: accepted.runId,
      headCheckpointId: old.thread.headCheckpointId,
      cleanupIntentId: old.thread.cleanupIntent.intentId,
      provider: {
        kind: "owned" as const,
        installationId: f.storage.installationId,
        threadId: accepted.threadId,
        generation: old.scope.generation,
        resources: [
          {
            associationId: "old-association",
            revision: "1",
            reference: "old-resource",
            exclusiveOwnershipProof: "prepared-old-reference",
          },
        ],
      },
    }
    for (const changed of [
      { ...plan, headCheckpointId: crypto.randomUUID() },
      { ...plan, cleanupIntentId: crypto.randomUUID() },
      { ...plan, generation: crypto.randomUUID() },
    ])
      expect(await backend.temporary?.finalize(changed)).toBe(false)

    const successor = await f.admit(
      body({
        thread_id: accepted.threadId,
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
      }),
    )
    finalize.release()
    await host.idle()
    expect((await f.snapshot(accepted.threadId)).thread?.currentRunId).toBe(successor.runId)
    expect(await backend.temporary?.finalize(plan)).toBe(false)
  },
  budget,
)
it(
  "keeps provider read exclusion until the actual inspection promise unwinds",
  async () => {
    const preparing = barrier(),
      startFinalization = barrier(),
      inspectionEntered = barrier(),
      inspectionUnwind = barrier()
    const f = await setup(async ({ installationId, threadId, generation }) => {
        preparing.release()
        await startFinalization.promise
        return {
          kind: "owned",
          installationId,
          threadId,
          generation,
          resources: [
            {
              associationId: "inspection-association",
              revision: "1",
              reference: "controlled-resource",
              exclusiveOwnershipProof: "prepared-exclusive-reference",
            },
          ],
        }
      }),
      accepted = await f.admit()
    const host = createExecutionHost({ ...f.authority, invoke: async () => ({}) })
    cleanups.push(
      () => host.close(),
      async () => {
        startFinalization.release()
        inspectionUnwind.release()
      },
    )
    await host.tick()
    await preparing.promise
    const store = await f.store(accepted.threadId),
      backend = runtimeStorageRegistration(f.storage)
    const inspection = store.withReadLease(async () => {
      inspectionEntered.release()
      await inspectionUnwind.promise
    })
    await inspectionEntered.promise
    startFinalization.release()
    let completed = false
    const idle = host.idle().then(() => {
      completed = true
    })
    expect((await backend.temporary?.candidates())?.map((p) => p.runId)).toContain(accepted.runId)
    expect(await backend.readThread(accepted.threadId)).toBeDefined()
    expect(completed).toBe(false)
    inspectionUnwind.release()
    await inspection
    await idle
    expect(await backend.readThread(accepted.threadId)).toBeUndefined()
  },
  budget,
)
