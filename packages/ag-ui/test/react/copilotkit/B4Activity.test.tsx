// @vitest-environment jsdom
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactElement } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { FakeAgent } from "./fake-agent.js"

const current: { agent: FakeAgent } = { agent: new FakeAgent() }
const interruptConfig: {
  render?: ((props: unknown) => ReactElement) | undefined
  renderInChat?: boolean | undefined
} = {}
const resolve = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
const cancel = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
const toolRenderers: Array<(props: unknown) => unknown> = []
/** What the mocked `useInterrupt` hands back for `renderInChat: false`. */
const pendingInterrupts: { value: ReactElement | null } = { value: null }

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: current.agent, isReady: true }),
  useRenderTool: (config: { render: (props: unknown) => unknown }) => {
    toolRenderers.push(config.render)
  },
  useInterrupt: (config: {
    render: (props: unknown) => ReactElement
    renderInChat?: boolean | undefined
  }) => {
    interruptConfig.render = config.render
    interruptConfig.renderInChat = config.renderInChat
    if (config.renderInChat === false) return pendingInterrupts.value
    return undefined
  },
  CopilotChatAssistantMessage: Object.assign(
    (props: {
      message: unknown
      toolbarVisible?: boolean
      toolCallsView?: (p: { message: unknown }) => ReactElement | null
    }) => (
      <div data-toolbar={String(props.toolbarVisible)}>
        {props.toolCallsView ? props.toolCallsView({ message: props.message }) : null}
      </div>
    ),
    { Toolbar: () => null },
  ),
  CopilotChatReasoningMessage: Object.assign(
    (props: { message: { id: string } }) => <p data-reasoning-row={props.message.id} />,
    { Header: () => null, Content: () => null, Toggle: () => null },
  ),
}))

const { B4Activity, useB4ActivityContext, useB4ChatSlots } = await import(
  "../../../src/react/copilotkit/index.js"
)

const call = (id: string, name: string) => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
})

function Host({
  message = { id: "a1", role: "assistant", content: "", toolCalls: [call("c1", "runBash")] },
}: {
  message?: unknown
}) {
  const slots = useB4ChatSlots()
  const Assistant = slots.messageView.assistantMessage as unknown as (p: {
    message: unknown
  }) => ReactElement
  return <Assistant message={message} />
}

/** Exposes the turn count the provider holds. */
function Probe() {
  const { turns } = useB4ActivityContext()
  return <output data-turns={turns.turns.length} />
}

const started = (runId: string): BaseEvent =>
  ({ type: EventType.RUN_STARTED, threadId: "t", runId }) as BaseEvent
const toolStart = (toolCallId: string, toolCallName: string, extra: object = {}): BaseEvent =>
  ({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName, ...extra }) as BaseEvent
const stepLabel = (toolCallId: string, label: string, extra: object = {}): BaseEvent =>
  ({
    type: EventType.CUSTOM,
    name: "b4.step",
    value: { toolCallId, status: "running", label, icon: "run" },
    ...extra,
  }) as BaseEvent
const parked = (runId: string, interrupts: unknown[]): BaseEvent =>
  ({
    type: EventType.RUN_FINISHED,
    threadId: "t",
    runId,
    outcome: { type: "interrupt", interrupts },
  }) as BaseEvent

const interrupt = {
  id: "i1",
  reason: "command",
  toolCallId: "c1",
  responseSchema: { type: "string", enum: ["once", "always", "deny"] },
  metadata: { kind: "command", detail: { command: "node x", suggestedPattern: "node" } },
}

const renderCards = (interrupts: unknown[]): ReactElement =>
  interruptConfig.render?.({ interrupts, resolve, cancel }) as ReactElement

beforeEach(() => {
  current.agent = new FakeAgent()
  toolRenderers.length = 0
  interruptConfig.render = undefined
  interruptConfig.renderInChat = undefined
  pendingInterrupts.value = null
  resolve.mockReset()
  resolve.mockImplementation(async () => {})
  cancel.mockReset()
  cancel.mockImplementation(async () => {})
})

describe("B4Activity", () => {
  test("silences stock tool rows, renders the turn for a message's tool calls without a toolbar, and renders approval cards that resolve or cancel", () => {
    const { container } = render(
      <B4Activity now={() => 5000}>
        <Host />
      </B4Activity>,
    )
    expect(toolRenderers[0]?.({})).toBeNull()
    expect(interruptConfig.renderInChat).toBe(true)
    act(() => {
      current.agent.emit(started("r1"))
      current.agent.emit(toolStart("c1", "runBash"))
      current.agent.emit(stepLabel("c1", "Running node x"))
      current.agent.emit(parked("r1", [interrupt]))
    })
    expect(container.querySelector("[data-toolbar]")?.getAttribute("data-toolbar")).toBe("false")
    const turn = container.querySelector("section.b4-turn")
    expect(turn?.getAttribute("data-state")).toBe("awaiting")
    expect(screen.getByText("Running node x")).toBeTruthy()

    const card = renderCards([interrupt])
    const first = render(card)
    expect(screen.getByText("The agent wants to run node x")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(resolve).toHaveBeenCalledWith("once", "i1")
    // A card takes one decision and goes busy; deny on a fresh instance.
    first.unmount()
    render(card)
    fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    expect(cancel).toHaveBeenCalledWith("i1")
  })

  test("a text-bearing row keeps its toolbar; an empty text part does not count as text", () => {
    const { container } = render(
      <B4Activity>
        <Host message={{ id: "a1", role: "assistant", content: "Answer." }} />
        <Host message={{ id: "a2", role: "assistant", content: [{ type: "text", text: "" }] }} />
        <Host message={{ id: "a3", role: "assistant", content: [{ type: "text", text: "Hi" }] }} />
      </B4Activity>,
    )
    expect(
      [...container.querySelectorAll("[data-toolbar]")].map((n) => n.getAttribute("data-toolbar")),
    ).toEqual(["true", "false", "true"])
  })

  test("renders the turn when the message's first call is hidden and only a later one is a step", () => {
    const { container } = render(
      <B4Activity hiddenTools={["recall"]} now={() => 5000}>
        <Host
          message={{
            id: "a1",
            role: "assistant",
            toolCalls: [call("c0", "recall"), call("c1", "searchCorpus")],
          }}
        />
      </B4Activity>,
    )
    act(() => {
      current.agent.emit(started("r1"))
      current.agent.emit(toolStart("c0", "recall"))
      current.agent.emit(toolStart("c1", "searchCorpus"))
    })
    expect(container.querySelector("section.b4-turn")).not.toBeNull()
    expect(container.querySelectorAll("li.b4-step")).toHaveLength(1)
  })

  test("a gated step with no running label reads 'wants to use <tool>'; an override's running label wins", () => {
    render(
      <B4Activity now={() => 5000} labels={{ planRoute: { running: () => "Plan the route" } }}>
        <Host />
      </B4Activity>,
    )
    act(() => {
      // A tool without `display.running`: no b4.step label arrived for it.
      current.agent.emit(started("r1"))
      current.agent.emit(toolStart("c1", "fileFlightPlan"))
      current.agent.emit(toolStart("c2", "planRoute"))
    })
    const gate = (id: string, toolCallId: string) => ({
      id,
      reason: "approval",
      toolCallId,
      responseSchema: { enum: ["once", "deny"] },
    })
    render(renderCards([gate("i1", "c1"), gate("i2", "c2")]))
    expect(screen.getByText("The agent wants to use fileFlightPlan")).toBeTruthy()
    expect(screen.getByText("The agent wants to plan the route")).toBeTruthy()
    expect(screen.queryByText(/wants to using/)).toBeNull()
  })

  test("names the subagent on a child's gate, says 'continue' without a step, and offers Always only when the schema does", () => {
    render(
      <B4Activity now={() => 5000}>
        <Host />
      </B4Activity>,
    )
    act(() => {
      current.agent.emit(started("r1"))
      current.agent.emit(toolStart("k1", "task"))
      current.agent.emit({
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "k1",
        name: "researcher",
        parentToolCallId: "k1",
      } as BaseEvent)
      current.agent.emit(toolStart("c2", "runBash", { subagentRunId: "k1" }))
      current.agent.emit(stepLabel("c2", "Fetch the paper", { subagentRunId: "k1" }))
    })
    const childGate = {
      id: "i2",
      reason: "command",
      toolCallId: "c2",
      subagentRunId: "k1",
      responseSchema: { enum: ["once", "deny"] },
      metadata: { kind: "command", detail: { command: "curl" } },
    }
    const bareGate = { id: "i3", reason: "approval", message: "Go on?" }
    render(renderCards([childGate, bareGate]))
    expect(screen.getByText("researcher wants to fetch the paper")).toBeTruthy()
    expect(screen.getByText("The agent wants to continue")).toBeTruthy()
    expect(screen.getByText("Go on?")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull()
  })

  test("renderInChat={false} renders the cards after the children inside the provider", () => {
    pendingInterrupts.value = <aside data-cards="here" />
    const { container } = render(
      <B4Activity renderInChat={false}>
        <Host />
      </B4Activity>,
    )
    expect(interruptConfig.renderInChat).toBe(false)
    const nodes = [...container.children].map((n) => n.tagName.toLowerCase())
    expect(nodes).toEqual(["div", "aside"])
  })

  test("a failed resume clears the resuming mark so the next run starts a new turn, and the card shows the failure", async () => {
    resolve.mockImplementation(async () => {
      throw new Error("offline")
    })
    const { container } = render(
      <B4Activity now={() => 5000}>
        <Host />
        <Probe />
      </B4Activity>,
    )
    act(() => {
      current.agent.emit(started("r1"))
      current.agent.emit(toolStart("c1", "runBash"))
      current.agent.emit(parked("r1", [interrupt]))
    })
    render(renderCards([interrupt]))
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    await waitFor(() =>
      expect(document.querySelector("section.b4-approval")?.getAttribute("data-state")).toBe(
        "failed",
      ),
    )
    act(() => {
      current.agent.emit({ type: EventType.RUN_ERROR, message: "expired" } as BaseEvent)
      current.agent.emit(started("r2"))
    })
    // A standing mark would glue r2 onto the failed turn; cleared, it appends.
    expect(container.querySelector("output")?.getAttribute("data-turns")).toBe("2")
  })

  test("drops CopilotKit's reasoning row for reasoning the turn's activity already shows", () => {
    function Rows() {
      const slots = useB4ChatSlots()
      const Reasoning = slots.messageView.reasoningMessage as unknown as (p: {
        message: unknown
      }) => ReactElement
      return (
        <>
          <Reasoning message={{ id: "rsn-1", role: "reasoning", content: "look first" }} />
          <Reasoning message={{ id: "rsn-2", role: "reasoning", content: "just answer" }} />
        </>
      )
    }
    const { container } = render(
      <B4Activity now={() => 5000}>
        <Rows />
      </B4Activity>,
    )
    const reasoning = (runId: string, span: string, message: string): BaseEvent[] => [
      started(runId),
      { type: EventType.REASONING_START, messageId: span } as BaseEvent,
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: message,
        role: "reasoning",
      } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: message, delta: "x" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: message } as BaseEvent,
      { type: EventType.REASONING_END, messageId: span } as BaseEvent,
    ]
    // Before the turn calls a tool it has no activity row: CopilotKit's row stays.
    act(() => {
      for (const event of reasoning("r1", "span-1", "rsn-1")) current.agent.emit(event)
    })
    expect(container.querySelector('[data-reasoning-row="rsn-1"]')).not.toBeNull()
    // Once it calls one, `TurnActivity` shows the reasoning: the row goes.
    act(() => {
      current.agent.emit(toolStart("c1", "listDir"))
    })
    expect(container.querySelector('[data-reasoning-row="rsn-1"]')).toBeNull()
    // A later turn that only reasoned and answered keeps CopilotKit's row.
    act(() => {
      current.agent.emit({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r1" } as BaseEvent)
      for (const event of reasoning("r2", "span-2", "rsn-2")) current.agent.emit(event)
    })
    expect(container.querySelector('[data-reasoning-row="rsn-2"]')).not.toBeNull()
  })

  test("useB4ChatSlots throws outside the provider", () => {
    expect(() => render(<Host />)).toThrow(/inside <B4Activity>/)
  })

  test("useB4ActivityContext throws outside the provider, naming itself", () => {
    expect(() => render(<Probe />)).toThrow("useB4ActivityContext must be used inside <B4Activity>")
  })
})
