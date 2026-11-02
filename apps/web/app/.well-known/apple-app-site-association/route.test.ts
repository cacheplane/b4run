import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET } from "./route"

const TEAM = "ABCDE12345"

function request(host: string | null): Request {
  return new Request("https://example.invalid/.well-known/apple-app-site-association", {
    headers: host === null ? {} : { host },
  })
}

beforeEach(() => {
  vi.stubEnv("APPLE_TEAM_ID", TEAM)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

function expected(macSuffix: string, iosSuffix: string) {
  const ios = `${TEAM}.com.cacheplane.b4app.ios${iosSuffix}`
  return {
    webcredentials: { apps: [`${TEAM}.com.cacheplane.b4app${macSuffix}`, ios] },
    applinks: {
      details: [{ appIDs: [ios], components: [{ "/": "/pair", comment: "Pair an iPhone" }] }],
    },
  }
}

describe("apple-app-site-association", () => {
  it.each([
    ["b4.run", "", ""],
    ["www.b4.run", "", ""],
    ["test.b4.run", ".beta", ""],
    ["local.b4.run", ".local", ".local"],
  ])("answers %s with its flavour's app ids", async (host, mac, ios) => {
    const response = await GET(request(host))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expected(mac, ios))
  })

  it("answers application/json", async () => {
    const response = await GET(request("b4.run"))
    expect(response.headers.get("content-type")).toMatch(/^application\/json/)
  })

  it("does not redirect", async () => {
    const response = await GET(request("b4.run"))
    expect(response.redirected).toBe(false)
    expect(response.headers.get("location")).toBeNull()
  })

  it("answers 404 for an unknown host, a preview host, and a missing host", async () => {
    for (const host of ["example.com", "web-abc-cacheplane.vercel.app", "localhost:3000", null]) {
      expect((await GET(request(host))).status, String(host)).toBe(404)
    }
  })

  it("answers 404 when APPLE_TEAM_ID is unset or empty", async () => {
    vi.stubEnv("APPLE_TEAM_ID", "")
    expect((await GET(request("b4.run"))).status).toBe(404)
    vi.unstubAllEnvs()
    delete process.env.APPLE_TEAM_ID
    expect((await GET(request("b4.run"))).status).toBe(404)
  })

  it("answers 404 for a malformed team id rather than serving a broken file", async () => {
    vi.stubEnv("APPLE_TEAM_ID", "not a team id")
    expect((await GET(request("b4.run"))).status).toBe(404)
  })
})
