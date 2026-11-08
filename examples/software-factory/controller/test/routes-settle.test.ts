import { CooperativeStopError } from "@b4run/sdk"
import { expect, it, vi } from "vitest"
import type { Factory } from "../src/lib/controller/factory.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { type SettleOptions, settleOutcome, withRuntimeStop } from "../src/lib/routes/settle.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const row = (state: WorkOrderRow["state"]) => ({ state, maxActiveMs: 1_000 }) as WorkOrderRow
const options: SettleOptions = {
  abortKey: "cancel:owned:stop",
  what: "Dispatch",
  success: (r) => r.state === "awaiting_approval",
  message: () => "Settled",
}

function fixture() {
  const execution = deferred<WorkOrderRow>()
  const cancellation = deferred<Awaited<ReturnType<Factory["cancel"]>>>()
  const cancel = vi.fn(() => cancellation.promise)
  const factory = {
    show: () => row("running"),
    settle: () => execution.promise,
    cancel,
  } as unknown as Factory
  return { execution, cancellation, cancel, factory, controller: new AbortController() }
}

it("waits for its triggered domain cancellation after the work-order settle resolves", async () => {
  const f = fixture()
  const pending = settleOutcome(f.factory, "owned", f.controller.signal, options)
  let settled = false
  void pending.then(() => {
    settled = true
  })
  f.controller.abort()
  expect(f.cancel).toHaveBeenCalledOnce()
  f.execution.resolve(row("cancelled"))
  await new Promise((resolve) => setTimeout(resolve, 0))
  try {
    expect(settled).toBe(false)
  } finally {
    f.cancellation.resolve({ ok: true, message: "Cancelled", state: "cancelled" })
  }
  expect(await pending).toMatchObject({ state: "cancelled" })
})

it("surfaces an independent cancellation cleanup failure", async () => {
  const f = fixture()
  const pending = settleOutcome(f.factory, "owned", f.controller.signal, options)
  f.controller.abort()
  const error = new Error("domain cancel storage failed")
  f.cancellation.reject(error)
  f.execution.resolve(row("cancelled"))
  await expect(pending).rejects.toBe(error)
})

it("preserves an independently returned failure when cancellation cleanup also fails", async () => {
  const f = fixture()
  const pending = settleOutcome(f.factory, "owned", f.controller.signal, options)
  f.controller.abort()
  f.cancellation.reject(new Error("secondary cancel failure"))
  f.execution.resolve(row("blocked"))
  expect(await pending).toMatchObject({ ok: false, state: "blocked" })
})

it("preserves an independent thrown error when cancellation cleanup also fails", async () => {
  const f = fixture()
  const error = new Error("primary outcome failure")
  const pending = settleOutcome(f.factory, "owned", f.controller.signal, {
    ...options,
    success: () => {
      throw error
    },
  })
  f.controller.abort()
  f.cancellation.reject(new Error("secondary cancel failure"))
  f.execution.resolve(row("cancelled"))
  await expect(pending).rejects.toBe(error)
})

it("does not cancel work that already settled before a late Stop request", async () => {
  const f = fixture()
  const pending = settleOutcome(f.factory, "owned", f.controller.signal, options)
  f.execution.resolve(row("awaiting_approval"))
  expect(await pending).toMatchObject({ ok: true, state: "awaiting_approval" })
  f.controller.abort()
  expect(f.cancel).not.toHaveBeenCalled()
})

it("handles a signal already aborted when settlement takes ownership", async () => {
  const f = fixture()
  f.controller.abort()
  const pending = settleOutcome(f.factory, "owned", f.controller.signal, options)
  try {
    expect(f.cancel).toHaveBeenCalledOnce()
  } finally {
    f.execution.resolve(row("cancelled"))
    f.cancellation.resolve({ ok: true, message: "Cancelled", state: "cancelled" })
    await pending
  }
})

it("observes an owned soft Stop only after its app operation returns cancellation", async () => {
  const hard = new AbortController()
  const stop = new AbortController()
  const held = deferred<void>()
  const reason = new CooperativeStopError("operator Stop")
  let operationSignal: AbortSignal | undefined
  const pending = withRuntimeStop(
    { signal: hard.signal, stopSignal: stop.signal },
    async (signal, observeStop) => {
      operationSignal = signal
      await held.promise
      observeStop()
      return { ok: false, state: "cancelled", message: "Cancelled" }
    },
  )
  let settled = false
  void pending.catch(() => {
    settled = true
  })
  stop.abort(reason)
  expect(operationSignal?.aborted).toBe(true)
  expect(hard.signal.aborted).toBe(false)
  expect(settled).toBe(false)
  held.resolve()
  await expect(pending).rejects.toBe(reason)
})

it("keeps independent returned failures when Stop was also requested", async () => {
  const stop = new AbortController()
  const failure = {
    ok: false,
    state: "cancelled" as const,
    message: "Independent verifier failure",
  }
  expect(
    await withRuntimeStop(
      { signal: new AbortController().signal, stopSignal: stop.signal },
      async () => {
        stop.abort(new CooperativeStopError())
        return failure
      },
    ),
  ).toBe(failure)
})

it("keeps an independent thrown error when Stop was also requested", async () => {
  const stop = new AbortController()
  const error = new Error("Independent image failure")
  await expect(
    withRuntimeStop({ signal: new AbortController().signal, stopSignal: stop.signal }, async () => {
      stop.abort(new CooperativeStopError())
      throw error
    }),
  ).rejects.toBe(error)
})

it("lets natural completion win when its outcome is not domain cancellation", async () => {
  const stop = new AbortController()
  const outcome = { ok: true, state: "awaiting_approval" as const, message: "Settled" }
  expect(
    await withRuntimeStop(
      { signal: new AbortController().signal, stopSignal: stop.signal },
      async () => {
        stop.abort(new CooperativeStopError())
        return outcome
      },
    ),
  ).toBe(outcome)
})

it("preserves the caller's hard signal when no soft Stop context is present", async () => {
  const hard = new AbortController()
  await withRuntimeStop({ signal: hard.signal }, async (signal) => {
    expect(signal).toBe(hard.signal)
    return { ok: true, message: "Settled" }
  })
})

it("preserves an already-aborted hard reason before a pre-stopped soft request", async () => {
  const hard = new AbortController()
  const stop = new AbortController()
  const reason = new Error("hard shutdown")
  hard.abort(reason)
  stop.abort(new CooperativeStopError())
  const operation = vi.fn()
  await expect(
    withRuntimeStop({ signal: hard.signal, stopSignal: stop.signal }, operation),
  ).rejects.toBe(reason)
  expect(operation).not.toHaveBeenCalled()
})

it("does not observe soft Stop after an independent settlement failure, even on a cancelled row", async () => {
  const f = fixture()
  const observeStop = vi.fn(() => {
    throw new CooperativeStopError()
  })
  f.factory.show = () => row("cancelled")
  const pending = settleOutcome(f.factory, "owned", f.controller.signal, options, observeStop)
  f.controller.abort()
  f.cancellation.reject(new Error("secondary cancel failure"))
  f.execution.reject(new Error("primary settlement failure"))
  expect(await pending).toMatchObject({
    ok: false,
    state: "cancelled",
    message: expect.stringContaining("primary settlement failure"),
  })
  expect(observeStop).not.toHaveBeenCalled()
})

it("does not infer an owned Stop from a previously cancelled row", async () => {
  const f = fixture()
  const observeStop = vi.fn()
  const pending = settleOutcome(f.factory, "owned", f.controller.signal, options, observeStop)
  f.execution.resolve(row("cancelled"))
  expect(await pending).toMatchObject({ state: "cancelled" })
  expect(f.cancel).not.toHaveBeenCalled()
  expect(observeStop).not.toHaveBeenCalled()
})
