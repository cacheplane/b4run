import { CLIENT_TOOL_RECORDER_KEY, type ToolDisplay } from "@b4run/sdk"
import { AIMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import {
  Annotation,
  Command,
  END,
  GraphInterrupt,
  type Interrupt,
  interrupt,
  isGraphInterrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  convertSubagentTaskToLangChain,
  type ResolvedSubagentGraph,
  type SubagentResolver,
} from "../src/subagent-tool-bridge.js"

const taskPlaceholder = {
  name: "task",
  description: "Delegate to a subagent.",
  schema: z.object({ subagent: z.string(), input: z.string() }),
  run: vi.fn(),
}

function childResult(text: string): { messages: AIMessage[] } {
  return { messages: [new AIMessage(text)] }
}

function allowedChild(
  graph: ResolvedSubagentGraph["graph"],
  routeId = "/parent/subagents/researcher",
): Awaited<ReturnType<SubagentResolver>> {
  return { ok: true, child: { routeId, routeKey: `${routeId}#agent`, graph } }
}

describe("convertSubagentTaskToLangChain", () => {
  it("passes the exact live config and task call id, then appends B4.run depth and stack metadata", async () => {
    let childConfig: RunnableConfig | undefined
    const child = {
      invoke: vi.fn(async (_input: unknown, config: RunnableConfig) => {
        childConfig = config
        return childResult("Final answer from child.")
      }),
    }
    const resolver = vi.fn<SubagentResolver>(async () => allowedChild(child))
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)
    const signal = new AbortController().signal
    const callbacks: RunnableConfig["callbacks"] = []
    const tags = ["live-parent"]
    const parentStack = [
      { callId: "outer", name: "planner", routeId: "/planner", routeKey: "/planner#agent" },
    ]
    const config = {
      callbacks,
      configurable: { checkpoint_ns: "parent:1", thread_id: "thread-1" },
      metadata: {
        tenant: "acme",
        b4: { root_sandbox_key: "sandbox-1", subagent_depth: 1, subagent_stack: parentStack },
      },
      signal,
      tags,
      toolCall: { args: {}, id: "task-live-1", name: "task", type: "tool_call" },
    } as RunnableConfig & { toolCall: { id: string } }

    const result = await tool.func(
      { subagent: "researcher", input: "Inspect the evidence" },
      undefined,
      config,
    )

    expect(result).toBe("Final answer from child.")
    expect(resolver).toHaveBeenCalledWith({
      callId: "task-live-1",
      name: "researcher",
      input: "Inspect the evidence",
      config,
    })
    expect(child.invoke).toHaveBeenCalledWith(
      { messages: [{ role: "user", content: "Inspect the evidence" }] },
      expect.any(Object),
    )
    expect(childConfig?.callbacks).toBe(callbacks)
    expect(childConfig?.configurable).toBe(config.configurable)
    expect(childConfig?.signal).toBe(signal)
    expect(childConfig?.tags).toBe(tags)
    expect(childConfig?.metadata).toEqual({
      tenant: "acme",
      b4: {
        root_sandbox_key: "sandbox-1",
        subagent_depth: 2,
        subagent_stack: [
          ...parentStack,
          {
            callId: "task-live-1",
            name: "researcher",
            routeId: "/parent/subagents/researcher",
            routeKey: "/parent/subagents/researcher#agent",
          },
        ],
      },
    })
  })

  it("returns a coded E5003 result without resolving or invoking a child beyond depth three", async () => {
    const resolver = vi.fn<SubagentResolver>()
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)
    const result = await tool.func({ subagent: "researcher", input: "Go deeper" }, undefined, {
      metadata: { b4: { subagent_depth: 3 } },
      toolCall: { id: "task-depth-4" },
    } as RunnableConfig)

    expect(result).toMatch(/^\[B4_E5003\]/)
    expect(resolver).not.toHaveBeenCalled()
  })

  it("returns a guarded resolver denial unchanged", async () => {
    const resolver = vi.fn<SubagentResolver>(async () => ({
      ok: false,
      message: "[B4_E3002] Dispatch denied.",
    }))
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)

    await expect(
      tool.func({ subagent: "writer", input: "Draft" }, undefined, {
        toolCall: { id: "task-denied" },
      } as RunnableConfig),
    ).resolves.toBe("[B4_E3002] Dispatch denied.")
  })

  it("rethrows the exact GraphInterrupt raised by a real child graph", async () => {
    const ChildState = Annotation.Root({ messages: Annotation<unknown[]>() })
    const child = new StateGraph(ChildState)
      .addNode("pause", () => {
        interrupt({ kind: "child-approval" })
        return {}
      })
      .addEdge(START, "pause")
      .addEdge("pause", END)
      .compile()
    let childError: unknown
    const graph = {
      invoke: async (input: unknown, config: RunnableConfig) => {
        try {
          return await child.invoke(input as never, config)
        } catch (error) {
          childError = error
          throw error
        }
      },
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(graph))
    let bridgeError: unknown
    const RootState = Annotation.Root({ result: Annotation<string>() })
    const root = new StateGraph(RootState)
      .addNode("dispatch", async (_state, config) => {
        try {
          return {
            result: await tool.func({ subagent: "researcher", input: "Pause" }, undefined, {
              ...config,
              toolCall: { id: "task-interrupt" },
            } as RunnableConfig),
          }
        } catch (error) {
          bridgeError = error
          throw error
        }
      })
      .addEdge(START, "dispatch")
      .addEdge("dispatch", END)
      .compile({ checkpointer: new MemorySaver() })

    await root.invoke({}, { configurable: { thread_id: "interrupt-identity" } })

    expect(isGraphInterrupt(bridgeError)).toBe(true)
    expect(bridgeError).toBe(childError)
  })

  it("converts ordinary failures and dispatches start/end custom events", async () => {
    const child = {
      invoke: vi.fn(async () => {
        throw new Error("child went boom")
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    const root = new StateGraph(Annotation.Root({ messages: Annotation<unknown[]>() }))
      .addNode("tools", new ToolNode([tool]))
      .addEdge(START, "tools")
      .addEdge("tools", END)
      .compile()
    const events: Array<{
      event: string
      data: unknown
    }> = []
    let toolRunId = ""

    for await (const event of root.streamEvents(
      {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "task",
                args: { subagent: "researcher", input: "Fail normally" },
                id: "task-failure",
                type: "tool_call",
              },
            ],
          }),
        ],
      },
      { version: "v2" },
    )) {
      if (event.event === "on_tool_start" && event.name === "task") {
        toolRunId = event.run_id
      }
      if (event.event === "on_custom_event" && event.name === "b4.subagent") {
        events.push({
          event: event.name,
          data: event.data,
        })
      }
      if (event.event === "on_tool_end" && event.name === "task") {
        expect(String((event.data.output as { content?: unknown }).content)).toContain(
          "subagent_failed: child went boom",
        )
      }
    }

    expect(toolRunId).not.toBe("")
    expect(events.map(({ data }) => data)).toEqual([
      {
        phase: "start",
        call_id: "task-failure",
        tool_run_id: toolRunId,
        subagent: "researcher",
        route_id: "/parent/subagents/researcher",
        depth: 1,
      },
      {
        phase: "end",
        call_id: "task-failure",
        tool_run_id: toolRunId,
        subagent: "researcher",
        route_id: "/parent/subagents/researcher",
        depth: 1,
        error: "child went boom",
      },
    ])
  })

  it("names the dispatching parent call and carries the child's description on start and end", async () => {
    const child = { invoke: vi.fn(async () => childResult("found it")) }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => ({
      ok: true,
      child: {
        routeId: "/planner/researcher",
        routeKey: "/planner/researcher#agent",
        description: "Finds sources",
        graph: child,
      },
    }))
    const root = new StateGraph(Annotation.Root({ messages: Annotation<unknown[]>() }))
      .addNode("tools", new ToolNode([tool]))
      .addEdge(START, "tools")
      .addEdge("tools", END)
      .compile()
    const events: unknown[] = []
    for await (const event of root.streamEvents(
      {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "task",
                args: { subagent: "researcher", input: "Find sources" },
                id: "task-nested",
                type: "tool_call",
              },
            ],
          }),
        ],
      },
      {
        version: "v2",
        // This parent is itself a subagent: its own dispatch is the top of the stack.
        metadata: {
          b4: {
            subagent_depth: 1,
            subagent_stack: [
              { callId: "outer", name: "planner", routeId: "/planner", routeKey: "/planner#agent" },
            ],
          },
        },
      },
    )) {
      if (event.event === "on_custom_event" && event.name === "b4.subagent") events.push(event.data)
    }
    expect(events).toEqual([
      expect.objectContaining({
        phase: "start",
        call_id: "task-nested",
        parent_call_id: "outer",
        subagent: "researcher",
        description: "Finds sources",
        depth: 2,
      }),
      expect.objectContaining({
        phase: "end",
        call_id: "task-nested",
        parent_call_id: "outer",
        description: "Finds sources",
        final_message: "found it",
      }),
    ])
  })

  it("rethrows a standard AbortError unchanged without an error-shaped end event", async () => {
    const abortError = new DOMException("Child cancelled", "AbortError")
    const child = {
      invoke: vi.fn(async () => {
        throw abortError
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    const RootState = Annotation.Root({ result: Annotation<string>() })
    const root = new StateGraph(RootState)
      .addNode("dispatch", async (_state, config) => ({
        result: await tool.func({ subagent: "researcher", input: "Cancel" }, undefined, {
          ...config,
          toolCall: { id: "task-cancel" },
        } as RunnableConfig),
      }))
      .addEdge(START, "dispatch")
      .addEdge("dispatch", END)
      .compile()
    const events: unknown[] = []
    let thrown: unknown

    try {
      for await (const event of root.streamEvents({}, { version: "v2" })) {
        if (event.event === "on_custom_event" && event.name === "b4.subagent") {
          events.push(event.data)
        }
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(abortError)
    expect(events).toEqual([expect.objectContaining({ phase: "start", call_id: "task-cancel" })])
  })

  it("rethrows child errors unchanged when the inherited signal is aborted", async () => {
    const cancellation = new Error("cancelled by parent")
    const controller = new AbortController()
    controller.abort()
    const child = {
      invoke: vi.fn(async () => {
        throw cancellation
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))

    await expect(
      tool.func({ subagent: "researcher", input: "Cancel" }, undefined, {
        signal: controller.signal,
        toolCall: { id: "task-aborted-signal" },
      } as RunnableConfig),
    ).rejects.toBe(cancellation)
  })

  it("inherits the root checkpointer and resumes a child interrupt from the root thread", async () => {
    const child = interruptingChild()
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    const saver = new MemorySaver()
    const root = new StateGraph(Annotation.Root({ messages: Annotation<unknown[]>() }))
      .addNode("tools", new ToolNode([tool]))
      .addEdge(START, "tools")
      .addEdge("tools", END)
      .compile({ checkpointer: saver })
    const config = { configurable: { thread_id: "root-thread" } }
    // `__interrupt__` is real on an interrupted invoke's return value, but the
    // graph's static state type does not carry it.
    const first = (await root.invoke(
      {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "task",
                args: { subagent: "researcher", input: "Review" },
                id: "task-review",
                type: "tool_call",
              },
            ],
          }),
        ],
      },
      config,
    )) as { __interrupt__?: Interrupt[] }
    const interruptId = first.__interrupt__?.[0]?.id
    expect(interruptId).toEqual(expect.any(String))

    const namespaces = await checkpointNamespaces(saver, config)
    expect(namespaces.some((namespace) => namespace.startsWith("tools:"))).toBe(true)

    const resumed = await root.invoke(
      new Command({ resume: { [interruptId as string]: "approved" } }),
      config,
    )
    const toolMessage = resumed.messages.at(-1) as { content?: unknown; tool_call_id?: unknown }
    expect(toolMessage.tool_call_id).toBe("task-review")
    expect(toolMessage.content).toBe("child:approved")
  })

  it("gives parallel child calls distinct native interrupt ids and checkpoint namespaces", async () => {
    const child = interruptingChild()
    const seenConfigs: RunnableConfig[] = []
    const graph = {
      invoke: async (input: unknown, config: RunnableConfig) => {
        seenConfigs.push(config)
        return await child.invoke(input as never, config)
      },
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(graph))
    const RootState = Annotation.Root({
      results: Annotation<string[]>({
        reducer: (left, right) => [...left, ...right],
        default: () => [],
      }),
    })
    const call =
      (callId: string, input: string) => async (_state: unknown, config: RunnableConfig) => ({
        results: [
          await tool.func({ subagent: "researcher", input }, undefined, {
            ...config,
            toolCall: { id: callId },
          } as RunnableConfig),
        ],
      })
    const saver = new MemorySaver()
    const root = new StateGraph(RootState)
      .addNode("first", call("task-a", "A"))
      .addNode("second", call("task-b", "B"))
      .addEdge(START, "first")
      .addEdge(START, "second")
      .addEdge("first", END)
      .addEdge("second", END)
      .compile({ checkpointer: saver })
    const config = { configurable: { thread_id: "parallel-root" } }

    const first = (await root.invoke({}, config)) as { __interrupt__?: Interrupt[] }
    const interruptIds = first.__interrupt__?.map(({ id }) => id) ?? []
    expect(interruptIds).toHaveLength(2)
    expect(new Set(interruptIds).size).toBe(2)
    expect(
      new Set(seenConfigs.slice(0, 2).map((entry) => entry.configurable?.checkpoint_ns as string))
        .size,
    ).toBe(2)

    const namespaces = (await checkpointNamespaces(saver, config)).filter(Boolean)
    expect(new Set(namespaces).size).toBeGreaterThanOrEqual(2)

    const resumed = await root.invoke(
      new Command({
        resume: Object.fromEntries(interruptIds.map((id, index) => [id, `approved-${index}`])),
      }),
      config,
    )
    expect(resumed.results).toEqual(["child:approved-0", "child:approved-1"])
  })
})

function interruptingChild() {
  const ChildState = Annotation.Root({ messages: Annotation<unknown[]>() })
  return new StateGraph(ChildState)
    .addNode("approval", (state) => {
      const input = (state.messages[0] as { content?: unknown } | undefined)?.content
      const decision = interrupt({ kind: "child-approval", input })
      return { messages: [new AIMessage(`child:${decision}`)] }
    })
    .addEdge(START, "approval")
    .addEdge("approval", END)
    .compile()
}

async function checkpointNamespaces(saver: MemorySaver, config: RunnableConfig): Promise<string[]> {
  const namespaces: string[] = []
  for await (const checkpoint of saver.list(config)) {
    const namespace = checkpoint.config.configurable?.checkpoint_ns
    if (typeof namespace === "string" && namespace !== "") namespaces.push(namespace)
  }
  return namespaces
}

describe("convertSubagentTaskToLangChain — the tool-call record", () => {
  function recorder() {
    const log: string[] = []
    return {
      log,
      recorder: {
        has: vi.fn(async () => false),
        record: vi.fn(async () => {}),
        issue: async (call: { toolCallId: string; toolName: string }) => {
          log.push(`issue:${call.toolName}:${call.toolCallId}`)
        },
        settle: async (toolCallId: string) => {
          log.push(`settle:${toolCallId}`)
        },
      },
    }
  }
  const withRecorder = (rec: unknown, extra: Record<string, unknown> = {}): RunnableConfig =>
    ({
      configurable: { thread_id: "thread-rec", [CLIENT_TOOL_RECORDER_KEY]: rec },
      toolCall: { id: "call_task_1" },
      ...extra,
    }) as RunnableConfig
  const INPUT = { subagent: "researcher", input: "Go" }

  it("records a root task with no origin, and a nested task with the enclosing subagent's origin", async () => {
    const issued: unknown[] = []
    const rec = {
      has: vi.fn(async () => false),
      record: vi.fn(async () => {}),
      issue: async (c: unknown) => {
        issued.push(c)
      },
      settle: async () => {},
    }
    const child = { invoke: vi.fn(async () => childResult("Done.")) }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    await tool.func(INPUT, undefined, withRecorder(rec))
    await tool.func(
      INPUT,
      undefined,
      withRecorder(rec, {
        toolCall: { id: "call_task_2" },
        metadata: {
          b4: {
            subagent_depth: 1,
            subagent_stack: [
              {
                callId: "call_task_1",
                name: "planner",
                routeId: "/parent/subagents/planner",
                routeKey: "/parent/subagents/planner#agent",
              },
            ],
          },
        },
      }),
    )
    expect(issued).toStrictEqual([
      { toolCallId: "call_task_1", toolName: "task" },
      {
        toolCallId: "call_task_2",
        toolName: "task",
        origin: { routeId: "/parent/subagents/planner#agent", parentToolCallId: "call_task_1" },
      },
    ])
  })

  it("issues before the child runs and settles after it returns", async () => {
    const { log, recorder: rec } = recorder()
    const child = {
      invoke: vi.fn(async () => {
        log.push("child")
        return childResult("Done.")
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    expect(await tool.func(INPUT, undefined, withRecorder(rec))).toBe("Done.")
    expect(log).toEqual(["issue:task:call_task_1", "child", "settle:call_task_1"])
  })

  it("stays open across a child park (GraphInterrupt rethrown)", async () => {
    const { log, recorder: rec } = recorder()
    const park = new GraphInterrupt([])
    const child = {
      invoke: vi.fn(async () => {
        throw park
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    await expect(tool.func(INPUT, undefined, withRecorder(rec))).rejects.toBe(park)
    expect(log).toEqual(["issue:task:call_task_1"])
  })

  it("stays open across the resolver's own approval interrupt", async () => {
    const { log, recorder: rec } = recorder()
    const park = new GraphInterrupt([])
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => {
      throw park
    })
    await expect(tool.func(INPUT, undefined, withRecorder(rec))).rejects.toBe(park)
    expect(log).toEqual(["issue:task:call_task_1"])
  })

  it("settles a depth refusal and a resolver denial like any refused tool", async () => {
    const { log, recorder: rec } = recorder()
    const resolver = vi.fn<SubagentResolver>(async () => ({ ok: false, message: "denied" }))
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)
    expect(await tool.func(INPUT, undefined, withRecorder(rec))).toBe("denied")
    expect(log).toEqual(["issue:task:call_task_1", "settle:call_task_1"])
    log.length = 0
    const deep = withRecorder(rec, {
      metadata: { b4: { subagent_depth: 3, subagent_stack: [] } },
    })
    expect(await tool.func(INPUT, undefined, deep)).toMatch(/B4_E5003/)
    expect(log).toEqual(["issue:task:call_task_1", "settle:call_task_1"])
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it("settles a subagent_failed result", async () => {
    const { log, recorder: rec } = recorder()
    const child = {
      invoke: vi.fn(async () => {
        throw new Error("child blew up")
      }),
    }
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, async () => allowedChild(child))
    expect(await tool.func(INPUT, undefined, withRecorder(rec))).toMatch(/^subagent_failed: /)
    expect(log).toEqual(["issue:task:call_task_1", "settle:call_task_1"])
  })

  it("records nothing without a provider tool-call id, and still runs under the fallback id", async () => {
    const { log, recorder: rec } = recorder()
    let seenCallId: string | undefined
    const resolver = vi.fn<SubagentResolver>(async ({ callId }) => {
      seenCallId = callId
      return allowedChild({ invoke: async () => childResult("Done.") })
    })
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)
    const config = {
      configurable: { thread_id: "thread-rec", [CLIENT_TOOL_RECORDER_KEY]: rec },
    } as RunnableConfig
    expect(await tool.func(INPUT, undefined, config)).toBe("Done.")
    expect(seenCallId).toMatch(/^task-/)
    expect(log).toEqual([])
  })

  describe("b4.step", () => {
    const display = {
      icon: "agent" as const,
      running: (i: { subagent: string; input: string }) => `Asking ${i.subagent} to ${i.input}`,
      done: (i: { subagent: string }) => `${i.subagent} finished`,
    }

    async function runTask(placeholder: typeof taskPlaceholder & { display?: ToolDisplay }) {
      const order: string[] = []
      const child = {
        invoke: vi.fn(async () => {
          order.push("child")
          return childResult("Done.")
        }),
      }
      const tool = convertSubagentTaskToLangChain(placeholder, async () => allowedChild(child))
      const root = new StateGraph(Annotation.Root({ messages: Annotation<unknown[]>() }))
        .addNode("tools", new ToolNode([tool]))
        .addEdge(START, "tools")
        .addEdge("tools", END)
        .compile()
      const steps: unknown[] = []
      for await (const event of root.streamEvents(
        {
          messages: [
            new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: "task",
                  args: { subagent: "researcher", input: "summarize ReAct" },
                  id: "task-step",
                  type: "tool_call",
                },
              ],
            }),
          ],
        },
        { version: "v2" },
      )) {
        if (event.event === "on_custom_event" && event.name === "b4.step") {
          steps.push(event.data)
          order.push(`step:${(event.data as { status: string }).status}`)
        }
      }
      return { steps, order }
    }

    it("streams running before the child and completed after it", async () => {
      const { steps, order } = await runTask({ ...taskPlaceholder, display })
      expect(order).toEqual(["step:running", "child", "step:completed"])
      expect(steps).toEqual([
        {
          tool_call_id: "task-step",
          status: "running",
          icon: "agent",
          label: "Asking researcher to summarize ReAct",
        },
        {
          tool_call_id: "task-step",
          status: "completed",
          icon: "agent",
          label: "researcher finished",
        },
      ])
    })

    it("dispatches nothing without a display", async () => {
      const { steps } = await runTask(taskPlaceholder)
      expect(steps).toEqual([])
    })
  })
})
