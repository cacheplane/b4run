import { recordActivity } from "./contacts"
import type { SqlExecutor, SqlTransaction } from "./database"
import { composeSequenceEmail, type Mailer, sendIdempotencyKey } from "./mailer"
import { businessMorningAfter, STEP_DELAY_BUSINESS_DAYS } from "./schedule"
import type { SequenceStep } from "./sequence-copy"
import type { SequenceEnv } from "./sequence-env"
import { createActionToken, unsubscribeUrl } from "./tokens"

export { sendIdempotencyKey }

export const SEND_BATCH = 10
export const LEASE_SECONDS = 300
export const MAX_ATTEMPTS = 3
/** The tick waits this long between sends (Resend's default limit is about 2 requests per second). */
export const SEND_PACING_MS = 600

export interface LeasedSend {
  readonly id: string
  readonly contactId: string
  readonly step: SequenceStep
  readonly attempts: number
  readonly leaseToken: string
}

export type SendOutcome =
  | "sent"
  | "cancelled_not_authorised"
  | "rejected"
  | "retry_later"
  | "failed_attempts"
  | "lease_lost"

const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/

/** Stores only short machine codes, so nothing a provider echoes back (an address, say) is kept. */
export function safeErrorCode(code: string): string {
  return ERROR_CODE_PATTERN.test(code) ? code : "unclassified"
}

const enrolledEventKey = (contactId: string) => `enrolled:v1:${contactId}`
const submittedEventKey = (sendId: string) => `submitted:${sendId}`

const enrollable = (startAtParam: string) =>
  `approved_at is not null and approved_at >= ${startAtParam} and stopped_at is null and deleted_at is null and not exists (select 1 from growth_sends s where s.contact_id = growth_contacts.id)`

/**
 * Inserts step 1 for each contact approved at or after `startAt` who has never had a send.
 * Each contact is re-checked under its row lock, so a stop that commits first wins.
 */
export async function enrollApprovedContacts(
  executor: SqlExecutor,
  input: { startAt: Date; now: Date },
): Promise<{ enrolled: number }> {
  const candidates = await executor.query<{ id: string }>(
    `select id from growth_contacts where ${enrollable("$1")} order by approved_at, id`,
    [input.startAt],
  )
  let enrolled = 0
  for (const candidate of candidates.rows) {
    const inserted = await executor.transaction(async (tx) => {
      const locked = await tx.query<{ approved_at: Date }>(
        `select approved_at from growth_contacts where id = $1 and ${enrollable("$2")} for update`,
        [candidate.id, input.startAt],
      )
      const contact = locked.rows[0]
      if (contact === undefined) return false
      const insert = await tx.query(
        "insert into growth_sends (contact_id, step, idempotency_key, status, due_at) values ($1, 1, $2, 'pending', $3) on conflict (idempotency_key) do nothing returning id",
        [
          candidate.id,
          sendIdempotencyKey(candidate.id, 1),
          businessMorningAfter(contact.approved_at, 1),
        ],
      )
      if (insert.rowCount === 0) return false
      await recordActivity(tx, {
        eventKey: enrolledEventKey(candidate.id),
        contactId: candidate.id,
        kind: "sequence.enrolled",
        occurredAt: input.now,
        data: { step: 1 },
      })
      return true
    })
    if (inserted) enrolled++
  }
  return { enrolled }
}

/**
 * Leases up to `limit` due sends for this tick. Rows another tick holds are skipped, never
 * waited on, so two concurrent ticks lease disjoint sets.
 */
export async function leaseDueSends(
  executor: SqlExecutor,
  input: { now: Date; limit: number; leaseToken: string },
): Promise<readonly LeasedSend[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new Error("Invalid lease limit")
  }
  // A crash on the last attempt leaves an expired lease nothing may reclaim; close it out.
  await executor.query(
    "update growth_sends set status = 'failed', delivery_status = 'unknown', last_error_code = 'lease_expired', lease_until = null, lease_token = null where id in (select id from growth_sends where status = 'leased' and lease_until <= $1 and attempts >= $2 for update skip locked)",
    [input.now, MAX_ATTEMPTS],
  )
  const result = await executor.query<{
    id: string
    contact_id: string
    step: number
    attempts: number
    lease_token: string
    due_at: Date
  }>(
    "with due as (select id from growth_sends where ((status = 'pending' and due_at <= $1) or (status = 'leased' and lease_until <= $1)) and attempts < $2 order by due_at, id limit $3 for update skip locked) update growth_sends s set status = 'leased', lease_token = $4, lease_until = $1::timestamptz + make_interval(secs => $5::int), attempts = s.attempts + 1 from due where s.id = due.id returning s.id, s.contact_id, s.step, s.attempts, s.lease_token, s.due_at",
    [input.now, MAX_ATTEMPTS, input.limit, input.leaseToken, LEASE_SECONDS],
  )
  return [...result.rows]
    .sort((a, b) => a.due_at.getTime() - b.due_at.getTime() || (a.id < b.id ? -1 : 1))
    .map((row) => ({
      id: row.id,
      contactId: row.contact_id,
      step: row.step as SequenceStep,
      attempts: row.attempts,
      leaseToken: row.lease_token,
    }))
}

const CLEAR_LEASE = "lease_until = null, lease_token = null"

async function scheduleNextStep(
  tx: SqlTransaction,
  contactId: string,
  step: SequenceStep,
  now: Date,
): Promise<void> {
  if (step === 3) return
  const next = (step + 1) as 2 | 3
  await tx.query(
    "insert into growth_sends (contact_id, step, idempotency_key, status, due_at) values ($1, $2, $3, 'pending', $4) on conflict (idempotency_key) do nothing",
    [
      contactId,
      next,
      sendIdempotencyKey(contactId, next),
      businessMorningAfter(now, STEP_DELAY_BUSINESS_DAYS[next]),
    ],
  )
}

/**
 * Re-checks authorisation and submits one leased send, all in one transaction. It locks the
 * contact, then the send — the order `stopContact` uses — so a concurrent stop waits for this
 * to commit and then cancels anything it scheduled.
 */
export function authoriseAndSend(
  executor: SqlExecutor,
  input: { send: LeasedSend; env: SequenceEnv; mailer: Mailer; now: Date },
): Promise<SendOutcome> {
  const { send, env, mailer, now } = input
  return executor.transaction(async (tx): Promise<SendOutcome> => {
    const contacts = await tx.query<{
      email: string | null
      approved_at: Date | null
      stopped_at: Date | null
      deleted_at: Date | null
    }>(
      "select email, approved_at, stopped_at, deleted_at from growth_contacts where id = $1 for update",
      [send.contactId],
    )
    const sends = await tx.query<{
      id: string
      contact_id: string
      step: number
      attempts: number
      created_at: Date
    }>(
      "select id, contact_id, step, attempts, created_at from growth_sends where id = $1 and lease_token = $2 and status = 'leased' for update",
      [send.id, send.leaseToken],
    )
    const row = sends.rows[0]
    if (row === undefined || row.contact_id !== send.contactId) return "lease_lost"

    const contact = contacts.rows[0]
    if (
      contact === undefined ||
      contact.approved_at === null ||
      contact.stopped_at !== null ||
      contact.deleted_at !== null ||
      contact.email === null
    ) {
      await tx.query(`update growth_sends set status = 'cancelled', ${CLEAR_LEASE} where id = $1`, [
        row.id,
      ])
      return "cancelled_not_authorised"
    }

    const step = row.step as SequenceStep
    // Minted from the send's creation time, so every retry carries the same body.
    const token = createActionToken({
      keyring: env.tokenKeyring,
      contactId: row.contact_id,
      purpose: "unsubscribe",
      issuedAt: row.created_at,
    })
    const email = composeSequenceEmail({
      step,
      to: contact.email,
      sendId: row.id,
      contactId: row.contact_id,
      unsubscribeUrl: unsubscribeUrl(env.publicOrigin, token),
      founderEmail: env.founderEmail,
      environment: env.environment,
    })
    const result = await mailer.send(email)

    if (result.kind === "accepted") {
      await tx.query(
        `update growth_sends set status = 'submitted', delivery_status = 'submitted', provider_email_id = $2, last_error_code = null, ${CLEAR_LEASE} where id = $1`,
        [row.id, result.providerEmailId],
      )
      await recordActivity(tx, {
        eventKey: submittedEventKey(row.id),
        contactId: row.contact_id,
        kind: "send.submitted",
        occurredAt: now,
        data: { send_id: row.id, step },
      })
      await scheduleNextStep(tx, row.contact_id, step, now)
      return "sent"
    }

    const code = safeErrorCode(result.code)
    if (result.kind === "rejected") {
      await tx.query(
        `update growth_sends set status = 'failed', last_error_code = $2, ${CLEAR_LEASE} where id = $1`,
        [row.id, code],
      )
      return "rejected"
    }
    if (result.code === "http_429") {
      // A rate limit never consumes an attempt.
      await tx.query(
        `update growth_sends set status = 'pending', attempts = attempts - 1, last_error_code = $2, ${CLEAR_LEASE} where id = $1`,
        [row.id, code],
      )
      return "retry_later"
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      await tx.query(
        `update growth_sends set status = 'failed', delivery_status = 'unknown', last_error_code = $2, ${CLEAR_LEASE} where id = $1`,
        [row.id, code],
      )
      return "failed_attempts"
    }
    await tx.query(
      `update growth_sends set status = 'pending', last_error_code = $2, ${CLEAR_LEASE} where id = $1`,
      [row.id, code],
    )
    return "retry_later"
  })
}
