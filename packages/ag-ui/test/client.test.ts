import { HttpAgent } from "@ag-ui/client"
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
