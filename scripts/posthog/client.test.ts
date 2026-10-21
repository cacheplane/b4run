import { describe, expect, it } from "vitest"
import { createPosthogClient } from "./client.ts"
import type { PosthogEnv } from "./env.ts"

const env: PosthogEnv = {
  POSTHOG_PERSONAL_API_KEY: "k".repeat(30),
  POSTHOG_HOST: "https://ph.example.com",
  POSTHOG_PROJECT_ID: 7,
}

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("createPosthogClient", () => {
  it("builds project urls, sends auth and JSON bodies", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return json(200, { id: 1 })
    }) as unknown as typeof fetch
    const client = createPosthogClient(env, fetchImpl, async () => undefined)
    await client.post("/insights/", { a: 1 })
    await client.get("/insights/", { limit: "5" })
    expect(calls[0]?.url).toBe("https://ph.example.com/api/projects/7/insights/")
    expect(calls[0]?.init.method).toBe("POST")
    expect(calls[0]?.init.body).toBe('{"a":1}')
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>
    expect(headers["Authorization"]).toBe(`Bearer ${env.POSTHOG_PERSONAL_API_KEY}`)
    expect(calls[1]?.url).toBe("https://ph.example.com/api/projects/7/insights/?limit=5")
  })

  it("retries 429/5xx with exponential backoff then succeeds", async () => {
    const statuses = [429, 503]
    const sleeps: number[] = []
    const fetchImpl = (async () => {
      const status = statuses.shift()
      return status ? json(status) : json(200, { ok: true })
    }) as unknown as typeof fetch
    const client = createPosthogClient(env, fetchImpl, async (ms) => {
      sleeps.push(ms)
    })
    expect(await client.get("/x/")).toEqual({ ok: true })
    expect(sleeps).toEqual([500, 1000])
  })

  it("throws naming method, path and status after three attempts", async () => {
    let attempts = 0
    const fetchImpl = (async () => {
      attempts += 1
      return json(502)
    }) as unknown as typeof fetch
    const client = createPosthogClient(env, fetchImpl, async () => undefined)
    await expect(client.patch("/insights/3/", {})).rejects.toThrow(/PATCH \/insights\/3\/.*502/)
    expect(attempts).toBe(3)
  })

  it("does not retry a 404 and handles delete", async () => {
    let attempts = 0
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      attempts += 1
      return init.method === "DELETE" ? new Response(null, { status: 404 }) : json(200)
    }) as unknown as typeof fetch
    const client = createPosthogClient(env, fetchImpl, async () => undefined)
    await expect(client.delete("/insights/3/")).rejects.toThrow(/DELETE.*404/)
    expect(attempts).toBe(1)
  })
})
