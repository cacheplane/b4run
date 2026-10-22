import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SqlExecutor } from "../database"
import { DISCLOSURE_VERSION } from "../disclosure"

const accept = vi.hoisted(() => vi.fn())
vi.mock("../contacts", () => ({ acceptFounderUpdatesForm: accept }))

import { type FounderUpdatesRouteDeps, handleFounderUpdatesPost } from "./founder-updates"

const MESSAGE = "please call me about pricing"
const body = {
  message: MESSAGE,
  email: "ada@example.com",
  disclosure_version: DISCLOSURE_VERSION,
  submission_id: "7d9f3b0e-2c1a-4f6e-9a55-0b1d2c3e4f50",
  posthog_distinct_id: "ph-1",
}

function post(payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/growth/forms/founder-updates", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  })
}

function setup(overrides: Partial<FounderUpdatesRouteDeps> = {}) {
  const capture = vi.fn(
    async (_input: { distinctId: string; event: string; properties: object }) => {},
  )
  const createExecutor = vi.fn(() => ({}) as SqlExecutor)
  const deps: FounderUpdatesRouteDeps = {
    loadEnv: () => ({
      databaseUrl: "postgres://x",
      emailHmacSecret: "s",
      tokenKeyring: { active: { id: 1, secret: "t" }, previous: [] },
      environment: "test",
      publicOrigin: "https://b4.run",
      posthogKey: "k",
    }),
    createExecutor,
    createSignals: () => ({ capture }),
    limiter: { allow: () => true },
    now: () => new Date("2026-10-21T00:00:00Z"),
    randomUUID: () => "generated-uuid",
    ...overrides,
  }
  return { deps, capture, createExecutor }
}

describe("handleFounderUpdatesPost", () => {
  beforeEach(() => {
    accept.mockReset()
    accept.mockResolvedValue({
      contactId: "c1",
      approved: true,
      emailKind: "work",
      created: true,
    })
  })

  it("accepts a valid submission, stores it, and emits site:contact_accepted with email_kind only", async () => {
    const { deps, capture } = setup()
    const response = await handleFounderUpdatesPost(post(body), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(accept).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledOnce()
    const sent = capture.mock.calls[0]?.[0]
    expect(sent?.distinctId).toBe("ph-1")
    expect(sent?.event).toBe("site:contact_accepted")
    expect(sent?.properties).toEqual({
      form: "founder_updates",
      email_kind: "work",
    })
    expect(JSON.stringify(capture.mock.calls)).not.toContain(body.email)
    expect(JSON.stringify(capture.mock.calls)).not.toContain(MESSAGE)
  })

  it("uses a generated distinct id when the browser sent none", async () => {
    const { deps, capture } = setup()
    const { posthog_distinct_id: _omit, ...rest } = body
    await handleFounderUpdatesPost(post(rest), deps)
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      distinctId: "generated-uuid",
    })
  })

  it("returns 200 and skips the database for a honeypot hit", async () => {
    const { deps, createExecutor, capture } = setup()
    const response = await handleFounderUpdatesPost(post({ ...body, b4_hp: "x" }), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(createExecutor).not.toHaveBeenCalled()
    expect(accept).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })

  it("returns 200 for a stopped contact without re-approving", async () => {
    accept.mockResolvedValue({
      contactId: "c1",
      approved: false,
      emailKind: "personal",
      created: false,
    })
    const { deps } = setup()
    const response = await handleFounderUpdatesPost(post(body), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it.each([
    ["a re-submission by an existing contact", { created: false, approved: true }],
    ["a created but unapproved contact", { created: true, approved: false }],
    ["a stopped contact", { created: false, approved: false }],
  ])("emits no signal for %s but still returns 200", async (_label, flags) => {
    accept.mockResolvedValue({ contactId: "c1", emailKind: "work", ...flags })
    const { deps, capture } = setup()
    const response = await handleFounderUpdatesPost(post(body), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(capture).not.toHaveBeenCalled()
  })

  it("returns 429 past the rate limit, keyed on the first forwarded address", async () => {
    const allow = vi.fn(() => false)
    const { deps } = setup({ limiter: { allow } })
    const response = await handleFounderUpdatesPost(
      post(body, { "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" }),
      deps,
    )
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: "rate_limited" })
    expect(allow).toHaveBeenCalledWith("1.2.3.4")
  })

  it("returns 503 when the database throws and never leaks the message", async () => {
    accept.mockRejectedValue(new Error("password=hunter2 connection refused"))
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const { deps } = setup()
    const response = await handleFounderUpdatesPost(post(body), deps)
    const text = await response.text()
    write.mockRestore()
    expect(response.status).toBe(503)
    expect(JSON.parse(text)).toEqual({ error: "unavailable" })
    expect(text).not.toContain("hunter2")
  })

  it("rejects a body over 4 KiB", async () => {
    const { deps } = setup()
    const response = await handleFounderUpdatesPost(
      post({ ...body, message: "x".repeat(5000) }),
      deps,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_body" })
  })

  it("rejects a declared content-length over 4 KiB before reading", async () => {
    const { deps } = setup()
    const request = post(body, { "content-length": "4097" })
    const spy = vi.spyOn(request, "text")
    const response = await handleFounderUpdatesPost(request, deps)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_body" })
    expect(spy).not.toHaveBeenCalled()
  })

  it("returns 400 when reading the body is aborted", async () => {
    const { deps } = setup()
    const request = post(body)
    vi.spyOn(request, "text").mockRejectedValue(new TypeError("terminated"))
    const response = await handleFounderUpdatesPost(request, deps)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_body" })
  })

  it("rejects non-JSON", async () => {
    const { deps } = setup()
    const response = await handleFounderUpdatesPost(post("not json"), deps)
    expect(response.status).toBe(400)
  })

  it("maps parser errors to 400 with the code", async () => {
    const { deps } = setup()
    const response = await handleFounderUpdatesPost(post({ ...body, email: "bad" }), deps)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_email" })
  })

  it("still succeeds when the signal client rejects", async () => {
    const { deps } = setup({
      createSignals: () => ({
        capture: async () => {
          throw new Error("x")
        },
      }),
    })
    const response = await handleFounderUpdatesPost(post(body), deps)
    expect(response.status).toBe(200)
  })
})
