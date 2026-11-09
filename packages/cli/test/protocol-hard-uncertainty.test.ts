import type { RuntimeStore } from "@b4run/sdk/agent-protocol"
import { expect, it } from "vitest"
import { createExecutionHost, settleExecution } from "../src/lib/runtime/executor.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

it.each([
  { winner: "error", cause: "shutdown" },
  { winner: "permission", cause: "shutdown" },
  { winner: "error", cause: "deadline" },
  { winner: "permission", cause: "deadline" },
] as const)(
  "$cause monotonically adds uncertainty to a committed $winner winner",
  async ({ winner, cause }) => {
    const f = await fixture(),
      committed = barrier(),
      aborted = barrier()
    let host: ReturnType<typeof createExecutionHost> | undefined, failure: unknown
    let resumedFixture: Awaited<ReturnType<typeof fixture>> | undefined
    let resumedHost: ReturnType<typeof createExecutionHost> | undefined
    const resumedEntered = barrier(),
      resumedRelease = barrier()
    const timers = new Map<unknown, { callback: () => void; delay: number }>()
    try {
      const accepted = await f.admit(body({ on_completion: "keep" }))
      host = createExecutionHost({
        ...f.authority,
        ...(cause === "deadline" ? { deadlineMs: 250 } : {}),
        clock: {
          now: () => new Date().toISOString(),
          setInterval(callback, delay) {
            const handle = {}
            timers.set(handle, { callback, delay })
            return handle
          },
          clearInterval(handle) {
            timers.delete(handle)
          },
        },
        async invoke({ store, run, signal }) {
          try {
            await store.transaction((tx) =>
              winner === "error"
                ? settleExecution(tx, run.run.run_id, {
                    status: "error",
                    reason: "execution_error",
                    result: { values: { winner: true } },
                  })
                : parkPermissions(tx, run.run.run_id, [
                    {
                      namespace: [],
                      interruptId: "owned-pause",
                      request: {
                        kind: "tool",
                        detail: { toolName: "effect", suggestedPattern: "effect" },
                      },
                      protectedProposal: {},
                    },
                  ]),
            )
            signal.addEventListener("abort", aborted.resolve, { once: true })
            committed.resolve()
            await aborted.promise
            expect(signal.aborted).toBe(true)
            // Hard shutdown and explicit user Stop have distinct park policies.
            // The uncertainty merge must also preserve its current pause state.
            const beforeMerge = await store.snapshot()
            const uncertainty = {
              status: "timeout",
              reason: "deadline",
              effectsUncertain: true,
              result: { values: { mustNotReplace: true } },
            } as const
            await store.transaction((tx) => settleExecution(tx, run.run.run_id, uncertainty))
            const once = await store.snapshot()
            expect(once.runs[0]?.metadata.continuation).toBe(
              beforeMerge.runs[0]?.metadata.continuation,
            )
            expect(once.pending).toEqual(beforeMerge.pending)
            expect(once.grants).toEqual(beforeMerge.grants)
            await store.transaction((tx) => settleExecution(tx, run.run.run_id, uncertainty))
            await store.transaction((tx) =>
              settleExecution(tx, run.run.run_id, {
                status: "success",
                reason: "completed",
                effectsUncertain: false,
              }),
            )
            expect(await store.snapshot()).toEqual(once)
            return {}
          } catch (error) {
            failure = error
            throw error
          }
        },
      })
      await host.tick()
      await Promise.race([
        committed.promise,
        host.idle().then(() => {
          throw failure ?? new Error("Missing committed winner")
        }),
      ])
      const beforeSnapshot = await f.snapshot(accepted.threadId),
        before = beforeSnapshot.runs[0]
      if (!before) throw new Error("Missing committed Run")
      expect(before.metadata.reason).toBe(winner === "error" ? "execution_error" : "permission")
      expect(before.metadata.effectsUncertain).toBe(false)
      if (winner === "permission") expect(beforeSnapshot.pending).toHaveLength(1)
      if (cause === "deadline") {
        const deadline = [...timers.values()].find((timer) => timer.delay === 250)
        expect(deadline).toBeDefined()
        deadline?.callback()
        await host.idle()
      }
      await host.close()
      if (failure) throw failure
      const after = await f.snapshot(accepted.threadId),
        row = after.runs[0]
      expect(row?.run.status).toBe(before.run.status)
      expect(row?.run.updated_at).toBe(before.run.updated_at)
      expect(row?.metadata.settledAt).toBe(before.metadata.settledAt)
      expect(row?.metadata.reason).toBe(before.metadata.reason)
      expect(row?.metadata.continuation).toBe(before.metadata.continuation)
      expect(row?.metadata.effectsUncertain).toBe(true)
      expect(row?.result?.values).toEqual(before.result?.values)
      expect(row?.result?.run?.metadata.b4).toMatchObject({
        reason: before.metadata.reason,
        effectsUncertain: true,
      })
      expect(after.pending).toEqual(beforeSnapshot.pending)
      expect(after.grants).toEqual(beforeSnapshot.grants)
      expect(after.thread?.pausedGeneration).toBe(beforeSnapshot.thread?.pausedGeneration)
      if (winner === "permission") {
        const registration = runtimeStorageRegistration(f.storage)
        resumedFixture = await fixture((register) => register({ ...registration, close() {} }))
        const permissions = createPermissionService({ ...resumedFixture.authority })
        const resumed = await permissions.respond(
          resumedFixture.request(),
          accepted.threadId,
          accepted.runId,
          {
            type: "command",
            id: 1,
            method: "input.respond",
            params: {
              responses: [
                { namespace: [], interruptId: "owned-pause", response: { decision: "once" } },
              ],
            },
          },
        )
        expect(resumed.runId).not.toBe(accepted.runId)
        let invocations = 0
        resumedHost = createExecutionHost({
          ...resumedFixture.authority,
          permissions,
          async invoke({ run, signal, stopSignal }) {
            invocations++
            expect(run.run.run_id).toBe(resumed.runId)
            resumedEntered.resolve()
            await resumedRelease.promise
            expect(signal.aborted).toBe(false)
            expect(stopSignal.aborted).toBe(false)
            return { values: { resumed: true } }
          },
        })
        await resumedHost.tick()
        await resumedEntered.promise
        await resumedHost.cancel(resumedFixture.request(), accepted.threadId, accepted.runId, {
          wait: false,
        })
        await resumedHost.tick()
        resumedRelease.resolve()
        await resumedHost.idle()
        expect(invocations).toBe(1)
        expect(
          (await resumedFixture.snapshot(accepted.threadId)).runs.find(
            (row) => row.run.run_id === resumed.runId,
          ),
        ).toMatchObject({
          metadata: { reason: "completed", effectsUncertain: false },
          result: { values: { resumed: true } },
        })
      }
    } finally {
      aborted.resolve()
      resumedRelease.resolve()
      await resumedHost?.close()
      await resumedFixture?.close()
      await host?.close()
      await f.close()
    }
  },
  30_000,
)

it("refuses predecessor-owner and historical-target uncertainty writes after a successor starts", async () => {
  const first = await fixture()
  let second: Awaited<ReturnType<typeof fixture>> | undefined
  let predecessor: ReturnType<typeof createExecutionHost> | undefined,
    successor: ReturnType<typeof createExecutionHost> | undefined
  let oldStore: RuntimeStore | undefined, failure: unknown
  try {
    const accepted = await first.admit(body({ on_completion: "keep" }))
    predecessor = createExecutionHost({
      ...first.authority,
      async invoke({ store }) {
        oldStore = store
        return { values: { winner: "predecessor" } }
      },
    })
    await predecessor.tick()
    await predecessor.idle()
    await predecessor.close()
    if (!oldStore) throw new Error("Missing predecessor store")
    const stale = oldStore
    // Reopen logical admission over the same real installation; the first
    // fixture still owns its physical SQLite connection and final teardown.
    const registration = runtimeStorageRegistration(first.storage)
    second = await fixture((register) => register({ ...registration, close() {} }))
    const next = await second.admit(
      body({
        thread_id: accepted.threadId,
        on_completion: "keep",
        metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
      }),
    )
    expect(next.runId).not.toBe(accepted.runId)
    let successorInvocations = 0
    successor = createExecutionHost({
      ...second.authority,
      async invoke({ store, run }) {
        successorInvocations++
        try {
          await store.transaction((tx) =>
            settleExecution(tx, run.run.run_id, {
              status: "success",
              reason: "completed",
              result: { values: { winner: "successor" } },
            }),
          )
          const before = await store.snapshot()
          const uncertainty = {
            status: "error",
            reason: "execution_lost",
            effectsUncertain: true,
          } as const
          await expect(
            stale.transaction((tx) => settleExecution(tx, run.run.run_id, uncertainty)),
          ).rejects.toMatchObject({ code: "stale_fence" })
          await expect(
            store.transaction((tx) => settleExecution(tx, accepted.runId, uncertainty)),
          ).rejects.toMatchObject({ code: "stale_fence" })
          expect(await store.snapshot()).toEqual(before)
          return {}
        } catch (error) {
          failure = error
          throw error
        }
      },
    })
    await successor.tick()
    await successor.idle()
    if (failure) throw failure
    expect(successorInvocations).toBe(1)
    const rows = (await second.snapshot(accepted.threadId)).runs
    expect(rows.find((row) => row.run.run_id === accepted.runId)?.metadata.effectsUncertain).toBe(
      false,
    )
    expect(rows.find((row) => row.run.run_id === next.runId)).toMatchObject({
      metadata: { reason: "completed", effectsUncertain: false },
      result: { values: { winner: "successor" } },
    })
  } finally {
    await successor?.close()
    await predecessor?.close()
    await second?.close()
    await first.close()
  }
}, 30_000)
