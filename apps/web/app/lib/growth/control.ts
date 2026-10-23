import {
  type ContactRow,
  contactJourney,
  deleteContact,
  findContactByEmail,
  reapproveContact,
  type StopReason,
  stopContact,
} from "./contacts"
import type { SqlExecutor } from "./database"
import { DIGEST_KIND } from "./digest"
import type { GrowthEnv } from "./env"
import { REPLY_PROVENANCE, settleReceiptByFounder } from "./replies"
import { createActionToken, unsubscribeUrl } from "./tokens"

const NOT_FOUND = "no contact found for that address"
const FOUNDER_STOP_REASONS = ["manual_suppression", "reply_received"] as const
/** Stops that say the address must not be mailed again; reapproving one needs `--force`. */
const GUARDED_STOP_REASONS: readonly string[] = ["complaint", "hard_bounce"]
const SEQUENCE_STEPS = [1, 2, 3] as const

type FounderStopReason = (typeof FOUNDER_STOP_REASONS)[number]

function isFounderStopReason(value: unknown): value is FounderStopReason {
  return FOUNDER_STOP_REASONS.some((reason) => reason === value)
}

function contactState(contact: ContactRow): string {
  if (contact.deletedAt !== null) return `deleted: ${contact.deletedAt.toISOString()}`
  if (contact.stoppedAt !== null) return `stopped: ${contact.stopReason ?? "unknown"}`
  if (contact.approvedAt !== null) return "approved"
  return "not approved"
}

function describeContact(contact: ContactRow, includeEmail: boolean): string[] {
  return [
    `id: ${contact.id}`,
    ...(includeEmail ? [`email: ${contact.email ?? "(redacted)"}`] : []),
    `state: ${contactState(contact)}`,
    `created: ${contact.createdAt.toISOString()}`,
    `approved at: ${contact.approvedAt?.toISOString() ?? "-"}`,
    `stopped at: ${contact.stoppedAt?.toISOString() ?? "-"}`,
  ]
}

type SendRow = {
  readonly step: number
  readonly status: string
  readonly delivery_status: string
  readonly due_at: Date
}

async function describeSequence(executor: SqlExecutor, contact: ContactRow): Promise<string[]> {
  const sends = await executor.query<SendRow>(
    "select step, status, delivery_status, due_at from growth_sends where contact_id = $1 order by step",
    [contact.id],
  )
  const lines = SEQUENCE_STEPS.map((step) => {
    const send = sends.rows.find((row) => Number(row.step) === step)
    return send === undefined
      ? `step ${step}: not enrolled`
      : `step ${step}: ${send.status} ${send.delivery_status} due ${send.due_at.toISOString()}`
  })

  // Once per contact: enrollment requires that a contact has no send at all, so a contact the
  // founder reapproved after their enrollment never gets the sequence again. That is the case
  // here when the contact is currently approved (not stopped, not deleted), has sends, none of
  // them is still pending or leased, and a `contact.reapproved` activity is later than the
  // `sequence.enrolled` one. Both times are the logical times recorded by those operations.
  const open = sends.rows.some((row) => row.status === "pending" || row.status === "leased")
  const approved =
    contact.approvedAt !== null && contact.stoppedAt === null && contact.deletedAt === null
  if (approved && sends.rows.length > 0 && !open) {
    const activity = await executor.query<{ kind: string; at: Date }>(
      "select kind, max(occurred_at) as at from growth_activity where contact_id = $1 and kind in ('sequence.enrolled', 'contact.reapproved') group by kind",
      [contact.id],
    )
    const at = (kind: string) => activity.rows.find((row) => row.kind === kind)?.at
    const enrolledAt = at("sequence.enrolled")
    const reapprovedAt = at("contact.reapproved")
    if (
      enrolledAt !== undefined &&
      reapprovedAt !== undefined &&
      reapprovedAt.getTime() > enrolledAt.getTime()
    ) {
      lines.push("sequence: not re-enrolled (once per contact)")
    }
  }
  return lines
}

/** Says what stopped a stopped contact: a reply to the sequence, the founder CLI, a webhook. */
async function describeStop(executor: SqlExecutor, contact: ContactRow): Promise<string[]> {
  if (contact.stoppedAt === null) return []
  const stop = await executor.query<{ provenance: string | null }>(
    "select data->>'provenance' as provenance from growth_activity where contact_id = $1 and kind like 'stop.%' order by occurred_at desc, id desc limit 1",
    [contact.id],
  )
  const provenance = stop.rows[0]?.provenance ?? null
  if (provenance === null) return []
  return [
    provenance === REPLY_PROVENANCE
      ? "stopped by: their reply to the sequence"
      : `stopped by: ${provenance}`,
  ]
}

export async function runControl(
  executor: SqlExecutor,
  env: GrowthEnv,
  args: {
    command: "status" | "approve" | "stop" | "delete"
    email: string
    reason?: StopReason
    force?: boolean
    now: Date
  },
): Promise<string> {
  const reason = args.reason ?? "manual_suppression"
  if (args.command === "stop" && !isFounderStopReason(reason)) {
    throw new Error("--reason must be manual_suppression or reply_received")
  }
  const contact = await findContactByEmail(executor, env.emailHmacSecret, args.email)
  if (contact === undefined) throw new Error(NOT_FOUND)

  if (args.command === "status") {
    const token = createActionToken({
      keyring: env.tokenKeyring,
      contactId: contact.id,
      purpose: "unsubscribe",
      issuedAt: args.now,
    })
    return [
      ...describeContact(contact, true),
      ...(await describeStop(executor, contact)),
      `unsubscribe url: ${unsubscribeUrl(env.publicOrigin, token)}`,
      ...(await describeSequence(executor, contact)),
    ].join("\n")
  }
  if (args.command === "approve") {
    if (
      contact.stopReason !== null &&
      GUARDED_STOP_REASONS.includes(contact.stopReason) &&
      args.force !== true
    ) {
      throw new Error(
        `refusing to reapprove a contact stopped for ${contact.stopReason}; pass --force to override`,
      )
    }
    const { applied } = await reapproveContact(executor, {
      contactId: contact.id,
      provenance: "founder_cli",
      now: args.now,
    })
    return applied ? "approved" : "not approved: contact is deleted"
  }
  if (args.command === "stop") {
    const { applied } = await stopContact(executor, {
      contactId: contact.id,
      reason: reason as FounderStopReason,
      provenance: "founder_cli",
      now: args.now,
    })
    return applied
      ? `stopped (${reason})`
      : `already stopped (${contact.stopReason ?? "unknown"}); nothing changed`
  }
  const { applied } = await deleteContact(executor, { contactId: contact.id, now: args.now })
  return applied
    ? "deleted: email, display name and analytics id cleared; form submission data redacted; open sends cancelled"
    : "already deleted; nothing changed"
}

/** `growth:control reply-settle`: releases one pending receipt that holds sends. */
export async function runReplySettle(
  executor: SqlExecutor,
  args: { id: string; as: string; now: Date },
): Promise<string> {
  if (args.as !== "unmatched" && args.as !== "ignored") {
    throw new Error("--as must be unmatched or ignored")
  }
  const result = await settleReceiptByFounder(executor, { id: args.id, as: args.as, now: args.now })
  if (result === "unknown_receipt") throw new Error("no inbound receipt with that id")
  return result === "settled"
    ? `settled as ${args.as} (founder_settled)`
    : "not pending; nothing changed"
}

export async function runReport(
  executor: SqlExecutor,
  env: GrowthEnv,
  args: { command: "journey" | "counts" | "sends"; email?: string },
): Promise<string> {
  if (args.command === "journey") {
    if (args.email === undefined) throw new Error("--email is required")
    const contact = await findContactByEmail(executor, env.emailHmacSecret, args.email)
    if (contact === undefined) throw new Error(NOT_FOUND)
    const activities = await contactJourney(executor, contact.id)
    return [
      ...describeContact(contact, false),
      "activities:",
      ...activities.map(
        (activity) =>
          `  ${activity.occurredAt.toISOString()} ${activity.kind} ${JSON.stringify(activity.data)}`,
      ),
    ].join("\n")
  }

  if (args.command === "sends") {
    // Counts only: no addresses or contact ids leave this report.
    const byStep = await executor.query<{ step: number; status: string; total: string }>(
      "select step, status, count(*) as total from growth_sends group by step, status order by step, status",
    )
    const byDelivery = await executor.query<{ delivery_status: string; total: string }>(
      "select delivery_status, count(*) as total from growth_sends group by delivery_status order by delivery_status",
    )
    const digest = await executor.query<{ date: string | null }>(
      "select data->>'date' as date from growth_activity where kind = $1 order by occurred_at desc limit 1",
      [DIGEST_KIND],
    )
    const unbound = await executor.query<{ total: string }>(
      "select count(*) as total from growth_sends where status = 'submitted' and rfc_message_id is null",
    )
    const replies = await executor.query<{ reply_status: string; total: string }>(
      "select reply_status, count(*) as total from growth_inbound_receipts group by reply_status order by reply_status",
    )
    // Receipt ids and codes only, so the founder can look each one up in Resend or settle it.
    const pendingReceipts = await executor.query<{ id: string; reply_error_code: string | null }>(
      "select id, reply_error_code from growth_inbound_receipts where reply_status = 'pending' order by created_at, id limit 20",
    )
    return [
      ...byStep.rows.map((row) => `step ${row.step} ${row.status}: ${row.total}`),
      ...byDelivery.rows.map((row) => `delivery ${row.delivery_status}: ${row.total}`),
      `submitted without message id: ${unbound.rows[0]?.total ?? "0"}`,
      ...replies.rows.map((row) => `inbound reply ${row.reply_status}: ${row.total}`),
      ...pendingReceipts.rows.map(
        (row) =>
          `pending reply receipt: ${row.id} (${row.reply_error_code ?? "not yet processed"})`,
      ),
      `last digest: ${digest.rows[0]?.date ?? "none"}`,
    ].join("\n")
  }

  const totals = await executor.query<{ contacts: string; approved: string; deleted: string }>(
    "select count(*) as contacts, count(*) filter (where approved_at is not null and deleted_at is null) as approved, count(*) filter (where deleted_at is not null) as deleted from growth_contacts",
  )
  const stopped = await executor.query<{ stop_reason: string; total: string }>(
    "select stop_reason, count(*) as total from growth_contacts where stopped_at is not null group by stop_reason order by stop_reason",
  )
  const row = totals.rows[0]
  return [
    `contacts: ${row?.contacts ?? "0"}`,
    `approved: ${row?.approved ?? "0"}`,
    `deleted: ${row?.deleted ?? "0"}`,
    ...stopped.rows.map((entry) => `stopped ${entry.stop_reason}: ${entry.total}`),
  ].join("\n")
}
