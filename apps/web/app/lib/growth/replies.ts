import { stopContact } from "./contacts"
import { nestedExecutor, type SqlExecutor, type SqlTransaction } from "./database"
import { emailLookupHmac, normalizeEmail } from "./email"
import { errorLogCode, safeErrorCode } from "./errors"
import {
  admitRecentInbound,
  InboundError,
  inboundProviderId,
  isAdmitted,
  isForward,
  isSelfSent,
  type ListingResult,
  parseAddress,
  type ReceivedEmail,
  type ReceivedReference,
  type SentEmail,
} from "./inbound"

/** At most this many In-Reply-To ids are read. */
export const DIRECT_REFERENCES_MAX = 5
/** At most this many References ids are read: the most recent ones, at the end of the header. */
export const REFERENCES_MAX = 50
/** A header longer than this is read from its end only. */
export const REFERENCE_HEADER_MAX_CHARS = 16_384
/** Reply processing handles at most this many pending receipts per tick. */
export const REPLY_BATCH = 10
/** The binding backfill reads at most this many sent emails per tick. */
export const BINDING_BATCH = 10
/** The provenance recorded on a stop that a reply caused. */
export const REPLY_PROVENANCE = "mailbox_reply"

const MESSAGE_ID = /^<([^<>\s@]+)@([A-Za-z0-9.-]+)>$/
const BARE_MESSAGE_ID = /^([^<>\s@]+)@([A-Za-z0-9.-]+)$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A validated RFC Message-ID in one canonical form: angle brackets, local part as written (it is
 * case-sensitive), domain lower-cased. Undefined for anything else.
 */
export function rfcMessageId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 998 || /[\r\n\0]/.test(value)) return undefined
  const trimmed = value.trim()
  const match = MESSAGE_ID.exec(trimmed) ?? BARE_MESSAGE_ID.exec(trimmed)
  if (match === null) return undefined
  const [, local, domain] = match as unknown as [string, string, string]
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return undefined
  return `<${local}@${domain.toLowerCase()}>`
}

function headerText(headers: Record<string, unknown>, name: string): string {
  const values = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === name)
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string")
  // Unfold, and drop anything that could end a header line.
  const text = values
    .join(" ")
    .replace(/\r?\n[ \t]+/g, " ")
    .replace(/[\r\n\0]/g, " ")
  return text.length > REFERENCE_HEADER_MAX_CHARS
    ? text.slice(text.length - REFERENCE_HEADER_MAX_CHARS)
    : text
}

function messageIds(text: string): string[] {
  const tokens = text.match(/<[^<>]*>/g)
  if (tokens === null) {
    // A lone id without angle brackets is accepted; anything else is not an id list.
    const bare = rfcMessageId(text)
    return bare !== undefined ? [bare] : []
  }
  return tokens.map(rfcMessageId).filter((id): id is string => id !== undefined)
}

export interface ReplyReferences {
  /** From In-Reply-To: the message this one answers. Preferred when it matches. */
  readonly direct: readonly string[]
  /** Every id to match: In-Reply-To first, then the most recent References. */
  readonly all: readonly string[]
}

/**
 * Reads a reply's In-Reply-To and References headers. Malformed ids are dropped, both lists are
 * bounded, and neither the subject nor the body is ever consulted.
 */
export function parseReplyHeaders(headers: unknown): ReplyReferences {
  if (!isRecord(headers)) return { direct: [], all: [] }
  const direct = [...new Set(messageIds(headerText(headers, "in-reply-to")))].slice(
    0,
    DIRECT_REFERENCES_MAX,
  )
  const references = messageIds(headerText(headers, "references")).slice(-REFERENCES_MAX)
  return { direct, all: [...new Set([...direct, ...references])] }
}

export type BindResult = "bound" | "conflict" | "unknown_send" | "invalid_message_id"

/**
 * Records the RFC Message-ID of the sequence send Resend accepted as `providerEmailId`. A binding
 * is set once: a different id for the same send, or an id another send holds, is a conflict and
 * changes nothing.
 */
export async function bindOutboundMessageId(
  executor: SqlExecutor,
  input: { providerEmailId: string; messageId: unknown },
): Promise<BindResult> {
  const messageId = rfcMessageId(input.messageId)
  if (messageId === undefined) return "invalid_message_id"
  try {
    const updated = await executor.query(
      "update growth_sends set rfc_message_id = $2 where provider_email_id = $1 and (rfc_message_id is null or rfc_message_id = $2) and not exists (select 1 from growth_sends other where other.rfc_message_id = $2 and other.provider_email_id is distinct from $1) returning id",
      [input.providerEmailId, messageId],
    )
    if (updated.rowCount > 0) return "bound"
  } catch (error) {
    // Two sends racing to claim one id: the unique constraint refuses the second.
    if ((error as { code?: unknown }).code === "23505") return "conflict"
    throw error
  }
  const existing = await executor.query(
    "select 1 as found from growth_sends where provider_email_id = $1",
    [input.providerEmailId],
  )
  return existing.rowCount > 0 ? "conflict" : "unknown_send"
}

export interface BindingReport {
  readonly bound: number
  readonly waiting: number
  readonly failed: number
}

/**
 * Fills in missing bindings from Resend's record of each submitted send. Bounded per tick; a rate
 * limit ends the pass, and the rest wait for the next tick.
 */
export async function backfillOutboundBindings(
  executor: SqlExecutor,
  deps: { getSent(id: string): Promise<SentEmail>; canContinue(): boolean; batch?: number },
): Promise<BindingReport> {
  let bound = 0
  let waiting = 0
  let failed = 0
  const unbound = await executor.query<{ provider_email_id: string }>(
    "select provider_email_id from growth_sends where status = 'submitted' and rfc_message_id is null and provider_email_id is not null order by created_at, id limit $1",
    [deps.batch ?? BINDING_BATCH],
  )
  for (const send of unbound.rows) {
    if (!deps.canContinue()) break
    let sent: SentEmail
    try {
      sent = await deps.getSent(send.provider_email_id)
    } catch (error) {
      const code = errorLogCode(error)
      process.stderr.write(`growth outbound binding failed: ${code}\n`)
      failed++
      if (code === "receiving_http_429") break
      continue
    }
    if (sent.messageId === null) {
      waiting++
      continue
    }
    const result = await bindOutboundMessageId(executor, {
      providerEmailId: send.provider_email_id,
      messageId: sent.messageId,
    })
    if (result === "bound") bound++
    else {
      process.stderr.write(`growth outbound binding refused: ${result}\n`)
      failed++
    }
  }
  return { bound, waiting, failed }
}

export interface ReplyDeps {
  getReceived(id: string): Promise<ReceivedEmail>
  readonly emailHmacSecret: string
  now(): Date
}

export type ReplyStatus = "pending" | "matched" | "unmatched" | "ignored"

export type ReplyResult =
  | { readonly outcome: "matched" | "already_processed" | "unknown_receipt" }
  | { readonly outcome: "unmatched" | "ignored" | "pending"; readonly code: string }

type Classified =
  | { kind: "settle"; status: "unmatched" | "ignored"; code: string }
  | { kind: "candidate"; sender: string; references: ReplyReferences }

/** The checks that need no database: recipients, loops, self-mail, sender, references. */
function classify(email: ReceivedEmail): Classified {
  if (!isAdmitted(email)) return { kind: "settle", status: "ignored", code: "recipient_mismatch" }
  if (isForward(email.headers)) return { kind: "settle", status: "ignored", code: "forward_loop" }
  if (isSelfSent(email.from)) return { kind: "settle", status: "ignored", code: "self_mail" }
  const parsed = parseAddress(email.from)
  const sender = parsed === undefined ? undefined : normalizeEmail(parsed)
  if (sender === undefined) return { kind: "settle", status: "unmatched", code: "sender_invalid" }
  const references = parseReplyHeaders(email.headers)
  if (references.all.length === 0) {
    return { kind: "settle", status: "unmatched", code: "no_references" }
  }
  return { kind: "candidate", sender, references }
}

const STILL_PENDING = "where id = $1 and reply_status = 'pending'"

async function lockPendingReceipt(tx: SqlTransaction, id: string): Promise<boolean> {
  const row = await tx.query<{ reply_status: ReplyStatus }>(
    "select reply_status from growth_inbound_receipts where id = $1 for update",
    [id],
  )
  return row.rows[0]?.reply_status === "pending"
}

async function settle(
  tx: SqlTransaction,
  id: string,
  status: "unmatched" | "ignored",
  code: string,
  locked = false,
): Promise<ReplyResult> {
  if (!locked && !(await lockPendingReceipt(tx, id))) return { outcome: "already_processed" }
  await tx.query(
    `update growth_inbound_receipts set reply_status = $2, reply_error_code = $3, reply_attempts = reply_attempts + 1 ${STILL_PENDING}`,
    [id, status, code],
  )
  return { outcome: status, code }
}

async function keepPending(executor: SqlTransaction, id: string, code: string) {
  const safe = safeErrorCode(code)
  await executor.query(
    `update growth_inbound_receipts set reply_error_code = $2, reply_attempts = reply_attempts + 1 ${STILL_PENDING}`,
    [id, safe],
  )
  return { outcome: "pending", code: safe } as const
}

/**
 * Decides whether one admitted receipt is a contact's reply to a sequence send, and stops that
 * contact if it is. The provider's copy of the message is authoritative: its In-Reply-To, then
 * References, must name exactly one contact's stored outbound Message-ID, and its sender must be
 * that contact's address. Subject or sender alone never stops anyone.
 *
 * A reply that may point at a send whose Message-ID is not bound yet, or that could not be read,
 * stays `pending` and is retried by the tick; everything else is settled for good. The stop and
 * the receipt's `matched` status commit together, under the contact's lock and then the
 * receipt's (the order `stopContact` and `authoriseAndSend` use), so a webhook and recovery
 * racing on one receipt stop the contact once.
 */
export async function processInboundReply(
  executor: SqlExecutor,
  rawId: string,
  deps: ReplyDeps,
): Promise<ReplyResult> {
  const id = inboundProviderId(rawId)
  const current = await executor.query<{ reply_status: ReplyStatus }>(
    "select reply_status from growth_inbound_receipts where id = $1",
    [id],
  )
  const receipt = current.rows[0]
  if (receipt === undefined) return { outcome: "unknown_receipt" }
  if (receipt.reply_status !== "pending") return { outcome: "already_processed" }

  // Provider reads happen before any lock is taken.
  let email: ReceivedEmail
  try {
    email = await deps.getReceived(id)
  } catch (error) {
    const code = errorLogCode(error)
    // Resend no longer holds the message, so nothing can ever match it.
    if (error instanceof InboundError && code === "receiving_http_404") {
      return executor.transaction((tx) => settle(tx, id, "unmatched", "source_missing"))
    }
    return keepPending(executor, id, code)
  }
  if (email.id !== id) return keepPending(executor, id, "source_mismatch")

  const classified = classify(email)
  if (classified.kind === "settle") {
    const { status, code } = classified
    return executor.transaction((tx) => settle(tx, id, status, code))
  }
  const { sender, references } = classified
  const senderHmac = emailLookupHmac(deps.emailHmacSecret, sender)

  return executor.transaction(async (tx): Promise<ReplyResult> => {
    const matches = await tx.query<{ id: string; contact_id: string; rfc_message_id: string }>(
      "select id, contact_id, rfc_message_id from growth_sends where rfc_message_id = any($1::text[]) order by step desc, id",
      [[...references.all]],
    )
    const direct = matches.rows.filter((row) => references.direct.includes(row.rfc_message_id))
    const candidates = direct.length > 0 ? direct : matches.rows
    const contactIds = [...new Set(candidates.map((row) => row.contact_id))]

    if (contactIds.length > 1) return settle(tx, id, "unmatched", "ambiguous_references")
    const [contactId] = contactIds
    if (contactId === undefined) {
      // No stored Message-ID matches. If the sender is a contact with a send whose Message-ID
      // is not bound yet, the reply may answer that send: wait for the binding.
      const unbound = await tx.query<{ bindable: number; unbindable: number }>(
        "select count(*) filter (where s.provider_email_id is not null)::int as bindable, count(*) filter (where s.provider_email_id is null)::int as unbindable from growth_contacts c join growth_sends s on s.contact_id = c.id where c.email_hmac = $1 and c.deleted_at is null and s.status = 'submitted' and s.rfc_message_id is null",
        [senderHmac],
      )
      const counts = unbound.rows[0]
      if ((counts?.bindable ?? 0) > 0) {
        if (!(await lockPendingReceipt(tx, id))) return { outcome: "already_processed" }
        return keepPending(tx, id, "binding_pending")
      }
      if ((counts?.unbindable ?? 0) > 0) {
        return settle(tx, id, "unmatched", "binding_unavailable")
      }
      return settle(tx, id, "unmatched", "no_match")
    }

    const contacts = await tx.query<{ email_hmac: string; deleted_at: Date | null }>(
      "select email_hmac, deleted_at from growth_contacts where id = $1 for update",
      [contactId],
    )
    const contact = contacts.rows[0]
    if (!(await lockPendingReceipt(tx, id))) return { outcome: "already_processed" }
    if (contact === undefined || contact.deleted_at !== null) {
      return settle(tx, id, "ignored", "contact_deleted", true)
    }
    if (contact.email_hmac !== senderHmac) {
      return settle(tx, id, "unmatched", "sender_mismatch", true)
    }

    const send = candidates.find((row) => row.contact_id === contactId)
    await stopContact(nestedExecutor(tx), {
      contactId,
      reason: "reply_received",
      provenance: REPLY_PROVENANCE,
      now: deps.now(),
    })
    await tx.query(
      `update growth_inbound_receipts set reply_status = 'matched', contact_id = $2, matched_send_id = $3, reply_error_code = null, reply_attempts = reply_attempts + 1 ${STILL_PENDING}`,
      [id, contactId, send?.id ?? null],
    )
    return { outcome: "matched" }
  })
}

export interface RepliesReport {
  readonly matched: number
  readonly unmatched: number
  readonly ignored: number
  readonly pending: number
}

/** Processes receipts still waiting for reply processing, oldest attempt first. */
export async function processPendingReplies(
  executor: SqlExecutor,
  deps: ReplyDeps & { canContinue(): boolean; batch?: number },
): Promise<RepliesReport> {
  const counts = { matched: 0, unmatched: 0, ignored: 0, pending: 0 }
  const pending = await executor.query<{ id: string }>(
    "select id from growth_inbound_receipts where reply_status = 'pending' order by updated_at, id limit $1",
    [deps.batch ?? REPLY_BATCH],
  )
  for (const receipt of pending.rows) {
    if (!deps.canContinue()) break
    const result = await processInboundReply(executor, receipt.id, deps)
    if (
      result.outcome === "matched" ||
      result.outcome === "unmatched" ||
      result.outcome === "ignored" ||
      result.outcome === "pending"
    ) {
      counts[result.outcome]++
    }
  }
  return counts
}

export interface ReplyRecoveryReport {
  readonly admitted: number
  readonly listing: ListingResult
  readonly bindings: BindingReport
  readonly replies: RepliesReport
}

/**
 * The tick's reply pass, run before any send: admit recent mail the webhook missed, bind
 * outbound Message-IDs, then process pending replies.
 */
export async function recoverReplies(
  executor: SqlExecutor,
  deps: ReplyDeps & {
    listReceived(): AsyncIterable<ReceivedReference>
    getSent(id: string): Promise<SentEmail>
    canContinue(): boolean
  },
): Promise<ReplyRecoveryReport> {
  const { admitted, listing } = await admitRecentInbound(executor, deps)
  const bindings = await backfillOutboundBindings(executor, deps)
  const replies = await processPendingReplies(executor, deps)
  return { admitted, listing, bindings, replies }
}
