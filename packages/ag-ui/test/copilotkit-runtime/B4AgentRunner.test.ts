import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { InMemoryAgentRunner } from "@copilotkit/runtime/v2"
import { lastValueFrom, of, toArray } from "rxjs"
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

  it("forwards the connect request's headers", async () => {
    const fetch = jsonFetch(200, {
      threadId: "t-1",
      status: "idle",
      events: [],
      warnings: [],
      truncated: false,
    })
    await lastValueFrom(
      new B4AgentRunner({ url: "http://b4.test", fetch })
        .connect({ threadId: "t-1", headers: { authorization: "Bearer x" } })
        .pipe(toArray()),
    )
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer x")
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

  it("delegates to the in-memory runner while a run for the thread is live in this process", async () => {
    const fetch = jsonFetch(200, {})
    const runner = new B4AgentRunner({ url: "http://b4.test", fetch })
    vi.spyOn(runner, "isRunning").mockResolvedValue(true)
    const live = vi.spyOn(InMemoryAgentRunner.prototype, "connect").mockReturnValue(of(...EVENTS))
    const events = await lastValueFrom(runner.connect({ threadId: "t-1" }).pipe(toArray()))
    expect(events).toEqual(EVENTS)
    expect(live).toHaveBeenCalledWith({ threadId: "t-1" })
    expect(fetch).not.toHaveBeenCalled()
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
