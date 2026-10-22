import { describe, expect, it } from "vitest"
import {
  acceptFounderUpdatesForm,
  contactJourney,
  DISCLOSURE_VERSION,
  deleteContact,
  reapproveContact,
  stopContact,
} from "./contacts"
import { createPgExecutor, type SqlExecutor, type SqlTransaction } from "./database"
import type { Mailer, OutgoingEmail, SendResult } from "./mailer"
import {
  authoriseAndSend,
  enrollApprovedContacts,
  IDEMPOTENCY_WINDOW_SECONDS,
  LEASE_SECONDS,
  type LeasedSend,
  leaseDueSends,
  MAX_ATTEMPTS,
  RATE_LIMIT_DELAY_SECONDS,
  RETRY_DELAY_SECONDS,
  releaseLeases,
  sendIdempotencyKey,
} from "./sequence"
import type { SequenceEnv } from "./sequence-env"
import { GROWTH_DB_TESTS_ENABLED, withMigratedDatabase } from "./test-support/postgres"
import { verifyActionToken } from "./tokens"

const SECRET = "test-secret"
const START_AT = new Date("2026-10-20T00:00:00.000Z")
// Wednesday 03:00 PDT.
const APPROVED = new Date("2026-10-21T10:00:00.000Z")
// Thursday 07:00 PDT.
const STEP1_DUE = new Date("2026-10-22T14:00:00.000Z")
const SEND1_NOW = new Date("2026-10-22T14:05:00.000Z")
// Tuesday 07:00 PDT, three business days after Thursday.
const STEP2_DUE = new Date("2026-10-27T14:00:00.000Z")
const SEND2_NOW = new Date("2026-10-27T14:05:00.000Z")
// Tuesday 07:00 PST, five business days after Tuesday, across the DST change.
const STEP3_DUE = new Date("2026-11-03T15:00:00.000Z")
const SEND3_NOW = new Date("2026-11-03T15:05:00.000Z")

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

const ACCEPTED: SendResult = { kind: "accepted", providerEmailId: "em_1" }

interface RecordingMailer extends Mailer {
  readonly calls: OutgoingEmail[]
}

function recordingMailer(
  results: SendResult | readonly SendResult[] | ((call: number) => Promise<SendResult>),
): RecordingMailer {
  const calls: OutgoingEmail[] = []
  return {
    calls,
    async send(email) {
      calls.push(email)
      const index = calls.length - 1
      if (typeof results === "function") return results(index)
      if (Array.isArray(results)) {
        const result = results[Math.min(index, results.length - 1)]
        if (result === undefined) throw new Error("no stub result")
        return result
      }
      return results as SendResult
    },
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let counter = 0
async function approve(executor: SqlExecutor, email = "ada@example.com", now = APPROVED) {
  counter += 1
  const result = await acceptFounderUpdatesForm(executor, SECRET, {
    email,
    disclosureVersion: DISCLOSURE_VERSION,
    submissionId: `sub-${counter}`,
    now,
  })
  return result.contactId
}

interface SendRow extends Record<string, unknown> {
  id: string
  step: number
  status: string
  due_at: Date
  attempts: number
  lease_token: string | null
  lease_until: Date | null
  provider_email_id: string | null
  delivery_status: string
  last_error_code: string | null
  idempotency_key: string
  first_attempted_at: Date | null
}

async function sendsFor(executor: SqlExecutor, contactId: string) {
  const result = await executor.query<SendRow>(
    "select id, step, status, due_at, attempts, lease_token, lease_until, provider_email_id, delivery_status, last_error_code, idempotency_key, first_attempted_at from growth_sends where contact_id = $1 order by step",
    [contactId],
  )
  return result.rows
}

const after = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000)

const lease = (executor: SqlExecutor, now: Date, limit = 10, leaseToken = crypto.randomUUID()) =>
  leaseDueSends(executor, { now, limit, leaseToken })

async function leaseOne(executor: SqlExecutor, now: Date): Promise<LeasedSend> {
  const leased = await lease(executor, now)
  expect(leased).toHaveLength(1)
  return leased[0] as LeasedSend
}

async function enrolledContact(executor: SqlExecutor, email = "ada@example.com") {
  const contactId = await approve(executor, email)
  await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })
  return contactId
}

async function sendStep(
  executor: SqlExecutor,
  now: Date,
  mailer: Mailer = recordingMailer(async () => ({
    kind: "accepted",
    providerEmailId: `em_${crypto.randomUUID()}`,
  })),
) {
  const send = await leaseOne(executor, now)
  return authoriseAndSend(executor, { send, env, mailer, now })
}

/** An executor bound to one open transaction, so its row locks stay held until the caller ends it. */
function transactionExecutor(tx: SqlTransaction): SqlExecutor {
  return {
    query: (text, params) => tx.query(text, params),
    transaction: (fn) => fn(tx),
    end: async () => undefined,
  }
}

async function withSecondExecutor<T>(uri: string, fn: (other: SqlExecutor) => Promise<T>) {
  const other = createPgExecutor(uri)
  try {
    return await fn(other)
  } finally {
    await other.end()
  }
}

async function waitForLockWaiter(executor: SqlExecutor) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await executor.query<{ waiting: number }>(
      "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    )
    if ((result.rows[0]?.waiting ?? 0) > 0) return
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error("no session waited on a lock")
}

describe.skipIf(!GROWTH_DB_TESTS_ENABLED)("growth founder sequence engine", () => {
  it("enrolls an approved contact once with step 1 due the next business morning", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await approve(executor)
      expect(await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })).toEqual({
        enrolled: 1,
      })
      expect(await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })).toEqual({
        enrolled: 0,
      })
      const rows = await sendsFor(executor, contactId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        step: 1,
        status: "pending",
        attempts: 0,
        idempotency_key: sendIdempotencyKey(contactId, 1),
      })
      expect(rows[0]?.due_at.toISOString()).toBe(STEP1_DUE.toISOString())
      const journey = await contactJourney(executor, contactId)
      expect(journey.filter((entry) => entry.kind === "sequence.enrolled")).toHaveLength(1)
      const keys = await executor.query<{ event_key: string }>(
        "select event_key from growth_activity where kind = 'sequence.enrolled'",
      )
      expect(keys.rows.map((row) => row.event_key)).toEqual([`enrolled:v1:${contactId}`])
    })
  }, 120_000)

  it("never enrolls a contact approved before the start time", async () => {
    await withMigratedDatabase(async (executor) => {
      const early = await approve(executor, "early@example.com", new Date("2026-10-19T23:59:59Z"))
      const onTime = await approve(executor, "ontime@example.com", START_AT)
      expect(await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })).toEqual({
        enrolled: 1,
      })
      expect(await sendsFor(executor, early)).toHaveLength(0)
      expect(await sendsFor(executor, onTime)).toHaveLength(1)
    })
  }, 120_000)

  it("never enrolls a stopped or deleted contact", async () => {
    await withMigratedDatabase(async (executor) => {
      const stopped = await approve(executor, "stopped@example.com")
      const deleted = await approve(executor, "deleted@example.com")
      await stopContact(executor, {
        contactId: stopped,
        reason: "unsubscribe",
        provenance: "test",
        now: APPROVED,
      })
      await deleteContact(executor, { contactId: deleted, now: APPROVED })
      expect(await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })).toEqual({
        enrolled: 0,
      })
      expect(await sendsFor(executor, stopped)).toHaveLength(0)
      expect(await sendsFor(executor, deleted)).toHaveLength(0)
    })
  }, 120_000)

  it("never re-enrolls a contact who was stopped and reapproved", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      await stopContact(executor, {
        contactId,
        reason: "unsubscribe",
        provenance: "test",
        now: APPROVED,
      })
      await reapproveContact(executor, {
        contactId,
        provenance: "founder",
        now: new Date("2026-10-23T10:00:00Z"),
      })
      expect(
        await enrollApprovedContacts(executor, {
          startAt: START_AT,
          now: new Date("2026-10-23T10:00:00Z"),
        }),
      ).toEqual({ enrolled: 0 })
      const rows = await sendsFor(executor, contactId)
      expect(rows.map((row) => row.status)).toEqual(["cancelled"])
    })
  }, 120_000)

  it("leases each due send once even when two ticks lease concurrently", async () => {
    await withMigratedDatabase(async (executor, uri) => {
      for (let index = 0; index < 12; index++) await approve(executor, `p${index}@example.com`)
      await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })
      await withSecondExecutor(uri, async (other) => {
        const [first, second] = await Promise.all([
          lease(executor, SEND1_NOW, 8),
          lease(other, SEND1_NOW, 8),
        ])
        const ids = [...first, ...second].map((send) => send.id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids).toHaveLength(12)
        expect(await lease(executor, SEND1_NOW)).toEqual([])
      })
    })
  }, 120_000)

  it("skips sends another tick holds instead of waiting for them", async () => {
    await withMigratedDatabase(async (executor, uri) => {
      for (let index = 0; index < 6; index++) await approve(executor, `q${index}@example.com`)
      await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })
      await withSecondExecutor(uri, async (other) => {
        await executor.transaction(async (tx) => {
          const held = await lease(transactionExecutor(tx), SEND1_NOW, 3)
          // The first tick has not committed; the second must skip its rows, not block on them.
          const rest = await lease(other, SEND1_NOW, 10)
          expect(held).toHaveLength(3)
          expect(rest).toHaveLength(3)
          const heldIds = new Set(held.map((send) => send.id))
          expect(rest.some((send) => heldIds.has(send.id))).toBe(false)
        })
      })
    })
  }, 120_000)

  it("reclaims an expired lease and marks an exhausted expired lease failed", async () => {
    await withMigratedDatabase(async (executor) => {
      const reclaimable = await enrolledContact(executor, "reclaim@example.com")
      const exhausted = await enrolledContact(executor, "exhausted@example.com")
      await executor.query(
        "update growth_sends set status = 'leased', attempts = $2, lease_token = gen_random_uuid(), lease_until = $3 where contact_id = $1",
        [exhausted, MAX_ATTEMPTS, SEND1_NOW],
      )
      const first = await leaseOne(executor, SEND1_NOW)
      expect(first).toMatchObject({ contactId: reclaimable, step: 1, attempts: 1 })

      const stillHeld = new Date(SEND1_NOW.getTime() + (LEASE_SECONDS - 1) * 1000)
      expect(await lease(executor, stillHeld)).toEqual([])

      const expired = new Date(SEND1_NOW.getTime() + LEASE_SECONDS * 1000)
      const second = await leaseOne(executor, expired)
      expect(second).toMatchObject({ id: first.id, attempts: 2 })
      expect(second.leaseToken).not.toBe(first.leaseToken)

      const [row] = await sendsFor(executor, exhausted)
      expect(row).toMatchObject({
        status: "failed",
        delivery_status: "unknown",
        last_error_code: "lease_expired",
        lease_token: null,
        lease_until: null,
      })
    })
  }, 120_000)

  it("releases unstarted leases back to pending and gives back the attempt", async () => {
    await withMigratedDatabase(async (executor) => {
      const a = await enrolledContact(executor, "ra@example.com")
      const b = await enrolledContact(executor, "rb@example.com")
      const c = await enrolledContact(executor, "rc@example.com")
      const leaseToken = crypto.randomUUID()
      const held = await lease(executor, SEND1_NOW, 10, leaseToken)
      expect(held).toHaveLength(3)
      const byContact = new Map(held.map((send) => [send.contactId, send.id]))

      // Another token never releases this tick's rows.
      expect(
        await releaseLeases(executor, {
          leaseToken: crypto.randomUUID(),
          ids: [byContact.get(a) as string],
        }),
      ).toEqual({ released: 0 })

      expect(
        await releaseLeases(executor, {
          leaseToken,
          ids: [byContact.get(a) as string, byContact.get(b) as string],
        }),
      ).toEqual({ released: 2 })
      for (const contactId of [a, b]) {
        const [row] = await sendsFor(executor, contactId)
        expect(row).toMatchObject({
          status: "pending",
          attempts: 0,
          lease_token: null,
          lease_until: null,
          first_attempted_at: null,
          due_at: STEP1_DUE,
        })
      }
      const [untouched] = await sendsFor(executor, c)
      expect(untouched).toMatchObject({ status: "leased", attempts: 1, lease_token: leaseToken })

      // Released rows are due again on the next lease.
      const again = await lease(executor, SEND1_NOW)
      expect(again.map((send) => send.contactId).sort()).toEqual([a, b].sort())
      expect(again.every((send) => send.attempts === 1)).toBe(true)
    })
  }, 120_000)

  it("keeps the first attempt time when a released send was attempted before", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      const first = await leaseOne(executor, SEND1_NOW)
      const expired = after(SEND1_NOW, LEASE_SECONDS)
      const second = await leaseOne(executor, expired)
      expect(second.attempts).toBe(2)
      // The first tick's token no longer holds the row another tick reclaimed.
      expect(
        await releaseLeases(executor, { leaseToken: first.leaseToken, ids: [first.id] }),
      ).toEqual({ released: 0 })
      expect(
        await releaseLeases(executor, { leaseToken: second.leaseToken, ids: [second.id] }),
      ).toEqual({ released: 1 })
      const [row] = await sendsFor(executor, contactId)
      expect(row).toMatchObject({ status: "pending", attempts: 1, first_attempted_at: SEND1_NOW })
    })
  }, 120_000)

  it("a 429 returns the send to pending without consuming an attempt", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      const mailer = recordingMailer({ kind: "retryable", code: "http_429" })
      let now = SEND1_NOW
      for (let round = 0; round < MAX_ATTEMPTS + 2; round++) {
        expect(await sendStep(executor, now, mailer)).toBe("retry_later")
        const [row] = await sendsFor(executor, contactId)
        expect(row?.due_at.toISOString()).toBe(after(now, RATE_LIMIT_DELAY_SECONDS).toISOString())
        expect(await lease(executor, now)).toEqual([])
        expect(await lease(executor, after(now, RATE_LIMIT_DELAY_SECONDS - 1))).toEqual([])
        now = after(now, RATE_LIMIT_DELAY_SECONDS)
      }
      const [row] = await sendsFor(executor, contactId)
      expect(row).toMatchObject({
        status: "pending",
        attempts: 0,
        lease_token: null,
        lease_until: null,
      })
      expect(mailer.calls).toHaveLength(MAX_ATTEMPTS + 2)
    })
  }, 120_000)

  it("sends step 1, records the provider id, and schedules step 2 three business days later", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      expect(await lease(executor, new Date(STEP1_DUE.getTime() - 1))).toEqual([])
      const mailer = recordingMailer(ACCEPTED)
      expect(await sendStep(executor, SEND1_NOW, mailer)).toBe("sent")

      const [step1, step2] = await sendsFor(executor, contactId)
      expect(step1).toMatchObject({
        status: "submitted",
        delivery_status: "submitted",
        provider_email_id: "em_1",
        lease_token: null,
        lease_until: null,
        last_error_code: null,
      })
      expect(step2).toMatchObject({
        step: 2,
        status: "pending",
        idempotency_key: sendIdempotencyKey(contactId, 2),
      })
      expect(step2?.due_at.toISOString()).toBe(STEP2_DUE.toISOString())

      expect(mailer.calls).toHaveLength(1)
      const email = mailer.calls[0] as OutgoingEmail
      expect(email.to).toBe("ada@example.com")
      expect(email.idempotencyKey).toBe(sendIdempotencyKey(contactId, 1))
      expect(email.headers["X-B4-Send-ID"]).toBe(step1?.id)
      const token = new URL(
        (email.headers["List-Unsubscribe"] ?? "").replace(/^<|>$/g, ""),
      ).searchParams.get("token")
      expect(
        verifyActionToken({
          token: token ?? "",
          keyring: env.tokenKeyring,
          purpose: "unsubscribe",
          now: SEND1_NOW,
        }),
      ).toEqual({ ok: true, contactId })

      const activity = await executor.query<{ event_key: string }>(
        "select event_key from growth_activity where kind = 'send.submitted'",
      )
      expect(activity.rows.map((row) => row.event_key)).toEqual([`submitted:${step1?.id}`])
    })
  }, 120_000)

  it("schedules step 3 five business days after step 2 and nothing after step 3", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      expect(await sendStep(executor, SEND1_NOW)).toBe("sent")
      expect(await lease(executor, new Date(STEP2_DUE.getTime() - 1))).toEqual([])
      expect(await sendStep(executor, SEND2_NOW)).toBe("sent")
      const afterTwo = await sendsFor(executor, contactId)
      expect(afterTwo[2]?.step).toBe(3)
      expect(afterTwo[2]?.due_at.toISOString()).toBe(STEP3_DUE.toISOString())

      const mailer = recordingMailer(ACCEPTED)
      expect(await sendStep(executor, SEND3_NOW, mailer)).toBe("sent")
      expect(mailer.calls[0]?.idempotencyKey).toBe(sendIdempotencyKey(contactId, 3))
      const rows = await sendsFor(executor, contactId)
      expect(rows.map((row) => [row.step, row.status])).toEqual([
        [1, "submitted"],
        [2, "submitted"],
        [3, "submitted"],
      ])
      expect(await lease(executor, new Date("2027-01-01T15:00:00Z"))).toEqual([])
    })
  }, 120_000)

  it("cancels instead of sending when the contact was stopped after leasing", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      const send = await leaseOne(executor, SEND1_NOW)
      // A stop recorded on the contact while the lease is still held.
      await executor.query(
        "update growth_contacts set approved_at = null, stopped_at = $2, stop_reason = 'unsubscribe' where id = $1",
        [contactId, SEND1_NOW],
      )
      const mailer = recordingMailer(ACCEPTED)
      expect(await authoriseAndSend(executor, { send, env, mailer, now: SEND1_NOW })).toBe(
        "cancelled_not_authorised",
      )
      expect(mailer.calls).toHaveLength(0)
      const rows = await sendsFor(executor, contactId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: "cancelled", lease_token: null, lease_until: null })
    })
  }, 120_000)

  it("a stop that races a send leaves no pending next step and never deadlocks", async () => {
    await withMigratedDatabase(async (executor, uri) => {
      const contactId = await enrolledContact(executor)
      const send = await leaseOne(executor, SEND1_NOW)
      const entered = deferred<void>()
      const release = deferred<void>()
      const mailer = recordingMailer(async () => {
        entered.resolve()
        await release.promise
        return ACCEPTED
      })
      await withSecondExecutor(uri, async (other) => {
        const sending = authoriseAndSend(executor, { send, env, mailer, now: SEND1_NOW })
        await entered.promise
        const stopping = stopContact(other, {
          contactId,
          reason: "unsubscribe",
          provenance: "test",
          now: SEND1_NOW,
        })
        // The stop is now queued behind the send's contact lock.
        await waitForLockWaiter(executor)
        release.resolve()
        const [outcome, stop] = await Promise.all([sending, stopping])
        expect(outcome).toBe("sent")
        expect(stop).toEqual({ applied: true })
      })
      expect(mailer.calls).toHaveLength(1)
      const rows = await sendsFor(executor, contactId)
      expect(rows.map((row) => [row.step, row.status])).toEqual([
        [1, "submitted"],
        [2, "cancelled"],
      ])
      expect(await lease(executor, new Date("2027-01-01T15:00:00Z"))).toEqual([])
    })
  }, 120_000)

  it("a stop that commits between leasing and sending yields lease_lost and no mail", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      const send = await leaseOne(executor, SEND1_NOW)
      await stopContact(executor, {
        contactId,
        reason: "unsubscribe",
        provenance: "test",
        now: SEND1_NOW,
      })
      const mailer = recordingMailer(ACCEPTED)
      expect(await authoriseAndSend(executor, { send, env, mailer, now: SEND1_NOW })).toBe(
        "lease_lost",
      )
      expect(mailer.calls).toHaveLength(0)
      const rows = await sendsFor(executor, contactId)
      expect(rows.map((row) => row.status)).toEqual(["cancelled"])
    })
  }, 120_000)

  it("a retryable failure retries with the same idempotency key and the same email body", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      const mailer = recordingMailer([{ kind: "retryable", code: "timeout" }, ACCEPTED])
      expect(await sendStep(executor, SEND1_NOW, mailer)).toBe("retry_later")
      const [afterFailure] = await sendsFor(executor, contactId)
      expect(afterFailure).toMatchObject({
        status: "pending",
        attempts: 1,
        last_error_code: "timeout",
        lease_token: null,
      })
      expect(afterFailure?.due_at.toISOString()).toBe(
        after(SEND1_NOW, RETRY_DELAY_SECONDS).toISOString(),
      )
      expect(afterFailure?.first_attempted_at?.toISOString()).toBe(SEND1_NOW.toISOString())
      // The same tick loop cannot burn the next attempt straight away.
      expect(await lease(executor, SEND1_NOW)).toEqual([])
      expect(await lease(executor, after(SEND1_NOW, RETRY_DELAY_SECONDS - 1))).toEqual([])
      // A later tick, with a different clock, retries the same send.
      expect(await sendStep(executor, new Date(SEND1_NOW.getTime() + 30 * 60_000), mailer)).toBe(
        "sent",
      )
      expect(mailer.calls).toHaveLength(2)
      expect(mailer.calls[1]).toEqual(mailer.calls[0])
      expect(JSON.stringify(mailer.calls[1])).toBe(JSON.stringify(mailer.calls[0]))
      const rows = await sendsFor(executor, contactId)
      expect(rows.filter((row) => row.step === 2)).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: "submitted", last_error_code: null })
    })
  }, 120_000)

  it("fails a send after the last retryable attempt", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      const mailer = recordingMailer({ kind: "retryable", code: "http_503" })
      let now = SEND1_NOW
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
        expect(await sendStep(executor, now, mailer)).toBe("retry_later")
        now = after(now, RETRY_DELAY_SECONDS)
      }
      expect(await sendStep(executor, now, mailer)).toBe("failed_attempts")
      const rows = await sendsFor(executor, contactId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        status: "failed",
        delivery_status: "unknown",
        attempts: MAX_ATTEMPTS,
        last_error_code: "http_503",
        lease_token: null,
      })
      expect(await lease(executor, SEND2_NOW)).toEqual([])
    })
  }, 120_000)

  it("fails a retry once Resend's idempotency window may have closed, without mailing", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      const mailer = recordingMailer([{ kind: "retryable", code: "timeout" }, ACCEPTED])
      expect(await sendStep(executor, SEND1_NOW, mailer)).toBe("retry_later")
      const late = after(SEND1_NOW, IDEMPOTENCY_WINDOW_SECONDS)
      const send = await leaseOne(executor, late)
      expect(send.attempts).toBe(2)
      expect(await authoriseAndSend(executor, { send, env, mailer, now: late })).toBe(
        "failed_attempts",
      )
      expect(mailer.calls).toHaveLength(1)
      const rows = await sendsFor(executor, contactId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        status: "failed",
        delivery_status: "unknown",
        last_error_code: "idempotency_window_expired",
        lease_token: null,
        lease_until: null,
      })
      // The first attempt's time is kept across leases.
      expect(rows[0]?.first_attempted_at?.toISOString()).toBe(SEND1_NOW.toISOString())
    })
  }, 120_000)

  it("retries normally while still inside the idempotency window", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      const mailer = recordingMailer([{ kind: "retryable", code: "timeout" }, ACCEPTED])
      expect(await sendStep(executor, SEND1_NOW, mailer)).toBe("retry_later")
      expect(await sendStep(executor, after(SEND1_NOW, 22 * 3600), mailer)).toBe("sent")
      expect(mailer.calls).toHaveLength(2)
      const rows = await sendsFor(executor, contactId)
      expect(rows[0]).toMatchObject({ status: "submitted" })
      expect(rows[0]?.first_attempted_at?.toISOString()).toBe(SEND1_NOW.toISOString())
    })
  }, 120_000)

  it("a rejected send fails permanently and schedules nothing", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      const mailer = recordingMailer({ kind: "rejected", code: "http_422" })
      expect(await sendStep(executor, SEND1_NOW, mailer)).toBe("rejected")
      const rows = await sendsFor(executor, contactId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        status: "failed",
        last_error_code: "http_422",
        lease_token: null,
        lease_until: null,
      })
      expect(await lease(executor, SEND2_NOW)).toEqual([])
    })
  }, 120_000)

  it("reconciles an idempotency mismatch as an earlier accepted send and schedules the next step", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await enrolledContact(executor)
      const mailer = recordingMailer({ kind: "rejected", code: "idempotency_mismatch" })
      expect(await sendStep(executor, SEND1_NOW, mailer)).toBe("sent")

      const [step1, step2] = await sendsFor(executor, contactId)
      expect(step1).toMatchObject({
        status: "submitted",
        delivery_status: "unknown",
        last_error_code: "idempotency_mismatch",
        provider_email_id: null,
        lease_token: null,
        lease_until: null,
      })
      expect(step2).toMatchObject({ step: 2, status: "pending" })
      expect(step2?.due_at.toISOString()).toBe(STEP2_DUE.toISOString())

      const activity = await executor.query<{ event_key: string; data: unknown }>(
        "select event_key, data from growth_activity where kind = 'send.submitted'",
      )
      expect(activity.rows).toEqual([
        {
          event_key: `submitted:${step1?.id}`,
          data: { send_id: step1?.id, step: 1, reconciled: true },
        },
      ])
    })
  }, 120_000)

  it("never puts an address in last_error_code", async () => {
    await withMigratedDatabase(async (executor) => {
      const rejected = await enrolledContact(executor, "rejected@example.com")
      const retried = await enrolledContact(executor, "retried@example.com")
      const mailer = recordingMailer(async () => ({
        kind: "rejected",
        code: "invalid recipient rejected@example.com",
      }))
      const retryMailer = recordingMailer({
        kind: "retryable",
        code: "bounced retried@example.com",
      })
      const leased = await lease(executor, SEND1_NOW)
      for (const send of leased) {
        await authoriseAndSend(executor, {
          send,
          env,
          mailer: send.contactId === rejected ? mailer : retryMailer,
          now: SEND1_NOW,
        })
      }
      const codes = await executor.query<{ last_error_code: string | null }>(
        "select last_error_code from growth_sends where contact_id = any($1::uuid[])",
        [[rejected, retried]],
      )
      expect(codes.rows.map((row) => row.last_error_code).sort()).toEqual([
        "unclassified",
        "unclassified",
      ])
      const activity = await executor.query<{ data: unknown }>("select data from growth_activity")
      expect(JSON.stringify(activity.rows)).not.toContain("@")
    })
  }, 120_000)
})
