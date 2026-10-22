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
import type { GrowthEnv } from "./env"
import { createActionToken, unsubscribeUrl } from "./tokens"

const NOT_FOUND = "no contact found for that address"
const FOUNDER_STOP_REASONS = ["manual_suppression", "reply_received"] as const

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

export async function runControl(
  executor: SqlExecutor,
  env: GrowthEnv,
  args: {
    command: "status" | "approve" | "stop" | "delete"
    email: string
    reason?: StopReason
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
      `unsubscribe url: ${unsubscribeUrl(env.publicOrigin, token)}`,
    ].join("\n")
  }
  if (args.command === "approve") {
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

export async function runReport(
  executor: SqlExecutor,
  env: GrowthEnv,
  args: { command: "journey" | "counts"; email?: string },
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
