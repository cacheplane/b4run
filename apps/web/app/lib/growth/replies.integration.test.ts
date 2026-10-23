import { describe, expect, it } from "vitest"
import { acceptFounderUpdatesForm, DISCLOSURE_VERSION } from "./contacts"
import type { SqlExecutor } from "./database"
import { admitInboundReceipt, type ReceivedEmail, type SentEmail } from "./inbound"
import type { Mailer, OutgoingEmail } from "./mailer"
import {
  backfillOutboundBindings,
  bindOutboundMessageId,
  processInboundReply,
  processPendingReplies,
  type ReplyDeps,
} from "./replies"
import {
  authoriseAndSend,
  enrollApprovedContacts,
  leaseDueSends,
  REPLY_HOLD_DELAY_SECONDS,
} from "./sequence"
import type { SequenceEnv } from "./sequence-env"
import { GROWTH_DB_TESTS_ENABLED, withMigratedDatabase } from "./test-support/postgres"

const SECRET = "test-secret"
const START_AT = new Date("2026-10-20T00:00:00.000Z")
// Wednesday 03:00 PDT.
const APPROVED = new Date("2026-10-21T10:00:00.000Z")
// Thursday 07:05 PDT: step 1 is due.
const SEND1_NOW = new Date("2026-10-22T14:05:00.000Z")
// Friday: the reply arrives.
const REPLY_AT = new Date("2026-10-23T18:00:00.000Z")
// Tuesday 07:05 PDT: step 2 is due.
const SEND2_NOW = new Date("2026-10-27T14:05:00.000Z")
const RECEIPT = "rcv_reply_1"
const STEP1_MESSAGE_ID = "<step1-0001@email.amazonses.com>"

const env: SequenceEnv = {
  databaseUrl: "postgres://unused",
  emailHmacSecret: SECRET,
  tokenKeyring: { active: { id: 1, secret: "token-secret-value" }, previous: [] },
  environment: "test",
  publicOrigin: "https://b4.run",
  sequenceEnabled: true,
  sequenceStartAt: START_AT,
  deliveryEnabled: true,
  resendApiKey: "re_test",
  founderEmail: "brian@b4.run",
}

function countingMailer() {
  const sent: OutgoingEmail[] = []
  const mailer: Mailer = {
    async send(email) {
      sent.push(email)
      return { kind: "accepted", providerEmailId: `em_${sent.length}` }
    },
  }
  return { mailer, sent }
}

const reply = (overrides: Record<string, unknown> = {}): ReceivedEmail => ({
  id: RECEIPT,
  to: ["brian@b4.run"],
  from: "Ada Lovelace <Ada@Example.com>",
  subject: "Re: Secret subject",
  text: "Secret body, out of office until Monday",
  headers: { "in-reply-to": STEP1_MESSAGE_ID, references: STEP1_MESSAGE_ID },
  ...overrides,
})

const replyDeps = (email: ReceivedEmail = reply()): ReplyDeps => ({
  getReceived: async () => email,
  emailHmacSecret: SECRET,
  now: () => REPLY_AT,
})

let submission = 0
/** An approved, enrolled contact whose step 1 Resend accepted as em_1. */
async function contactAfterStep1(executor: SqlExecutor, mailer: Mailer, email = "ada@example.com") {
  submission += 1
  const { contactId } = await acceptFounderUpdatesForm(executor, SECRET, {
    email,
    disclosureVersion: DISCLOSURE_VERSION,
    submissionId: `sub-${submission}`,
    now: APPROVED,
  })
  await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })
  const [send] = await leaseDueSends(executor, {
    now: SEND1_NOW,
    limit: 1,
    leaseToken: crypto.randomUUID(),
  })
  if (send === undefined) throw new Error("step 1 was not due")
  expect(await authoriseAndSend(executor, { send, env, mailer, now: SEND1_NOW })).toBe("sent")
  return contactId
}

async function state(executor: SqlExecutor, contactId: string) {
  const contact = await executor.query<{ stop_reason: string | null; approved_at: Date | null }>(
    "select stop_reason, approved_at from growth_contacts where id = $1",
    [contactId],
  )
  const sends = await executor.query<{
    step: number
    status: string
    attempts: number
    last_error_code: string | null
    due_at: Date
  }>(
    "select step, status, attempts, last_error_code, due_at from growth_sends where contact_id = $1 order by step",
    [contactId],
  )
  const receipt = await executor.query<{
    reply_status: string
    contact_id: string | null
    matched_send_id: string | null
    reply_error_code: string | null
  }>(
    "select reply_status, contact_id, matched_send_id, reply_error_code from growth_inbound_receipts where id = $1",
    [RECEIPT],
  )
  return { contact: contact.rows[0], sends: sends.rows, receipt: receipt.rows[0] }
}

const stopActivities = (executor: SqlExecutor, contactId: string) =>
  executor.query<{ kind: string; data: { provenance?: string } }>(
    "select kind, data from growth_activity where contact_id = $1 and kind like 'stop.%'",
    [contactId],
  )

describe.skipIf(!GROWTH_DB_TESTS_ENABLED)("growth reply detection", () => {
  it("a reply to step 1 stops the contact and cancels the pending step 2", async () => {
    await withMigratedDatabase(async (executor) => {
      const { mailer } = countingMailer()
      const contactId = await contactAfterStep1(executor, mailer)
      expect(
        await bindOutboundMessageId(executor, {
          providerEmailId: "em_1",
          messageId: STEP1_MESSAGE_ID,
        }),
      ).toBe("bound")
      await admitInboundReceipt(executor, { id: RECEIPT, receivedAt: REPLY_AT })

      expect(await processInboundReply(executor, RECEIPT, replyDeps())).toEqual({
        outcome: "matched",
      })
      const after = await state(executor, contactId)
      expect(after.contact).toMatchObject({ stop_reason: "reply_received", approved_at: null })
      expect(after.sends.map((send) => [send.step, send.status])).toEqual([
        [1, "submitted"],
        [2, "cancelled"],
      ])
      expect(after.receipt).toMatchObject({
        reply_status: "matched",
        contact_id: contactId,
        reply_error_code: null,
      })
      expect(after.receipt?.matched_send_id).not.toBeNull()
      const stops = await stopActivities(executor, contactId)
      expect(stops.rows).toEqual([
        { kind: "stop.reply_received", data: { provenance: "mailbox_reply" } },
      ])
    })
  }, 120_000)

  it("a reply that arrives before the outbound binding waits, then matches after the backfill", async () => {
    await withMigratedDatabase(async (executor) => {
      const { mailer } = countingMailer()
      const contactId = await contactAfterStep1(executor, mailer)
      await admitInboundReceipt(executor, { id: RECEIPT, receivedAt: REPLY_AT })

      expect(await processInboundReply(executor, RECEIPT, replyDeps())).toEqual({
        outcome: "pending",
        code: "binding_pending",
      })
      expect((await state(executor, contactId)).contact?.stop_reason).toBeNull()

      const reads: string[] = []
      const bindings = await backfillOutboundBindings(executor, {
        getSent: async (id): Promise<SentEmail> => {
          reads.push(id)
          return { messageId: STEP1_MESSAGE_ID }
        },
        canContinue: () => true,
      })
      expect(bindings).toEqual({ bound: 1, waiting: 0, failed: 0 })
      expect(reads).toEqual(["em_1"])

      expect(
        await processPendingReplies(executor, { ...replyDeps(), canContinue: () => true }),
      ).toEqual({ matched: 1, unmatched: 0, ignored: 0, pending: 0 })
      expect((await state(executor, contactId)).contact?.stop_reason).toBe("reply_received")
    })
  }, 120_000)

  it("refuses a conflicting binding", async () => {
    await withMigratedDatabase(async (executor) => {
      const { mailer } = countingMailer()
      await contactAfterStep1(executor, mailer)
      await contactAfterStep1(executor, mailer, "grace@example.com")
      expect(
        await bindOutboundMessageId(executor, {
          providerEmailId: "em_1",
          messageId: STEP1_MESSAGE_ID,
        }),
      ).toBe("bound")
      // The same send, a different id; and a different send claiming the same id.
      expect(
        await bindOutboundMessageId(executor, {
          providerEmailId: "em_1",
          messageId: "<other@email.amazonses.com>",
        }),
      ).toBe("conflict")
      expect(
        await bindOutboundMessageId(executor, {
          providerEmailId: "em_2",
          messageId: STEP1_MESSAGE_ID,
        }),
      ).toBe("conflict")
      expect(
        await bindOutboundMessageId(executor, {
          providerEmailId: "em_1",
          messageId: STEP1_MESSAGE_ID,
        }),
      ).toBe("bound")
    })
  }, 120_000)

  it("a duplicate webhook and a recovery racing on one reply stop the contact once", async () => {
    await withMigratedDatabase(async (executor) => {
      const { mailer } = countingMailer()
      const contactId = await contactAfterStep1(executor, mailer)
      await bindOutboundMessageId(executor, {
        providerEmailId: "em_1",
        messageId: STEP1_MESSAGE_ID,
      })
      await admitInboundReceipt(executor, { id: RECEIPT, receivedAt: REPLY_AT })
      await admitInboundReceipt(executor, { id: RECEIPT, receivedAt: REPLY_AT })

      // Both calls finish their provider read before either takes a lock.
      let arrived = 0
      let release: () => void = () => undefined
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const racing: ReplyDeps = {
        ...replyDeps(),
        async getReceived() {
          arrived += 1
          if (arrived === 2) release()
          await barrier
          return reply()
        },
      }
      const results = await Promise.all([
        processInboundReply(executor, RECEIPT, racing),
        processInboundReply(executor, RECEIPT, racing),
      ])
      expect(results.map((result) => result.outcome).sort()).toEqual([
        "already_processed",
        "matched",
      ])
      expect((await stopActivities(executor, contactId)).rows).toHaveLength(1)
    })
  }, 120_000)

  it("a pending receipt holds the next step without consuming an attempt, then releases it", async () => {
    await withMigratedDatabase(async (executor) => {
      const { mailer, sent } = countingMailer()
      const contactId = await contactAfterStep1(executor, mailer)
      await bindOutboundMessageId(executor, {
        providerEmailId: "em_1",
        messageId: STEP1_MESSAGE_ID,
      })
      // Someone who is not a contact writes in; until it is processed, it could be anyone's reply.
      await admitInboundReceipt(executor, { id: RECEIPT, receivedAt: REPLY_AT })

      const [held] = await leaseDueSends(executor, {
        now: SEND2_NOW,
        limit: 1,
        leaseToken: crypto.randomUUID(),
      })
      if (held === undefined) throw new Error("step 2 was not due")
      expect(await authoriseAndSend(executor, { send: held, env, mailer, now: SEND2_NOW })).toBe(
        "held_for_reply",
      )
      expect(sent).toHaveLength(1)
      const step2 = (await state(executor, contactId)).sends[1]
      expect(step2).toMatchObject({
        status: "pending",
        attempts: 0,
        last_error_code: "reply_processing_pending",
      })
      expect(step2?.due_at.getTime()).toBe(SEND2_NOW.getTime() + REPLY_HOLD_DELAY_SECONDS * 1000)

      const stranger = reply({ from: "stranger@example.org" })
      expect(await processInboundReply(executor, RECEIPT, replyDeps(stranger))).toEqual({
        outcome: "unmatched",
        code: "sender_mismatch",
      })

      const later = new Date(SEND2_NOW.getTime() + 600_000)
      const [released] = await leaseDueSends(executor, {
        now: later,
        limit: 1,
        leaseToken: crypto.randomUUID(),
      })
      if (released === undefined) throw new Error("step 2 was not released")
      expect(released.attempts).toBe(1)
      expect(await authoriseAndSend(executor, { send: released, env, mailer, now: later })).toBe(
        "sent",
      )
      expect(sent).toHaveLength(2)
    })
  }, 120_000)

  it("holds the next step until the previous send's Message-ID is bound", async () => {
    await withMigratedDatabase(async (executor) => {
      const { mailer, sent } = countingMailer()
      const contactId = await contactAfterStep1(executor, mailer)
      const [send] = await leaseDueSends(executor, {
        now: SEND2_NOW,
        limit: 1,
        leaseToken: crypto.randomUUID(),
      })
      if (send === undefined) throw new Error("step 2 was not due")
      expect(await authoriseAndSend(executor, { send, env, mailer, now: SEND2_NOW })).toBe(
        "held_for_reply",
      )
      expect((await state(executor, contactId)).sends[1]).toMatchObject({
        status: "pending",
        attempts: 0,
        last_error_code: "reply_binding_pending",
      })
      expect(sent).toHaveLength(1)
    })
  }, 120_000)

  it("B4's own mail never holds a send", async () => {
    await withMigratedDatabase(async (executor) => {
      const { mailer } = countingMailer()
      await contactAfterStep1(executor, mailer)
      await bindOutboundMessageId(executor, {
        providerEmailId: "em_1",
        messageId: STEP1_MESSAGE_ID,
      })
      await admitInboundReceipt(executor, { id: "bcc_copy", receivedAt: SEND1_NOW, selfSent: true })
      const [send] = await leaseDueSends(executor, {
        now: SEND2_NOW,
        limit: 1,
        leaseToken: crypto.randomUUID(),
      })
      if (send === undefined) throw new Error("step 2 was not due")
      expect(await authoriseAndSend(executor, { send, env, mailer, now: SEND2_NOW })).toBe("sent")
    })
  }, 120_000)

  it("a reply from another address that references the send never stops anyone", async () => {
    await withMigratedDatabase(async (executor) => {
      const { mailer } = countingMailer()
      const contactId = await contactAfterStep1(executor, mailer)
      await bindOutboundMessageId(executor, {
        providerEmailId: "em_1",
        messageId: STEP1_MESSAGE_ID,
      })
      await admitInboundReceipt(executor, { id: RECEIPT, receivedAt: REPLY_AT })
      const forged = reply({ from: "mallory@example.net" })
      expect(await processInboundReply(executor, RECEIPT, replyDeps(forged))).toEqual({
        outcome: "unmatched",
        code: "sender_mismatch",
      })
      const after = await state(executor, contactId)
      expect(after.contact?.stop_reason).toBeNull()
      expect(after.sends[1]?.status).toBe("pending")
      expect(after.receipt).toMatchObject({ contact_id: null, matched_send_id: null })
      expect((await stopActivities(executor, contactId)).rows).toHaveLength(0)
    })
  }, 120_000)

  it("stores nothing but ids and codes", async () => {
    await withMigratedDatabase(async (executor) => {
      const { mailer } = countingMailer()
      await contactAfterStep1(executor, mailer)
      await bindOutboundMessageId(executor, {
        providerEmailId: "em_1",
        messageId: STEP1_MESSAGE_ID,
      })
      await admitInboundReceipt(executor, { id: RECEIPT, receivedAt: REPLY_AT })
      await admitInboundReceipt(executor, { id: "rcv_other", receivedAt: REPLY_AT })
      await processInboundReply(executor, RECEIPT, replyDeps())
      await processInboundReply(executor, "rcv_other", {
        ...replyDeps(reply({ id: "rcv_other", from: "x@example.org", headers: {} })),
      })
      const receipts = await executor.query("select * from growth_inbound_receipts")
      expect(JSON.stringify(receipts.rows)).not.toMatch(/@|Secret|Lovelace|out of office/)
      const activity = await executor.query(
        "select data from growth_activity where kind like 'stop.%'",
      )
      expect(JSON.stringify(activity.rows)).not.toMatch(/@|Secret/)
    })
  }, 120_000)
})
