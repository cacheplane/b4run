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
  /** How many times a component subscribed to the activity kit's slots. */
  slotsCalls: 0,
  /** The props the activity kit's assistant slot last received. */
  assistantProps: undefined as Record<string, unknown> | undefined,
  /** The activity kit's assistant slot: renders the markdown renderer it is handed. */
  assistantMessage: (props: {
    message: { content: string }
    markdownRenderer?: (p: { content: string }) => unknown
  }) => {
    mocks.assistantProps = props
    const Renderer = props.markdownRenderer
    return Renderer
      ? (Renderer as (p: { content: string }) => null)({ content: props.message.content })
      : null
  },
  /** What the mocked chat view shows: an assistant message, rendered through the chat's slots. */
  shownMessage: undefined as { id: string; role: string; content: string } | undefined,
  inputChange: undefined as ((value: string) => void) | undefined,
  inputValue: "",
  renderChatView: false,
}))

/** Importing CopilotKit for real pulls in CSS Node cannot load; capture what NavlogChat passes. */
vi.mock("@copilotkit/react-core/v2", () => {
  const MarkdownRenderer = ({ content }: { content: string }) => (
    <div data-cpk-markdown>{content}</div>
  )
  const CopilotChatAssistantMessage = Object.assign(() => null, { MarkdownRenderer })
  return {
    CopilotChat: (props: Record<string, unknown>) => {
      mocks.chatProps = props
      if (!mocks.renderChatView) return null
      const ChatView = props.chatView as (p: Record<string, unknown>) => null
      return <ChatView {...props} onInputChange={mocks.inputChange} inputValue={mocks.inputValue} />
    },
    CopilotChatView: (props: {
      messageView: { assistantMessage: React.ComponentType<{ message: unknown }> }
    }) => {
      const Assistant = props.messageView.assistantMessage
      return (
        <>
          {mocks.shownMessage ? <Assistant message={mocks.shownMessage} /> : null}
          <textarea aria-label="Message" />
        </>
      )
    },
    CopilotChatAssistantMessage,
    useAgent: () => ({ agent: { isRunning: mocks.isRunning, messages: [] } }),
  }
})

vi.mock("@b4run/ag-ui/react/copilotkit", () => {
  // One object for the module's life, like the real slots; `transformMessages` reads the test's merge.
  const slots = {
    messageView: {
      get transformMessages() {
        return mocks.merge
      },
      assistantMessage: mocks.assistantMessage,
    },
  }
  return {
    useB4ChatSlots: () => {
      mocks.slotsCalls++
      return slots
    },
    useB4ActivityContext: () => ({ turns: mocks.turns }),
  }
})

const { NavlogAssistantMessage, NavlogChat, attachmentFailureText, stripEchoMessages } =
  await import("./NavlogChat")

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
  mocks.shownMessage = undefined
  mocks.inputChange = undefined
  mocks.inputValue = ""
  mocks.renderChatView = false
  mocks.slotsCalls = 0
  mocks.assistantProps = undefined
})

/** A structured answer with one assumption, in the brief kit's wrapper shape. */
const STRUCTURED = JSON.stringify({
  ui: [
    { BottomLine: { props: { level: "GO", reason: "VFR all the way.", cite: [] } } },
    { Assumptions: { props: { items: [{ statement: "full fuel.", origin: "default" }] } } },
  ],
})

/** Mounts NavlogChat with the mocked CopilotChat rendering its chat view and `message`. */
function mountChat(message: { id: string; role: string; content: string }) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.renderChatView = true
  mocks.shownMessage = message
  mocks.inputChange = vi.fn()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<NavlogChat threadId="t1" canAttachImages />))
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe("NavlogChat", () => {
  test("drives CopilotChat on the given thread with the B4 slots", () => {
    const { chat } = render()
    expect(chat.threadId).toBe("t1")
    const messageView = chat.messageView as Slot
    expect(messageView.assistantMessage).toBe(NavlogAssistantMessage)
    expect(typeof messageView.transformMessages).toBe("function")
  })

  test("the assistant slot wraps the activity kit's, keeping CopilotKit's statics", () => {
    expect(typeof NavlogAssistantMessage).toBe("function")
    expect("MarkdownRenderer" in NavlogAssistantMessage).toBe(true)
  })

  test("a structured answer renders with the brief kit, citations scoped to the message", () => {
    const view = mountChat({ id: "m1", role: "assistant", content: STRUCTURED })
    expect(view.container.querySelector('[data-level="GO"]')?.textContent).toBe("GO")
    expect(view.container.textContent).toContain("VFR all the way.")
    expect(view.container.querySelector("[data-cpk-markdown]")).toBeNull()
    view.unmount()
  })

  test("a markdown answer renders through CopilotKit's markdown renderer", () => {
    const view = mountChat({ id: "m1", role: "assistant", content: "**Filed.**" })
    expect(view.container.querySelector("[data-cpk-markdown]")?.textContent).toBe("**Filed.**")
    view.unmount()
  })

  test("an assumption's Change fills the composer through CopilotChat's input setter and focuses it", async () => {
    const view = mountChat({ id: "m1", role: "assistant", content: STRUCTURED })
    const change = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change: full fuel."]',
    )
    act(() => change?.click())
    expect(mocks.inputChange).toHaveBeenCalledWith("Actually, full fuel.")
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
    expect(document.activeElement).toBe(
      view.container.querySelector('textarea[aria-label="Message"]'),
    )
    view.unmount()
  })

  test("Change keeps a draft the pilot had started, adding the correction on a new line", () => {
    mocks.inputValue = "Also check KOWA"
    const view = mountChat({ id: "m1", role: "assistant", content: STRUCTURED })
    act(() =>
      view.container
        .querySelector<HTMLButtonElement>('button[aria-label="Change: full fuel."]')
        ?.click(),
    )
    expect(mocks.inputChange).toHaveBeenCalledWith("Also check KOWA\nActually, full fuel.")
    view.unmount()
  })

  test("Change is disabled while an approval is open, as the composer is", () => {
    mocks.turns = awaitingTurns()
    const view = mountChat({ id: "m1", role: "assistant", content: STRUCTURED })
    const change = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change: full fuel."]',
    )
    expect(change?.disabled).toBe(true)
    view.unmount()
  })

  test("a message does not subscribe to the activity kit itself; the chat hands it the slot", () => {
    const view = mountChat({ id: "m1", role: "assistant", content: STRUCTURED })
    // NavlogChat's own call only: the messages read the slot from a stable context.
    expect(mocks.slotsCalls).toBe(1)
    expect(view.container.textContent).toContain("VFR all the way.")
    view.unmount()
  })

  test("Copy on a structured answer copies the brief as plain text, not its JSON", async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const view = mountChat({ id: "m1", role: "assistant", content: STRUCTURED })
    const copyButton = mocks.assistantProps?.copyButton as
      | { onClick: () => Promise<boolean> }
      | undefined
    expect(await copyButton?.onClick()).toBe(true)
    expect(writeText).toHaveBeenCalledWith(
      "Bottom line: GO. VFR all the way.\n\nAssumptions:\n- full fuel. (Default)",
    )
    view.unmount()
  })

  test("Copy on a markdown answer is CopilotKit's own", () => {
    const view = mountChat({ id: "m1", role: "assistant", content: "**Filed.**" })
    expect(mocks.assistantProps?.copyButton).toBeUndefined()
    view.unmount()
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
    expect(input.textArea?.placeholder).toBe("Answer above first")
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
    expect(second.messageView).toBe(first.messageView)
    expect(second.chatView).toBe(first.chatView)
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
  test("a structured answer is left whole", () => {
    const messages: Message[] = [{ id: "a1", role: "assistant", content: `${STRUCTURED}\n\n` }]
    expect(stripEchoMessages(messages)).toBe(messages)
  })

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
