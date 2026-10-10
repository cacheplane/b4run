import { NextRequest } from "next/server"
import { afterEach, describe, expect, test, vi } from "vitest"
import { GET } from "./route"

function call(
  q: string | undefined,
  init?: { headers?: Record<string, string> },
): Promise<Response> {
  const query = q === undefined ? "" : `?q=${encodeURIComponent(q)}`
  return GET(new NextRequest(`http://localhost/api/waypoints${query}`, init))
}

interface Body {
  readonly results: readonly { id: string; kind: string }[]
  readonly snapshot: string
}

describe("waypoints route", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  test("returns ranked results and the snapshot date, uncached", async () => {
    const response = await call("SNS")

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = (await response.json()) as Body
    expect(body.snapshot).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results.length).toBeLessThanOrEqual(8)
    expect(body.results.slice(0, 3).map((w) => `${w.kind}:${w.id}`)).toEqual(
      expect.arrayContaining(["airport:KSNS", "navaid:SNS"]),
    )
  })

  test("an empty or missing query gives no results", async () => {
    for (const q of [undefined, "", "   "]) {
      const body = (await (await call(q)).json()) as Body
      expect(body.results).toEqual([])
    }
  })

  test("caps the query at 32 characters rather than refusing it", async () => {
    // The first 32 characters are an airport id followed by padding that
    // trim() removes; the tail past the cap would otherwise make it match nothing.
    const response = await call(`KPAO${" ".repeat(28)}no-such-waypoint`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as Body
    expect(body.results[0]).toMatchObject({ id: "KPAO", kind: "airport" })
  })

  test("mints a visitor cookie, as the b4 proxy does", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "")

    const response = await call("KPAO")

    expect(response.headers.get("set-cookie") ?? "").toMatch(/b4_visitor=v-[A-Za-z0-9_-]+/)
  })

  test("refuses a cross-origin call when an origin allowlist is set", async () => {
    vi.stubEnv("B4_DEMO_ORIGINS", "https://navlog.b4.run")

    const response = await call("KPAO", { headers: { origin: "https://evil.example" } })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "origin_not_allowed" })
  })
})
