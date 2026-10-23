import { describe, expect, it, vi } from "vitest"

import {
  composeDigestEmail,
  composeSequenceEmail,
  createResendMailer,
  type OutgoingEmail,
  SENDER,
} from "./mailer"
import { sequenceDraft } from "./sequence-copy"

const email: OutgoingEmail = {
  from: SENDER,
  to: "person@example.com",
  replyTo: SENDER,
  bcc: "founder@example.com",
  subject: "Hello",
  text: "Body",
  headers: { "X-B4-Send-ID": "s1" },
  tags: [{ name: "kind", value: "sequence" }],
  idempotencyKey: "seq:v1:c1:step:2",
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe("composeSequenceEmail", () => {
  it("composes step 2 with the checked draft, footer, headers, tags, and idempotency key", () => {
    const url = "https://b4.run/unsubscribe?t=abc"
    const out = composeSequenceEmail({
      step: 2,
      to: "person@example.com",
      sendId: "send-1",
      contactId: "contact-1",
      unsubscribeUrl: url,
      founderEmail: "founder@example.com",
      environment: "production",
    })
    const draft = sequenceDraft(2)
    expect(out.subject).toBe(draft.subject)
    expect(out.text).toBe(`${draft.body}\n\n--\nUnsubscribe with one click: ${url}`)
    expect(out.headers).toEqual({
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "X-B4-Send-ID": "send-1",
    })
    expect(out.tags).toEqual([
      { name: "app", value: "b4" },
      { name: "environment", value: "production" },
      { name: "kind", value: "sequence" },
      { name: "step", value: "2" },
    ])
    expect(out.idempotencyKey).toBe("seq:v1:contact-1:step:2")
    expect(out.from).toBe(SENDER)
    expect(out.replyTo).toBe(SENDER)
    expect(out.bcc).toBe("founder@example.com")
    expect(out.to).toBe("person@example.com")
  })
})

describe("composeDigestEmail", () => {
  it("goes to the founder only with a dated subject and key", () => {
    const out = composeDigestEmail({
      to: "founder@example.com",
      date: "2026-10-22",
      text: "digest",
      environment: "production",
    })
    expect(out.subject).toBe("B4.run founder digest 2026-10-22")
    expect(out.bcc).toBeUndefined()
    expect("bcc" in out).toBe(false)
    expect(out.headers["List-Unsubscribe"]).toBeUndefined()
    expect(out.tags).toEqual([
      { name: "app", value: "b4" },
      { name: "environment", value: "production" },
      { name: "kind", value: "digest" },
    ])
    expect(out.idempotencyKey).toBe("digest:production:2026-10-22")
    expect(out.text).toBe("digest")
  })
})

describe("createResendMailer", () => {
  it("posts to Resend with the bearer key and Idempotency-Key and returns the provider id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "re_123" }))
    const mailer = createResendMailer("key-1", fetchImpl as unknown as typeof fetch)
    const result = await mailer.send(email)
    expect(result).toEqual({ kind: "accepted", providerEmailId: "re_123" })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://api.resend.com/emails")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({
      Authorization: "Bearer key-1",
      "Content-Type": "application/json",
      "Idempotency-Key": "seq:v1:c1:step:2",
    })
    expect(JSON.parse(init.body as string)).toEqual({
      from: SENDER,
      to: ["person@example.com"],
      reply_to: SENDER,
      bcc: ["founder@example.com"],
      subject: "Hello",
      text: "Body",
      headers: { "X-B4-Send-ID": "s1" },
      tags: [{ name: "kind", value: "sequence" }],
    })
  })

  it("omits bcc when none is set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "re_1" }))
    const { bcc: _bcc, ...noBcc } = email
    await createResendMailer("k", fetchImpl as unknown as typeof fetch).send(noBcc)
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect("bcc" in JSON.parse(init.body as string)).toBe(false)
  })

  it("sends html and attachments only when set, and omits reply_to when none is set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "re_1" }))
    const mailer = createResendMailer("k", fetchImpl as unknown as typeof fetch)
    const { replyTo: _replyTo, ...noReplyTo } = email
    await mailer.send({
      ...noReplyTo,
      html: "<p>Body</p>",
      attachments: [{ filename: "original.eml", content: "YQ==" }],
    })
    await mailer.send(email)
    const bodies = fetchImpl.mock.calls.map((call) =>
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    )
    expect(bodies[0]).toMatchObject({
      html: "<p>Body</p>",
      attachments: [{ filename: "original.eml", content: "YQ==" }],
    })
    expect("reply_to" in bodies[0]).toBe(false)
    expect("html" in bodies[1]).toBe(false)
    expect("attachments" in bodies[1]).toBe(false)
    expect(bodies[1].reply_to).toBe(SENDER)
  })

  it("treats a 200 without an id as retryable malformed_response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}))
    const result = await createResendMailer("k", fetchImpl as unknown as typeof fetch).send(email)
    expect(result).toEqual({ kind: "retryable", code: "malformed_response" })
  })

  it.each([
    [422, "rejected"],
    [400, "rejected"],
    [429, "retryable"],
    [500, "retryable"],
  ])("maps HTTP %s to %s", async (status, kind) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, { name: "x" }))
    const result = await createResendMailer("k", fetchImpl as unknown as typeof fetch).send(email)
    expect(result).toEqual({ kind, code: `http_${status}` })
  })

  it("maps a 409 concurrent_idempotent_requests to retryable and a 409 invalid_idempotent_request to rejected idempotency_mismatch", async () => {
    const concurrent = vi.fn(async () =>
      jsonResponse(409, { name: "concurrent_idempotent_requests" }),
    )
    expect(
      await createResendMailer("k", concurrent as unknown as typeof fetch).send(email),
    ).toEqual({ kind: "retryable", code: "http_409" })
    const invalid = vi.fn(async () => jsonResponse(409, { name: "invalid_idempotent_request" }))
    expect(await createResendMailer("k", invalid as unknown as typeof fetch).send(email)).toEqual({
      kind: "rejected",
      code: "idempotency_mismatch",
    })
    const unreadable = vi.fn(async () => new Response("not json", { status: 409 }))
    expect(
      await createResendMailer("k", unreadable as unknown as typeof fetch).send(email),
    ).toEqual({ kind: "rejected", code: "idempotency_mismatch" })
  })

  it("maps a timeout and a thrown fetch to retryable", async () => {
    const timeout = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError")
    })
    expect(await createResendMailer("k", timeout as unknown as typeof fetch).send(email)).toEqual({
      kind: "retryable",
      code: "timeout",
    })
    const boom = vi.fn(async () => {
      throw new TypeError("fetch failed for person@example.com")
    })
    expect(await createResendMailer("k", boom as unknown as typeof fetch).send(email)).toEqual({
      kind: "retryable",
      code: "network",
    })
  })

  it("never includes the recipient address in a result code", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { message: "bad person@example.com" }))
    const result = await createResendMailer("k", fetchImpl as unknown as typeof fetch).send(email)
    expect(JSON.stringify(result)).not.toContain("person@example.com")
  })
})
