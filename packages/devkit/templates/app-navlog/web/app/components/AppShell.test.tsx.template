// @vitest-environment jsdom
import { act, type ReactNode, StrictMode, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The shell over fakes: the contract under test is *our* wiring — the probe,
 * the error banner, the keyed `B4Activity`, the thread-switch clear on the
 * shared agent, titling and drop notices — not CopilotKit's or the kit's.
 * `CopilotChat` sits behind `NavlogChat` (mocked here; `NavlogChat.test.tsx`
 * pins what it passes), and `B4Activity` is a stand-in that counts its mounts
 * and provides the turns a test sets.
 */
const mocks = vi.hoisted(() => ({
  agent: null as unknown as FakeAgent,
  capabilities: undefined as unknown,
  turns: { turns: [] } as unknown,
  onError: undefined as ((params: { error: Error; code: string }) => void) | undefined,
  activityMounts: 0,
  activityRenderStep: undefined as unknown,
  chatProps: [] as { threadId: string; canAttachImages: boolean }[],
}))

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: mocks.agent }),
  useCapabilities: () => mocks.capabilities,
  useCopilotKit: () => ({
    copilotkit: {
      subscribe: (subscriber: { onError: typeof mocks.onError }) => {
        mocks.onError = subscriber.onError
        return { unsubscribe: () => {} }
      },
    },
  }),
}))

vi.mock("@b4run/ag-ui/copilotkit", () => ({
  B4Activity: ({ children, renderStep }: { children: ReactNode; renderStep: unknown }) => {
    // Counts mounts, not renders: a changed key is a new instance.
    useState(() => {
      mocks.activityMounts += 1
      return null
    })
    mocks.activityRenderStep = renderStep
    return <>{children}</>
  },
  useB4ActivityContext: () => ({ turns: mocks.turns }),
}))

vi.mock("./NavlogChat", () => ({
  NavlogChat: (props: { threadId: string; canAttachImages: boolean }) => {
    mocks.chatProps.push(props)
    return <div data-chat={props.threadId} />
  },
}))

// Leaflet needs a real browser; the memory panel has its own tests.
vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="map" /> }))
vi.mock("./MemoryPanel", () => ({ MemoryPanel: () => null }))
vi.mock("../lib/use-media-query", () => ({ useMediaQuery: () => true }))

const { AppShell, RUN_ERROR_TITLES } = await import("./AppShell")
const { CONNECT_SCREEN_HEADING } = await import("./ConnectScreen")
const { NAVLOG_STEP_RENDERERS } = await import("./StepViews")
type WorkbenchThread = import("../lib/thread-source").WorkbenchThread

interface FakeSubscriber {
  onCustomEvent?: (params: { event: { name: string; value: unknown } }) => void
  onNewMessage?: (params: { message: { id: string; role: string; content?: unknown } }) => void
  onRunStartedEvent?: () => void
  onRunFinalized?: () => void
  onRunFailed?: () => void
}

interface FakeAgent {
  messages: { id: string; role: string; content?: unknown }[]
  isRunning: boolean
  pendingInterrupts: unknown[]
  setMessagesCalls: unknown[][]
  abortCalls: number
  setMessages: (messages: FakeAgent["messages"]) => void
  abortRun: () => void
  subscribers: FakeSubscriber[]
  subscribe: (subscriber: FakeSubscriber) => { unsubscribe: () => void }
}

function makeAgent(messages: FakeAgent["messages"] = []): FakeAgent {
  return {
    messages,
    isRunning: false,
    pendingInterrupts: [{ id: "interrupt-1" }],
    setMessagesCalls: [],
    abortCalls: 0,
    setMessages(next) {
      this.setMessagesCalls.push(next)
      this.messages = next
    },
    abortRun() {
      this.abortCalls += 1
    },
    subscribers: [],
    subscribe(subscriber) {
      this.subscribers.push(subscriber)
      return {
        unsubscribe: () => {
          this.subscribers = this.subscribers.filter((candidate) => candidate !== subscriber)
        },
      }
    },
  }
}

const THREADS: readonly WorkbenchThread[] = [
  { id: "thread-a", lastActiveAt: 2 },
  { id: "thread-b", lastActiveAt: 1, title: "Duluth tomorrow" },
]

let container: HTMLDivElement
let root: Root
let onUserMessage: ReturnType<typeof vi.fn<(message: string) => void>>
let probeStatus: number

function shell(activeThreadId: string | undefined, threads = THREADS) {
  return (
    <AppShell
      threads={threads}
      activeThreadId={activeThreadId}
      onSelectThread={() => {}}
      onCreateThread={() => {}}
      onUserMessage={onUserMessage}
    />
  )
}

/** Mounts the shell and lets the first probe answer. */
async function render(activeThreadId: string | undefined, threads = THREADS): Promise<void> {
  act(() => root.render(shell(activeThreadId, threads)))
  await act(async () => {})
}

function rerender(activeThreadId: string | undefined, threads = THREADS): void {
  act(() => root.render(shell(activeThreadId, threads)))
}

const text = (): string => container.textContent ?? ""
const alert = (): Element | null => container.querySelector('[role="alert"]')
const button = (name: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === name)

/**
 * A message the user sends: `CopilotChat` (submit or a suggestion pill) calls
 * `agent.addMessage`, which pushes it and fires `onNewMessage`. A restore
 * does neither — the replayed messages arrive through `RUN_STARTED.input`.
 */
function send(id: string, content: unknown): void {
  act(() => {
    const message = { id, role: "user", content }
    mocks.agent.messages = [...mocks.agent.messages, message]
    for (const subscriber of mocks.agent.subscribers) subscriber.onNewMessage?.({ message })
  })
}

/** A restore: the replay lands on the agent with no `onNewMessage`. */
function restore(messages: FakeAgent["messages"], activeThreadId: string): void {
  mocks.agent.messages = messages
  rerender(activeThreadId)
}

function agentEvent(name: "onRunStartedEvent" | "onRunFinalized" | "onRunFailed"): void {
  act(() => {
    for (const subscriber of mocks.agent.subscribers) subscriber[name]?.()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.agent = makeAgent()
  mocks.capabilities = undefined
  mocks.turns = { turns: [] }
  mocks.onError = undefined
  mocks.activityMounts = 0
  mocks.chatProps = []
  onUserMessage = vi.fn<(message: string) => void>()
  probeStatus = 200
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: probeStatus })),
  )
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("app shell connect screen", () => {
  test("shows the connect screen once the probe reports the proxy's cannot-reach 502", async () => {
    probeStatus = 502
    await render("thread-a")
    expect(text()).toContain(CONNECT_SCREEN_HEADING)
    expect(container.querySelector("[data-chat]")).toBeNull()
  })

  test("does NOT show the connect screen while the first probe is still in flight", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    )
    act(() => root.render(shell("thread-a")))
    expect(text()).not.toContain(CONNECT_SCREEN_HEADING)
    expect(container.querySelector('[data-chat="thread-a"]')).not.toBeNull()
  })

  test("the retry button re-probes, and recovery brings the workbench back", async () => {
    probeStatus = 502
    await render("thread-a")
    const mounts = mocks.activityMounts
    probeStatus = 200
    act(() => button("Try again")?.click())
    await act(async () => {})
    expect(text()).not.toContain(CONNECT_SCREEN_HEADING)
    // Remounted: the chat connects the thread again.
    expect(mocks.activityMounts).toBeGreaterThan(mounts)
  })

  test("polls every ~5s while down", async () => {
    vi.useFakeTimers()
    probeStatus = 502
    await render("thread-a")
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const before = fetchMock.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(fetchMock.mock.calls.length).toBe(before + 1)
  })

  test("shows the connect screen under StrictMode, which is what dev actually runs", async () => {
    probeStatus = 502
    act(() => root.render(<StrictMode>{shell("thread-a")}</StrictMode>))
    await act(async () => {})
    expect(text()).toContain(CONNECT_SCREEN_HEADING)
  })
})

describe("app shell workbench", () => {
  test("wraps the workbench in B4Activity with the navlog step views", async () => {
    await render("thread-a")
    expect(mocks.activityMounts).toBe(1)
    expect(mocks.activityRenderStep).toBe(NAVLOG_STEP_RENDERERS)
    expect(container.querySelector('[data-chat="thread-a"]')).not.toBeNull()
  })

  test("renders no chat until the thread id resolves (CopilotChat would mint its own)", async () => {
    await render(undefined)
    expect(container.querySelector("[data-chat]")).toBeNull()
    expect(text()).toContain("B4.run navlog")
  })

  test("attachments follow the route's capability document", async () => {
    await render("thread-a")
    expect(mocks.chatProps.at(-1)?.canAttachImages).toBe(false)
    mocks.capabilities = { multimodal: { input: { image: true } } }
    rerender("thread-a")
    expect(mocks.chatProps.at(-1)?.canAttachImages).toBe(true)
  })

  test("the status badge reads Running from a working turn and Awaiting approval from the turns", async () => {
    await render("thread-a")
    expect(text()).toContain("Ready")
    mocks.turns = { turns: [{ status: "awaiting", steps: [] }] }
    rerender("thread-a")
    expect(text()).toContain("Awaiting approval")
    mocks.turns = { turns: [{ status: "working", steps: [] }] }
    rerender("thread-a")
    expect(text()).toContain("Running")
  })

  test("a restore is not a run: the agent's connect-time isRunning alone reads Ready", async () => {
    await render("thread-a")
    mocks.agent.isRunning = true
    mocks.turns = { turns: [{ status: "done", steps: [] }] }
    rerender("thread-a")
    expect(text()).toContain("Ready")
    expect(text()).not.toContain("Running")
  })

  test("a send reads Running at once, before its run's first event lands", async () => {
    await render("thread-a")
    mocks.agent.isRunning = true
    send("u1", "Plan KSTP to KRST")
    expect(text()).toContain("Running")
    // RUN_STARTED hands over to the turns, which now carry the run.
    mocks.turns = { turns: [{ status: "working", steps: [] }] }
    agentEvent("onRunStartedEvent")
    expect(text()).toContain("Running")
    mocks.turns = { turns: [{ status: "done", steps: [] }] }
    mocks.agent.isRunning = false
    agentEvent("onRunFinalized")
    rerender("thread-a")
    expect(text()).toContain("Ready")
  })

  test("a send that fails before its run starts does not leave the badge on Running", async () => {
    await render("thread-a")
    send("u1", "Plan KSTP to KRST")
    expect(text()).toContain("Running")
    agentEvent("onRunFailed")
    expect(text()).not.toContain("Running")
  })
})

describe("app shell thread switch", () => {
  test("leaves the agent alone on the first render of a thread", async () => {
    await render("thread-a")
    expect(mocks.agent.setMessagesCalls).toEqual([])
    expect(mocks.agent.pendingInterrupts).toHaveLength(1)
  })

  test("a switch remounts the activity, clears the shared agent and aborts a run in flight", async () => {
    await render("thread-a")
    mocks.agent.isRunning = true
    rerender("thread-b")
    expect(mocks.activityMounts).toBe(2)
    expect(mocks.chatProps.at(-1)?.threadId).toBe("thread-b")
    expect(mocks.agent.pendingInterrupts).toEqual([])
    expect(mocks.agent.setMessagesCalls).toEqual([[]])
    expect(mocks.agent.abortCalls).toBe(1)
  })

  test("does NOT reset when only the agent's identity changes", async () => {
    await render("thread-a")
    mocks.agent = makeAgent([{ id: "m1", role: "user", content: "hello" }])
    rerender("thread-a")
    expect(mocks.agent.setMessagesCalls).toEqual([])
    expect(mocks.agent.pendingInterrupts).toHaveLength(1)
    expect(mocks.activityMounts).toBe(1)
  })
})

describe("app shell errors", () => {
  test("a failed run shows the banner with its title and message, and Dismiss clears it", async () => {
    await render("thread-a")
    act(() => mocks.onError?.({ error: new Error("boom"), code: "agent_run_failed" }))
    expect(alert()?.textContent).toContain("The run failed")
    expect(alert()?.textContent).toContain("boom")
    expect(button("Retry")).toBeUndefined()
    act(() => button("Dismiss")?.click())
    expect(alert()).toBeNull()
  })

  test("a failed load reads Couldn't load this conversation, and Retry connects again", async () => {
    expect(RUN_ERROR_TITLES.agent_connect_failed).toBe("Couldn't load this conversation")
    await render("thread-a")
    act(() => mocks.onError?.({ error: new Error("replay 500"), code: "agent_connect_failed" }))
    expect(alert()?.textContent).toContain("Couldn't load this conversation")
    act(() => button("Retry")?.click())
    expect(alert()).toBeNull()
    // The nonce is in the key: a new activity, so a new chat and a new connect.
    expect(mocks.activityMounts).toBe(2)
  })

  test("an error code that is not the user's problem stays a console line", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    await render("thread-a")
    act(() => mocks.onError?.({ error: new Error("x"), code: "subscriber_callback_failed" }))
    expect(alert()).toBeNull()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test("the server coming back clears a banner from while it was down", async () => {
    probeStatus = 502
    await render("thread-a")
    act(() => mocks.onError?.({ error: new Error("fetch failed"), code: "agent_connect_failed" }))
    probeStatus = 200
    act(() => button("Try again")?.click())
    await act(async () => {})
    expect(text()).not.toContain(CONNECT_SCREEN_HEADING)
    expect(alert()).toBeNull()
  })

  test("a thread switch clears the banner", async () => {
    await render("thread-a")
    act(() => mocks.onError?.({ error: new Error("boom"), code: "agent_run_failed" }))
    rerender("thread-b")
    expect(alert()).toBeNull()
  })
})

describe("app shell rail recency", () => {
  test("every message the user sends touches the thread, not just the first", async () => {
    await render("thread-b")
    send("u1", "Duluth tomorrow")
    send("u2", "File it")
    expect(onUserMessage.mock.calls).toEqual([["Duluth tomorrow"], ["File it"]])
  })

  test("the first send in an untitled thread touches it once, with its title", async () => {
    await render("thread-a")
    send("u1", "Plan KSTP to KRST")
    rerender("thread-a")
    expect(onUserMessage.mock.calls).toEqual([["Plan KSTP to KRST"]])
  })

  test("a message delivered twice touches once", async () => {
    await render("thread-b")
    act(() => {
      const message = { id: "u1", role: "user", content: "again" }
      for (const subscriber of mocks.agent.subscribers) {
        subscriber.onNewMessage?.({ message })
        subscriber.onNewMessage?.({ message })
      }
    })
    expect(onUserMessage).toHaveBeenCalledTimes(1)
  })

  test("assistant messages do not touch", async () => {
    await render("thread-b")
    act(() => {
      for (const subscriber of mocks.agent.subscribers)
        subscriber.onNewMessage?.({ message: { id: "a1", role: "assistant", content: "Hi" } })
    })
    expect(onUserMessage).not.toHaveBeenCalled()
  })

  test("restoring a titled thread does not touch it", async () => {
    await render("thread-b")
    restore(
      [
        { id: "u1", role: "user", content: "Duluth tomorrow" },
        { id: "a1", role: "assistant", content: "VFR." },
        { id: "u2", role: "user", content: "File it" },
      ],
      "thread-b",
    )
    expect(onUserMessage).not.toHaveBeenCalled()
  })
})

describe("app shell titling", () => {
  test("titles a restored untitled thread from its first user message, once", async () => {
    await render("thread-a")
    expect(onUserMessage).not.toHaveBeenCalled()
    mocks.agent.messages = [{ id: "u1", role: "user", content: "Plan KSTP to KRST" }]
    rerender("thread-a")
    expect(onUserMessage).toHaveBeenCalledWith("Plan KSTP to KRST")
    mocks.agent.messages = [
      ...mocks.agent.messages,
      { id: "a1", role: "assistant", content: "On it." },
      { id: "u2", role: "user", content: "File it" },
    ]
    rerender("thread-a")
    expect(onUserMessage).toHaveBeenCalledTimes(1)
  })

  test("an image-only first message titles the thread by what it carries", async () => {
    mocks.agent.messages = [
      {
        id: "u1",
        role: "user",
        content: [
          { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
        ],
      },
    ]
    await render("thread-a")
    expect(onUserMessage).toHaveBeenCalledWith("(image)")
  })

  test("leaves a titled thread alone", async () => {
    mocks.agent.messages = [{ id: "u1", role: "user", content: "Something else" }]
    await render("thread-b")
    expect(onUserMessage).not.toHaveBeenCalled()
  })

  test("never titles the thread switched to with the previous thread's messages", async () => {
    mocks.agent.messages = [{ id: "u1", role: "user", content: "Duluth tomorrow" }]
    const threads: readonly WorkbenchThread[] = [
      { id: "thread-b", lastActiveAt: 1, title: "Duluth tomorrow" },
      { id: "thread-c", lastActiveAt: 3 },
    ]
    await render("thread-b", threads)
    rerender("thread-c", threads)
    expect(onUserMessage).not.toHaveBeenCalled()
  })
})

describe("app shell drop notices", () => {
  const dropped = (value: unknown) =>
    act(() => {
      for (const subscriber of mocks.agent.subscribers)
        subscriber.onCustomEvent?.({ event: { name: "b4.content_parts_dropped", value } })
    })
  const NOTICE = { parts: [{ index: 0, type: "image", reason: "unsupported_by_model" }] }

  test("a b4.content_parts_dropped event shows a notice in the dock", async () => {
    await render("thread-a")
    dropped(NOTICE)
    expect(text()).toContain("The planner could not see this content")
    expect(text()).toContain("image (unsupported_by_model)")
  })

  test("ignores other custom events and malformed drop payloads", async () => {
    await render("thread-a")
    act(() => {
      for (const subscriber of mocks.agent.subscribers)
        subscriber.onCustomEvent?.({ event: { name: "something.else", value: NOTICE } })
    })
    dropped({ parts: [{ type: 5 }] })
    dropped({ parts: [] })
    expect(text()).not.toContain("could not see")
  })

  test("a thread switch clears the previous thread's notices", async () => {
    await render("thread-a")
    dropped(NOTICE)
    rerender("thread-b")
    expect(text()).not.toContain("could not see")
  })
})
