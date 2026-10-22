import { findContactByEmail, type StopInput, stopContact } from "./contacts"
import type { SqlExecutor } from "./database"
import type { GrowthEnv } from "./env"

export const RESEND_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.suppressed",
  "email.failed",
] as const

export type ResendEventType = (typeof RESEND_EVENT_TYPES)[number]

export interface ParsedResendEvent {
  readonly type: ResendEventType
  readonly occurredAt: Date
  readonly providerEmailId: string
  readonly to: readonly string[]
  readonly tags: Readonly<Record<string, string>>
  readonly bounceType?: "permanent" | "transient" | "unknown"
}

export type WebhookOutcome =
  | "ignored_environment"
  | "ignored_type"
  | "updated_delivery"
  | "stopped"
  | "already_stopped"
  | "no_contact"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function parseTags(raw: unknown): Record<string, string> {
  const tags: Record<string, string> = {}
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (isRecord(entry) && typeof entry.name === "string" && typeof entry.value === "string") {
        tags[entry.name] = entry.value
      }
    }
  } else if (isRecord(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === "string") tags[name] = value
    }
  }
  return tags
}

function parseBounceType(data: Record<string, unknown>): "permanent" | "transient" | "unknown" {
  const bounce = data.bounce
  const type = isRecord(bounce) && typeof bounce.type === "string" ? bounce.type.toLowerCase() : ""
  if (type === "permanent") return "permanent"
  if (type === "transient") return "transient"
  return "unknown"
}

export function parseResendEvent(payload: unknown): ParsedResendEvent | undefined {
  if (!isRecord(payload)) return undefined
  const type = RESEND_EVENT_TYPES.find((candidate) => candidate === payload.type)
  if (type === undefined) return undefined
  const data = payload.data
  if (!isRecord(data)) return undefined
  if (typeof data.email_id !== "string" || data.email_id === "") return undefined
  if (!Array.isArray(data.to) || !data.to.every((entry) => typeof entry === "string")) {
    return undefined
  }
  if (typeof payload.created_at !== "string") return undefined
  const occurredAt = new Date(payload.created_at)
  if (Number.isNaN(occurredAt.getTime())) return undefined
  return {
    type,
    occurredAt,
    providerEmailId: data.email_id,
    to: data.to as string[],
    tags: parseTags(data.tags),
    ...(type === "email.bounced" ? { bounceType: parseBounceType(data) } : {}),
  }
}

const STATUS_FOR_EVENT: Partial<Record<ResendEventType, string>> = {
  "email.sent": "submitted",
  "email.delivered": "delivered",
  "email.failed": "failed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.suppressed": "suppressed",
}

const RANK: Record<string, number> = {
  not_submitted: -1,
  unknown: -1,
  submitted: 0,
  delivered: 1,
  failed: 1,
  bounced: 2,
  suppressed: 3,
  complained: 4,
}

function stopReasonFor(event: ParsedResendEvent): StopInput["reason"] | undefined {
  switch (event.type) {
    case "email.bounced":
      return event.bounceType === "permanent" ? "hard_bounce" : undefined
    case "email.complained":
      return "complaint"
    case "email.suppressed":
      return "provider_suppression"
    default:
      return undefined
  }
}

export async function processResendEvent(
  executor: SqlExecutor,
  input: {
    event: ParsedResendEvent
    environment: GrowthEnv["environment"]
    emailHmacSecret: string
    now: Date
  },
): Promise<WebhookOutcome> {
  const { event } = input
  const tagged = event.tags.environment
  if (tagged !== undefined ? tagged !== input.environment : input.environment !== "production") {
    return "ignored_environment"
  }

  const sendRows = await executor.query<{
    contact_id: string
    delivery_status: string
  }>("select contact_id, delivery_status from growth_sends where provider_email_id = $1", [
    event.providerEmailId,
  ])
  const send = sendRows.rows[0]

  // Only a permanent bounce is a delivery failure; transient and unknown bounces leave the status alone.
  const target =
    event.type === "email.bounced" && event.bounceType !== "permanent"
      ? undefined
      : STATUS_FOR_EVENT[event.type]
  if (send !== undefined && target !== undefined) {
    const current = RANK[send.delivery_status] ?? -1
    if ((RANK[target] ?? -1) > current) {
      // Re-check the rank in SQL so a concurrent, higher-precedence event is never overwritten.
      await executor.query(
        `update growth_sends set delivery_status = $2
         where provider_email_id = $1
           and (case delivery_status
                  when 'submitted' then 0 when 'delivered' then 1 when 'failed' then 1
                  when 'bounced' then 2 when 'suppressed' then 3 when 'complained' then 4
                  else -1 end) < $3`,
        [event.providerEmailId, target, RANK[target]],
      )
    }
  }

  const reason = stopReasonFor(event)
  if (reason === undefined) return send !== undefined ? "updated_delivery" : "no_contact"

  const contactIds = new Set<string>()
  if (send !== undefined) {
    contactIds.add(send.contact_id)
  } else {
    for (const address of event.to) {
      const found = await findContactByEmail(executor, input.emailHmacSecret, address)
      if (found !== undefined) contactIds.add(found.id)
    }
  }
  if (contactIds.size === 0) return "no_contact"

  let applied = false
  for (const contactId of contactIds) {
    const result = await stopContact(executor, {
      contactId,
      reason,
      provenance: `resend:${event.type}`,
      now: input.now,
    })
    applied = applied || result.applied
  }
  return applied ? "stopped" : "already_stopped"
}
