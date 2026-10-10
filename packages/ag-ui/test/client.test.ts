import { HttpAgent } from "@ag-ui/client"
import type { RunAgentInput } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"
import { B4HttpAgent } from "../src/client.js"

const URL = "http://localhost:3001/agui/%2Fchat%23agent"

function recordingFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ init, url })
    return response()
  }
  return { calls, fetch }
}

describe("B4HttpAgent.getCapabilities", () => {
  it("GETs the run URL with the agent's headers and returns the parsed document", async () => {
    const document = {
      humanInTheLoop: { approvals: true, interrupts: true, supported: true },
      tools: { clientProvided: true, supported: true },
    }
    const { calls, fetch } = recordingFetch(() => Response.json(document))
    const agent = new B4HttpAgent({
      fetch,
      headers: { accept: "text/event-stream", authorization: "Bearer t" },
      url: URL,
    })

    expect(await agent.getCapabilities()).toEqual(document)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(URL)
    expect(calls[0]?.init).toMatchObject({
      // The caller's own `accept`, in any case, is replaced rather than merged.
      headers: { Accept: "application/json", authorization: "Bearer t" },
      method: "GET",
    })
    expect(calls[0]?.init.headers).not.toHaveProperty("accept")
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it("throws on a non-2xx answer instead of reporting nothing declared", async () => {
    const { fetch } = recordingFetch(() => Response.json({ error: "nope" }, { status: 404 }))
    const agent = new B4HttpAgent({ fetch, url: URL })

    await expect(agent.getCapabilities()).rejects.toThrow(/404/)
  })

  it("gives up on a server that never answers", async () => {
    const timeout = new AbortController()
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal)
    try {
      const agent = new B4HttpAgent({
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
          }),
        url: URL,
      })
      const pending = agent.getCapabilities()
      expect(spy).toHaveBeenCalledWith(10_000)
      timeout.abort(new DOMException("timed out", "TimeoutError"))
      await expect(pending).rejects.toThrow("timed out")
    } finally {
      spy.mockRestore()
    }
  })

  it("rejects a document that is not AgentCapabilities", async () => {
    const { fetch } = recordingFetch(() => Response.json({ tools: { supported: "yes" } }))
    const agent = new B4HttpAgent({ fetch, url: URL })

    await expect(agent.getCapabilities()).rejects.toThrow()
  })

  it("is still an HttpAgent, and clone() keeps the subclass", () => {
    const agent = new B4HttpAgent({ url: URL })
    const clone = agent.clone()

    expect(agent).toBeInstanceOf(HttpAgent)
    expect(clone).toBeInstanceOf(B4HttpAgent)
    expect(clone.url).toBe(URL)
  })
})

const runInput: RunAgentInput = {
  context: [],
  forwardedProps: {},
  messages: [],
  runId: "r1",
  state: {},
  threadId: "t1",
  tools: [],
}

const responseSchema = {
  additionalProperties: false,
  properties: { ui: { type: "array" } },
  required: ["ui"],
  type: "object",
}

/** Exposes the protected `requestInit` so a test can read the run body. */
class RunBodyProbe extends B4HttpAgent {
  init(input: RunAgentInput = runInput): RequestInit {
    return this.requestInit(input)
  }

  body(input?: RunAgentInput): Record<string, unknown> {
    return JSON.parse(String(this.init(input).body)) as Record<string, unknown>
  }
}

describe("B4HttpAgent responseSchema", () => {
  it("without one, the run body is the plain AG-UI input", () => {
    const body = new RunBodyProbe({ url: URL }).body()
    expect(body.forwardedProps).toEqual({})
    expect(body.threadId).toBe("t1")
  })

  it("with one, every run's forwardedProps carries responseSchema and nothing library-specific", () => {
    const agent = new RunBodyProbe({ responseSchema, url: URL })
    expect(agent.responseSchema).toBe(responseSchema)
    const body = agent.body()
    expect(body.forwardedProps).toEqual({ responseSchema })
    expect(body).not.toHaveProperty("hashbrown")
    expect(body.threadId).toBe("t1")
    expect(body.runId).toBe("r1")
    // A second run carries it too.
    expect(agent.body().forwardedProps).toEqual({ responseSchema })
  })

  it("keeps the forwardedProps the run already carries", () => {
    const agent = new RunBodyProbe({ responseSchema, url: URL })
    const body = agent.body({ ...runInput, forwardedProps: { toolChoice: "auto" } })
    expect(body.forwardedProps).toEqual({ responseSchema, toolChoice: "auto" })
  })

  it("keeps the base request's method and headers", () => {
    const agent = new RunBodyProbe({
      headers: { authorization: "Bearer t" },
      responseSchema,
      url: URL,
    })
    const init = agent.init()
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      authorization: "Bearer t",
    })
  })

  it("sends the schema on the wire when the agent runs", async () => {
    const { calls, fetch } = recordingFetch(() => new Response("", { status: 500 }))
    const agent = new B4HttpAgent({ fetch, responseSchema, url: URL })
    await agent.runAgent().catch(() => undefined)
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.forwardedProps).toEqual({ responseSchema })
  })

  it("a clone keeps the schema", () => {
    const agent = new RunBodyProbe({ responseSchema, url: URL })
    const clone = agent.clone()
    expect(clone).toBeInstanceOf(RunBodyProbe)
    expect((clone as RunBodyProbe).responseSchema).toBe(responseSchema)
    expect((clone as RunBodyProbe).body().forwardedProps).toEqual({ responseSchema })
  })

  it("a clone of an agent without one still sends none", () => {
    const clone = new RunBodyProbe({ url: URL }).clone() as RunBodyProbe
    expect(clone.body().forwardedProps).toEqual({})
  })
})
