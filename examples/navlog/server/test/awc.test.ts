import { afterEach, describe, expect, it, vi } from "vitest"
import { AwcClient } from "../src/lib/awc.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("AwcClient", () => {
  it("builds the airport URL and parses JSON", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ icaoId: "KSTP", lat: 44.9, lon: -93.1 }]))
    vi.stubGlobal("fetch", fetchMock)
    const client = new AwcClient({ baseUrl: "https://awc.test/api/data", now: () => 0 })
    const data = await client.getJson<{ icaoId: string }[]>("airport", { ids: "KSTP" })
    expect(data[0]?.icaoId).toBe("KSTP")
    expect(fetchMock).toHaveBeenCalledWith(
      "https://awc.test/api/data/airport?ids=KSTP&format=json",
      expect.anything(),
    )
  })
  it("serves a repeat request from the cache inside the TTL and refetches after it", async () => {
    let now = 0
    const fetchMock = vi.fn(async () => jsonResponse({ n: 1 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = new AwcClient({ baseUrl: "https://awc.test/api/data", now: () => now })
    await client.getJson("metar", { ids: "KSTP" })
    await client.getJson("metar", { ids: "KSTP" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now = 5 * 60_000 + 1
    await client.getJson("metar", { ids: "KSTP" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it("refetches after clearCache inside the TTL", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ n: 1 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = new AwcClient({ baseUrl: "https://awc.test/api/data", now: () => 0 })
    await client.getJson("metar", { ids: "KSTP" })
    client.clearCache()
    await client.getJson("metar", { ids: "KSTP" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it("reads a 204 No Content answer as an empty array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    )
    const client = new AwcClient({ baseUrl: "https://awc.test/api/data", now: () => 0 })
    await expect(client.getJson("airsigmet", {})).resolves.toEqual([])
  })
  it("throws a readable error on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    )
    const client = new AwcClient({ baseUrl: "https://awc.test/api/data", now: () => 0 })
    await expect(client.getText("windtemp", { region: "chi" })).rejects.toThrow(
      /aviationweather.gov windtemp returned 503/,
    )
  })
  it("abandons a request that never answers once its timeout passes", async () => {
    const neverAnswers = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        }),
    )
    vi.stubGlobal("fetch", neverAnswers)
    const client = new AwcClient({
      baseUrl: "https://awc.test/api/data",
      now: () => 0,
      timeoutMs: 20,
    })
    await expect(client.getText("metar", { ids: "KSTP" })).rejects.toThrow(/timed? ?out|aborted/i)
  })
  it("passes the abort signal through", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return jsonResponse([])
    })
    vi.stubGlobal("fetch", fetchMock)
    const client = new AwcClient({ baseUrl: "https://awc.test/api/data", now: () => 0 })
    await client.getJson("taf", { ids: "KRST" }, new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
