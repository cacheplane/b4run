import { RunnableLambda } from "@langchain/core/runnables"
import { expect, it } from "vitest"
import { chainAdapter } from "../src/chain-adapter.ts"

it("allows an active opaque chain to settle naturally after soft Stop", async () => {
  let enter!: () => void,
    release!: () => void,
    effects = 0
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const entry = RunnableLambda.from(async () => {
    enter()
    await blocked
    effects++
    return "done"
  })
  const controller = new AbortController(),
    stop = new AbortController()
  const result = chainAdapter
    .execute(entry, "start", {
      signal: controller.signal,
      stopSignal: stop.signal,
    })
    .then(
      () => "fulfilled",
      () => "rejected",
    )
  try {
    await entered
    stop.abort()
    expect(controller.signal.aborted).toBe(false)
    expect(
      await Promise.race([
        result,
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
      ]),
    ).toBe("held")
    expect(effects).toBe(0)
  } finally {
    release()
    await result
  }
  expect(effects).toBe(1)
}, 30_000)
