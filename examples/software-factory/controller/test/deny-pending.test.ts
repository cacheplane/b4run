import { describe, expect, it } from "vitest"
import type { ControllerContext } from "../src/lib/controller/context.ts"
import { denyPending } from "../src/lib/controller/run-observer.ts"
import type { CancelResult } from "../src/lib/worker/client.ts"
import type { StreamFrame } from "../src/lib/worker/wire.ts"

/**
 * `denyPending({ cancel: true })`, which `retry` uses to abandon a parked builder thread: the
 * resumed stream is closed through its own signal whatever happens, drained only when the
 * cancel interrupted a run, and never waited on when the cancel found none.
 */
function harness(cancel: CancelResult) {
  const seen: { signal?: AbortSignal; drained: boolean; events: string[] } = {
    drained: false,
    events: [],
  }
  /** A resumed turn that ends only when its signal is aborted, unless it was interrupted. */
  async function* frames(signal: AbortSignal): AsyncGenerator<StreamFrame> {
    if (cancel === "interrupted") {
      seen.drained = true
      yield { event: "done", data: { output: { cancelled: true } } }
      return
    }
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()))
    seen.drained = true
  }
  const ctx = {
    signal: new AbortController().signal,
    mustGet: () => ({ id: "wo-1", workerThreadId: "t-1" }),
    recordEvent: (_id: string, type: string) => seen.events.push(type),
    workerOfThread: () => ({
      route: "/build#agent",
      client: {
        pendingInterrupts: async () => [{ interruptId: "i-1", kind: "command" }],
        resume: async (_t: string, _r: string, _res: unknown, signal: AbortSignal) => {
          seen.signal = signal
          return frames(signal)
        },
        cancel: async () => cancel,
      },
    }),
  } as unknown as ControllerContext
  return { ctx, seen }
}

describe("denyPending with cancel", () => {
  it("does not wait on the resumed turn when the cancel finds no run, and closes its stream", async () => {
    const { ctx, seen } = harness("no_run_in_flight")
    // The resumed stream here never ends by itself: awaiting it would hang the test.
    await denyPending(ctx, "wo-1", { cancel: true })
    expect(seen.events).toEqual(["pending_denied", "worker_cancel"])
    expect(seen.drained).toBe(false)
    expect(seen.signal?.aborted).toBe(true)
  })

  it("drains the cancelled turn's last frames when the cancel interrupted a run, then closes", async () => {
    const { ctx, seen } = harness("interrupted")
    await denyPending(ctx, "wo-1", { cancel: true })
    expect(seen.drained).toBe(true)
    expect(seen.events).toEqual(["pending_denied", "worker_cancel"])
    expect(seen.signal?.aborted).toBe(true)
  })
})
