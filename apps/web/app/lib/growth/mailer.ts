import { type SequenceStep, sequenceDraft } from "./sequence-copy"

export const SENDER = "Brian at B4.run <brian@b4.run>"

/**
 * Marks every email B4 composes. The Resend account is shared with other products, so the
 * webhook acts only on events whose email carries this tag.
 */
export const B4_APP_TAG = { name: "app", value: "b4" } as const

const RESEND_URL = "https://api.resend.com/emails"
const DEFAULT_TIMEOUT_MS = 5000

/** Resend's Idempotency-Key for one sequence step; also the unique key of its `growth_sends` row. */
export const sendIdempotencyKey = (contactId: string, step: SequenceStep) =>
  `seq:v1:${contactId}:step:${step}`

export interface OutgoingEmail {
  readonly from: string
  readonly to: string
  readonly replyTo: string
  readonly bcc?: string
  readonly subject: string
  readonly text: string
  readonly headers: Readonly<Record<string, string>>
  readonly tags: readonly { name: string; value: string }[]
  readonly idempotencyKey: string
}

export type SendResult =
  | { kind: "accepted"; providerEmailId: string }
  | { kind: "rejected"; code: string }
  | { kind: "retryable"; code: string }

export interface Mailer {
  send(email: OutgoingEmail): Promise<SendResult>
}

export function composeSequenceEmail(input: {
  step: SequenceStep
  to: string
  sendId: string
  contactId: string
  unsubscribeUrl: string
  founderEmail: string
  environment: string
}): OutgoingEmail {
  const draft = sequenceDraft(input.step)
  return {
    from: SENDER,
    to: input.to,
    replyTo: SENDER,
    bcc: input.founderEmail,
    subject: draft.subject,
    text: `${draft.body}\n\n--\nUnsubscribe with one click: ${input.unsubscribeUrl}`,
    headers: {
      "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "X-B4-Send-ID": input.sendId,
    },
    tags: [
      B4_APP_TAG,
      { name: "environment", value: input.environment },
      { name: "kind", value: "sequence" },
      { name: "step", value: String(input.step) },
    ],
    idempotencyKey: sendIdempotencyKey(input.contactId, input.step),
  }
}

export function composeDigestEmail(input: {
  to: string
  date: string
  text: string
  environment: string
}): OutgoingEmail {
  return {
    from: SENDER,
    to: input.to,
    replyTo: SENDER,
    subject: `B4.run founder digest ${input.date}`,
    text: input.text,
    headers: {},
    tags: [
      B4_APP_TAG,
      { name: "environment", value: input.environment },
      { name: "kind", value: "digest" },
    ],
    // Per environment, so a preview and production sharing one Resend account never collide.
    idempotencyKey: `digest:${input.environment}:${input.date}`,
  }
}

async function errorName(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json()
    if (typeof body === "object" && body !== null && "name" in body) {
      const name = (body as { name: unknown }).name
      return typeof name === "string" ? name : undefined
    }
  } catch {
    // An unreadable body is treated as an unknown error name.
  }
  return undefined
}

async function classify(response: Response): Promise<SendResult> {
  const status = response.status
  if (status === 200) {
    try {
      const body: unknown = await response.json()
      const id =
        typeof body === "object" && body !== null ? (body as { id?: unknown }).id : undefined
      if (typeof id === "string") return { kind: "accepted", providerEmailId: id }
    } catch {
      // Falls through to the malformed-response result.
    }
    return { kind: "retryable", code: "malformed_response" }
  }
  if (status === 429 || status >= 500) return { kind: "retryable", code: `http_${status}` }
  if (status === 409) {
    return (await errorName(response)) === "concurrent_idempotent_requests"
      ? { kind: "retryable", code: "http_409" }
      : { kind: "rejected", code: "idempotency_mismatch" }
  }
  return { kind: "rejected", code: `http_${status}` }
}

export function createResendMailer(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Mailer {
  return {
    async send(email) {
      const payload = {
        from: email.from,
        to: [email.to],
        reply_to: email.replyTo,
        ...(email.bcc !== undefined ? { bcc: [email.bcc] } : {}),
        subject: email.subject,
        text: email.text,
        headers: email.headers,
        tags: email.tags,
      }
      try {
        const response = await fetchImpl(RESEND_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": email.idempotencyKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        })
        return await classify(response)
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError"
        return { kind: "retryable", code: timedOut ? "timeout" : "network" }
      }
    },
  }
}
