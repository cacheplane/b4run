import { NextRequest } from "next/server"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ownerCookieValue } from "../../../lib/proxy-guard"
import { GET } from "./route"

function call(
  path: readonly string[],
  init?: { method?: string; headers?: Record<string, string> },
): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/b4/${path.join("/")}`, init), {
    params: Promise.resolve({ path: [...path] }),
  })
}

/** The headers the proxy sent upstream on its only fetch. */
function upstreamHeadersOf(fetchSpy: { mock: { calls: unknown[][] } }): Headers {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined
  return new Headers(init?.headers)
}

describe("b4 proxy route", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  test("forwards an allowed path to the resolved upstream URL", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      )

    await call(["memory", "candidates"])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toBe("http://127.0.0.1:3002/memory/candidates")
  })

  test("passes status, content-type and cache-control through untouched", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response('{"ok":true}', {
        status: 201,
        headers: { "content-type": "application/json", "cache-control": "private, max-age=5" },
      }),
    )

    const response = await call(["memory", "candidates"])

    expect(response.status).toBe(201)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("cache-control")).toBe("private, max-age=5")
  })

  test("defaults to no-store when upstream sends no cache-control", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))

    const response = await call(["memory", "candidates"])

    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("omits content-type rather than inventing one for a bodyless upstream reply", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 204 }))

    const response = await call(["memory", "candidates", "abc", "approve"], { method: "POST" })

    expect(response.headers.has("content-type")).toBe(false)
  })

  // 403 rather than 404 on purpose: a 404 would read as "no such thing yet",
  // which hides a broken allowlist.
  test("rejects a path that is not on the allowlist without calling fetch", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")

    const response = await call(["threads", "t1", "resume"], { method: "POST" })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "Not proxied" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("does not proxy thread state", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")

    const response = await call(["threads", "t1", "state"])

    expect(response.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("returns 502 with the underlying cause when fetch rejects", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3002"), {
      code: "ECONNREFUSED",
    })
    vi.spyOn(global, "fetch").mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause }),
    )

    const response = await call(["memory", "candidates"])

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain("ECONNREFUSED")
  })

  test("mints a visitor cookie and forwards the visitor id, with no token in development", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "")
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}"))

    const response = await call(["memory", "candidates"])

    const cookie = response.headers.get("set-cookie") ?? ""
    const minted = /b4_visitor=(v-[A-Za-z0-9_-]+)/.exec(cookie)?.[1]
    expect(minted).toBeDefined()
    expect(cookie).toContain("HttpOnly")
    expect(cookie).not.toContain("Secure")
    const sent = upstreamHeadersOf(fetchSpy)
    expect(sent.get("x-b4-visitor")).toBe(minted)
    expect(sent.has("x-internal-token")).toBe(false)
  })

  test("keeps an existing visitor cookie and injects the token when deployed", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "server-secret-0123456789abcdefghijkl")
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}"))

    const response = await call(["memory", "candidates"], {
      headers: { cookie: "__Host-b4_visitor=v-returning01" },
    })

    expect(response.headers.has("set-cookie")).toBe(false)
    const sent = upstreamHeadersOf(fetchSpy)
    expect(sent.get("x-b4-visitor")).toBe("v-returning01")
    expect(sent.get("x-internal-token")).toBe("server-secret-0123456789abcdefghijkl")
  })

  test("refuses a cross-origin call when an origin allowlist is set", async () => {
    vi.stubEnv("B4_DEMO_ORIGINS", "https://navlog.b4.run")
    const fetchSpy = vi.spyOn(global, "fetch")

    const response = await call(["memory", "candidates"], {
      headers: { origin: "https://evil.example" },
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "origin_not_allowed" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("reserves memory approval for the demo owner when deployed", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "server-secret-0123456789abcdefghijkl")
    vi.stubEnv("B4_DEMO_ADMIN_TOKEN", "owner-secret")
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}"))

    const visitor = await call(["memory", "candidates", "c1", "approve"], { method: "POST" })
    expect(visitor.status).toBe(403)
    expect(await visitor.json()).toMatchObject({ error: "owner_only" })
    expect(fetchSpy).not.toHaveBeenCalled()

    const owner = await call(["memory", "candidates", "c1", "approve"], {
      method: "POST",
      headers: { cookie: `__Host-b4_demo_owner=${ownerCookieValue("owner-secret")}` },
    })
    expect(owner.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // The raw token is not the cookie: only its HMAC is.
    const raw = await call(["memory", "candidates", "c1", "approve"], {
      method: "POST",
      headers: { cookie: "__Host-b4_demo_owner=owner-secret" },
    })
    expect(raw.status).toBe(403)
  })

  test("leaves memory approval open in development", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "")
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}"))

    const response = await call(["memory", "candidates", "c1", "reject"], { method: "POST" })

    expect(response.status).toBe(200)
  })
})
