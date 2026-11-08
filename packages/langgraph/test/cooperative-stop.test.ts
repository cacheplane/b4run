import { CooperativeStopError } from "@b4run/sdk"
import { Annotation, END, MemorySaver, RunControl, START, StateGraph } from "@langchain/langgraph"
import { expect, it } from "vitest"
import { graphAdapter, workflowAdapter } from "../src/langgraph-adapter.ts"

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const state = Annotation.Root({
  count: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
})

it("drains and retires a standalone native graph without advancing its next node", async () => {
  const entered = barrier(),
    held = barrier(),
    stop = new AbortController(),
    saver = new MemorySaver()
  let next = 0
  const graph = new StateGraph(state)
    .addNode("active", async () => {
      entered.release()
      await held.promise
      return { count: 1 }
    })
    .addNode("next", () => {
      next++
      return { count: 1 }
    })
    .addEdge(START, "active")
    .addEdge("active", "next")
    .addEdge("next", END)
    .compile({ checkpointer: saver })
    .withConfig({ configurable: { thread_id: "native" } })
  const result = graphAdapter
    .execute(graph, {}, { signal: new AbortController().signal, stopSignal: stop.signal })
    .catch((error) => error)
  await entered.promise
  stop.abort()
  held.release()
  expect(await result).toMatchObject({ name: "CooperativeStopError" })
  expect(next).toBe(0)
  expect((await graph.getState({ configurable: { thread_id: "native" } })).next).toEqual([])
})

it("preserves stateless graph execution and receiver", async () => {
  const graph = new StateGraph(state)
    .addNode("one", () => ({ count: 1 }))
    .addEdge(START, "one")
    .addEdge("one", END)
    .compile()
  await expect(
    graphAdapter.execute(
      graph,
      {},
      { signal: new AbortController().signal, stopSignal: new AbortController().signal },
    ),
  ).resolves.toEqual({ count: 1 })
})

it("gives an opaque workflow its context and lets its completed call win", async () => {
  const entered = barrier(),
    held = barrier(),
    stop = new AbortController(),
    hard = new AbortController()
  const context = { signal: hard.signal, stopSignal: stop.signal }
  const result = workflowAdapter.execute(
    async (_input: unknown, received: unknown) => {
      expect(received).toBe(context)
      entered.release()
      await held.promise
      return "natural"
    },
    {},
    context,
  )
  await entered.promise
  stop.abort()
  expect(hard.signal.aborted).toBe(false)
  held.release()
  await expect(result).resolves.toBe("natural")
})

it("propagates the owned Stop when an opaque workflow explicitly observes it", async () => {
  const entered = barrier(),
    held = barrier(),
    stop = new AbortController(),
    hard = new AbortController()
  const result = workflowAdapter.execute(
    async (_input: unknown, context: { readonly stopSignal?: AbortSignal }) => {
      entered.release()
      await held.promise
      context.stopSignal?.throwIfAborted()
      return "unreachable"
    },
    {},
    { signal: hard.signal, stopSignal: stop.signal },
  )
  const assertion = expect(result).rejects.toBeInstanceOf(CooperativeStopError)
  await entered.promise
  stop.abort(new CooperativeStopError())
  held.release()
  await assertion
  expect(hard.signal.aborted).toBe(false)
})

it("preserves an explicit standalone null continuation at a static breakpoint", async () => {
  let calls = 0
  const graph = new StateGraph(state)
    .addNode("one", () => {
      calls++
      return { count: 1 }
    })
    .addEdge(START, "one")
    .addEdge("one", END)
    .compile({ checkpointer: new MemorySaver(), interruptBefore: ["one"] })
    .withConfig({ configurable: { thread_id: "null-resume" } })
  await graph.invoke({})
  expect(calls).toBe(0)
  await graphAdapter.execute(graph, null, {
    signal: new AbortController().signal,
    stopSignal: new AbortController().signal,
  })
  expect(calls).toBe(1)
})

it("treats runtime null payload as fresh input rather than authorization to continue", async () => {
  let calls = 0
  const graph = new StateGraph(state)
    .addNode("one", () => {
      calls++
      return { count: 1 }
    })
    .addEdge(START, "one")
    .addEdge("one", END)
    .compile({ checkpointer: new MemorySaver(), interruptBefore: ["one"] })
    .withConfig({ configurable: { thread_id: "null-fresh" } })
  await graph.invoke({})
  const context = {
    signal: new AbortController().signal,
    stopSignal: new AbortController().signal,
    __b4_fresh_turn: true,
  }
  await graphAdapter.execute(graph, null, context)
  expect(calls).toBe(0)
  expect((await graph.getState({ configurable: { thread_id: "null-fresh" } })).next).toEqual([])
})

it("preserves a configured native RunControl when no managed Stop context is supplied", async () => {
  let calls = 0
  const control = new RunControl()
  control.requestDrain("caller drain")
  const graph = new StateGraph(state)
    .addNode("one", () => {
      calls++
      return { count: 1 }
    })
    .addEdge(START, "one")
    .addEdge("one", END)
    .compile()
    .withConfig({ control })
  await expect(
    graphAdapter.execute(graph, {}, { signal: new AbortController().signal }),
  ).rejects.toMatchObject({ name: "GraphDrained" })
  expect(calls).toBe(0)
})
