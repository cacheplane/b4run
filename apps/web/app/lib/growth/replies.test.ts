import { describe, expect, it } from "vitest"
import { emailLookupHmac } from "./email"
import { recordingExecutor } from "./fake-executor"
import { InboundError, type ReceivedEmail } from "./inbound"
import {
  bindOutboundMessageId,
  DIRECT_REFERENCES_MAX,
  parseReplyHeaders,
  processInboundReply,
  REFERENCES_MAX,
  type ReplyDeps,
  rfcMessageId,
} from "./replies"

const ID = "56761188-7520-42d8-8898-ff6fc54ce618"
const SECRET = "hmac-secret"
const NOW = new Date("2026-10-23T15:00:00.000Z")
const STEP1 = "<step1-abc@email.amazonses.com>"
const CONTACT = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const SEND = "33333333-3333-4333-8333-333333333333"

const reply = (overrides: Record<string, unknown> = {}): ReceivedEmail => ({
  id: ID,
  to: ["brian@b4.run"],
  from: "Ada <ada@example.com>",
  subject: "Re: Secret subject",
  text: "Secret body",
  headers: { "in-reply-to": STEP1, references: STEP1 },
  ...overrides,
})

const deps = (email: ReceivedEmail | Error = reply()): ReplyDeps => ({
  getReceived: async () => {
    if (email instanceof Error) throw email
    return email
  },
  emailHmacSecret: SECRET,
  now: () => NOW,
})

const PENDING = { rows: [{ reply_status: "pending" }], rowCount: 1 }
const NONE = { rows: [], rowCount: 0 }

describe("rfcMessageId", () => {
  it("canonicalises angle brackets and the domain's case, keeping the local part", () => {
    expect(rfcMessageId("<AbC.123@Email.AmazonSES.com>")).toBe("<AbC.123@email.amazonses.com>")
    expect(rfcMessageId("  AbC@example.com ")).toBe("<AbC@example.com>")
  })

  it("rejects malformed ids", () => {
    for (const value of [
      undefined,
      42,
      "",
      "<>",
      "<no-at-sign>",
      "<a@b@c>",
      "<a b@example.com>",
      "<a@exa mple.com>",
      "<a@.example.com>",
      "<a@example..com>",
      "<a@example.com>\r\nBcc: x@y.z",
      `<${"a".repeat(1000)}@example.com>`,
    ]) {
      expect(rfcMessageId(value)).toBeUndefined()
    }
  })
})

describe("parseReplyHeaders", () => {
  it("puts In-Reply-To first, then References, without duplicates", () => {
    expect(
      parseReplyHeaders({
        "In-Reply-To": "<b@example.com>",
        References: "<a@example.com> <b@example.com>",
      }),
    ).toEqual({
      direct: ["<b@example.com>"],
      all: ["<b@example.com>", "<a@example.com>"],
    })
  })

  it("matches header names in any case and reads folded and repeated values", () => {
    expect(
      parseReplyHeaders({
        REFERENCES: ["<a@example.com>\r\n <b@example.com>", "<c@example.com>"],
      }).all,
    ).toEqual(["<a@example.com>", "<b@example.com>", "<c@example.com>"])
  })

  it("drops malformed ids and keeps the valid ones", () => {
    expect(
      parseReplyHeaders({
        "in-reply-to": "<not an id>",
        references: "<a@example.com> <broken> junk <b@EXAMPLE.com>",
      }),
    ).toEqual({ direct: [], all: ["<a@example.com>", "<b@example.com>"] })
  })

  it("bounds both lists, keeping the most recent References", () => {
    const ids = Array.from({ length: 120 }, (_, index) => `<r${index}@example.com>`)
    const parsed = parseReplyHeaders({
      "in-reply-to": ids.slice(0, 10).join(" "),
      references: ids.join(" "),
    })
    expect(parsed.direct).toHaveLength(DIRECT_REFERENCES_MAX)
    expect(parsed.all).toContain("<r119@example.com>")
    expect(parsed.all).not.toContain("<r60@example.com>")
    expect(parsed.all.length).toBeLessThanOrEqual(DIRECT_REFERENCES_MAX + REFERENCES_MAX)
  })

  it("reads an oversized header from its end only", () => {
    const filler = "<x@example.com> ".repeat(5000)
    expect(parseReplyHeaders({ references: `${filler}<last@example.com>` }).all).toContain(
      "<last@example.com>",
    )
  })

  it("returns nothing for missing or non-object headers", () => {
    expect(parseReplyHeaders(undefined)).toEqual({ direct: [], all: [] })
    expect(parseReplyHeaders(["<a@example.com>"])).toEqual({ direct: [], all: [] })
    expect(parseReplyHeaders({ subject: "<a@example.com>" })).toEqual({ direct: [], all: [] })
  })
})

describe("bindOutboundMessageId", () => {
  it("binds only when unset or equal, and never an id another send holds", async () => {
    const { executor, calls } = recordingExecutor([{ rows: [{ id: SEND }], rowCount: 1 }])
    expect(
      await bindOutboundMessageId(executor, { providerEmailId: "em_1", messageId: STEP1 }),
    ).toBe("bound")
    expect(calls[0]?.text).toContain("(rfc_message_id is null or rfc_message_id = $2)")
    expect(calls[0]?.text).toContain("not exists")
    expect(calls[0]?.params).toEqual(["em_1", STEP1])
  })

  it("reports a conflict when the send already holds a different id", async () => {
    const { executor } = recordingExecutor([NONE, { rows: [{ found: 1 }], rowCount: 1 }])
    expect(
      await bindOutboundMessageId(executor, { providerEmailId: "em_1", messageId: STEP1 }),
    ).toBe("conflict")
  })

  it("refuses an invalid id without touching the database", async () => {
    const { executor, calls } = recordingExecutor()
    expect(
      await bindOutboundMessageId(executor, { providerEmailId: "em_1", messageId: "nope" }),
    ).toBe("invalid_message_id")
    expect(calls).toHaveLength(0)
  })
})

describe("processInboundReply (recorded SQL)", () => {
  const stopped = (calls: { text: string }[]) =>
    calls.some((call) => call.text.startsWith("update growth_contacts set approved_at = null"))

  it("stops the contact and marks the receipt matched in one transaction", async () => {
    const { executor, calls } = recordingExecutor([
      PENDING,
      { rows: [{ id: SEND, contact_id: CONTACT, rfc_message_id: STEP1 }], rowCount: 1 },
      {
        rows: [{ email_hmac: emailLookupHmac(SECRET, "ada@example.com"), deleted_at: null }],
        rowCount: 1,
      },
      PENDING,
      { rows: [{ id: CONTACT }], rowCount: 1 },
    ])
    expect(await processInboundReply(executor, ID, deps())).toEqual({ outcome: "matched" })
    expect(calls[1]?.params).toEqual([[STEP1]])
    expect(calls[2]?.text).toContain("from growth_contacts where id = $1 for update")
    expect(calls[3]?.text).toContain("from growth_inbound_receipts where id = $1 for update")
    expect(calls[4]?.params).toEqual([CONTACT, NOW, "reply_received"])
    const activity = calls.find((call) => call.text.startsWith("insert into growth_activity"))
    expect(activity?.params[4]).toBe(JSON.stringify({ provenance: "mailbox_reply" }))
    const matched = calls.at(-1)
    expect(matched?.text).toContain("reply_status = 'matched'")
    expect(matched?.params).toEqual([ID, CONTACT, SEND])
  })

  it("never stops anyone when the sender is not the matched contact", async () => {
    const { executor, calls } = recordingExecutor([
      PENDING,
      { rows: [{ id: SEND, contact_id: CONTACT, rfc_message_id: STEP1 }], rowCount: 1 },
      {
        rows: [{ email_hmac: emailLookupHmac(SECRET, "someone@else.com"), deleted_at: null }],
        rowCount: 1,
      },
      PENDING,
    ])
    expect(await processInboundReply(executor, ID, deps())).toEqual({
      outcome: "unmatched",
      code: "sender_mismatch",
    })
    expect(stopped(calls)).toBe(false)
  })

  it("prefers the In-Reply-To match and settles references to several contacts as ambiguous", async () => {
    const other = "<other@email.amazonses.com>"
    const viaDirect = recordingExecutor([
      PENDING,
      {
        rows: [
          { id: SEND, contact_id: CONTACT, rfc_message_id: STEP1 },
          { id: "s2", contact_id: OTHER, rfc_message_id: other },
        ],
        rowCount: 2,
      },
      {
        rows: [{ email_hmac: emailLookupHmac(SECRET, "ada@example.com"), deleted_at: null }],
        rowCount: 1,
      },
      PENDING,
      { rows: [{ id: CONTACT }], rowCount: 1 },
    ])
    const direct = reply({ headers: { "in-reply-to": STEP1, references: `${other} ${STEP1}` } })
    expect(await processInboundReply(viaDirect.executor, ID, deps(direct))).toEqual({
      outcome: "matched",
    })

    const ambiguous = recordingExecutor([
      PENDING,
      {
        rows: [
          { id: SEND, contact_id: CONTACT, rfc_message_id: STEP1 },
          { id: "s2", contact_id: OTHER, rfc_message_id: other },
        ],
        rowCount: 2,
      },
      PENDING,
    ])
    const refsOnly = reply({ headers: { references: `${other} ${STEP1}` } })
    expect(await processInboundReply(ambiguous.executor, ID, deps(refsOnly))).toEqual({
      outcome: "unmatched",
      code: "ambiguous_references",
    })
    expect(stopped(ambiguous.calls)).toBe(false)
  })

  it("ignores B4's own mail, forwards, and mail for other recipients", async () => {
    const cases: [ReceivedEmail, string][] = [
      [reply({ from: "Brian at B4.run <brian@b4.run>" }), "self_mail"],
      [reply({ from: "brian@cacheplane.ai" }), "self_mail"],
      [reply({ headers: { "X-B4-Forwarded": "x", "in-reply-to": STEP1 } }), "forward_loop"],
      [reply({ to: ["hello@b4.run"] }), "recipient_mismatch"],
    ]
    for (const [email, code] of cases) {
      const { executor, calls } = recordingExecutor([PENDING, PENDING])
      expect(await processInboundReply(executor, ID, deps(email))).toEqual({
        outcome: "ignored",
        code,
      })
      expect(stopped(calls)).toBe(false)
      expect(calls.some((call) => call.text.includes("from growth_sends"))).toBe(false)
    }
  })

  it("settles a message without references as unmatched, whatever its subject", async () => {
    const { executor, calls } = recordingExecutor([PENDING, PENDING])
    const bare = reply({ subject: "Re: Unsubscribe me", headers: {} })
    expect(await processInboundReply(executor, ID, deps(bare))).toEqual({
      outcome: "unmatched",
      code: "no_references",
    })
    expect(stopped(calls)).toBe(false)
  })

  it("waits when the sender is a contact whose send is not bound yet", async () => {
    const { executor, calls } = recordingExecutor([
      PENDING,
      NONE,
      { rows: [{ bindable: 1, unbindable: 0 }], rowCount: 1 },
      PENDING,
    ])
    expect(await processInboundReply(executor, ID, deps())).toEqual({
      outcome: "pending",
      code: "binding_pending",
    })
    expect(calls[2]?.params).toEqual([emailLookupHmac(SECRET, "ada@example.com")])
    expect(calls.at(-1)?.text).toContain("reply_attempts = reply_attempts + 1")
  })

  it("settles as unmatched when no send matches and nothing is waiting for a binding", async () => {
    const { executor } = recordingExecutor([
      PENDING,
      NONE,
      { rows: [{ bindable: 0, unbindable: 0 }], rowCount: 1 },
      PENDING,
    ])
    expect(await processInboundReply(executor, ID, deps())).toEqual({
      outcome: "unmatched",
      code: "no_match",
    })
  })

  it("keeps a receipt pending with a code when Resend cannot be read", async () => {
    const { executor, calls } = recordingExecutor([PENDING])
    expect(
      await processInboundReply(executor, ID, deps(new InboundError("receiving_timeout"))),
    ).toEqual({ outcome: "pending", code: "receiving_timeout" })
    expect(calls[1]?.params).toEqual([ID, "receiving_timeout"])
  })

  it("settles a message Resend no longer holds", async () => {
    const { executor } = recordingExecutor([PENDING, PENDING])
    expect(
      await processInboundReply(executor, ID, deps(new InboundError("receiving_http_404"))),
    ).toEqual({ outcome: "unmatched", code: "source_missing" })
  })

  it("does nothing for an already processed or unknown receipt", async () => {
    const done = recordingExecutor([{ rows: [{ reply_status: "matched" }], rowCount: 1 }])
    expect(await processInboundReply(done.executor, ID, deps())).toEqual({
      outcome: "already_processed",
    })
    expect(done.calls).toHaveLength(1)
    const unknown = recordingExecutor([NONE])
    expect(await processInboundReply(unknown.executor, ID, deps())).toEqual({
      outcome: "unknown_receipt",
    })
  })

  it("stores ids and codes only", async () => {
    const { executor, calls } = recordingExecutor([
      PENDING,
      NONE,
      { rows: [{ bindable: 0, unbindable: 0 }], rowCount: 1 },
      PENDING,
    ])
    await processInboundReply(executor, ID, deps())
    const writes = calls.filter((call) => call.text.startsWith("update growth_inbound_receipts"))
    expect(JSON.stringify(writes.map((call) => call.params))).not.toMatch(
      /@|Secret|amazonses|example/,
    )
  })
})
