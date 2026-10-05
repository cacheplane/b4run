import {
  B4_STEP_KEY,
  B4_SUBAGENT_KEY,
  CLIENT_TOOL_RECORDER_KEY,
  type ToolDisplay,
} from "@b4run/sdk"
import { AIMessage, ToolMessage } from "@langchain/core/messages"
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

    expect(result).toBeInstanceOf(ToolMessage)
    expect((result as ToolMessage).content).toBe("Final answer from child.")
    expect((result as ToolMessage).tool_call_id).toBe("task-live-1")
    expect((result as ToolMessage).additional_kwargs[B4_SUBAGENT_KEY]).toMatchObject({
      name: "researcher",
      depth: 2,
      checkpointNs: "parent:1",
      outcome: "done",
    })
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

    expect(result).toBeInstanceOf(ToolMessage)
    expect((result as ToolMessage).status).toBe("error")
    expect((result as ToolMessage).content).toMatch(/^\[B4_E5003\]/)
    expect(resolver).not.toHaveBeenCalled()
  })

  it("returns a guarded resolver denial unchanged", async () => {
    const resolver = vi.fn<SubagentResolver>(async () => ({
      ok: false,
      message: "[B4_E3002] Dispatch denied.",
    }))
    const tool = convertSubagentTaskToLangChain(taskPlaceholder, resolver)

    const result = (await tool.func({ subagent: "writer", input: "Draft" }, undefined, {
      toolCall: { id: "task-denied" },
    } as RunnableConfig)) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("error")
    expect(result.content).toBe("[B4_E3002] Dispatch denied.")
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
          String(
            (
              (await tool.func({ subagent: "researcher", input }, undefined, {
                ...config,
                toolCall: { id: callId },
              } as RunnableConfig)) as ToolMessage
            ).content,
          ),
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
    const result = (await tool.func(INPUT, undefined, withRecorder(rec))) as ToolMessage
    expect(result.content).toBe("Done.")
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
    const denied = (await tool.func(INPUT, undefined, withRecorder(rec))) as ToolMessage
    expect(denied.status).toBe("error")
    expect(denied.content).toBe("denied")
    expect(log).toEqual(["issue:task:call_task_1", "settle:call_task_1"])
    log.length = 0
    const deep = withRecorder(rec, {
      metadata: { b4: { subagent_depth: 3, subagent_stack: [] } },
    })
    const tooDeep = (await tool.func(INPUT, undefined, deep)) as ToolMessage
    expect(tooDeep.status).toBe("error")
    expect(tooDeep.content).toMatch(/B4_E5003/)
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
    const result = (await tool.func(INPUT, undefined, withRecorder(rec))) as ToolMessage
    expect(result.status).toBe("error")
    expect(result.content).toMatch(/^subagent_failed: /)
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
    const result = (await tool.func(INPUT, undefined, config)) as ToolMessage
    expect(result.content).toBe("Done.")
    // No provider id: the message names no call, and the stamp still rides on it.
    expect(result.tool_call_id).toBe("")
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "completed" })
    expect(seenCallId).toMatch(/^task-/)
    expect(log).toEqual([])
  })

  describe("b4.step", () => {
    const display = {
      icon: "agent" as const,
      running: (i: { subagent: string; input: string }) => `Asking ${i.subagent} to ${i.input}`,
      done: (i: { subagent: string }) => `Heard back from ${i.subagent}`,
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
          label: "Heard back from researcher",
        },
      ])
    })

    it("dispatches nothing without a display", async () => {
      const { steps } = await runTask(taskPlaceholder)
      expect(steps).toEqual([])
    })
  })
})

describe("task bridge persists the subagent on its ToolMessage", () => {
  const TASK_DISPLAY: ToolDisplay = {
    icon: "agent",
    running: (i) =>
      `Asking ${(i as { subagent: string }).subagent} to ${(i as { input: string }).input}`,
    done: (i) => `Heard back from ${(i as { subagent: string }).subagent}`,
  }
  const taskConfig = (callId: string, ns: string) =>
    ({
      configurable: { thread_id: "t", toolCallId: callId, checkpoint_ns: ns },
      toolCall: { id: callId, name: "task", args: {} },
    }) as RunnableConfig
  const placeholderWithDisplay = () => ({
    name: "task",
    schema: z.object({ subagent: z.string(), input: z.string() }),
    display: TASK_DISPLAY,
  })
  const resolverReturning =
    (graph: ResolvedSubagentGraph["graph"]): SubagentResolver =>
    async () => ({
      ok: true,
      child: {
        routeId: "/researcher",
        routeKey: "/researcher#agent",
        description: "Finds sources",
        graph,
      },
    })
  const childGraphReplying = (text: string): ResolvedSubagentGraph["graph"] => ({
    invoke: async () => ({ messages: [new AIMessage(text)] }),
  })
  const childGraphThrowing = (error: unknown): ResolvedSubagentGraph["graph"] => ({
    invoke: async () => {
      throw error
    },
  })

  it("success: ToolMessage with the final text, a completed step and the child namespace", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-05T00:00:00.000Z") })
    try {
      const tool = convertSubagentTaskToLangChain(
        placeholderWithDisplay(),
        resolverReturning({
          invoke: async () => {
            vi.advanceTimersByTime(2000)
            return { messages: [new AIMessage("Done: ReAct interleaves…")] }
          },
        }),
      )
      const result = (await tool.invoke(
        { subagent: "researcher", input: "summarize ReAct" },
        taskConfig("call_task_1", "tools:abc"),
      )) as ToolMessage
      expect(result).toBeInstanceOf(ToolMessage)
      expect(result.tool_call_id).toBe("call_task_1")
      expect(result.name).toBe("task")
      expect(result.status).toBe("success")
      expect(result.content).toBe("Done: ReAct interleaves…")
      expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
        status: "completed",
        icon: "agent",
        label: "Heard back from researcher",
        startedAt: "2026-10-05T00:00:00.000Z",
        settledAt: "2026-10-05T00:00:02.000Z",
      })
      expect(result.additional_kwargs[B4_SUBAGENT_KEY]).toEqual({
        name: "researcher",
        routeId: "/researcher",
        description: "Finds sources",
        depth: 1,
        checkpointNs: "tools:abc",
        outcome: "done",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("a child without a description leaves the field off the stamp", async () => {
    const tool = convertSubagentTaskToLangChain(placeholderWithDisplay(), async () =>
      allowedChild(childGraphReplying("ok"), "/plain"),
    )
    const result = (await tool.invoke(
      { subagent: "plain", input: "x" },
      taskConfig("call_task_0", "tools:000"),
    )) as ToolMessage
    expect(result.additional_kwargs[B4_SUBAGENT_KEY]).toEqual({
      name: "plain",
      routeId: "/plain",
      depth: 1,
      checkpointNs: "tools:000",
      outcome: "done",
    })
  })

  it("child threw: error ToolMessage, failed step, outcome failed with the error", async () => {
    const tool = convertSubagentTaskToLangChain(
      placeholderWithDisplay(),
      resolverReturning(childGraphThrowing(new Error("boom"))),
    )
    const result = (await tool.invoke(
      { subagent: "researcher", input: "x" },
      taskConfig("call_task_2", "tools:def"),
    )) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("error")
    expect(result.content).toBe("subagent_failed: boom")
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "failed",
      icon: "agent",
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
    expect(result.additional_kwargs[B4_SUBAGENT_KEY]).toEqual({
      name: "researcher",
      routeId: "/researcher",
      description: "Finds sources",
      depth: 1,
      checkpointNs: "tools:def",
      outcome: "failed",
      error: "boom",
    })
  })

  it("resolver refused and depth exceeded are error ToolMessages with a failed step and no b4_subagent", async () => {
    const refused = convertSubagentTaskToLangChain(placeholderWithDisplay(), async () => ({
      ok: false,
      message: "[B4_E5003] No subagent named ghost",
    }))
    const result = (await refused.invoke(
      { subagent: "ghost", input: "x" },
      taskConfig("call_task_3", "tools:ghi"),
    )) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("error")
    expect(result.content).toBe("[B4_E5003] No subagent named ghost")
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "failed",
      icon: "agent",
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
    expect(result.additional_kwargs).not.toHaveProperty(B4_SUBAGENT_KEY)

    const resolver = vi.fn<SubagentResolver>()
    const deep = convertSubagentTaskToLangChain(placeholderWithDisplay(), resolver)
    const tooDeep = (await deep.invoke(
      { subagent: "researcher", input: "x" },
      {
        ...taskConfig("call_task_3b", "tools:jjj"),
        metadata: { b4: { subagent_depth: 3, subagent_stack: [] } },
      },
    )) as ToolMessage
    expect(tooDeep.status).toBe("error")
    expect(tooDeep.content).toMatch(/^\[B4_E5003\] Cannot dispatch 'researcher' at depth 4/)
    expect(tooDeep.additional_kwargs[B4_STEP_KEY]).toMatchObject({
      status: "failed",
      icon: "agent",
    })
    expect(tooDeep.additional_kwargs).not.toHaveProperty(B4_SUBAGENT_KEY)
    expect(resolver).not.toHaveBeenCalled()
  })

  it("without a display the steps are bare but still persisted", async () => {
    const tool = convertSubagentTaskToLangChain(
      taskPlaceholder,
      resolverReturning(childGraphReplying("plain")),
    )
    const result = (await tool.invoke(
      { subagent: "researcher", input: "x" },
      taskConfig("call_task_5", "tools:mno"),
    )) as ToolMessage
    expect(result.content).toBe("plain")
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "completed",
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
    expect(result.additional_kwargs[B4_SUBAGENT_KEY]).toMatchObject({ outcome: "done" })
  })

  it("a GraphInterrupt from the child still propagates", async () => {
    const park = new GraphInterrupt([])
    const tool = convertSubagentTaskToLangChain(
      placeholderWithDisplay(),
      resolverReturning(childGraphThrowing(park)),
    )
    await expect(
      tool.invoke({ subagent: "researcher", input: "x" }, taskConfig("call_task_4", "tools:jkl")),
    ).rejects.toBe(park)
  })

  it("streams completed only when the child succeeded", async () => {
    const steps = async (graph: ResolvedSubagentGraph["graph"]) => {
      const tool = convertSubagentTaskToLangChain(
        placeholderWithDisplay(),
        resolverReturning(graph),
      )
      const root = new StateGraph(Annotation.Root({ messages: Annotation<unknown[]>() }))
        .addNode("tools", new ToolNode([tool]))
        .addEdge(START, "tools")
        .addEdge("tools", END)
        .compile()
      const seen: string[] = []
      for await (const event of root.streamEvents(
        {
          messages: [
            new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: "task",
                  args: { subagent: "researcher", input: "go" },
                  id: "task-steps",
                  type: "tool_call",
                },
              ],
            }),
          ],
        },
        { version: "v2" },
      )) {
        if (event.event === "on_custom_event" && event.name === "b4.step") {
          seen.push((event.data as { status: string }).status)
        }
      }
      return seen
    }
    expect(await steps(childGraphReplying("ok"))).toEqual(["running", "completed"])
    expect(await steps(childGraphThrowing(new Error("boom")))).toEqual(["running"])
  })
})
