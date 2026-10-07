import type { Message } from "@ag-ui/client"
import type { TurnsView } from "@b4run/ag-ui/view"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  chatProps: undefined as Record<string, unknown> | undefined,
  isRunning: false,
  turns: { turns: [] } as unknown,
  merge: (m: unknown[]) => m,
  assistantMessage: () => null,
}))

/** Importing CopilotKit for real pulls in CSS Node cannot load; capture what NavlogChat passes. */
vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotChat: (props: Record<string, unknown>) => {
    mocks.chatProps = props
    return null
  },
  useAgent: () => ({ agent: { isRunning: mocks.isRunning, messages: [] } }),
}))

vi.mock("@b4run/ag-ui/copilotkit", () => ({
  useB4ChatSlots: () => ({
    messageView: { transformMessages: mocks.merge, assistantMessage: mocks.assistantMessage },
  }),
  useB4ActivityContext: () => ({ turns: mocks.turns }),
}))

const { NavlogChat, stripEchoMessages } = await import("./NavlogChat")

type Slot = Record<string, unknown>
function render(props: { canAttachImages?: boolean } = {}) {
  renderToStaticMarkup(<NavlogChat threadId="t1" canAttachImages={props.canAttachImages ?? true} />)
  const chat = mocks.chatProps ?? {}
  const input = chat.input as Record<string, Slot>
  return { chat, input }
}

function awaitingTurns(): TurnsView {
  return { turns: [{ status: "awaiting" }] } as unknown as TurnsView
}

beforeEach(() => {
  mocks.chatProps = undefined
  mocks.isRunning = false
  mocks.turns = { turns: [] }
  mocks.merge = (m) => m
})

describe("NavlogChat", () => {
  test("drives CopilotChat on the given thread with the B4 slots", () => {
    const { chat } = render()
    expect(chat.threadId).toBe("t1")
    const messageView = chat.messageView as Slot
    expect(messageView.assistantMessage).toBe(mocks.assistantMessage)
    expect(typeof messageView.transformMessages).toBe("function")
  })

  test("names the input controls", () => {
    const { chat, input } = render()
    expect(input.textArea?.["aria-label"]).toBe("Message")
    expect(input.sendButton?.["aria-label"]).toBe("Send")
    expect(input.addMenuButton?.["aria-label"]).toBe("Add attachments")
    expect((chat.scrollView as Record<string, Slot>).scrollToBottomButton?.["aria-label"]).toBe(
      "Jump to latest",
    )
    expect(chat.labels).toEqual({ chatDisclaimerText: "" })
  })

  test("the send button is Stop while a run is going", () => {
    mocks.isRunning = true
    const { input } = render()
    expect(input.sendButton?.["aria-label"]).toBe("Stop")
    expect(input.sendButton?.disabled).toBeUndefined()
  })

  test("the input waits while an approval is open", () => {
    const idle = render().input
    expect(idle.textArea?.disabled).toBe(false)
    expect(idle.sendButton?.disabled).toBeUndefined()
    mocks.turns = awaitingTurns()
    const { input } = render()
    expect(input.textArea?.disabled).toBe(true)
    expect(input.textArea?.placeholder).toBe("Answer the approval above to continue")
    expect(input.sendButton?.disabled).toBe(true)
  })

  test("attachments are images only, and only when the model takes them", () => {
    expect(render().chat.attachments).toEqual({
      enabled: true,
      accept: "image/png,image/jpeg,image/gif,image/webp",
      maxSize: 4 * 1024 * 1024,
    })
    expect((render({ canAttachImages: false }).chat.attachments as Slot).enabled).toBe(false)
  })

  test("transformMessages merges turns, then strips echoed tool calls", () => {
    const merged: Message[] = [
      { id: "a1", role: "assistant", content: 'recall({ "query": "x" })\nThe winds are calm.' },
    ]
    mocks.merge = vi.fn(() => merged)
    const { chat } = render()
    const transform = (chat.messageView as Slot).transformMessages as (m: Message[]) => Message[]
    const out = transform([])
    expect(mocks.merge).toHaveBeenCalledTimes(1)
    expect(out).toEqual([{ id: "a1", role: "assistant", content: "The winds are calm." }])
  })
})

describe("stripEchoMessages", () => {
  test("returns the same array when nothing changes", () => {
    const messages: Message[] = [
      { id: "u1", role: "user", content: 'recall({ "query": "x" })' },
      { id: "a1", role: "assistant", content: "Clear skies." },
    ]
    expect(stripEchoMessages(messages)).toBe(messages)
  })

  test("only assistant prose is cleaned; other messages keep their identity", () => {
    const user: Message = { id: "u1", role: "user", content: "hi" }
    const out = stripEchoMessages([
      user,
      { id: "a1", role: "assistant", content: '- task({ subagent: "weather" })\nDone.' },
    ])
    expect(out[0]).toBe(user)
    expect(out[1]).toEqual({ id: "a1", role: "assistant", content: "Done." })
  })
})
