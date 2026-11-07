import { afterEach, expect, it } from "vitest"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

const budget = 30_000
const cleanups: (() => Promise<void>)[] = []
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
