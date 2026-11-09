import { CooperativeStopError } from "@b4run/sdk"
import { expect, it } from "vitest"
import { graphAdapter, workflowAdapter } from "../src/langgraph-adapter.ts"

it.each(["graph", "workflow"] as const)(
  "settles an opaque %s invocation at its awaited boundary",
  async (kind) => {
    let enter!: () => void,
      release!: () => void,
      effects = 0
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const hard = new AbortController(),
      soft = new AbortController()
    const reason = new CooperativeStopError("observed opaque Stop")
    const entry = async (_input: unknown, context: { stopSignal?: AbortSignal }) => {
      enter()
      await held
      effects++
      context.stopSignal?.throwIfAborted()
    }
    const result = (kind === "graph" ? graphAdapter : workflowAdapter).execute(
      entry,
      {},
      { signal: hard.signal, stopSignal: soft.signal },
    )
    const assertion = expect(result).rejects.toBe(reason)
    try {
      await entered
      soft.abort(reason)
      expect(hard.signal.aborted).toBe(false)
      expect(effects).toBe(0)
    } finally {
      release()
      await assertion
    }
    expect(effects).toBe(1)
  },
)
