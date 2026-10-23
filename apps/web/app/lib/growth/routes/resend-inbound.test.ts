import { Webhook } from "standardwebhooks"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GrowthEnv } from "../env"
import { GrowthConfigError } from "../errors"
import { recordingExecutor } from "../fake-executor"
import type { ForwardDeps, ForwardResult } from "../inbound"
import type { ReplyDeps, ReplyResult } from "../replies"
import {
  defaultResendInboundDeps,
  handleResendInbound,
  type ResendInboundRouteDeps,
} from "./resend-inbound"

const ID = "56761188-7520-42d8-8898-ff6fc54ce618"
const PAYLOAD = {
  type: "email.received",
  created_at: "2026-10-22T10:00:01.000Z",
  data: {
    email_id: ID,
    created_at: "2026-10-22T10:00:00.000Z",
    from: "Ada <ada@example.com>",
    to: ["Brian <brian@b4.run>"],
    subject: "Secret subject",
  },
}

const ENV: GrowthEnv = {
  databaseUrl: "postgres://x",
  emailHmacSecret: "s",
  tokenKeyring: { active: { id: 1, secret: "t" }, previous: [] },
  environment: "production",
  publicOrigin: "https://b4.run",
  resendInboundWebhookSecret: "whsec_inbound",
  resendReceivingApiKey: "re_full",
}

const forwardDeps = { environment: "production" } as unknown as ForwardDeps & ReplyDeps

function harness(
  overrides: Partial<ResendInboundRouteDeps> = {},
  result: ForwardResult = { outcome: "forwarded" },
) {
  // The reply-gate lock, then the insert.
  const recording = recordingExecutor([
    { rows: [], rowCount: 0 },
    { rows: [{ id: ID }], rowCount: 1 },
  ])
  const forward = vi.fn(async () => result)
  const processReply = vi.fn(
    async (): Promise<ReplyResult> => ({ outcome: "unmatched", code: "no_references" }),
  )
  const deps: ResendInboundRouteDeps = {
    loadEnv: () => ENV,
    createExecutor: () => recording.executor,
    verify: ({ payload }) => JSON.parse(payload),
    forwardDeps: () => forwardDeps,
    forward,
    processReply,
    ...overrides,
  }
  return { deps, forward, processReply, calls: recording.calls }
}

const svixHeaders = { "svix-id": "msg_1", "svix-timestamp": "1", "svix-signature": "v1,abc" }
const post = (body: unknown, headers: Record<string, string> = svixHeaders) =>
  new Request("http://localhost/api/growth/webhooks/resend-inbound", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

const logged = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => String(call[0])).join("")

describe("resend inbound route", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns 401 without svix headers, like the delivery route", async () => {
    const h = harness()
    const res = await handleResendInbound(post(PAYLOAD, {}), h.deps)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unverified" })
    expect(h.forward).not.toHaveBeenCalled()
  })

  it("returns 401 when the signature does not verify", async () => {
    const h = harness({
      verify: () => {
        throw new Error("bad signature")
      },
    })
    const res = await handleResendInbound(post(PAYLOAD), h.deps)
    expect(res.status).toBe(401)
    expect(h.calls).toHaveLength(0)
  })

  it("verifies with the inbound secret, not the delivery secret", async () => {
    const secret = `whsec_${Buffer.from("inbound-secret-bytes-0123456789").toString("base64")}`
    const other = `whsec_${Buffer.from("delivery-secret-bytes-012345678").toString("base64")}`
    const body = JSON.stringify(PAYLOAD)
    const timestamp = new Date()
    const signature = new Webhook(secret).sign("msg_1", timestamp, body)
    const headers = {
      "svix-id": "msg_1",
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    }
    const make = (env: GrowthEnv) =>
      harness({ verify: defaultResendInboundDeps().verify, loadEnv: () => env })
    const good = make({ ...ENV, resendInboundWebhookSecret: secret, resendWebhookSecret: other })
    expect((await handleResendInbound(post(body, headers), good.deps)).status).toBe(200)
    const wrong = make({ ...ENV, resendInboundWebhookSecret: other, resendWebhookSecret: secret })
    expect((await handleResendInbound(post(body, headers), wrong.deps)).status).toBe(401)
  })

  it("answers 503 with a code-only log when inbound is not configured", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const { resendInboundWebhookSecret: _secret, ...noSecret } = ENV
    const missingSecret = harness({ loadEnv: () => noSecret })
    expect((await handleResendInbound(post(PAYLOAD), missingSecret.deps)).status).toBe(503)
    const missingKey = harness({ forwardDeps: () => undefined })
    expect((await handleResendInbound(post(PAYLOAD), missingKey.deps)).status).toBe(503)
    const broken = harness({
      loadEnv: () => {
        throw new GrowthConfigError("GROWTH_DATABASE_URL is not set")
      },
    })
    expect((await handleResendInbound(post(PAYLOAD), broken.deps)).status).toBe(503)
    expect(logged(stderr)).toBe(
      "resend inbound unavailable: inbound_disabled\n".repeat(2) +
        "resend inbound unavailable: config_invalid\n",
    )
    expect(missingSecret.forward).not.toHaveBeenCalled()
  })

  it("acknowledges other event types without touching the database", async () => {
    const h = harness()
    const res = await handleResendInbound(post({ ...PAYLOAD, type: "email.delivered" }), h.deps)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ outcome: "ignored_type" })
    expect(h.calls).toHaveLength(0)
  })

  it.each([["hello@b4.run"], ["Brian <brian@b4.run.example.com>"], ["support@b4.run", "x@y.z"]])(
    "ignores mail for %s with no database write",
    async (...to) => {
      const h = harness()
      const res = await handleResendInbound(
        post({ ...PAYLOAD, data: { ...PAYLOAD.data, to } }),
        h.deps,
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ outcome: "ignored_recipient" })
      expect(h.calls).toHaveLength(0)
      expect(h.forward).not.toHaveBeenCalled()
    },
  )

  it("admits mail for brian@b4.run, then forwards it", async () => {
    const h = harness()
    const res = await handleResendInbound(post(PAYLOAD), h.deps)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: "forwarded" })
    expect(h.calls).toHaveLength(2)
    expect(h.calls[0]?.text).toContain("pg_advisory_xact_lock(")
    expect(h.calls[1]?.text).toContain("insert into growth_inbound_receipts (id, received_at")
    expect(h.calls[1]?.text).toContain("on conflict (id) do nothing")
    expect(h.calls[1]?.params).toEqual([ID, new Date("2026-10-22T10:00:00.000Z"), "pending", null])
    expect(h.forward).toHaveBeenCalledWith(expect.anything(), ID, forwardDeps)
    expect(h.processReply).toHaveBeenCalledWith(expect.anything(), ID, forwardDeps)
  })

  it("admits B4's own mail as needing no reply processing", async () => {
    const h = harness()
    const self = { ...PAYLOAD, data: { ...PAYLOAD.data, from: "Brian at B4.run <brian@b4.run>" } }
    expect((await handleResendInbound(post(self), h.deps)).status).toBe(200)
    expect(h.calls[1]?.params).toEqual([
      ID,
      new Date("2026-10-22T10:00:00.000Z"),
      "ignored",
      "self_mail",
    ])
  })

  it("processes the reply even when forwarding fails, and forwards when reply processing fails", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const failingForward = harness({}, { outcome: "retry", code: "http_503" })
    await handleResendInbound(post(PAYLOAD), failingForward.deps)
    expect(failingForward.processReply).toHaveBeenCalledTimes(1)

    const failingReply = harness({
      processReply: async () => {
        throw Object.assign(new Error("ada@example.com"), { code: "ECONNRESET" })
      },
    })
    const res = await handleResendInbound(post(PAYLOAD), failingReply.deps)
    expect(res.status).toBe(200)
    expect(failingReply.forward).toHaveBeenCalledTimes(1)
    expect(logged(stderr)).toContain("resend inbound reply failed: econnreset\n")
    expect(logged(stderr)).not.toMatch(/@/)
  })

  it("answers 200 for an already forwarded or settled receipt", async () => {
    for (const result of [
      { outcome: "already_forwarded" },
      { outcome: "failed", code: "http_422" },
      { outcome: "ignored", code: "recipient_mismatch" },
    ] as ForwardResult[]) {
      const res = await handleResendInbound(post(PAYLOAD), harness({}, result).deps)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ outcome: result.outcome })
    }
  })

  it("answers 500 with a code-only log when forwarding failed retryably", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const h = harness({}, { outcome: "retry", code: "http_503" })
    const res = await handleResendInbound(post(PAYLOAD), h.deps)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "forward_failed" })
    expect(logged(stderr)).toBe("resend inbound forward failed: http_503\n")
  })

  it("answers 500 and logs no address, subject or message when something throws", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const h = harness()
    h.deps.forward = async () => {
      throw Object.assign(new Error("ada@example.com Secret subject"), { code: "ECONNRESET" })
    }
    const res = await handleResendInbound(post(PAYLOAD), h.deps)
    expect(res.status).toBe(500)
    const text = logged(stderr)
    expect(text).toBe("resend inbound failed: econnreset\n")
    expect(text).not.toMatch(/@|Secret/)
  })

  it("refuses an oversized body", async () => {
    const h = harness()
    const res = await handleResendInbound(
      post(PAYLOAD, { ...svixHeaders, "content-length": "70000" }),
      h.deps,
    )
    expect(res.status).toBe(413)
  })
})
