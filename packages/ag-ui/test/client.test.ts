import { HttpAgent } from "@ag-ui/client"
import { describe, expect, it } from "vitest"
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
    const agent = new B4HttpAgent({ fetch, headers: { authorization: "Bearer t" }, url: URL })

    expect(await agent.getCapabilities()).toEqual(document)
    expect(calls).toEqual([
      {
        init: { headers: { Accept: "application/json", authorization: "Bearer t" }, method: "GET" },
        url: URL,
      },
    ])
  })

  it("throws on a non-2xx answer instead of reporting nothing declared", async () => {
    const { fetch } = recordingFetch(() => Response.json({ error: "nope" }, { status: 404 }))
    const agent = new B4HttpAgent({ fetch, url: URL })

    await expect(agent.getCapabilities()).rejects.toThrow(/404/)
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
