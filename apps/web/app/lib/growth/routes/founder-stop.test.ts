import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SqlExecutor } from "../database"
import { createActionToken } from "../tokens"

const stop = vi.hoisted(() => vi.fn())
vi.mock("../contacts", () => ({ stopContact: stop }))

import {
  type FounderStopRouteDeps,
  handleFounderStopGet,
  handleFounderStopPost,
} from "./founder-stop"

const KEYRING = { active: { id: 1, secret: "token-secret" }, previous: [] }
const CONTACT_ID = "7d9f3b0e-2c1a-4f6e-9a55-0b1d2c3e4f50"
const NOW = new Date("2026-10-21T00:00:00Z")
const URL_BASE = "http://localhost/api/growth/founder-stop"
const token = (purpose: "unsubscribe" | "founder_stop" = "founder_stop") =>
  createActionToken({
    keyring: KEYRING,
    contactId: CONTACT_ID,
    purpose,
    issuedAt: NOW,
  })

function deps(): FounderStopRouteDeps {
  return {
    loadEnv: () => ({
      databaseUrl: "postgres://x",
      emailHmacSecret: "s",
      tokenKeyring: KEYRING,
      environment: "test",
      publicOrigin: "https://b4.run",
    }),
    createExecutor: () => ({}) as SqlExecutor,
    now: () => NOW,
  }
}

function expectHeaders(res: Response) {
  expect(res.headers.get("cache-control")).toBe("no-store")
  expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  expect(res.headers.get("x-robots-tag")).toBe("noindex")
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
  expect(res.headers.get("set-cookie")).toBeNull()
}

describe("founder-stop route", () => {
  beforeEach(() => {
    stop.mockReset()
    stop.mockResolvedValue({ applied: true })
  })

  it("GET with a valid token renders the confirmation without calling stopContact", async () => {
    const t = token()
    const res = await handleFounderStopGet(new Request(`${URL_BASE}?token=${t}`), deps())
    expect(res.status).toBe(200)
    expectHeaders(res)
    const body = await res.text()
    expect(body).toContain(t)
    expect(body).toContain('action="/api/growth/founder-stop"')
    expect(body).toContain("Stop the sequence</button>")
    expect(stop).not.toHaveBeenCalled()
  })

  it("GET with an unsubscribe token renders the uniform failure", async () => {
    const res = await handleFounderStopGet(
      new Request(`${URL_BASE}?token=${token("unsubscribe")}`),
      deps(),
    )
    expect(res.status).toBe(400)
    expectHeaders(res)
    expect(await res.text()).toContain("This link is not valid.")
  })

  it("GET with a founder_stop token older than seven days renders the uniform failure", async () => {
    const res = await handleFounderStopGet(new Request(`${URL_BASE}?token=${token()}`), {
      ...deps(),
      now: () => new Date(NOW.getTime() + 604_801_000),
    })
    expect(res.status).toBe(400)
    expectHeaders(res)
  })

  it("GET with a bad token renders the uniform failure with 400", async () => {
    const res = await handleFounderStopGet(new Request(`${URL_BASE}?token=nope`), deps())
    expect(res.status).toBe(400)
    expectHeaders(res)
    expect(await res.text()).toContain("This link is not valid.")
    const missing = await handleFounderStopGet(new Request(URL_BASE), deps())
    expect(missing.status).toBe(400)
    expect(stop).not.toHaveBeenCalled()
  })

  it("POST with the token in the query (urlencoded body) stops the contact and returns 200", async () => {
    const res = await handleFounderStopPost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "confirm=1",
      }),
      deps(),
    )
    expect(res.status).toBe(200)
    expectHeaders(res)
    expect(res.headers.get("location")).toBeNull()
    expect(stop).toHaveBeenCalledWith(expect.anything(), {
      contactId: CONTACT_ID,
      reason: "reply_received",
      provenance: "founder_stop_link",
      now: NOW,
    })
  })

  it("POST with a urlencoded token field (the confirm form) stops the contact", async () => {
    const res = await handleFounderStopPost(
      new Request(URL_BASE, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: token() }).toString(),
      }),
      deps(),
    )
    expect(res.status).toBe(200)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("POST with a JSON token stops the contact", async () => {
    const res = await handleFounderStopPost(
      new Request(URL_BASE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token() }),
      }),
      deps(),
    )
    expect(res.status).toBe(200)
    expectHeaders(res)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("POST for an already-stopped contact still returns 200 done", async () => {
    stop.mockResolvedValue({ applied: false })
    const res = await handleFounderStopPost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "confirm=1",
      }),
      deps(),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("The sequence is stopped.")
  })

  it("POST with an unsubscribe token is rejected (wrong purpose)", async () => {
    const res = await handleFounderStopPost(
      new Request(`${URL_BASE}?token=${token("unsubscribe")}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "confirm=1",
      }),
      deps(),
    )
    expect(res.status).toBe(400)
    expectHeaders(res)
    expect(stop).not.toHaveBeenCalled()
  })

  it("POST rejects an oversize body, a missing token and unsupported content", async () => {
    const big = await handleFounderStopPost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `x=${"a".repeat(5000)}`,
      }),
      deps(),
    )
    expect(big.status).toBe(400)
    const none = await handleFounderStopPost(
      new Request(URL_BASE, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "confirm=1",
      }),
      deps(),
    )
    expect(none.status).toBe(400)
    const text = await handleFounderStopPost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hi",
      }),
      deps(),
    )
    expect(text.status).toBe(400)
    expect(stop).not.toHaveBeenCalled()
  })

  it("POST with no headers and no body uses the query token", async () => {
    const res = await handleFounderStopPost(
      new Request(`${URL_BASE}?token=${token()}`, { method: "POST" }),
      deps(),
    )
    expect(res.status).toBe(200)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("POST urlencoded with an empty body uses the query token", async () => {
    const res = await handleFounderStopPost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }),
      deps(),
    )
    expect(res.status).toBe(200)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("POST rejects an oversize declared content-length before reading", async () => {
    const res = await handleFounderStopPost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-length": "99999" },
      }),
      deps(),
    )
    expect(res.status).toBe(400)
    expect(stop).not.toHaveBeenCalled()
  })

  it("POST answers the failure page with headers when the body read aborts", async () => {
    const req = new Request(`${URL_BASE}?token=${token()}`, { method: "POST" })
    vi.spyOn(req, "text").mockRejectedValue(new Error("aborted"))
    const res = await handleFounderStopPost(req, deps())
    expect(res.status).toBe(503)
    expectHeaders(res)
  })

  it("POST answers 503 with the failure page on a database error, never the message", async () => {
    stop.mockRejectedValue(new Error("connection refused secret-host"))
    const res = await handleFounderStopPost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "confirm=1",
      }),
      deps(),
    )
    expect(res.status).toBe(503)
    expectHeaders(res)
    const text = await res.text()
    expect(text).toContain("This link is not valid.")
    expect(text).not.toContain("secret-host")
  })

  it("POST logs only a safe error code, never the error message", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logged = async (error: Error) => {
      stop.mockRejectedValue(error)
      write.mockClear()
      const res = await handleFounderStopPost(
        new Request(`${URL_BASE}?token=${token()}`, { method: "POST" }),
        deps(),
      )
      expect(res.status).toBe(503)
      return write.mock.calls.map((call) => String(call[0])).join("")
    }
    try {
      const plain = await logged(new Error("connection refused secret-host ada@example.com"))
      expect(plain).toBe("founder stop failed: unclassified\n")
      const coded = await logged(
        Object.assign(new Error("terminating connection secret-host"), { code: "57P01" }),
      )
      expect(coded).toBe("founder stop failed: 57p01\n")
      const odd = await logged(Object.assign(new Error("x"), { code: "ada@example.com" }))
      expect(odd).toBe("founder stop failed: unclassified\n")
    } finally {
      write.mockRestore()
    }
  })
})
