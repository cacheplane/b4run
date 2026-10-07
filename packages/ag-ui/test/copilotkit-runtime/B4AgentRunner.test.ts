import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { InMemoryAgentRunner } from "@copilotkit/runtime/v2"
import { lastValueFrom, Observable, Subject, toArray } from "rxjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { B4AgentRunner } from "../../src/copilotkit-runtime/index.js"

const EVENTS: BaseEvent[] = [
  { type: EventType.RUN_STARTED, threadId: "t-1", runId: "u-1" } as BaseEvent,
  {
    type: EventType.RUN_FINISHED,
    threadId: "t-1",
    runId: "u-1",
    outcome: { type: "success" },
  } as BaseEvent,
]

function jsonFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body, { status }),
  )
}

afterEach(() => vi.restoreAllMocks())

describe("B4AgentRunner.connect", () => {
  it("replays /threads/:id/events from the B4 server when no run is live here", async () => {
    const fetch = jsonFetch(200, {
      threadId: "t-1",
      status: "idle",
      events: EVENTS,
      warnings: [],
      truncated: false,
    })
    const runner = new B4AgentRunner({ url: "http://b4.test/", fetch })
    const events = await lastValueFrom(runner.connect({ threadId: "t-1" }).pipe(toArray()))
    expect(events).toEqual(EVENTS)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://b4.test/threads/t-1/events")
  })

  it("encodes the thread id in the path", async () => {
    const fetch = jsonFetch(200, {
      threadId: "a/b",
      status: "idle",
      events: [],
      warnings: [],
      truncated: false,
    })
    await lastValueFrom(
      new B4AgentRunner({ url: "http://b4.test", fetch })
        .connect({ threadId: "a/b" })
        .pipe(toArray()),
    )
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://b4.test/threads/a%2Fb/events")
  })

  it("never forwards the connect request's headers (auth comes from the host's fetch)", async () => {
    const fetch = jsonFetch(200, {
      threadId: "t-1",
      status: "idle",
      events: [],
      warnings: [],
      truncated: false,
    })
    await lastValueFrom(
      new B4AgentRunner({ url: "http://b4.test", fetch })
        .connect({
          threadId: "t-1",
          headers: {
            authorization: "Bearer browser",
            "x-b4-visitor": "someone-else",
            Accept: "text/event-stream",
          },
        })
        .pipe(toArray()),
    )
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("x-b4-visitor")).toBeNull()
    expect(headers.get("accept")).toBe("application/json")
  })

  it.each([404, 409])("completes empty on %i (nothing to restore)", async (status) => {
    const runner = new B4AgentRunner({
      url: "http://b4.test",
      fetch: jsonFetch(status, { error: {} }),
    })
    expect(await lastValueFrom(runner.connect({ threadId: "t-1" }).pipe(toArray()))).toEqual([])
  })

  it("errors with the status on any other failure", async () => {
    const runner = new B4AgentRunner({
      url: "http://b4.test",
      fetch: jsonFetch(503, { error: {} }),
    })
    await expect(
      lastValueFrom(runner.connect({ threadId: "t-1" }).pipe(toArray())),
    ).rejects.toThrow(/503/)
  })

  describe("while a run for the thread is live in this process", () => {
    const turn = (runId: string, text: string): BaseEvent[] => [
      {
        type: EventType.RUN_STARTED,
        threadId: "t-1",
        runId,
        input: { messages: [{ id: `${runId}-m`, role: "user", content: text }] },
      } as unknown as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: `${runId}-a`,
        role: "assistant",
      } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: `${runId}-a` } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "t-1",
        runId,
        outcome: { type: "success" },
      } as BaseEvent,
    ]
    const closed = [...turn("r-1", "one"), ...turn("r-2", "two")]
    const openHead: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-1", runId: "r-3" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "ckpt-a", role: "assistant" } as BaseEvent,
    ]
    const currentStarted = {
      type: EventType.RUN_STARTED,
      threadId: "t-1",
      runId: "live-3",
      input: {
        threadId: "t-1",
        runId: "live-3",
        messages: [
          { id: "c-1", role: "user", content: "one" },
          { id: "c-2", role: "assistant", content: "hi" },
          { id: "c-3", role: "user", content: "three" },
          { id: "c-4", role: "assistant", content: "draft" },
        ],
      },
    } as unknown as BaseEvent
    const currentText = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "live-a",
      role: "assistant",
    } as BaseEvent
    const historic: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t-1", runId: "old" } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "t-1",
        runId: "old",
        outcome: { type: "success" },
      } as BaseEvent,
    ]

    function liveInner(
      replayed: readonly BaseEvent[] = [...historic, currentStarted, currentText],
    ) {
      const later = new Subject<BaseEvent>()
      let unsubscribed = false
      const inner = new Observable<BaseEvent>((subscriber) => {
        for (const event of replayed) subscriber.next(event)
        const subscription = later.subscribe(subscriber)
        return () => {
          unsubscribed = true
          subscription.unsubscribe()
        }
      })
      const spy = vi.spyOn(InMemoryAgentRunner.prototype, "connect").mockReturnValue(inner)
      return { later, spy, isUnsubscribed: () => unsubscribed }
    }

    it("emits B4 history without its open head, then this process's current run, then later live events", async () => {
      const fetch = jsonFetch(200, {
        threadId: "t-1",
        status: "busy",
        events: [...closed, ...openHead],
        warnings: [],
        truncated: false,
      })
      const runner = new B4AgentRunner({ url: "http://b4.test", fetch })
      vi.spyOn(runner, "isRunning").mockResolvedValue(true)
      const { later, spy } = liveInner()
      const seen: BaseEvent[] = []
      let done = false
      runner.connect({ threadId: "t-1" }).subscribe({
        next: (event) => seen.push(event),
        complete: () => {
          done = true
        },
      })
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith({ threadId: "t-1" }))
      const finished = {
        type: EventType.RUN_FINISHED,
        threadId: "t-1",
        runId: "live-3",
        outcome: { type: "success" },
      } as BaseEvent
      later.next(finished)
      later.complete()
      expect(done).toBe(true)
      expect(seen).toEqual([
        ...closed,
        {
          ...currentStarted,
          input: {
            ...(currentStarted as unknown as { input: object }).input,
            messages: [{ id: "c-3", role: "user", content: "three" }],
          },
        },
        currentText,
        finished,
      ])
    })

    it("rejoins a resumed run from the parked run it answers, so the turn keeps its start", async () => {
      // While the resume is in flight, B4 replays park + resume as one open turn.
      const fetch = jsonFetch(200, {
        threadId: "t-1",
        status: "busy",
        events: [...closed, ...openHead],
        warnings: [],
        truncated: false,
      })
      const runner = new B4AgentRunner({ url: "http://b4.test", fetch })
      vi.spyOn(runner, "isRunning").mockResolvedValue(true)
      const messages = [
        { id: "c-1", role: "user", content: "one" },
        { id: "c-3", role: "user", content: "three" },
        { id: "c-4", role: "assistant", content: "draft" },
      ]
      const parkedStart = {
        type: EventType.RUN_STARTED,
        threadId: "t-1",
        runId: "park",
        input: { threadId: "t-1", runId: "park", messages },
      } as unknown as BaseEvent
      const parkedText = {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "park-a",
        role: "assistant",
      } as BaseEvent
      const parked = {
        type: EventType.RUN_FINISHED,
        threadId: "t-1",
        runId: "park",
        outcome: { type: "interrupt", interrupts: [{ id: "i-1", reason: "tool_call" }] },
      } as unknown as BaseEvent
      const resumeStart = {
        type: EventType.RUN_STARTED,
        threadId: "t-1",
        runId: "resume",
        input: {
          threadId: "t-1",
          runId: "resume",
          messages,
          resume: [{ interruptId: "i-1", status: "resolved", payload: { approved: true } }],
        },
      } as unknown as BaseEvent
      const resumeText = {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "resume-a",
        role: "assistant",
      } as BaseEvent
      const { later, spy } = liveInner([
        ...historic,
        parkedStart,
        parkedText,
        parked,
        resumeStart,
        resumeText,
      ])
      const seen: BaseEvent[] = []
      runner.connect({ threadId: "t-1" }).subscribe({ next: (event) => seen.push(event) })
      await vi.waitFor(() => expect(spy).toHaveBeenCalled())
      const finished = {
        type: EventType.RUN_FINISHED,
        threadId: "t-1",
        runId: "resume",
        outcome: { type: "success" },
      } as BaseEvent
      later.next(finished)
      const cut = (event: BaseEvent) => ({
        ...event,
        input: {
          ...(event as unknown as { input: object }).input,
          messages: [{ id: "c-3", role: "user", content: "three" }],
        },
      })
      expect(seen).toEqual([
        ...closed,
        cut(parkedStart),
        parkedText,
        parked,
        cut(resumeStart),
        resumeText,
        finished,
      ])
    })

    it("rejoins a resumed run from its own start when the parked run ran elsewhere", async () => {
      const fetch = jsonFetch(200, {
        threadId: "t-1",
        status: "busy",
        events: closed,
        warnings: [],
        truncated: false,
      })
      const runner = new B4AgentRunner({ url: "http://b4.test", fetch })
      vi.spyOn(runner, "isRunning").mockResolvedValue(true)
      const resumeStart = {
        type: EventType.RUN_STARTED,
        threadId: "t-1",
        runId: "resume",
        input: { messages: [], resume: [{ interruptId: "i-1", status: "resolved" }] },
      } as unknown as BaseEvent
      const { spy } = liveInner([...historic, resumeStart, currentText])
      const seen: BaseEvent[] = []
      runner.connect({ threadId: "t-1" }).subscribe({ next: (event) => seen.push(event) })
      await vi.waitFor(() => expect(spy).toHaveBeenCalled())
      expect(seen).toEqual([...closed, resumeStart, currentText])
    })

    it("emits only the new run when the in-memory batch holds just finished runs", async () => {
      const fetch = jsonFetch(200, {
        threadId: "t-1",
        status: "busy",
        events: closed,
        warnings: [],
        truncated: false,
      })
      const runner = new B4AgentRunner({ url: "http://b4.test", fetch })
      vi.spyOn(runner, "isRunning").mockResolvedValue(true)
      const { later, spy } = liveInner(historic)
      const seen: BaseEvent[] = []
      runner.connect({ threadId: "t-1" }).subscribe({ next: (event) => seen.push(event) })
      await vi.waitFor(() => expect(spy).toHaveBeenCalled())
      const finished = {
        type: EventType.RUN_FINISHED,
        threadId: "t-1",
        runId: "live-3",
        outcome: { type: "success" },
      } as BaseEvent
      later.next(currentStarted)
      later.next(currentText)
      later.next(finished)
      expect(seen).toEqual([
        ...closed,
        {
          ...currentStarted,
          input: {
            ...(currentStarted as unknown as { input: object }).input,
            messages: [{ id: "c-3", role: "user", content: "three" }],
          },
        },
        currentText,
        finished,
      ])
    })

    it("re-reads the replay when the run ended while the history was being read", async () => {
      const bodies = [
        { threadId: "t-1", status: "busy", events: [...closed, ...openHead] },
        { threadId: "t-1", status: "idle", events: [...closed, ...turn("r-3", "three")] },
      ]
      const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ ...bodies.shift(), warnings: [], truncated: false }),
      )
      const runner = new B4AgentRunner({ url: "http://b4.test", fetch })
      vi.spyOn(runner, "isRunning").mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      const { spy } = liveInner()
      const seen = await lastValueFrom(runner.connect({ threadId: "t-1" }).pipe(toArray()))
      expect(seen).toEqual([...closed, ...turn("r-3", "three")])
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(spy).not.toHaveBeenCalled()
    })

    it("aborts the history read when the subscriber unsubscribes before it lands", async () => {
      let signal: AbortSignal | undefined
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      })
      const runner = new B4AgentRunner({ url: "http://b4.test", fetch })
      vi.spyOn(runner, "isRunning").mockResolvedValue(true)
      const { spy } = liveInner()
      const subscription = runner.connect({ threadId: "t-1" }).subscribe()
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
      subscription.unsubscribe()
      expect(signal?.aborted).toBe(true)
      expect(spy).not.toHaveBeenCalled()
    })

    it("unsubscribes the live inner stream when the subscriber unsubscribes", async () => {
      const fetch = jsonFetch(200, {
        threadId: "t-1",
        status: "busy",
        events: closed,
        warnings: [],
        truncated: false,
      })
      const runner = new B4AgentRunner({ url: "http://b4.test", fetch })
      vi.spyOn(runner, "isRunning").mockResolvedValue(true)
      const { spy, isUnsubscribed } = liveInner()
      const subscription = runner.connect({ threadId: "t-1" }).subscribe()
      await vi.waitFor(() => expect(spy).toHaveBeenCalled())
      subscription.unsubscribe()
      expect(isUnsubscribed()).toBe(true)
    })
  })

  it("reports replay warnings once through onWarnings", async () => {
    const onWarnings = vi.fn()
    const fetch = jsonFetch(200, {
      threadId: "t-1",
      status: "idle",
      events: [],
      warnings: ["w"],
      truncated: false,
    })
    await lastValueFrom(
      new B4AgentRunner({ url: "http://b4.test", fetch, onWarnings })
        .connect({ threadId: "t-1" })
        .pipe(toArray()),
    )
    expect(onWarnings).toHaveBeenCalledWith("t-1", ["w"])
  })

  it("aborts the replay read when the subscriber unsubscribes", async () => {
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    const subscription = new B4AgentRunner({ url: "http://b4.test", fetch })
      .connect({ threadId: "t-1" })
      .subscribe()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    subscription.unsubscribe()
    expect(signal?.aborted).toBe(true)
  })
})
