import { wrapToolWithApproval } from "@b4run/core"
import { B4_STEP_KEY, toolDenial } from "@b4run/sdk"
import { ToolMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import {
  Annotation,
  Command,
  END,
  GraphInterrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { afterEach, describe, expect, test, vi } from "vitest"
import { convertToolToLangChain } from "../src/tool-converter.js"

type Tool = Parameters<typeof convertToolToLangChain>[0]

const config = (toolCallId = "call_1") => ({
  configurable: { thread_id: "t-1" },
  toolCall: { id: toolCallId, name: "x", args: {} },
})

/** Calls the converted tool the way LangChain's ToolNode does: `func` with a config naming the call. */
const run = (tool: Tool, input: unknown = {}, id?: string) =>
  convertToolToLangChain(tool).func(input, undefined, config(id) as never)

afterEach(() => {
  vi.useRealTimers()
})

describe("converter persists a complete b4_step", () => {
  test("a display-less tool returns a ToolMessage with status, timing and no label", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-05T00:00:00.000Z") })
    const result = await run({
      name: "searchCorpus",
      run: async () => {
        vi.advanceTimersByTime(1500)
        return "3 hits"
      },
    })
    expect(result).toBeInstanceOf(ToolMessage)
    const message = result as ToolMessage
    expect(message.tool_call_id).toBe("call_1")
    expect(message.name).toBe("searchCorpus")
    expect(message.content).toBe('"3 hits"')
    expect(message.status).toBe("success")
    expect(message.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "completed",
      startedAt: "2026-10-05T00:00:00.000Z",
      settledAt: "2026-10-05T00:00:01.500Z",
    })
  })

  test("a displayed tool keeps icon, label and sources", async () => {
    const result = (await run(
      {
        name: "readDoc",
        display: {
          icon: "read",
          done: (input) => `Read ${(input as { path: string }).path}`,
          sources: () => [{ title: "a.md" }],
        },
        run: async () => "…",
      },
      { path: "a.md" },
    )) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "completed",
      icon: "read",
      label: "Read a.md",
      sources: [{ title: "a.md" }],
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
  })

  test("a branded denial is an error ToolMessage with a failed step carrying the decision the gate reported", async () => {
    const reason = "[B4_E3001] Permission denied by user: tool deployProd"
    const result = (await run({
      name: "deployProd",
      display: { icon: "run", done: () => "Deployed" },
      run: async (_input, context) => {
        context.onGateDecision?.("deny")
        return toolDenial(reason)
      },
    })) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("error")
    expect(result.content).toBe(reason)
    const step = result.additional_kwargs[B4_STEP_KEY] as Record<string, unknown>
    expect(step).toMatchObject({ status: "failed", icon: "run", decision: "deny" })
    expect(step).not.toHaveProperty("label")
    expect(step).not.toHaveProperty("sources")
  })

  test("a branded denial on a display-less tool is still a failed error ToolMessage", async () => {
    const result = (await run({
      name: "plain",
      run: async () => toolDenial("Blocked: nope"),
    })) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("error")
    expect(result.content).toBe("Blocked: nope")
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "failed",
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
  })

  test("an approved call records once/always on a completed step", async () => {
    const result = (await run({
      name: "deployProd",
      run: async (_input, context) => {
        context.onGateDecision?.("always")
        return "ok"
      },
    })) as ToolMessage
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({
      status: "completed",
      decision: "always",
    })
    const once = (await run({
      name: "deployProd",
      run: async (_input, context) => {
        context.onGateDecision?.("once")
        return "ok"
      },
    })) as ToolMessage
    expect(once.additional_kwargs[B4_STEP_KEY]).toMatchObject({ decision: "once" })
  })

  test("a call the gate never answered has no decision", async () => {
    const result = (await run({ name: "x", run: async () => "v" })) as ToolMessage
    expect(result.additional_kwargs[B4_STEP_KEY]).not.toHaveProperty("decision")
  })

  test("a thrown tool becomes an error ToolMessage with a failed step", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-05T00:00:00.000Z") })
    const result = (await run({
      name: "readFile",
      display: { icon: "read", done: () => "Read it" },
      run: async () => {
        vi.advanceTimersByTime(250)
        throw new Error("ENOENT")
      },
    })) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("error")
    expect(result.tool_call_id).toBe("call_1")
    expect(result.name).toBe("readFile")
    expect(result.content).toBe("Error: ENOENT\n Please fix your mistakes.")
    // The icon only: `done` is never asked to describe an error.
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "failed",
      icon: "read",
      startedAt: "2026-10-05T00:00:00.000Z",
      settledAt: "2026-10-05T00:00:00.250Z",
    })
  })

  test("a thrown non-Error value is stringified like toolErrorMessage does", async () => {
    const result = (await run({
      name: "x",
      run: async () => {
        throw "plain failure"
      },
    })) as ToolMessage
    expect(result.status).toBe("error")
    expect(result.content).toBe("Error: plain failure\n Please fix your mistakes.")
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "failed" })
  })

  test("a GraphInterrupt still throws (a park is not a failure)", async () => {
    const park = new GraphInterrupt([])
    await expect(
      run({
        name: "x",
        run: async () => {
          throw park
        },
      }),
    ).rejects.toBe(park)
  })

  test("an abort still throws", async () => {
    const controller = new AbortController()
    const tool = convertToolToLangChain({
      name: "x",
      run: async (_input, context) => {
        controller.abort()
        context.signal.throwIfAborted()
      },
    })
    await expect(
      tool.func({}, undefined, { ...config(), signal: controller.signal } as never),
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  test("a call with no tool call id is still a ToolMessage (id empty) and streams no step", async () => {
    const { dispatchCustomEvent } = await import("@langchain/core/callbacks/dispatch/web")
    const spy = vi.fn()
    vi.mocked(dispatchCustomEvent).mockImplementation(spy)
    const result = (await convertToolToLangChain({
      name: "x",
      display: { icon: "read", done: () => "Read" },
      run: async () => "v",
    }).func({}, undefined, {} as never)) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.tool_call_id).toBe("")
    expect(result.content).toBe('"v"')
    // No display without a call to attach it to, so the persisted step is bare.
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "completed",
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
    expect(spy).not.toHaveBeenCalled()
  })

  test("the streamed steps are unchanged: running, then completed only on success", async () => {
    const { dispatchCustomEvent } = await import("@langchain/core/callbacks/dispatch/web")
    const spy = vi.fn()
    vi.mocked(dispatchCustomEvent).mockImplementation(spy)
    const display = { icon: "search" as const, done: () => "Searched" }
    await run({ name: "s", display, run: async () => "hits" })
    expect(spy.mock.calls.map((call) => call[1])).toEqual([
      { tool_call_id: "call_1", status: "running", icon: "search" },
      { tool_call_id: "call_1", status: "completed", icon: "search", label: "Searched" },
    ])
    spy.mockClear()
    await run({ name: "s", display, run: async () => toolDenial("no") })
    expect(spy.mock.calls.map((call) => call[1])).toEqual([
      { tool_call_id: "call_1", status: "running", icon: "search" },
    ])
    spy.mockClear()
    await run({
      name: "s",
      display,
      run: async () => {
        throw new Error("x")
      },
    })
    expect(spy.mock.calls.map((call) => call[1])).toEqual([
      { tool_call_id: "call_1", status: "running", icon: "search" },
    ])
  })
})

describe("the approval gate's answer reaches the persisted step", () => {
  /** A store with no rule for the tool, so every call asks the human. */
  const asksEveryTime = {
    mode: "interactive" as const,
    match: () => "unknown" as const,
    load: async () => {},
    addAllow: async () => {},
  }

  /** Parks the wrapped, converted tool on its permission interrupt, then resumes with `decision`. */
  async function gatedCall(decision: "once" | "deny") {
    const converted = convertToolToLangChain(
      wrapToolWithApproval(
        {
          name: "deployProd",
          display: { icon: "run" as const, done: () => "Deployed" },
          run: async () => "deployed",
        },
        asksEveryTime,
      ),
    )
    const State = Annotation.Root({ result: Annotation<ToolMessage | undefined>() })
    const graph = new StateGraph(State)
      .addNode("tools", async (_state, graphConfig: RunnableConfig) => ({
        result: (await converted.func({}, undefined, {
          ...graphConfig,
          toolCall: { id: "call_gated", name: "deployProd", args: {} },
        } as never)) as ToolMessage,
      }))
      .addEdge(START, "tools")
      .addEdge("tools", END)
      .compile({ checkpointer: new MemorySaver() })
    const graphConfig = { configurable: { thread_id: `gate-${decision}` } }
    await graph.invoke({}, graphConfig)
    const parked = await graph.getState(graphConfig)
    expect(parked.tasks[0]?.interrupts[0]?.value).toMatchObject({
      type: "permission-request",
      kind: "tool",
      toolCallId: "call_gated",
    })
    const resumed = await graph.invoke(new Command({ resume: decision }), graphConfig)
    return resumed.result as ToolMessage
  }

  test("once: the completed step records the decision", async () => {
    const result = await gatedCall("once")
    expect(result.status).toBe("success")
    expect(result.content).toBe('"deployed"')
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({
      status: "completed",
      icon: "run",
      label: "Deployed",
      decision: "once",
    })
  })

  test("deny: an error ToolMessage with a failed step that records the decision", async () => {
    const result = await gatedCall("deny")
    expect(result.status).toBe("error")
    expect(result.content).toBe("[B4_E3001] Permission denied by user: tool deployProd")
    const step = result.additional_kwargs[B4_STEP_KEY] as Record<string, unknown>
    expect(step).toMatchObject({ status: "failed", icon: "run", decision: "deny" })
    expect(step).not.toHaveProperty("label")
  })
})

vi.mock("@langchain/core/callbacks/dispatch/web", () => ({ dispatchCustomEvent: vi.fn() }))
