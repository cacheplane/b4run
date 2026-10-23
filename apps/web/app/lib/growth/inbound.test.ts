import { describe, expect, it, vi } from "vitest"
import { recordingExecutor } from "./fake-executor"
import {
  composeInboundForward,
  createReceivingClient,
  downloadRaw,
  type ForwardDeps,
  forwardInboundReceipt,
  INBOUND_FORWARD_TO,
  InboundError,
  isAdmitted,
  isInboundAddress,
  parseInboundEvent,
  RAW_MAX_BYTES,
  type ReceivedEmail,
} from "./inbound"
import { B4_APP_TAG, type Mailer, SENDER } from "./mailer"

const ID = "56761188-7520-42d8-8898-ff6fc54ce618"
const RAW = new TextEncoder().encode("From: ada@example.com\r\n\r\nHello")

const received = (overrides: Record<string, unknown> = {}): ReceivedEmail => ({
  id: ID,
  to: ["Brian <brian@b4.run>"],
  from: "Ada Lovelace <ada@example.com>",
  subject: "Question about B4",
  text: "Hi Brian",
  html: "<p>Hi Brian</p>",
  headers: { from: "Ada Lovelace <ada@example.com>" },
  raw: { download_url: "https://example.resend.com/raw/1?Signature=x" },
  created_at: "2026-10-22T10:00:00.000Z",
  ...overrides,
})

describe("inbound admission", () => {
  it.each([
    "brian@b4.run",
    "BRIAN@B4.RUN",
    "Brian@B4.run",
    "Brian <brian@b4.run>",
    '"Love, Brian" <Brian@b4.run>',
    "  brian@b4.run  ",
  ])("admits %s", (value) => {
    expect(isInboundAddress(value)).toBe(true)
  })

  it.each([
    "hello@b4.run",
    "brian@b4.run.evil.com",
    "brian@sub.b4.run",
    "xbrian@b4.run",
    "brian@b4.run <eve@example.com>",
    "brian@b4.run, eve@example.com",
    "brian@b4.run\r\nBcc: eve@example.com",
    "",
    42,
    undefined,
  ])("ignores %s", (value) => {
    expect(isInboundAddress(value)).toBe(false)
  })

  it("looks at to, cc, bcc and received_for, and nothing else", () => {
    expect(isAdmitted({ to: ["hello@b4.run", "brian@b4.run"] })).toBe(true)
    expect(isAdmitted({ to: ["hello@b4.run"], cc: ["Brian <brian@b4.run>"] })).toBe(true)
    expect(isAdmitted({ to: [], bcc: ["brian@b4.run"] })).toBe(true)
    expect(isAdmitted({ to: ["list@example.com"], received_for: ["brian@b4.run"] })).toBe(true)
    expect(isAdmitted({ to: ["hello@b4.run", "support@b4.run"] })).toBe(false)
    expect(isAdmitted({ from: "brian@b4.run", reply_to: ["brian@b4.run"] })).toBe(false)
    expect(isAdmitted({ to: "brian@b4.run" })).toBe(false)
    expect(isAdmitted(null)).toBe(false)
  })
})

describe("parseInboundEvent", () => {
  const payload = {
    type: "email.received",
    created_at: "2026-10-22T10:00:01.000Z",
    data: {
      email_id: ID,
      created_at: "2026-10-22T10:00:00.000Z",
      from: "ada@example.com",
      to: ["brian@b4.run"],
      subject: "Hi",
    },
  }

  it("reads the id, received time and admission", () => {
    expect(parseInboundEvent(payload)).toEqual({
      id: ID,
      receivedAt: new Date("2026-10-22T10:00:00.000Z"),
      admitted: true,
      selfSent: false,
    })
    expect(
      parseInboundEvent({ ...payload, data: { ...payload.data, to: ["hello@b4.run"] } }),
    ).toMatchObject({ admitted: false })
    for (const from of ["Brian at B4.run <brian@b4.run>", "BRIAN@cacheplane.ai"]) {
      expect(parseInboundEvent({ ...payload, data: { ...payload.data, from } })).toMatchObject({
        selfSent: true,
      })
    }
  })

  it("rejects other types, bad ids, and missing times", () => {
    expect(parseInboundEvent({ ...payload, type: "email.delivered" })).toBeUndefined()
    expect(
      parseInboundEvent({ ...payload, data: { ...payload.data, email_id: "../x" } }),
    ).toBeUndefined()
    expect(
      parseInboundEvent({
        type: "email.received",
        data: { email_id: ID, to: ["brian@b4.run"] },
      }),
    ).toBeUndefined()
    expect(parseInboundEvent("x")).toBeUndefined()
  })
})

describe("composeInboundForward", () => {
  it("forwards to the fixed address with the original attached", () => {
    const email = composeInboundForward(received(), RAW, "production")
    expect(email).toEqual({
      from: SENDER,
      to: INBOUND_FORWARD_TO,
      replyTo: "ada@example.com",
      subject: "Fwd: Question about B4",
      text: "Hi Brian",
      html: "<p>Hi Brian</p>",
      attachments: [{ filename: "original.eml", content: Buffer.from(RAW).toString("base64") }],
      headers: { "Auto-Submitted": "auto-generated", "X-B4-Forwarded": ID },
      tags: [
        B4_APP_TAG,
        { name: "environment", value: "production" },
        { name: "kind", value: "forward" },
      ],
      idempotencyKey: `b4:production:inbound-forward:${ID}`,
    })
    expect(INBOUND_FORWARD_TO).toBe("brian@cacheplane.ai")
  })

  it("fills a missing subject and body, omits empty html and an unparseable sender", () => {
    const email = composeInboundForward(
      received({ subject: null, text: null, html: "", from: "not an address" }),
      RAW,
      "preview",
    )
    expect(email.subject).toBe("Fwd: (no subject)")
    expect(email.text).toContain("attached as original.eml")
    expect("html" in email).toBe(false)
    expect("replyTo" in email).toBe(false)
    expect(email.idempotencyKey).toBe(`b4:preview:inbound-forward:${ID}`)
  })

  it("flattens line breaks in the subject", () => {
    expect(composeInboundForward(received({ subject: "a\r\nBcc: x" }), RAW, "test").subject).toBe(
      "Fwd: a Bcc: x",
    )
  })

  it("notes an original too large to attach", () => {
    const email = composeInboundForward(received(), undefined, "test")
    expect("attachments" in email).toBe(false)
    expect(email.text).toMatch(/^Hi Brian\n\n--\nThe original email is larger than 20 MiB/)
  })
})

describe("downloadRaw", () => {
  const ok = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers })

  it("downloads over HTTPS without following redirects", async () => {
    const fetchImpl = vi.fn(async () => ok(RAW))
    const bytes = await downloadRaw("https://example.resend.com/raw/1", fetchImpl)
    expect(new TextDecoder().decode(bytes)).toContain("Hello")
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.redirect).toBe("error")
  })

  it.each(["http://example.resend.com/raw/1", "file:///etc/passwd", "not a url"])(
    "rejects %s before fetching",
    async (url) => {
      const fetchImpl = vi.fn(async () => ok(RAW))
      await expect(downloadRaw(url, fetchImpl)).rejects.toMatchObject({ code: "raw_url_invalid" })
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it("rejects a redirect response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    )
    await expect(downloadRaw("https://example.resend.com/raw/1", fetchImpl)).rejects.toMatchObject({
      code: "raw_redirect",
    })
  })

  it("rejects a thrown redirect (redirect: error) as a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("redirect mode is set to error")
    })
    await expect(downloadRaw("https://example.resend.com/raw/1", fetchImpl)).rejects.toBeInstanceOf(
      InboundError,
    )
  })

  it("rejects a declared size over 20 MiB", async () => {
    const fetchImpl = vi.fn(async () => ok("x", { "content-length": String(RAW_MAX_BYTES + 1) }))
    await expect(downloadRaw("https://example.resend.com/raw/1", fetchImpl)).rejects.toMatchObject({
      code: "raw_too_large",
    })
  })

  it("rejects a streamed body over 20 MiB", async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1
        if (sent > 21) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const fetchImpl = vi.fn(async () => ok(stream))
    await expect(downloadRaw("https://example.resend.com/raw/1", fetchImpl)).rejects.toMatchObject({
      code: "raw_too_large",
    })
  })

  it("rejects a failed download", async () => {
    const fetchImpl = vi.fn(async () => new Response("gone", { status: 404 }))
    await expect(downloadRaw("https://example.resend.com/raw/1", fetchImpl)).rejects.toMatchObject({
      code: "raw_unavailable",
    })
  })
})

describe("createReceivingClient", () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers })

  it("gets one received email by id and retries a 429", async () => {
    const waits: number[] = []
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}, { "retry-after": "1" }))
      .mockResolvedValueOnce(json(200, received()))
    const client = createReceivingClient(
      "re_full",
      fetchImpl as unknown as typeof fetch,
      async (ms) => {
        waits.push(ms)
      },
    )
    expect((await client.getReceived(ID)).id).toBe(ID)
    expect(waits).toEqual([1000])
    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit]
    expect(url).toBe(`https://api.resend.com/emails/receiving/${ID}`)
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_full")
  })

  it("fails with a code only, never the response body", async () => {
    const fetchImpl = vi.fn(async () => json(404, { message: "ada@example.com not found" }))
    const client = createReceivingClient("re_full", fetchImpl as unknown as typeof fetch)
    const error = await client.getReceived(ID).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "receiving_http_404" })
    expect(String((error as Error).message)).not.toContain("@")
  })

  it("refuses an id that is not a Resend id", async () => {
    const fetchImpl = vi.fn()
    const client = createReceivingClient("re_full", fetchImpl as unknown as typeof fetch)
    await expect(client.getReceived("../emails")).rejects.toMatchObject({
      code: "invalid_provider_id",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("pages through received mail with the after cursor", async () => {
    const item = (id: string, to: string[]) => ({ id, to, created_at: "2026-10-22T10:00:00.000Z" })
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, { has_more: true, data: [item("a", ["brian@b4.run"]), item("b", ["x@b4.run"])] }),
      )
      .mockResolvedValueOnce(json(200, { has_more: false, data: [item("c", ["brian@b4.run"])] }))
    const client = createReceivingClient("re_full", fetchImpl as unknown as typeof fetch)
    const seen = []
    for await (const reference of client.listReceived()) seen.push(reference)
    expect(seen.map((reference) => [reference.id, reference.admitted])).toEqual([
      ["a", true],
      ["b", false],
      ["c", true],
    ])
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://api.resend.com/emails/receiving?limit=100",
      "https://api.resend.com/emails/receiving?limit=100&after=b",
    ])
  })

  it("reads a sent email's Message-ID", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { id: "em_1", message_id: "<abc@email.example.com>" }))
      .mockResolvedValueOnce(json(200, { id: "em_2", message_id: null }))
      .mockResolvedValueOnce(json(200, { id: "em_other", message_id: "<x@example.com>" }))
    const client = createReceivingClient("re_full", fetchImpl as unknown as typeof fetch)
    expect(await client.getSent("em_1")).toEqual({ messageId: "<abc@email.example.com>" })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.resend.com/emails/em_1")
    expect(await client.getSent("em_2")).toEqual({ messageId: null })
    await expect(client.getSent("em_3")).rejects.toMatchObject({ code: "sent_malformed" })
  })

  it("treats more pages than recovery reads as a failed listing", async () => {
    let page = 0
    const fetchImpl = vi.fn(async () => {
      page += 1
      return json(200, {
        has_more: true,
        data: [{ id: `p${page}`, to: [], created_at: "2026-10-22T10:00:00.000Z" }],
      })
    })
    const client = createReceivingClient("re_full", fetchImpl as unknown as typeof fetch)
    const read = async () => {
      for await (const _ of client.listReceived()) {
        // drain
      }
    }
    await expect(read()).rejects.toMatchObject({ code: "receiving_page_limit" })
  })
})

describe("forwardInboundReceipt", () => {
  const NOW = new Date("2026-10-22T10:05:00.000Z")
  const pending = {
    status: "pending",
    forward_provider_id: null,
    first_attempted_at: null,
    last_error_code: null,
  }

  function forwardDeps(overrides: Partial<ForwardDeps> = {}, mailer?: Mailer): ForwardDeps {
    return {
      environment: "test",
      getReceived: async () => received(),
      downloadRaw: async () => RAW,
      mailer: mailer ?? { send: async () => ({ kind: "accepted", providerEmailId: "em_fwd" }) },
      now: () => NOW,
      ...overrides,
    }
  }

  it("commits the first-attempt time before the send and records the provider id", async () => {
    const order: string[] = []
    const { executor, calls } = recordingExecutor([
      { rows: [pending], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ ...pending, first_attempted_at: NOW }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ])
    const mailer: Mailer = {
      send: async (email) => {
        order.push(`send:${calls.length}`)
        expect(email.idempotencyKey).toBe(`b4:test:inbound-forward:${ID}`)
        return { kind: "accepted", providerEmailId: "em_fwd" }
      },
    }
    const result = await forwardInboundReceipt(executor, ID, forwardDeps({}, mailer))
    expect(result).toEqual({ outcome: "forwarded" })
    expect(calls[1]?.text).toContain("first_attempted_at = coalesce(first_attempted_at, $2)")
    expect(calls[1]?.params).toEqual([ID, NOW])
    expect(calls[2]?.text).toContain("for update")
    // The send happens after the reservation, the lock, and the attempt count.
    expect(order).toEqual(["send:4"])
    expect(calls[4]?.text).toContain("status = 'forwarded', forward_provider_id = $2")
    expect(calls[4]?.params).toEqual([ID, "em_fwd"])
  })

  it("does nothing more for an already forwarded receipt", async () => {
    const send = vi.fn()
    const { executor, calls } = recordingExecutor([
      { rows: [{ ...pending, status: "forwarded", forward_provider_id: "em_fwd" }], rowCount: 1 },
    ])
    expect(await forwardInboundReceipt(executor, ID, forwardDeps({}, { send }))).toEqual({
      outcome: "already_forwarded",
    })
    expect(send).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it("ignores a receipt whose authoritative recipients no longer include brian@b4.run", async () => {
    const send = vi.fn()
    const { executor, calls } = recordingExecutor([{ rows: [pending], rowCount: 1 }])
    const result = await forwardInboundReceipt(
      executor,
      ID,
      forwardDeps({ getReceived: async () => received({ to: ["hello@b4.run"] }) }, { send }),
    )
    expect(result).toEqual({ outcome: "ignored", code: "recipient_mismatch" })
    expect(send).not.toHaveBeenCalled()
    expect(calls[1]?.text).toContain("status = 'ignored'")
  })

  it("ignores one of B4's own forwards", async () => {
    const send = vi.fn()
    const { executor } = recordingExecutor([{ rows: [pending], rowCount: 1 }])
    const result = await forwardInboundReceipt(
      executor,
      ID,
      forwardDeps(
        { getReceived: async () => received({ headers: { "X-B4-Forwarded": "x" } }) },
        { send },
      ),
    )
    expect(result).toEqual({ outcome: "ignored", code: "forward_loop" })
    expect(send).not.toHaveBeenCalled()
  })

  it("leaves the receipt pending with a code when the source cannot be read", async () => {
    const send = vi.fn()
    const { executor, calls } = recordingExecutor([{ rows: [pending], rowCount: 1 }])
    const result = await forwardInboundReceipt(
      executor,
      ID,
      forwardDeps(
        {
          getReceived: async () => {
            throw new InboundError("receiving_http_503")
          },
        },
        { send },
      ),
    )
    expect(result).toEqual({ outcome: "retry", code: "receiving_http_503" })
    expect(send).not.toHaveBeenCalled()
    expect(calls[1]?.text).toContain("set last_error_code = $2")
    expect(calls[1]?.params).toEqual([ID, "receiving_http_503"])
  })

  it("forwards without the attachment when the original is over the limit", async () => {
    const sent: unknown[] = []
    const { executor } = recordingExecutor([
      { rows: [pending], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ ...pending, first_attempted_at: NOW }], rowCount: 1 },
    ])
    await forwardInboundReceipt(
      executor,
      ID,
      forwardDeps(
        {
          downloadRaw: async () => {
            throw new InboundError("raw_too_large")
          },
        },
        {
          send: async (email) => {
            sent.push(email)
            return { kind: "accepted", providerEmailId: "em_fwd" }
          },
        },
      ),
    )
    expect(sent).toHaveLength(1)
    expect("attachments" in (sent[0] as object)).toBe(false)
  })

  it("keeps a retryable send pending with its code", async () => {
    const { executor, calls } = recordingExecutor([
      { rows: [pending], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ ...pending, first_attempted_at: NOW }], rowCount: 1 },
    ])
    const result = await forwardInboundReceipt(
      executor,
      ID,
      forwardDeps({}, { send: async () => ({ kind: "retryable", code: "http_503" }) }),
    )
    expect(result).toEqual({ outcome: "retry", code: "http_503" })
    expect(calls.at(-1)?.text).toBe(
      "update growth_inbound_receipts set last_error_code = $2 where id = $1",
    )
  })
})
