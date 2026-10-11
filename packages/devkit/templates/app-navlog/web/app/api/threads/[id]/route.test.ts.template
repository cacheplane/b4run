import { afterEach, describe, expect, test, vi } from "vitest"
import { GET } from "./route"

function call(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/threads/${encodeURIComponent(id)}`), {
    params: Promise.resolve({ id }),
  })
}

describe("thread access route", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  test("204 for a thread the server serves, with no body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ thread_id: "t-1", values: { secret: true } }))

    const response = await call("t-1")

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(response.headers.get("cache-control")).toBe("no-store")
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toMatch(/\/threads\/t-1$/)
    expect(new Headers(init?.headers).get("x-b4-visitor")).toMatch(/^v-/)
  })

  test("404 for a thread the server refuses or does not know", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }))

    const response = await call("t-other")

    expect(response.status).toBe(404)
    expect(await response.text()).toBe("")
  })

  test("the id is one encoded path segment", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null))

    await call("../memory/candidates")

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/threads\/\.\.%2Fmemory%2Fcandidates$/)
  })

  test("502 when the server is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"))

    expect((await call("t-1")).status).toBe(502)
  })
})
