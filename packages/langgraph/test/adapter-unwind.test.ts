import { ownRunnableExecution } from "@b4run/sdk/internal/execution-work"
import { Annotation, END, getWriter, START, StateGraph } from "@langchain/langgraph"
import { expect, it } from "vitest"
import { graphAdapter, workflowAdapter } from "../src/langgraph-adapter.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

it.each(["compiled-graph", "workflow"] as const)(
  "awaits actual authored work after abort (%s)",
  async (kind) => {
    const entered = deferred(),
      release = deferred(),
      controller = new AbortController()
    let effects = 0
    const node = async () => {
      entered.resolve()
      await release.promise
      effects++
      return { value: "done" }
    }
    const entry =
      kind === "compiled-graph"
        ? new StateGraph(Annotation.Root({ value: Annotation<string> }))
            .addNode("work", node)
            .addEdge(START, "work")
            .addEdge("work", END)
            .compile()
        : node
    const adapter = kind === "compiled-graph" ? graphAdapter : workflowAdapter
    const result = adapter.execute!(entry, { value: "start" }, { signal: controller.signal }).then(
      () => "fulfilled",
      () => "rejected",
    )
    try {
      await entered.promise
      controller.abort(new Error("controlled stop"))
      expect(
        await Promise.race([
          result,
          new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
        ]),
      ).toBe("held")
      expect(effects).toBe(0)
    } finally {
      release.resolve()
      await result
    }
    expect(effects).toBe(1)
  },
  30_000,
)

it.each(["stream", "streamEvents"] as const)(
  "preserves compiled graph %s callbacks, error identity and actual consumer-close drain",
  async (method) => {
    for (const outcome of ["close", "error"] as const) {
      const entered = deferred(),
        release = deferred(),
        fault = new Error("authored graph fault")
      let effects = 0,
        callbacks = 0
      const source = new StateGraph(Annotation.Root({ value: Annotation<string> }))
        .addNode("work", async () => {
          entered.resolve()
          getWriter()?.("started")
          await release.promise
          effects++
          if (outcome === "error") throw fault
          return { value: "done" }
        })
        .addEdge(START, "work")
        .addEdge("work", END)
        .compile()
      const invoke = source.invoke,
        stream = source.stream,
        events = source.streamEvents
      const owned = ownRunnableExecution(source).entry
      const config = {
        callbacks: [
          {
            name: "owned-graph-callback",
            handleChainStart() {
              callbacks++
            },
          },
        ],
      }
      const iterator = (
        method === "stream"
          ? await owned.stream({ value: "start" }, { ...config, streamMode: "custom" })
          : owned.streamEvents({ value: "start" }, { ...config, version: "v2" })
      )[Symbol.asyncIterator]()
      let completion: Promise<unknown> | undefined
      try {
        const first = await iterator.next()
        expect(first.done).toBe(false)
        await entered.promise
        if (outcome === "close") {
          completion = iterator.return!().then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          expect(
            await Promise.race([
              completion.then(() => "settled"),
              new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
            ]),
          ).toBe("held")
          expect(effects).toBe(0)
          release.resolve()
          await completion
        } else {
          completion = (async () => {
            while (!(await iterator.next()).done) {
              /* consume actual graph events */
            }
          })().then(
            () => undefined,
            (error: unknown) => error,
          )
          release.resolve()
          expect(await completion).toBe(fault)
        }
        expect(effects).toBe(1)
        expect(callbacks).toBeGreaterThan(0)
        expect(source.invoke).toBe(invoke)
        expect(source.stream).toBe(stream)
        expect(source.streamEvents).toBe(events)
      } finally {
        release.resolve()
        await completion
        await iterator.return?.()
      }
    }
  },
  30_000,
)
