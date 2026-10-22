import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SqlExecutor } from "../database"

const process_ = vi.hoisted(() => vi.fn())
vi.mock("../webhooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../webhooks")>()),
  processResendEvent: process_,
}))

import { Webhook } from "standardwebhooks"
import {
  defaultResendWebhookDeps,
  handleResendWebhook,
  type ResendWebhookRouteDeps,
} from "./resend-webhook"

const NOW = new Date("2026-10-21T00:00:00Z")
const PAYLOAD = {
  type: "email.delivered",
  created_at: "2026-10-21T10:00:00.000Z",
  data: { email_id: "em_1", to: ["ada@example.com"] },
}

function deps(overrides: Partial<ResendWebhookRouteDeps> = {}): ResendWebhookRouteDeps {
  return {
    loadEnv: () => ({
      databaseUrl: "postgres://x",
      emailHmacSecret: "s",
      tokenKeyring: { active: { id: 1, secret: "t" }, previous: [] },
      environment: "production",
      publicOrigin: "https://b4.run",
      resendWebhookSecret: "whsec_x",
    }),
    createExecutor: () => ({}) as SqlExecutor,
    verify: ({ payload }) => JSON.parse(payload),
    now: () => NOW,
    ...overrides,
  }
}

const svixHeaders = {
  "svix-id": "msg_1",
  "svix-timestamp": "1",
  "svix-signature": "v1,abc",
}
const post = (body: unknown, headers: Record<string, string> = svixHeaders) =>
  new Request("http://localhost/api/growth/webhooks/resend", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

describe("resend webhook route", () => {
  beforeEach(() => {
    process_.mockReset()
    process_.mockResolvedValue("updated_delivery")
  })

  it("returns 401 without svix headers", async () => {
    const res = await handleResendWebhook(post(PAYLOAD, {}), deps())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unverified" })
    expect(process_).not.toHaveBeenCalled()
  })

  it("returns 401 when any one header is missing", async () => {
    const { "svix-id": _id, ...rest } = svixHeaders
    expect((await handleResendWebhook(post(PAYLOAD, rest), deps())).status).toBe(401)
  })

  it("returns 401 when verify throws", async () => {
    const res = await handleResendWebhook(
      post(PAYLOAD),
      deps({
        verify: () => {
          throw new Error("bad signature")
        },
      }),
    )
    expect(res.status).toBe(401)
    expect(process_).not.toHaveBeenCalled()
  })

  it("returns 401 when the webhook secret is not configured", async () => {
    const res = await handleResendWebhook(
      post(PAYLOAD),
      deps({
        loadEnv: () => ({
          databaseUrl: "postgres://x",
          emailHmacSecret: "s",
          tokenKeyring: { active: { id: 1, secret: "t" }, previous: [] },
          environment: "production",
          publicOrigin: "https://b4.run",
        }),
      }),
    )
    expect(res.status).toBe(401)
  })

  it("rejects an oversized body", async () => {
    const res = await handleResendWebhook(
      post(PAYLOAD, { ...svixHeaders, "content-length": "70000" }),
      deps(),
    )
    expect(res.status).toBe(413)
  })

  it("passes the raw body text to verify", async () => {
    const verify = vi.fn(({ payload }: { payload: string }) => JSON.parse(payload))
    const raw = `${JSON.stringify(PAYLOAD)}  `
    await handleResendWebhook(post(raw), deps({ verify }))
    expect(verify).toHaveBeenCalledWith({
      payload: raw,
      headers: { id: "msg_1", timestamp: "1", signature: "v1,abc" },
      secret: "whsec_x",
    })
  })

  it("returns 200 with the outcome", async () => {
    process_.mockResolvedValue("stopped")
    const res = await handleResendWebhook(post(PAYLOAD), deps())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: "stopped" })
    expect(process_.mock.calls[0]?.[1]).toMatchObject({
      environment: "production",
      emailHmacSecret: "s",
      now: NOW,
    })
  })

  it("returns 202 ignored_type for a verified but unsupported event", async () => {
    const res = await handleResendWebhook(post({ ...PAYLOAD, type: "email.opened" }), deps())
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ outcome: "ignored_type" })
    expect(process_).not.toHaveBeenCalled()
  })

  it("returns 503 on database errors", async () => {
    process_.mockRejectedValue(new Error("connection refused"))
    const res = await handleResendWebhook(post(PAYLOAD), deps())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "unavailable" })
  })

  it("verifies real Standard Webhooks signatures through the default deps", async () => {
    const secret = `whsec_${Buffer.from("test-secret-bytes").toString("base64")}`
    const body = JSON.stringify(PAYLOAD)
    const timestamp = new Date()
    const signature = new Webhook(secret).sign("msg_1", timestamp, body)
    const headers = {
      "svix-id": "msg_1",
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    }
    const real = {
      ...deps({ verify: defaultResendWebhookDeps().verify }),
      loadEnv: () => ({ ...deps().loadEnv(), resendWebhookSecret: secret }),
    }
    const ok = await handleResendWebhook(post(body, headers), real)
    expect(ok.status).toBe(200)
    const tampered = body.replace("em_1", "em_2")
    expect((await handleResendWebhook(post(tampered, headers), real)).status).toBe(401)
  })
})
