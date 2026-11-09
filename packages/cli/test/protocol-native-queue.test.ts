import { expect, it } from "vitest"
import type { BoundRuntimeStore } from "../../postgres-storage/dist/runtime/transaction.js"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { runtimeStorageRegistration } from "../src/lib/runtime/storage-host.ts"
import { body, fixture, reportOwnedCleanup } from "./fixtures/protocol-admission.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

it.each([6, 8, 10])(
  "does not bind a captured generation after queued native cleanup (%s scheduling turns)",
  async (turns) => {
    const entered = deferred(),
      release = deferred()
    const f = await fixture(undefined, undefined, {
      prepareTemporaryCleanup: async (context) => {
        entered.resolve()
        await release.promise
        return { kind: "none", ...context }
      },
    })
    let host: ReturnType<typeof createExecutionHost> | undefined,
      cleanup: Promise<boolean> | undefined
    let gate: Awaited<ReturnType<typeof f.native.cleanupGate>>
    let opening: ReturnType<ReturnType<typeof runtimeStorageRegistration>["openThread"]> | undefined
    let primary: { readonly error: unknown } | undefined
    try {
      const accepted = await f.admit(body({ on_completion: "delete" }))
      host = createExecutionHost({
        storage: f.storage,
        async invoke() {
          return {}
        },
      })
      await host.tick()
      await Promise.race([
        entered.promise,
        host.idle().then(() => {
          throw new Error("Native cleanup preparation finished before its barrier")
        }),
      ])
      const backend = runtimeStorageRegistration(f.storage),
        plan = (await backend.temporary!.candidates())[0]!
      gate = await f.native.cleanupGate()
      cleanup = backend.temporary!.finalize({
        ...plan,
        provider: {
          kind: "none",
          installationId: f.storage.installationId,
          threadId: accepted.threadId,
          generation: plan.generation,
        },
      })
      if (gate) await gate.entered()
      for (let turn = 0; turn < turns; turn++) await Promise.resolve()
      opening = backend.openThread(accepted.threadId, false, plan.generation)
      const settling = Promise.allSettled([cleanup, opening])
      if (gate) {
        await gate.bindingBlocked()
        await gate.release()
      }
      const results = await settling
      for (const result of results) if (result.status === "rejected") throw result.reason
      expect(results[0]).toMatchObject({ status: "fulfilled", value: true })
      expect(results[1]).toMatchObject({ status: "fulfilled", value: undefined })
      expect(await backend.openThread(accepted.threadId, false, plan.generation)).toBeUndefined()
      expect(await backend.openThread(accepted.threadId, true, plan.generation)).toBeUndefined()
    } catch (error) {
      primary = { error }
      throw error
    } finally {
      release.resolve()
      await gate?.release()
      const work = await Promise.allSettled([cleanup, opening, host?.idle()])
      const resources = await Promise.allSettled([gate?.close(), host?.close()])
      const fixtureClosed = await Promise.allSettled([f.close()])
      const errors = [...work, ...resources, ...fixtureClosed]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason)
      reportOwnedCleanup("Queued cleanup fixture failed", errors, primary)
    }
  },
  30_000,
)

it.runIf(process.env.B4_ADMISSION_POSTGRES === "1")(
  "rejects same-scope lease binding before a real conflicting row exclusion can wait",
  async () => {
    const f = await fixture()
    try {
      const accepted = await f.admit(body({ on_completion: "keep" })),
        store = await f.store(accepted.threadId),
        before = await store.snapshot()
      const backend = runtimeStorageRegistration(f.storage)
      const outcome = await store.withReadLease(async () => {
        const gate = await f.native.scopeRowGate(accepted.threadId)
        let settled = false
        const opening = backend.openThread(accepted.threadId, false).then(
          (value) => {
            settled = true
            return { value }
          },
          (error: unknown) => {
            settled = true
            return { error }
          },
        )
        try {
          const waited = await gate.bindingWaits(() => settled)
          await gate.release()
          return { waited, result: await opening }
        } finally {
          await gate.release()
          await opening
        }
      })
      expect(outcome.result).toMatchObject({
        error: { message: "Nested runtime transaction or lease would deadlock" },
      })
      expect(outcome.waited).toBe(false)
      expect(await store.snapshot()).toEqual(before)
    } finally {
      await f.close()
    }
  },
  30_000,
)

it.runIf(process.env.B4_ADMISSION_POSTGRES === "1").each(["live", "expired-idle"] as const)(
  "binds %s before native deletion and later refuses that stale handle without touching replacement",
  async (mode) => {
    const entered = deferred(),
      release = deferred()
    const f = await fixture(undefined, undefined, {
      prepareTemporaryCleanup: async (context) => {
        entered.resolve()
        await release.promise
        return { kind: "none", ...context }
      },
    })
    let host: ReturnType<typeof createExecutionHost> | undefined
    try {
      const accepted = await f.admit(body({ on_completion: "delete" }))
      host = createExecutionHost({
        storage: f.storage,
        async invoke() {
          return {}
        },
      })
      await host.tick()
      await Promise.race([
        entered.promise,
        host.idle().then(() => {
          throw new Error("Native cleanup preparation finished before its barrier")
        }),
      ])
      const backend = runtimeStorageRegistration(f.storage),
        plan = (await backend.temporary!.candidates())[0]!
      if (mode === "expired-idle") await f.native.expireOwner(accepted.threadId)
      const selected = await backend.openThread(accepted.threadId, false, plan.generation)
      expect(selected).toBeDefined()
      expect(await selected!.transaction(async (tx) => tx.scope.generation)).toBe(plan.generation)
      expect(
        await backend.temporary!.finalize({
          ...plan,
          provider: {
            kind: "none",
            installationId: f.storage.installationId,
            threadId: accepted.threadId,
            generation: plan.generation,
          },
        }),
      ).toBe(true)
      let enteredMutation = false
      await expect(
        selected!.transaction(async () => {
          enteredMutation = true
        }),
      ).rejects.toMatchObject({ code: "stale_fence" })
      expect(enteredMutation).toBe(false)
      const fresh = await f.admit(
        body({
          thread_id: accepted.threadId,
          if_not_exists: "create",
          on_completion: "keep",
          metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
        }),
      )
      const replacement = await f.native.scopeRecord(accepted.threadId)
      expect(fresh.runId).not.toBe(accepted.runId)
      expect(await backend.openThread(accepted.threadId, false, plan.generation)).toBeUndefined()
      expect(await backend.openThread(accepted.threadId, true, plan.generation)).toBeUndefined()
      expect(await f.native.scopeRecord(accepted.threadId)).toEqual(replacement)
    } finally {
      release.resolve()
      await host?.idle()
      await host?.close()
      await f.close()
    }
  },
  30_000,
)

it.runIf(process.env.B4_ADMISSION_POSTGRES === "1")(
  "constructs a new canonical PG binding and never creates from an expected generation",
  async () => {
    const f = await fixture()
    try {
      const backend = runtimeStorageRegistration(f.storage),
        threadId = crypto.randomUUID(),
        missing = crypto.randomUUID()
      const created = await backend.openThread(threadId, true)
      expect(created).toBeDefined()
      const scope = await created!.transaction(async (tx) => tx.scope)
      expect(scope).toMatchObject({ threadId, fence: 1 })
      const same = await backend.openThread(threadId, false, scope.generation)
      expect(await same!.transaction(async (tx) => tx.scope)).toEqual(scope)
      expect(await backend.openThread(missing, true, scope.generation)).toBeUndefined()
      expect(await f.native.scopeRecord(missing)).toEqual([])
    } finally {
      await f.close()
    }
  },
  30_000,
)

it.runIf(process.env.B4_ADMISSION_POSTGRES === "1").each(["gone", "active"] as const)(
  "rechecks expired expected generation when the original is %s after independent renewal",
  async (mode) => {
    const entered = deferred(),
      releasePreparation = deferred()
    const f = await fixture(undefined, undefined, {
      prepareTemporaryCleanup: async (context) => {
        entered.resolve()
        await releasePreparation.promise
        return { kind: "none", ...context }
      },
    })
    let host: ReturnType<typeof createExecutionHost> | undefined,
      gate: ReturnType<typeof f.native.pauseBindingCommit> | undefined
    let opening: ReturnType<ReturnType<typeof runtimeStorageRegistration>["openThread"]> | undefined
    let primary: { readonly error: unknown } | undefined
    try {
      const accepted = await f.admit(body({ on_completion: "delete" }))
      host = createExecutionHost({
        storage: f.storage,
        async invoke() {
          return {}
        },
      })
      await host.tick()
      await Promise.race([
        entered.promise,
        host.idle().then(() => {
          throw new Error("Cleanup preparation finished before its barrier")
        }),
      ])
      const backend = runtimeStorageRegistration(f.storage),
        plan = (await backend.temporary!.candidates())[0]!,
        store = await f.store(accepted.threadId)
      const cleanupPlan = {
        ...plan,
        provider: {
          kind: "none" as const,
          installationId: f.storage.installationId,
          threadId: accepted.threadId,
          generation: plan.generation,
        },
      }
      await f.native.expireOwner(accepted.threadId)
      const expired = await f.native.scopeRecord(accepted.threadId)
      await expect(
        (store as BoundRuntimeStore).finalizeTemporary(cleanupPlan),
      ).rejects.toMatchObject({
        code: "stale_fence",
        message: "Runtime generation or ownership lease changed",
      })
      expect(await f.native.scopeRecord(accepted.threadId)).toEqual(expired)
      gate = f.native.pauseBindingCommit(accepted.threadId)
      opening = backend.openThread(accepted.threadId, false, plan.generation)
      const outcome = Promise.allSettled([opening])
      await Promise.race([
        gate.committed,
        outcome.then(() => {
          throw new Error("Expired selection finished before its actual COMMIT response barrier")
        }),
      ])
      // The original request committed and holds no native row/TX. A separate
      // normal request renews the actual unowned generation, once, legitimately.
      const renewed = await backend.openThread(accepted.threadId, false, plan.generation)
      expect(renewed).toBeDefined()
      if (mode === "gone") {
        expect(await backend.temporary!.finalize(cleanupPlan)).toBe(true)
        await f.admit(
          body({
            thread_id: accepted.threadId,
            if_not_exists: "create",
            on_completion: "keep",
            metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } },
          }),
        )
      }
      const beforeOriginal = await f.native.scopeRecord(accepted.threadId)
      gate.release()
      const resolved = await outcome
      opening = undefined
      if (mode === "gone") expect(resolved).toEqual([{ status: "fulfilled", value: undefined }])
      else
        expect(resolved).toMatchObject([
          {
            status: "rejected",
            reason: {
              code: "storage_unavailable",
              message: "Runtime scope changed during idle renewal; retry",
            },
          },
        ])
      expect(await f.native.scopeRecord(accepted.threadId)).toEqual(beforeOriginal)
    } catch (error) {
      primary = { error }
      throw error
    } finally {
      releasePreparation.resolve()
      gate?.release()
      const work = await Promise.allSettled([opening, host?.idle()])
      gate?.close()
      const closed = await Promise.allSettled([host?.close()])
      const fixtureClosed = await Promise.allSettled([f.close()])
      const errors = [...work, ...closed, ...fixtureClosed]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason)
      reportOwnedCleanup("Expired-idle native response barrier cleanup failed", errors, primary)
    }
  },
  30_000,
)
