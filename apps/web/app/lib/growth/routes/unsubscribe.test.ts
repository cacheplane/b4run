import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SqlExecutor } from "../database"
import { createActionToken } from "../tokens"

const stop = vi.hoisted(() => vi.fn())
vi.mock("../contacts", () => ({ stopContact: stop }))

import {
  handleUnsubscribeGet,
  handleUnsubscribePost,
  type UnsubscribeRouteDeps,
} from "./unsubscribe"

const SECRET = "token-secret"
const CONTACT_ID = "7d9f3b0e-2c1a-4f6e-9a55-0b1d2c3e4f50"
const NOW = new Date("2026-10-21T00:00:00Z")
const URL_BASE = "http://localhost/api/growth/unsubscribe"
const token = (purpose: "unsubscribe" | "founder_stop" = "unsubscribe") =>
  createActionToken({
    secret: SECRET,
    contactId: CONTACT_ID,
    purpose,
    issuedAt: NOW,
  })

function deps(): UnsubscribeRouteDeps {
  return {
    loadEnv: () => ({
      databaseUrl: "postgres://x",
      emailHmacSecret: "s",
      tokenSecret: SECRET,
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

describe("unsubscribe route", () => {
  beforeEach(() => {
    stop.mockReset()
    stop.mockResolvedValue({ applied: true })
  })

  it("GET with a valid token renders the confirmation without calling stopContact", async () => {
    const t = token()
    const res = await handleUnsubscribeGet(new Request(`${URL_BASE}?token=${t}`), deps())
    expect(res.status).toBe(200)
    expectHeaders(res)
    expect(await res.text()).toContain(t)
    expect(stop).not.toHaveBeenCalled()
  })

  it("GET with a bad token renders the uniform failure with 400", async () => {
    const res = await handleUnsubscribeGet(new Request(`${URL_BASE}?token=nope`), deps())
    expect(res.status).toBe(400)
    expectHeaders(res)
    expect(await res.text()).toContain("This link is not valid.")
    const missing = await handleUnsubscribeGet(new Request(URL_BASE), deps())
    expect(missing.status).toBe(400)
    expect(stop).not.toHaveBeenCalled()
  })

  it("POST one-click (urlencoded List-Unsubscribe=One-Click, token in the query) stops the contact and returns 200", async () => {
    const res = await handleUnsubscribePost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      deps(),
    )
    expect(res.status).toBe(200)
    expectHeaders(res)
    expect(res.headers.get("location")).toBeNull()
    expect(stop).toHaveBeenCalledWith(expect.anything(), {
      contactId: CONTACT_ID,
      reason: "unsubscribe",
      provenance: "unsubscribe_link",
      now: NOW,
    })
  })

  it("POST with a urlencoded token field (the confirm form) stops the contact", async () => {
    const res = await handleUnsubscribePost(
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
    const res = await handleUnsubscribePost(
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
    const res = await handleUnsubscribePost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      deps(),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("unsubscribed")
  })

  it("POST with a founder_stop token is rejected (wrong purpose)", async () => {
    const res = await handleUnsubscribePost(
      new Request(`${URL_BASE}?token=${token("founder_stop")}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      deps(),
    )
    expect(res.status).toBe(400)
    expectHeaders(res)
    expect(stop).not.toHaveBeenCalled()
  })

  it("POST rejects an oversize body, a missing token and unsupported content", async () => {
    const big = await handleUnsubscribePost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `x=${"a".repeat(5000)}`,
      }),
      deps(),
    )
    expect(big.status).toBe(400)
    const none = await handleUnsubscribePost(
      new Request(URL_BASE, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      deps(),
    )
    expect(none.status).toBe(400)
    const text = await handleUnsubscribePost(
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
    const res = await handleUnsubscribePost(
      new Request(`${URL_BASE}?token=${token()}`, { method: "POST" }),
      deps(),
    )
    expect(res.status).toBe(200)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("POST urlencoded with an empty body uses the query token", async () => {
    const res = await handleUnsubscribePost(
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
    const res = await handleUnsubscribePost(
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
    const res = await handleUnsubscribePost(req, deps())
    expect(res.status).toBe(503)
    expectHeaders(res)
  })

  it("POST answers 503 with the failure page on a database error, never the message", async () => {
    stop.mockRejectedValue(new Error("connection refused secret-host"))
    const res = await handleUnsubscribePost(
      new Request(`${URL_BASE}?token=${token()}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      deps(),
    )
    expect(res.status).toBe(503)
    expectHeaders(res)
    const text = await res.text()
    expect(text).toContain("This link is not valid.")
    expect(text).not.toContain("secret-host")
  })
})
