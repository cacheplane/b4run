import { REPLY_GATE_LOCK, type SqlExecutor } from "./database"
import type { GrowthEnv } from "./env"
import { errorLogCode, safeErrorCode } from "./errors"
import { B4_APP_TAG, createResendMailer, type Mailer, type OutgoingEmail, SENDER } from "./mailer"
import { IDEMPOTENCY_WINDOW_SECONDS } from "./sequence"

/** The one receiving address B4 acts on. Every other recipient is ignored. */
export const INBOUND_ADDRESS = "brian@b4.run"
/** Fixed forwarding destination; a received message can never choose where it goes. */
export const INBOUND_FORWARD_TO = "brian@cacheplane.ai"
/** The default founder (digest and BCC) address, as `GROWTH_FOUNDER_EMAIL` defaults. */
const DEFAULT_FOUNDER_EMAIL = "brian@b4.run"

/**
 * B4's own senders: the address every B4 email is From (`brian@b4.run`) and the configured
 * founder address. Mail from one of them (the digest, the BCC copy of a sequence send) is never a
 * contact's reply. Any other sender, the founder's personal mailbox included, goes through
 * normal matching, where a stop still needs the sender to be the matched contact.
 */
export function selfAddressesFor(env: { readonly founderEmail?: string }): readonly string[] {
  const founder = parseAddress(env.founderEmail ?? DEFAULT_FOUNDER_EMAIL)
  return [...new Set([INBOUND_ADDRESS, ...(founder !== undefined ? [founder] : [])])]
}

const DEFAULT_SELF_ADDRESSES: readonly string[] = [INBOUND_ADDRESS]

/** The largest original message attached to a forward. */
export const RAW_MAX_BYTES = 20 * 1024 * 1024
/** Recovery lists received mail back this far. */
export const INBOUND_RECOVERY_DAYS = 3
/** Recovery retries at most this many unforwarded receipts per tick. */
export const INBOUND_RECOVERY_BATCH = 5
/** The forward send's timeout; the original can be large. */
export const FORWARD_SEND_TIMEOUT_MS = 10_000

const RESEND_API = "https://api.resend.com"
const RECEIVING_TIMEOUT_MS = 5000
const RAW_TIMEOUT_MS = 10_000
const RECEIVING_RETRIES = 2
const MAX_RATE_LIMIT_WAIT_MS = 2000
const MAX_LIST_PAGES = 20
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const RECIPIENT_FIELDS = ["to", "cc", "bcc", "received_for"] as const
const FORWARD_MARKER = "x-b4-forwarded"

/** A provider or source failure; `code` is a short machine code, safe to store and log. */
export class InboundError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = "InboundError"
    this.code = code
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A Resend id, checked before it reaches a URL path or the database. */
export function inboundProviderId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
    throw new InboundError("invalid_provider_id")
  }
  return value
}

/** The bare, lower-cased address of `addr` or `Name <addr>`; undefined unless it is one address. */
export function parseAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 998 || /[\r\n\0]/.test(value)) return undefined
  const trimmed = value.trim()
  const angle = /<([^<>]*)>$/.exec(trimmed)
  const address = (angle?.[1] ?? trimmed).trim().toLowerCase()
  return /^[^\s<>@,;"]+@[^\s<>@,;"]+$/.test(address) ? address : undefined
}

export const isInboundAddress = (value: unknown): boolean => parseAddress(value) === INBOUND_ADDRESS

/** True when `from` is one of B4's own senders. */
export function isSelfSent(
  from: unknown,
  selfAddresses: readonly string[] = DEFAULT_SELF_ADDRESSES,
): boolean {
  const address = parseAddress(from)
  return address !== undefined && selfAddresses.includes(address)
}

/**
 * True when brian@b4.run is among the message's recipients (`to`, `cc`, `bcc`, or the envelope
 * `received_for`). One predicate serves the webhook, recovery, and the authoritative re-check.
 */
export function isAdmitted(message: unknown): boolean {
  if (!isRecord(message)) return false
  return RECIPIENT_FIELDS.some((field) => {
    const value = message[field]
    return Array.isArray(value) && value.some(isInboundAddress)
  })
}

export type ReceivedEmail = Readonly<Record<string, unknown>> & { readonly id: string }

export interface ReceivedReference {
  readonly id: string
  readonly receivedAt: Date
  readonly admitted: boolean
  /** From one of B4's own addresses, so never a contact's reply. */
  readonly selfSent: boolean
}

export interface ParsedInboundEvent {
  readonly id: string
  readonly receivedAt: Date
  readonly admitted: boolean
  readonly selfSent: boolean
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** Parses a verified `email.received` webhook payload; undefined for any other shape. */
export function parseInboundEvent(
  payload: unknown,
  selfAddresses: readonly string[] = DEFAULT_SELF_ADDRESSES,
): ParsedInboundEvent | undefined {
  if (!isRecord(payload) || payload.type !== "email.received") return undefined
  const data = payload.data
  if (!isRecord(data)) return undefined
  if (typeof data.email_id !== "string" || !PROVIDER_ID_PATTERN.test(data.email_id)) {
    return undefined
  }
  const receivedAt = parseDate(data.created_at) ?? parseDate(payload.created_at)
  if (receivedAt === undefined) return undefined
  return {
    id: data.email_id,
    receivedAt,
    admitted: isAdmitted(data),
    selfSent: isSelfSent(data.from, selfAddresses),
  }
}

export interface SentEmail {
  /** The RFC Message-ID Resend gave the email, or null while it has none. */
  readonly messageId: string | null
}

export interface ReceivingClient {
  getReceived(id: string): Promise<ReceivedEmail>
  listReceived(): AsyncGenerator<ReceivedReference>
  /** Reads a sent email's metadata; needs the full-access key, like receiving. */
  getSent(id: string): Promise<SentEmail>
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Reads Resend receiving with the full-access key. Errors carry only codes, never response bodies.
 */
export function createReceivingClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = defaultWait,
  selfAddresses: readonly string[] = DEFAULT_SELF_ADDRESSES,
): ReceivingClient {
  if (apiKey === "" || /[\r\n]/.test(apiKey)) throw new InboundError("receiving_key_invalid")

  async function get(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetchImpl(`${RESEND_API}${path}`, {
          headers: { Authorization: `Bearer ${apiKey}`, "Cache-Control": "no-store" },
          redirect: "error",
          signal: AbortSignal.timeout(RECEIVING_TIMEOUT_MS),
        })
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError"
        throw new InboundError(timedOut ? "receiving_timeout" : "receiving_network")
      }
      if (response.status === 429 && attempt < RECEIVING_RETRIES) {
        const seconds = Number(response.headers.get("retry-after"))
        await response.body?.cancel().catch(() => undefined)
        await wait(
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds * 1000, MAX_RATE_LIMIT_WAIT_MS)
            : 500 * (attempt + 1),
        )
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new InboundError(`receiving_http_${response.status}`)
      }
      try {
        return await response.json()
      } catch {
        throw new InboundError("receiving_malformed")
      }
    }
  }

  return {
    async getReceived(id) {
      const body = await get(`/emails/receiving/${inboundProviderId(id)}`)
      if (!isRecord(body) || typeof body.id !== "string") {
        throw new InboundError("receiving_malformed")
      }
      return body as ReceivedEmail
    },
    async *listReceived() {
      const seen = new Set<string>()
      let after: string | undefined
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const query = after === undefined ? "" : `&after=${encodeURIComponent(after)}`
        const body = await get(`/emails/receiving?limit=100${query}`)
        if (!isRecord(body) || !Array.isArray(body.data) || typeof body.has_more !== "boolean") {
          throw new InboundError("receiving_malformed")
        }
        let last: string | undefined
        for (const item of body.data) {
          if (!isRecord(item)) throw new InboundError("receiving_malformed")
          const id = inboundProviderId(item.id)
          const receivedAt = parseDate(item.created_at)
          if (receivedAt === undefined) throw new InboundError("receiving_malformed")
          if (seen.has(id)) throw new InboundError("receiving_repeated_cursor")
          seen.add(id)
          last = id
          yield {
            id,
            receivedAt,
            admitted: isAdmitted(item),
            selfSent: isSelfSent(item.from, selfAddresses),
          }
        }
        if (!body.has_more) return
        if (last === undefined) throw new InboundError("receiving_malformed")
        after = last
      }
      // More pages than recovery reads: the listing is incomplete, never silently complete.
      throw new InboundError("receiving_page_limit")
    },
    async getSent(id) {
      const body = await get(`/emails/${inboundProviderId(id)}`)
      if (!isRecord(body) || body.id !== id) throw new InboundError("sent_malformed")
      const messageId = body.message_id
      if (messageId !== undefined && messageId !== null && typeof messageId !== "string") {
        throw new InboundError("sent_malformed")
      }
      return { messageId: typeof messageId === "string" && messageId !== "" ? messageId : null }
    },
  }
}

/** Downloads the provider-held raw message: HTTPS only, no redirects, at most 20 MiB. */
export async function downloadRaw(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new InboundError("raw_url_invalid")
  }
  if (parsed.protocol !== "https:") throw new InboundError("raw_url_invalid")
  let response: Response
  try {
    response = await fetchImpl(parsed.href, {
      redirect: "error",
      signal: AbortSignal.timeout(RAW_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError"
    throw new InboundError(timedOut ? "raw_timeout" : "raw_network")
  }
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined)
    throw new InboundError("raw_redirect")
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined)
    throw new InboundError("raw_unavailable")
  }
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > RAW_MAX_BYTES) {
    await response.body.cancel().catch(() => undefined)
    throw new InboundError("raw_too_large")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > RAW_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new InboundError("raw_too_large")
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    if (error instanceof InboundError) throw error
    throw new InboundError("raw_network")
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** Resend's Idempotency-Key for one forward, per environment on the shared account. */
export const forwardIdempotencyKey = (environment: string, id: string) =>
  `b4:${environment}:inbound-forward:${id}`

const ATTACHED_NOTE = "The original email, including attachments, is attached as original.eml."
const OVERSIZE_NOTE =
  "The original email is larger than 20 MiB, so it is not attached. It stays in Resend receiving."

/**
 * The forward of one received message, rebuilt from provider-held content on every attempt, so
 * a retry carries the same body under the same Idempotency-Key. `raw` is undefined only when the
 * original exceeds the attachment limit.
 */
export function composeInboundForward(
  email: ReceivedEmail,
  raw: Uint8Array | undefined,
  environment: string,
): OutgoingEmail {
  const subject =
    typeof email.subject === "string" ? email.subject.replace(/[\r\n\0]+/g, " ").trim() : ""
  const body = typeof email.text === "string" && email.text.trim() !== "" ? email.text : undefined
  const text =
    raw !== undefined
      ? (body ?? ATTACHED_NOTE)
      : `${body !== undefined ? `${body}\n\n--\n` : ""}${OVERSIZE_NOTE}`
  const html = typeof email.html === "string" && email.html.trim() !== "" ? email.html : undefined
  const replyTo = parseAddress(email.from)
  return {
    from: SENDER,
    to: INBOUND_FORWARD_TO,
    ...(replyTo !== undefined ? { replyTo } : {}),
    subject: `Fwd: ${subject === "" ? "(no subject)" : subject}`,
    text,
    ...(html !== undefined ? { html } : {}),
    ...(raw !== undefined
      ? {
          attachments: [{ filename: "original.eml", content: Buffer.from(raw).toString("base64") }],
        }
      : {}),
    headers: { "Auto-Submitted": "auto-generated", "X-B4-Forwarded": email.id },
    tags: [
      B4_APP_TAG,
      { name: "environment", value: environment },
      { name: "kind", value: "forward" },
    ],
    idempotencyKey: forwardIdempotencyKey(environment, email.id),
  }
}

/** True when the received message is itself one of B4's forwards. */
export function isForward(headers: unknown): boolean {
  return (
    isRecord(headers) && Object.keys(headers).some((name) => name.toLowerCase() === FORWARD_MARKER)
  )
}

/**
 * Records an admitted message; a repeat (webhook retry, recovery) changes nothing. Mail from
 * B4's own addresses needs no reply processing; everything else waits for it, and holds sequence
 * sends until it is processed. Admission takes the reply-gate lock, so a send authorised after
 * this commits sees the pending receipt.
 */
export function admitInboundReceipt(
  executor: SqlExecutor,
  input: { id: string; receivedAt: Date; selfSent?: boolean },
): Promise<boolean> {
  const id = inboundProviderId(input.id)
  const self = input.selfSent === true
  return executor.transaction(async (tx) => {
    await tx.query(REPLY_GATE_LOCK)
    const inserted = await tx.query(
      "insert into growth_inbound_receipts (id, received_at, reply_status, reply_error_code) values ($1, $2, $3, $4) on conflict (id) do nothing returning id",
      [id, input.receivedAt, self ? "ignored" : "pending", self ? "self_mail" : null],
    )
    return inserted.rowCount > 0
  })
}

export interface ForwardDeps {
  readonly environment: GrowthEnv["environment"]
  getReceived(id: string): Promise<ReceivedEmail>
  downloadRaw(url: string): Promise<Uint8Array>
  readonly mailer: Mailer
  now(): Date
}

export type ForwardResult =
  | { readonly outcome: "forwarded" | "already_forwarded" | "unknown_receipt" }
  | { readonly outcome: "failed" | "ignored" | "retry"; readonly code: string }

interface ReceiptRow extends Record<string, unknown> {
  status: "pending" | "forwarded" | "failed" | "ignored"
  forward_provider_id: string | null
  first_attempted_at: Date | null
  last_error_code: string | null
}

function settled(row: ReceiptRow): ForwardResult | undefined {
  if (row.forward_provider_id !== null || row.status === "forwarded") {
    return { outcome: "already_forwarded" }
  }
  if (row.status === "failed" || row.status === "ignored") {
    return { outcome: row.status, code: row.last_error_code ?? "unclassified" }
  }
  return undefined
}

type Source =
  | { kind: "ready"; email: ReceivedEmail; raw: Uint8Array | undefined }
  | { kind: "ignored"; code: string }
  | { kind: "retry"; code: string }

async function fetchSource(id: string, deps: ForwardDeps): Promise<Source> {
  try {
    const email = await deps.getReceived(id)
    if (email.id !== id) return { kind: "retry", code: "source_mismatch" }
    // The authoritative content decides, not the webhook payload or the listing.
    if (!isAdmitted(email)) return { kind: "ignored", code: "recipient_mismatch" }
    if (isForward(email.headers)) return { kind: "ignored", code: "forward_loop" }
    const url = isRecord(email.raw) ? email.raw.download_url : undefined
    if (typeof url !== "string") return { kind: "retry", code: "raw_unavailable" }
    try {
      return { kind: "ready", email, raw: await deps.downloadRaw(url) }
    } catch (error) {
      if (error instanceof InboundError && error.code === "raw_too_large") {
        return { kind: "ready", email, raw: undefined }
      }
      throw error
    }
  } catch (error) {
    return { kind: "retry", code: errorLogCode(error) }
  }
}

const CHECK_PENDING = "where id = $1 and status = 'pending' and forward_provider_id is null"

/**
 * Forwards one admitted receipt to brian@cacheplane.ai at most once. The first-attempt time is
 * committed before any send, so a crash never reopens Resend's idempotency window; once that
 * time is 23 hours old without a known provider id, the receipt fails instead of risking a
 * second copy. The send runs under the receipt's row lock, so a webhook and a recovery racing on
 * one receipt send once.
 */
export async function forwardInboundReceipt(
  executor: SqlExecutor,
  rawId: string,
  deps: ForwardDeps,
): Promise<ForwardResult> {
  const id = inboundProviderId(rawId)
  const select =
    "select status, forward_provider_id, first_attempted_at, last_error_code from growth_inbound_receipts where id = $1"
  const current = (await executor.query<ReceiptRow>(select, [id])).rows[0]
  if (current === undefined) return { outcome: "unknown_receipt" }
  const done = settled(current)
  if (done !== undefined) return done

  // Provider reads happen before any lock is taken.
  const source = await fetchSource(id, deps)
  if (source.kind === "retry") {
    const code = safeErrorCode(source.code)
    await executor.query(
      `update growth_inbound_receipts set last_error_code = $2 ${CHECK_PENDING}`,
      [id, code],
    )
    return { outcome: "retry", code }
  }
  if (source.kind === "ignored") {
    await executor.query(
      `update growth_inbound_receipts set status = 'ignored', last_error_code = $2 ${CHECK_PENDING}`,
      [id, source.code],
    )
    return { outcome: "ignored", code: source.code }
  }

  const email = composeInboundForward(source.email, source.raw, deps.environment)
  // Committed on its own, before the send: an uncertain send never rolls this back.
  await executor.query(
    `update growth_inbound_receipts set first_attempted_at = coalesce(first_attempted_at, $2) ${CHECK_PENDING}`,
    [id, deps.now()],
  )

  return executor.transaction(async (tx): Promise<ForwardResult> => {
    const row = (await tx.query<ReceiptRow>(`${select} for update`, [id])).rows[0]
    if (row === undefined) return { outcome: "unknown_receipt" }
    const finished = settled(row)
    if (finished !== undefined) return finished
    // Unreachable while the reservation above applies; never send without first-attempt evidence.
    if (row.first_attempted_at === null) return { outcome: "retry", code: "not_reserved" }
    if (
      row.first_attempted_at.getTime() <=
      deps.now().getTime() - IDEMPOTENCY_WINDOW_SECONDS * 1000
    ) {
      await tx.query(
        "update growth_inbound_receipts set status = 'failed', last_error_code = 'idempotency_window_expired' where id = $1",
        [id],
      )
      return { outcome: "failed", code: "idempotency_window_expired" }
    }
    await tx.query("update growth_inbound_receipts set attempts = attempts + 1 where id = $1", [id])
    const result = await deps.mailer.send(email)
    if (result.kind === "accepted") {
      await tx.query(
        "update growth_inbound_receipts set status = 'forwarded', forward_provider_id = $2, last_error_code = null where id = $1",
        [id, result.providerEmailId],
      )
      return { outcome: "forwarded" }
    }
    // Resend holds a different body under this key only if an earlier attempt was accepted.
    if (result.kind === "rejected" && result.code === "idempotency_mismatch") {
      await tx.query(
        "update growth_inbound_receipts set status = 'forwarded', last_error_code = 'idempotency_mismatch' where id = $1",
        [id],
      )
      return { outcome: "forwarded" }
    }
    const code = safeErrorCode(result.code)
    if (result.kind === "rejected") {
      await tx.query(
        "update growth_inbound_receipts set status = 'failed', last_error_code = $2 where id = $1",
        [id, code],
      )
      return { outcome: "failed", code }
    }
    await tx.query("update growth_inbound_receipts set last_error_code = $2 where id = $1", [
      id,
      code,
    ])
    return { outcome: "retry", code }
  })
}

export interface InboundRuntime extends ForwardDeps {
  listReceived(): AsyncIterable<ReceivedReference>
  getSent(id: string): Promise<SentEmail>
  /** The contact lookup secret, so a reply's sender is compared the way the form stores it. */
  readonly emailHmacSecret: string
  /** B4's own senders; see `selfAddressesFor`. */
  readonly selfAddresses: readonly string[]
}

/**
 * How far the listing got: `complete` reached the end or the three-day horizon, `partial` ran
 * out of budget first, `failed` hit a provider error. Only a complete listing proves that every
 * recent message is admitted.
 */
export type ListingResult = "complete" | "partial" | "failed"

export interface InboundReport {
  readonly admitted: number
  readonly listing: ListingResult
  readonly forwarded: number
  readonly failed: number
  readonly retrying: number
}

/** Admits brian@b4.run messages from the last three days of received mail, newest first. */
export async function admitRecentInbound(
  executor: SqlExecutor,
  deps: {
    listReceived(): AsyncIterable<ReceivedReference>
    now(): Date
    canContinue(): boolean
  },
): Promise<{ admitted: number; listing: ListingResult }> {
  let admitted = 0
  const horizon = deps.now().getTime() - INBOUND_RECOVERY_DAYS * 86_400_000
  try {
    for await (const item of deps.listReceived()) {
      if (item.receivedAt.getTime() < horizon) return { admitted, listing: "complete" }
      if (!deps.canContinue()) return { admitted, listing: "partial" }
      if (!item.admitted) continue
      if (await admitInboundReceipt(executor, item)) admitted++
    }
  } catch (error) {
    // A listing failure still lets already-admitted receipts retry.
    if (!(error instanceof InboundError)) throw error
    process.stderr.write(`growth inbound listing failed: ${errorLogCode(error)}\n`)
    return { admitted, listing: "failed" }
  }
  return { admitted, listing: "complete" }
}

/** Retries unforwarded receipts while `canContinue` allows. */
export async function retryForwards(
  executor: SqlExecutor,
  deps: ForwardDeps & { canContinue(): boolean; batch?: number },
): Promise<{ forwarded: number; failed: number; retrying: number }> {
  let forwarded = 0
  let failed = 0
  let retrying = 0
  const pending = await executor.query<{ id: string }>(
    "select id from growth_inbound_receipts where status = 'pending' and forward_provider_id is null order by updated_at, id limit $1",
    [deps.batch ?? INBOUND_RECOVERY_BATCH],
  )
  for (const receipt of pending.rows) {
    if (!deps.canContinue()) break
    const result = await forwardInboundReceipt(executor, receipt.id, deps)
    if (result.outcome === "forwarded") forwarded++
    else if (result.outcome === "failed") failed++
    else if (result.outcome === "retry") retrying++
  }
  return { forwarded, failed, retrying }
}

/**
 * Catches mail the webhook missed: admits recent brian@b4.run messages, then retries
 * unforwarded receipts while `canContinue` allows.
 */
export async function recoverInbound(
  executor: SqlExecutor,
  deps: ForwardDeps & {
    listReceived(): AsyncIterable<ReceivedReference>
    canContinue(): boolean
    batch?: number
  },
): Promise<InboundReport> {
  const { admitted, listing } = await admitRecentInbound(executor, deps)
  return { admitted, listing, ...(await retryForwards(executor, deps)) }
}

/**
 * Resend clients for inbound mail: the full-access key reads receiving; the forward goes out on
 * the sending key when one is set.
 */
export function createInboundRuntime(input: {
  receivingApiKey: string
  sendApiKey: string
  environment: GrowthEnv["environment"]
  emailHmacSecret: string
  founderEmail?: string
  fetchImpl?: typeof fetch
}): InboundRuntime {
  const fetchImpl = input.fetchImpl ?? fetch
  const selfAddresses = selfAddressesFor(
    input.founderEmail !== undefined ? { founderEmail: input.founderEmail } : {},
  )
  const client = createReceivingClient(input.receivingApiKey, fetchImpl, defaultWait, selfAddresses)
  return {
    environment: input.environment,
    getReceived: (id) => client.getReceived(id),
    listReceived: () => client.listReceived(),
    getSent: (id) => client.getSent(id),
    emailHmacSecret: input.emailHmacSecret,
    selfAddresses,
    downloadRaw: (url) => downloadRaw(url, fetchImpl),
    mailer: createResendMailer(input.sendApiKey, fetchImpl, FORWARD_SEND_TIMEOUT_MS),
    now: () => new Date(),
  }
}

/** The inbound runtime for a loaded environment, or undefined when receiving is not configured. */
export function inboundRuntimeFor(
  env: GrowthEnv,
  create: typeof createInboundRuntime = createInboundRuntime,
): InboundRuntime | undefined {
  if (env.resendReceivingApiKey === undefined) return undefined
  return create({
    receivingApiKey: env.resendReceivingApiKey,
    sendApiKey: env.resendApiKey ?? env.resendReceivingApiKey,
    environment: env.environment,
    emailHmacSecret: env.emailHmacSecret,
    ...(env.founderEmail !== undefined ? { founderEmail: env.founderEmail } : {}),
  })
}
