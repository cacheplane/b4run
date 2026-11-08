import { AIMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  MessagesAnnotation,
  RunControl,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { streamAgent } from "../src/agent-adapter.ts"
import { chainAdapter } from "../src/chain-adapter.ts"

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

describe("cooperative Stop with native LangGraph", () => {
  it("settles the active superstep without aborting it or starting the next", async () => {
    const entered = barrier(),
      held = barrier()
    const hard = new AbortController(),
      stop = new AbortController()
    let next = 0,
      cleaned = false,
      settled = false
    const graph = new StateGraph(state)
      .addNode("active", async () => {
        entered.release()
        try {
          await held.promise
          return { count: 1 }
        } finally {
          cleaned = true
        }
      })
      .addNode("next", () => {
        next++
        return { count: 1 }
      })
      .addEdge(START, "active")
      .addEdge("active", "next")
      .addEdge("next", END)
      .compile()
    const result = chainAdapter
      .execute(graph, { count: 0 }, { signal: hard.signal, stopSignal: stop.signal })
      .then(
        () => {
          settled = true
          return undefined
        },
        (error) => {
          settled = true
          return error
        },
      )
    await entered.promise
    stop.abort(new Error("Stop"))
    await new Promise((resolve) => setImmediate(resolve))
    expect(hard.signal.aborted).toBe(false)
    expect(settled).toBe(false)
    expect(cleaned).toBe(false)
    held.release()
    expect(await result).toMatchObject({ name: "CooperativeStopError" })
    expect(cleaned).toBe(true)
    expect(next).toBe(0)
  })

  it("a pre-stopped graph dispatches no node", async () => {
    let calls = 0
    const graph = new StateGraph(state)
      .addNode("one", () => {
        calls++
        return { count: 1 }
      })
      .addEdge(START, "one")
      .addEdge("one", END)
      .compile()
    const stop = new AbortController()
    stop.abort()
    await expect(
      chainAdapter.execute(
        graph,
        {},
        { signal: new AbortController().signal, stopSignal: stop.signal },
      ),
    ).rejects.toMatchObject({ name: "CooperativeStopError" })
    expect(calls).toBe(0)
  })

  it("a naturally final superstep can win against Stop", async () => {
    const entered = barrier(),
      held = barrier(),
      stop = new AbortController()
    const graph = new StateGraph(state)
      .addNode("one", async () => {
        entered.release()
        await held.promise
        return { count: 1 }
      })
      .addEdge(START, "one")
      .addEdge("one", END)
      .compile()
    const result = chainAdapter.execute(
      graph,
      {},
      { signal: new AbortController().signal, stopSignal: stop.signal },
    )
    await entered.promise
    stop.abort()
    held.release()
    await expect(result).resolves.toEqual({ count: 1 })
  })

  it("does not turn an independent node failure into a stopped turn", async () => {
    const entered = barrier(),
      held = barrier(),
      stop = new AbortController()
    const graph = new StateGraph(state)
      .addNode("one", async () => {
        entered.release()
        await held.promise
        throw new Error("independent failure")
      })
      .addEdge(START, "one")
      .addEdge("one", END)
      .compile()
    const result = chainAdapter.execute(
      graph,
      {},
      { signal: new AbortController().signal, stopSignal: stop.signal },
    )
    const assertion = expect(result).rejects.toThrow("independent failure")
    await entered.promise
    stop.abort()
    held.release()
    await assertion
  })

  it("retires model-planned tools and starts fresh input without replaying them", async () => {
    const entered = barrier(),
      held = barrier(),
      stop = new AbortController(),
      saver = new MemorySaver()
    let oldTools = 0,
      models = 0
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("model", async (value) => {
        models++
        if (value.messages.at(-1)?.content === "old") {
          entered.release()
          await held.promise
          return {
            messages: [
              new AIMessage({
                content: "",
                tool_calls: [{ name: "oldTool", id: "old-call", args: {} }],
              }),
            ],
          }
        }
        return { messages: [new AIMessage("fresh answer")] }
      })
      .addNode("oldTool", () => {
        oldTools++
        return { messages: [] }
      })
      .addEdge(START, "model")
      .addConditionalEdges("model", (value) =>
        (value.messages.at(-1) as AIMessage).tool_calls?.length ? "oldTool" : END,
      )
      .addEdge("oldTool", END)
      .compile({ checkpointer: saver })
    const consume = async (content: string, signal?: AbortSignal) => {
      for await (const _ of streamAgent({
        checkpointer: saver,
        entry: graph,
        input: { messages: [{ role: "user", content }] },
        routeParamNames: [],
        tools: [],
        signal: new AbortController().signal,
        ...(signal ? { stopSignal: signal } : {}),
        threadId: "fresh",
      })) {
      }
    }
    const first = consume("old", stop.signal).catch((error) => error)
    await entered.promise
    stop.abort()
    held.release()
    expect((await first)?.name).toBe("CooperativeStopError")
    expect((await graph.getState({ configurable: { thread_id: "fresh" } })).next).toEqual([])
    await consume("fresh")
    expect(oldTools).toBe(0)
    expect(models).toBe(2)
  })
})

it.each(["put", "putWrites"])("preserves a raw graph %s error racing Stop", async (method) => {
  const entered = barrier(),
    held = barrier(),
    stop = new AbortController()
  class FailingSaver extends MemorySaver {
    override async put(...args: Parameters<MemorySaver["put"]>) {
      if (method === "put" && args[1].channel_values.count === 1)
        throw new Error("independent checkpoint failure")
      return super.put(...args)
    }
    override async putWrites(...args: Parameters<MemorySaver["putWrites"]>) {
      if (
        method === "putWrites" &&
        args[1].some(([channel, value]) => channel === "count" && value === 1)
      )
        throw new Error("independent checkpoint failure")
      return super.putWrites(...args)
    }
  }
  const graph = new StateGraph(state)
    .addNode("active", async () => {
      entered.release()
      await held.promise
      return { count: 1 }
    })
    .addNode("next", () => ({ count: 1 }))
    .addEdge(START, "active")
    .addEdge("active", "next")
    .addEdge("next", END)
    .compile({ checkpointer: new FailingSaver() })
  // The graph owns its saver; no shared-instance mutation is needed.
  const configured = graph.withConfig({ configurable: { thread_id: "write-failure" } })
  const result = chainAdapter.execute(
    configured,
    {},
    { signal: new AbortController().signal, stopSignal: stop.signal },
  )
  const assertion = expect(result).rejects.toThrow("independent checkpoint failure")
  await entered.promise
  stop.abort()
  held.release()
  await assertion
})

it("holds parallel raw Core factory tools and nested work inside the active parent step", async () => {
  const entered = barrier(),
    held = barrier(),
    stop = new AbortController(),
    saver = new MemorySaver()
  let started = 0,
    finished = 0,
    parentNext = 0,
    nestedCalls = 0
  const nested = new StateGraph(state)
    .addNode("first", () => {
      nestedCalls++
      return { count: 1 }
    })
    .addNode("second", () => {
      nestedCalls++
      return { count: 1 }
    })
    .addEdge(START, "first")
    .addEdge("first", "second")
    .addEdge("second", END)
    .compile()
  const raw = (name: string) =>
    tool(
      async (_input, config) => {
        expect(config.signal?.aborted).toBe(false)
        // Core's ambient config drops top-level RunControl. Its awaited nested
        // work is part of this parent superstep and is allowed to finish.
        if (++started === 2) entered.release()
        try {
          await held.promise
          await nested.invoke({})
          return "settled"
        } finally {
          finished++
        }
      },
      { name, description: "held raw tool", schema: z.object({}) },
    )
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("model", () => ({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { name: "a", id: "a", args: {} },
            { name: "b", id: "b", args: {} },
          ],
        }),
      ],
    }))
    .addNode("tools", new ToolNode([raw("a"), raw("b")]))
    .addNode("next", () => {
      parentNext++
      return { messages: [] }
    })
    .addEdge(START, "model")
    .addEdge("model", "tools")
    .addEdge("tools", "next")
    .addEdge("next", END)
    .compile({ checkpointer: saver })
  let settled = false
  const result = (async () => {
    for await (const _ of streamAgent({
      checkpointer: saver,
      entry: graph,
      input: { messages: [{ role: "user", content: "tools" }] },
      routeParamNames: [],
      tools: [],
      threadId: "parallel",
      signal: new AbortController().signal,
      stopSignal: stop.signal,
    })) {
    }
  })().then(
    () => {
      settled = true
      return undefined
    },
    (error) => {
      settled = true
      return error
    },
  )
  await entered.promise
  stop.abort()
  await new Promise((resolve) => setImmediate(resolve))
  expect(settled).toBe(false)
  expect(finished).toBe(0)
  held.release()
  expect(await result).toMatchObject({ name: "CooperativeStopError" })
  expect(finished).toBe(2)
  expect(nestedCalls).toBe(4)
  expect(parentNext).toBe(0)
})

it("never retires a live permission park and forwards authorized Command resume", async () => {
  const saver = new MemorySaver()
  let allowed = 0
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("permission", () => {
      const decision = interrupt({ type: "permission-request", interruptId: "owned" })
      if (decision === "once") allowed++
      return { messages: [new AIMessage("approved")] }
    })
    .addEdge(START, "permission")
    .addEdge("permission", END)
    .compile({ checkpointer: saver })
  const consume = async (input: unknown) => {
    const chunks = []
    for await (const chunk of streamAgent({
      checkpointer: saver,
      entry: graph,
      input,
      routeParamNames: [],
      tools: [],
      threadId: "park",
      signal: new AbortController().signal,
    }))
      chunks.push(chunk)
    return chunks
  }
  await consume({ messages: [{ role: "user", content: "park" }] })
  await expect(consume({ messages: [{ role: "user", content: "fresh" }] })).rejects.toThrow(
    "authorized resume",
  )
  expect(allowed).toBe(0)
  expect(
    (await graph.getState({ configurable: { thread_id: "park" } })).tasks[0]?.interrupts.length,
  ).toBe(1)
  await consume(new Command({ resume: "once" }))
  expect(allowed).toBe(1)
})

it("retires a standalone checkpointed chain's drained tasks without executing them", async () => {
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
    .withConfig({ configurable: { thread_id: "standalone" } })
  const result = chainAdapter
    .execute(graph, {}, { signal: new AbortController().signal, stopSignal: stop.signal })
    .catch((error) => error)
  await entered.promise
  stop.abort()
  held.release()
  expect(await result).toMatchObject({ name: "CooperativeStopError" })
  expect((await graph.getState({ configurable: { thread_id: "standalone" } })).next).toEqual([])
  expect(next).toBe(0)
})

it.each([false, true])(
  "materialized B4 agent settles its tool and checkpoint before Stop (write failure: %s)",
  async (failWrite) => {
    const { agent } = await import("@b4run/sdk")
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { seedModelImporter } = await import("../src/chat-model-factory.ts")
    const entered = barrier(),
      held = barrier(),
      writeEntered = barrier(),
      writeHeld = barrier(),
      stop = new AbortController()
    let models = 0,
      toolFinished = false,
      settled = false
    class ScriptedModel extends BaseChatModel {
      constructor() {
        super({})
      }
      _llmType() {
        return "scripted-stop-model"
      }
      bindTools() {
        return this
      }
      async _generate() {
        models++
        const message =
          models === 1
            ? new AIMessage({
                content: "",
                tool_calls: [{ name: "work", id: "work-call", args: {} }],
              })
            : new AIMessage("fresh answer")
        return { generations: [{ text: "", message }] }
      }
    }
    seedModelImporter(async () => ({ ChatOpenAI: ScriptedModel }))
    class HeldSaver extends MemorySaver {
      override async put(...args: Parameters<MemorySaver["put"]>) {
        if (toolFinished) {
          writeEntered.release()
          await writeHeld.promise
          if (failWrite) throw new Error("materialized checkpoint failure")
        }
        return super.put(...args)
      }
    }
    const saver = new HeldSaver(),
      entry = agent({ model: "gpt-5-mini", systemPrompt: "Complete one task." })
    const options = {
      checkpointer: saver,
      entry,
      routeParamNames: [],
      tools: [
        {
          name: "work",
          schema: { type: "object", properties: {} },
          run: async (_input: unknown, context: { readonly signal: AbortSignal }) => {
            entered.release()
            try {
              await held.promise
              expect(context.signal.aborted).toBe(false)
              return "finished"
            } finally {
              toolFinished = true
            }
          },
        },
      ],
      threadId: "materialized",
      signal: new AbortController().signal,
    }
    const consume = async (stopSignal?: AbortSignal) => {
      for await (const _ of streamAgent({
        ...options,
        input: { messages: [{ role: "user", content: "fresh" }] },
        ...(stopSignal ? { stopSignal } : {}),
      })) {
      }
    }
    const result = consume(stop.signal).then(
      () => {
        settled = true
        return undefined
      },
      (error) => {
        settled = true
        return error
      },
    )
    await Promise.race([
      entered.promise,
      result.then((error) => {
        throw error ?? new Error("run settled before tool")
      }),
    ])
    stop.abort()
    held.release()
    await Promise.race([
      writeEntered.promise,
      result.then((error) => {
        throw error ?? new Error("run settled before checkpoint")
      }),
    ])
    expect(toolFinished).toBe(true)
    expect(settled).toBe(false)
    expect(models).toBe(1)
    writeHeld.release()
    const error = await result
    expect(error?.message).toBe(failWrite ? "materialized checkpoint failure" : "Run stopped")
    if (!failWrite) {
      await consume()
      expect(models).toBe(2)
    }
  },
)

it("keeps an already-aborted explicit hard signal distinct from Stop", async () => {
  const hard = new AbortController(),
    stop = new AbortController()
  hard.abort(new Error("hard shutdown"))
  stop.abort()
  const graph = new StateGraph(state)
    .addNode("one", () => ({ count: 1 }))
    .addEdge(START, "one")
    .addEdge("one", END)
    .compile()
  await expect(
    chainAdapter.execute(graph, {}, { signal: hard.signal, stopSignal: stop.signal }),
  ).rejects.toThrow("hard shutdown")
})

it("fails closed before fresh model/tool code when retirement cannot persist", async () => {
  const entered = barrier(),
    held = barrier(),
    stop = new AbortController()
  let models = 0,
    tools = 0,
    refuse = true
  class RetirementFailureSaver extends MemorySaver {
    override async put(...args: Parameters<MemorySaver["put"]>) {
      if (refuse && args[2].source === "update") throw new Error("retirement failed")
      return super.put(...args)
    }
  }
  const saver = new RetirementFailureSaver()
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("model", async () => {
      models++
      if (models === 1) {
        entered.release()
        await held.promise
        return {
          messages: [
            new AIMessage({ content: "", tool_calls: [{ name: "old", id: "old", args: {} }] }),
          ],
        }
      }
      return { messages: [new AIMessage("fresh")] }
    })
    .addNode("old", () => {
      tools++
      return { messages: [] }
    })
    .addEdge(START, "model")
    .addConditionalEdges("model", (value) =>
      (value.messages.at(-1) as AIMessage).tool_calls?.length ? "old" : END,
    )
    .addEdge("old", END)
    .compile({ checkpointer: saver })
  const consume = async (stopSignal?: AbortSignal) => {
    for await (const _ of streamAgent({
      checkpointer: saver,
      entry: graph,
      input: { messages: [{ role: "user", content: "fresh" }] },
      routeParamNames: [],
      tools: [],
      threadId: "retire-failure",
      signal: new AbortController().signal,
      ...(stopSignal ? { stopSignal } : {}),
    })) {
    }
  }
  const first = consume(stop.signal).catch((error) => error)
  await entered.promise
  stop.abort()
  held.release()
  expect((await first)?.message).toBe("retirement failed")
  await expect(consume()).rejects.toThrow("retirement failed")
  expect(models).toBe(1)
  expect(tools).toBe(0)
  refuse = false
  await consume()
  expect(models).toBe(2)
  expect(tools).toBe(0)
})

it("retains uncertainty about partial nested execution without replaying old child actions", async () => {
  const entered = barrier(),
    held = barrier(),
    stop = new AbortController(),
    saver = new MemorySaver()
  let first = 0,
    second = 0,
    models = 0
  const child = new StateGraph(state)
    .addNode("first", async () => {
      first++
      entered.release()
      await held.promise
      return { count: 1 }
    })
    .addNode("second", () => {
      second++
      return { count: 1 }
    })
    .addEdge(START, "first")
    .addEdge("first", "second")
    .addEdge("second", END)
    .compile({ checkpointer: true })
  const root = new StateGraph(MessagesAnnotation)
    .addNode("model", () => {
      models++
      return {
        messages: [
          models === 1
            ? new AIMessage({
                content: "",
                tool_calls: [{ name: "child", id: "partial-child", args: {} }],
              })
            : new AIMessage("fresh"),
        ],
      }
    })
    .addNode("child", async (_value, config) => {
      await child.invoke({}, config)
      return { messages: [] }
    })
    .addEdge(START, "model")
    .addConditionalEdges("model", (value) =>
      (value.messages.at(-1) as AIMessage).tool_calls?.length ? "child" : END,
    )
    .addEdge("child", END)
    .compile({ checkpointer: saver })
  const consume = async (stopSignal?: AbortSignal) => {
    for await (const _ of streamAgent({
      checkpointer: saver,
      entry: root,
      input: { messages: [{ role: "user", content: "fresh" }] },
      routeParamNames: [],
      tools: [],
      threadId: "partial",
      signal: new AbortController().signal,
      ...(stopSignal ? { stopSignal } : {}),
    })) {
    }
  }
  const firstTurn = consume(stop.signal).catch((error) => error)
  await entered.promise
  stop.abort()
  held.release()
  expect((await firstTurn)?.name).toBe("CooperativeStopError")
  expect(first).toBe(1)
  expect(second).toBe(0)
  await consume()
  expect(first).toBe(1)
  expect(second).toBe(0)
  expect(models).toBe(2)
  const history = []
  for await (const tuple of saver.list({ configurable: { thread_id: "partial" } }))
    history.push(tuple)
  expect(history.some((tuple) => tuple.checkpoint.channel_values.count === 1)).toBe(true)
  const { answerDanglingToolCalls } = await import("../src/agent-middleware.ts")
  const repaired = answerDanglingToolCalls([
    new AIMessage({ content: "", tool_calls: [{ name: "child", id: "partial-child", args: {} }] }),
  ])
  expect(String(repaired.at(-1)?.content)).toContain("execution and effects are unknown")
  expect(String(repaired.at(-1)?.content)).not.toContain("did not run")
})

it("keeps an already-aborted hard signal distinct on streaming agent invocation", async () => {
  const hard = new AbortController(),
    stop = new AbortController()
  hard.abort(new Error("hard agent shutdown"))
  stop.abort()
  let calls = 0
  const consume = async () => {
    for await (const _ of streamAgent({
      checkpointer: new MemorySaver(),
      entry: {
        invoke: async () => {
          calls++
          return {}
        },
      },
      input: {},
      tools: [],
      routeParamNames: [],
      signal: hard.signal,
      stopSignal: stop.signal,
    })) {
    }
  }
  await expect(consume()).rejects.toThrow("hard agent shutdown")
  expect(calls).toBe(0)
})

it("fails closed for an unsupported pending-head rebinding profile", async () => {
  let invokes = 0,
    updates = 0
  const entry = {
    getState: async () => ({ next: ["old"] }),
    updateState: async () => {
      updates++
    },
    invoke: async () => {
      invokes++
    },
  }
  await expect(
    chainAdapter.execute(entry, {}, { signal: new AbortController().signal }),
  ).rejects.toThrow("safely retire")
  expect(invokes).toBe(0)
  expect(updates).toBe(0)
})

it.each(["execute", "stream"] as const)(
  "preserves a caller RunControl without managed Stop (%s)",
  async (mode) => {
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
    const result =
      mode === "execute"
        ? chainAdapter.execute(graph, {}, { signal: new AbortController().signal })
        : (async () => {
            for await (const _ of chainAdapter.stream(
              graph,
              {},
              { signal: new AbortController().signal },
            )) {
            }
          })()
    await expect(result).rejects.toMatchObject({ name: "GraphDrained" })
    expect(calls).toBe(0)
  },
)

it("keeps a raw agent caller's native drain checkpoint resumable without managed Stop", async () => {
  const saver = new MemorySaver(),
    control = new RunControl()
  control.requestDrain("caller drain")
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("one", () => ({ messages: [new AIMessage("one")] }))
    .addEdge(START, "one")
    .addEdge("one", END)
    .compile({ checkpointer: saver })
    .withConfig({ control })
  const consume = async () => {
    for await (const _ of streamAgent({
      checkpointer: saver,
      entry: graph,
      input: { messages: [{ role: "user", content: "wait" }] },
      tools: [],
      routeParamNames: [],
      threadId: "caller-control",
      signal: new AbortController().signal,
    })) {
    }
  }
  await expect(consume()).rejects.toMatchObject({ name: "GraphDrained" })
  expect((await graph.getState({ configurable: { thread_id: "caller-control" } })).next).toEqual([
    START,
  ])
  const resumed = await graph
    .withConfig({ control: new RunControl() })
    .invoke(null, { configurable: { thread_id: "caller-control" } })
  expect(resumed.messages.at(-1)?.content).toBe("one")
})
