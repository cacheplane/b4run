import type { SqlExecutor, SqlTransaction } from "./database"
import { DISCLOSURE_VERSION } from "./disclosure"
import { type EmailKind, emailKind, emailLookupHmac, normalizeEmail } from "./email"

export { DISCLOSURE_VERSION }

export const STOP_REASONS = [
  "unsubscribe",
  "complaint",
  "hard_bounce",
  "provider_suppression",
  "manual_suppression",
  "reply_received",
  "deletion",
] as const
export type StopReason = (typeof STOP_REASONS)[number]

export function isStopReason(value: unknown): value is StopReason {
  return typeof value === "string" && (STOP_REASONS as readonly string[]).includes(value)
}

export const formAcceptedEventKey = (submissionId: string) => `form:${submissionId}`
export const approvedEventKey = (contactId: string, now: Date) =>
  `approved:${contactId}:${now.toISOString()}`
export const reapprovedEventKey = (contactId: string, now: Date) =>
  `reapproved:${contactId}:${now.toISOString()}`
export const stopEventKey = (contactId: string, reason: string, now: Date) =>
  `stop:${contactId}:${reason}:${now.toISOString()}`
export const deletedEventKey = (contactId: string) => `deleted:${contactId}`

export interface AcceptFormInput {
  readonly email: string
  readonly message?: string
  readonly posthogDistinctId?: string
  readonly disclosureVersion: string
  readonly submissionId: string
  readonly now: Date
}

export interface AcceptFormResult {
  readonly contactId: string
  readonly approved: boolean
  readonly emailKind: EmailKind
  readonly created: boolean
}

export interface StopInput {
  readonly contactId: string
  readonly reason: Exclude<StopReason, "deletion">
  readonly provenance: string
  readonly now: Date
}

export interface ContactRow {
  readonly id: string
  readonly email: string | null
  readonly approvedAt: Date | null
  readonly stoppedAt: Date | null
  readonly stopReason: string | null
  readonly deletedAt: Date | null
  readonly createdAt: Date
}

async function recordActivity(
  tx: SqlTransaction,
  input: {
    eventKey: string
    contactId: string
    kind: string
    occurredAt: Date
    data: Record<string, unknown>
  },
): Promise<void> {
  await tx.query(
    "insert into growth_activity (event_key, contact_id, kind, occurred_at, data) values ($1, $2, $3, $4, $5::jsonb) on conflict (event_key) do nothing",
    [input.eventKey, input.contactId, input.kind, input.occurredAt, JSON.stringify(input.data)],
  )
}

async function cancelOpenSends(tx: SqlTransaction, contactId: string): Promise<void> {
  await tx.query(
    "update growth_sends set status = 'cancelled', lease_until = null, lease_token = null where contact_id = $1 and status in ('pending', 'leased')",
    [contactId],
  )
}

export function acceptFounderUpdatesForm(
  executor: SqlExecutor,
  secret: string,
  input: AcceptFormInput,
): Promise<AcceptFormResult> {
  const email = normalizeEmail(input.email)
  if (email === undefined) return Promise.reject(new Error("invalid email address"))
  const kind = emailKind(email)
  const hmac = emailLookupHmac(secret, email)

  return executor.transaction(async (tx) => {
    const upsert = await tx.query<{
      id: string
      approved_at: Date | null
      stopped_at: Date | null
      deleted_at: Date | null
      posthog_distinct_id: string | null
      created: boolean
    }>(
      "insert into growth_contacts (email, email_hmac, source, disclosure_version) values ($1, $2, 'founder_updates', $3) on conflict (email_hmac) do update set updated_at = excluded.updated_at returning id, approved_at, stopped_at, deleted_at, posthog_distinct_id, (xmax = 0) as created",
      [email, hmac, input.disclosureVersion],
    )
    const row = upsert.rows[0]
    if (row === undefined) throw new Error("contact upsert returned no row")
    const contactId = row.id
    const blocked = row.stopped_at !== null || row.deleted_at !== null

    await recordActivity(tx, {
      eventKey: formAcceptedEventKey(input.submissionId),
      contactId,
      kind: "form.accepted",
      occurredAt: input.now,
      data: {
        form: "founder_updates",
        ...(!blocked && input.message !== undefined ? { message: input.message } : {}),
        disclosure_version: input.disclosureVersion,
        email_kind: kind,
      },
    })

    if (blocked)
      return {
        contactId,
        approved: false,
        emailKind: kind,
        created: row.created,
      }

    if (input.posthogDistinctId !== undefined && row.posthog_distinct_id === null) {
      await tx.query(
        "update growth_contacts set posthog_distinct_id = $2 where id = $1 and posthog_distinct_id is null",
        [contactId, input.posthogDistinctId],
      )
    }
    if (row.approved_at === null) {
      await tx.query(
        "update growth_contacts set approved_at = $2 where id = $1 and approved_at is null and stopped_at is null and deleted_at is null",
        [contactId, input.now],
      )
      await recordActivity(tx, {
        eventKey: approvedEventKey(contactId, input.now),
        contactId,
        kind: "contact.approved",
        occurredAt: input.now,
        data: { disclosure_version: input.disclosureVersion },
      })
    }
    return { contactId, approved: true, emailKind: kind, created: row.created }
  })
}

export function stopContact(
  executor: SqlExecutor,
  input: StopInput,
): Promise<{ applied: boolean }> {
  return executor.transaction(async (tx) => {
    const updated = await tx.query(
      "update growth_contacts set approved_at = null, stopped_at = $2, stop_reason = $3 where id = $1 and stopped_at is null returning id",
      [input.contactId, input.now, input.reason],
    )
    if (updated.rowCount === 0) return { applied: false }
    await recordActivity(tx, {
      eventKey: stopEventKey(input.contactId, input.reason, input.now),
      contactId: input.contactId,
      kind: `stop.${input.reason}`,
      occurredAt: input.now,
      data: { provenance: input.provenance },
    })
    await cancelOpenSends(tx, input.contactId)
    return { applied: true }
  })
}

export function reapproveContact(
  executor: SqlExecutor,
  input: { contactId: string; provenance: string; now: Date },
): Promise<{ applied: boolean }> {
  return executor.transaction(async (tx) => {
    const updated = await tx.query(
      "update growth_contacts set stopped_at = null, stop_reason = null, approved_at = $2 where id = $1 and deleted_at is null returning id",
      [input.contactId, input.now],
    )
    if (updated.rowCount === 0) return { applied: false }
    await recordActivity(tx, {
      eventKey: reapprovedEventKey(input.contactId, input.now),
      contactId: input.contactId,
      kind: "contact.reapproved",
      occurredAt: input.now,
      data: { provenance: input.provenance },
    })
    return { applied: true }
  })
}

export function deleteContact(
  executor: SqlExecutor,
  input: { contactId: string; now: Date },
): Promise<{ applied: boolean }> {
  return executor.transaction(async (tx) => {
    // Right-hand sides read the pre-update row, so an existing stop and its reason are kept.
    const updated = await tx.query(
      "update growth_contacts set approved_at = null, stop_reason = case when stopped_at is null then 'deletion' else stop_reason end, stopped_at = coalesce(stopped_at, $2), email = null, display_name = null, posthog_distinct_id = null, deleted_at = $2 where id = $1 and deleted_at is null returning id",
      [input.contactId, input.now],
    )
    if (updated.rowCount === 0) return { applied: false }
    await tx.query(
      "update growth_activity set data = '{}'::jsonb where contact_id = $1 and kind = 'form.accepted'",
      [input.contactId],
    )
    await cancelOpenSends(tx, input.contactId)
    await recordActivity(tx, {
      eventKey: deletedEventKey(input.contactId),
      contactId: input.contactId,
      kind: "contact.deleted",
      occurredAt: input.now,
      data: {},
    })
    return { applied: true }
  })
}

export async function findContactByEmail(
  executor: SqlExecutor,
  secret: string,
  email: string,
): Promise<ContactRow | undefined> {
  const normalized = normalizeEmail(email)
  if (normalized === undefined) return undefined
  const result = await executor.query<{
    id: string
    email: string | null
    approved_at: Date | null
    stopped_at: Date | null
    stop_reason: string | null
    deleted_at: Date | null
    created_at: Date
  }>(
    "select id, email, approved_at, stopped_at, stop_reason, deleted_at, created_at from growth_contacts where email_hmac = $1",
    [emailLookupHmac(secret, normalized)],
  )
  const row = result.rows[0]
  if (row === undefined) return undefined
  return {
    id: row.id,
    email: row.email,
    approvedAt: row.approved_at,
    stoppedAt: row.stopped_at,
    stopReason: row.stop_reason,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  }
}

export async function contactJourney(
  executor: SqlExecutor,
  contactId: string,
): Promise<readonly { kind: string; occurredAt: Date; data: Record<string, unknown> }[]> {
  const result = await executor.query<{
    kind: string
    occurred_at: Date
    data: Record<string, unknown>
  }>(
    "select kind, occurred_at, data from growth_activity where contact_id = $1 order by occurred_at, id",
    [contactId],
  )
  return result.rows.map((row) => ({
    kind: row.kind,
    occurredAt: row.occurred_at,
    data: row.data,
  }))
}
