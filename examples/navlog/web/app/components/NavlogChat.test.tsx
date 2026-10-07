// @vitest-environment jsdom
import type { Message } from "@ag-ui/client"
import type { TurnsView } from "@b4run/ag-ui/view"
import { act } from "react"
import { createRoot } from "react-dom/client"
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

const { NavlogChat, attachmentFailureText, stripEchoMessages } = await import("./NavlogChat")

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
    expect(input.textArea?.placeholder).toBe("Answer the approval first")
    expect(input.sendButton?.disabled).toBe(true)
  })

  test("attachments are images only, and only when the model takes them", () => {
    expect(render().chat.attachments).toEqual({
      enabled: true,
      accept: "image/png,image/jpeg,image/gif,image/webp",
      maxSize: 4 * 1024 * 1024,
      onUploadFailed: expect.any(Function),
    })
    expect((render({ canAttachImages: false }).chat.attachments as Slot).enabled).toBe(false)
  })

  test("the slot objects keep their identity across renders with the same inputs", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    const root = createRoot(container)
    act(() => root.render(<NavlogChat threadId="t1" canAttachImages />))
    const first = mocks.chatProps ?? {}
    act(() => root.render(<NavlogChat threadId="t1" canAttachImages />))
    const second = mocks.chatProps ?? {}
    expect(second.input).toBe(first.input)
    expect(second.scrollView).toBe(first.scrollView)
    expect(second.attachments).toBe(first.attachments)
    // A changed input is a new object: CopilotChat must see the new label.
    mocks.isRunning = true
    act(() => root.render(<NavlogChat threadId="t1" canAttachImages />))
    expect(mocks.chatProps?.input).not.toBe(first.input)
    act(() => root.unmount())
  })

  test("a rejected attachment shows a dismissible line in the dock", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<NavlogChat threadId="t1" canAttachImages />))
    expect(container.querySelector('[role="status"]')).toBeNull()
    const attachments = mocks.chatProps?.attachments as {
      onUploadFailed: (error: { reason: string; file: File; message: string }) => void
    }
    const file = new File(["x"], "chart.png", { type: "image/png" })
    act(() => attachments.onUploadFailed({ reason: "file-too-large", file, message: "too big" }))
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "chart.png is larger than 4 MB",
    )
    const dismiss = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Dismiss",
    )
    act(() => dismiss?.click())
    expect(container.querySelector('[role="status"]')).toBeNull()
    act(() => root.unmount())
    container.remove()
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

describe("attachmentFailureText", () => {
  const file = new File(["x"], "notes.heic", { type: "image/heic" })
  test("names the file that is too large, and the types that can be attached", () => {
    expect(attachmentFailureText({ reason: "file-too-large", file, message: "" })).toBe(
      "notes.heic is larger than 4 MB",
    )
    expect(attachmentFailureText({ reason: "invalid-type", file, message: "" })).toBe(
      "Only PNG, JPEG, GIF or WebP images can be attached.",
    )
    expect(attachmentFailureText({ reason: "upload-failed", file, message: "" })).toBe(
      "Could not read notes.heic",
    )
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
