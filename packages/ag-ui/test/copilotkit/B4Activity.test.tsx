// @vitest-environment jsdom
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import { describe, expect, test, vi } from "vitest"
import { FakeAgent } from "./fake-agent.js"

const agent = new FakeAgent()
const interruptConfig: { render?: (props: unknown) => ReactElement } = {}
const resolve = vi.fn(async () => {})
const cancel = vi.fn(async () => {})
const toolRenderers: Array<(props: unknown) => unknown> = []

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent, isReady: true }),
  useRenderTool: (config: { render: (props: unknown) => unknown }) => {
    toolRenderers.push(config.render)
  },
  useInterrupt: (config: { render: (props: unknown) => ReactElement }) => {
    interruptConfig.render = config.render
  },
  CopilotChatAssistantMessage: Object.assign(
    (props: {
      message: unknown
      toolCallsView?: (p: { message: unknown }) => ReactElement | null
    }) => (props.toolCallsView ? props.toolCallsView({ message: props.message }) : null),
    { Toolbar: () => null },
  ),
}))

const { B4Activity, useB4ChatSlots } = await import("../../src/copilotkit/index.js")

function Host() {
  const slots = useB4ChatSlots()
  const Assistant = slots.messageView.assistantMessage as unknown as (p: {
    message: unknown
  }) => ReactElement
  return (
    <Assistant
      message={{
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", type: "function", function: { name: "runBash", arguments: "{}" } }],
      }}
    />
  )
}

const interrupt = {
  id: "i1",
  reason: "command",
  toolCallId: "c1",
  responseSchema: { type: "string", enum: ["once", "always", "deny"] },
  metadata: { kind: "command", detail: { command: "node x", suggestedPattern: "node" } },
}

describe("B4Activity", () => {
  test("silences stock tool rows, renders the turn for a message's tool calls, and renders approval cards that resolve or cancel", async () => {
    const { container } = render(
      <B4Activity now={() => 5000}>
        <Host />
      </B4Activity>,
    )
    expect(toolRenderers[0]?.({})).toBeNull()
    act(() => {
      agent.emit({ type: EventType.RUN_STARTED, threadId: "t", runId: "r1" } as BaseEvent)
      agent.emit({
        type: EventType.TOOL_CALL_START,
        toolCallId: "c1",
        toolCallName: "runBash",
      } as BaseEvent)
      agent.emit({
        type: EventType.CUSTOM,
        name: "b4.step",
        value: { toolCallId: "c1", status: "running", label: "Running node x", icon: "run" },
      } as BaseEvent)
      agent.emit({
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "r1",
        outcome: { type: "interrupt", interrupts: [interrupt] },
      } as BaseEvent)
    })
    const turn = container.querySelector("section.b4-turn")
    expect(turn?.getAttribute("data-state")).toBe("awaiting")
    expect(screen.getByText("Running node x")).toBeTruthy()

    const card = interruptConfig.render?.({
      interrupts: [interrupt],
      resolve,
      cancel,
    }) as ReactElement
    const first = render(card)
    expect(screen.getByText("The agent wants to running node x")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(resolve).toHaveBeenCalledWith("once", "i1")
    // A card takes one decision and goes busy; deny on a fresh instance.
    first.unmount()
    render(card)
    fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    expect(cancel).toHaveBeenCalledWith("i1")
  })

  test("useB4ChatSlots throws outside the provider", () => {
    expect(() => render(<Host />)).toThrow(/inside <B4Activity>/)
  })
})
