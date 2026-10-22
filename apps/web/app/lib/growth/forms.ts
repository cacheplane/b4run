import { DISCLOSURE_VERSION, FOUNDER_UPDATES_DISCLOSURE } from "./disclosure"
import { normalizeEmail } from "./email"

export { FOUNDER_UPDATES_DISCLOSURE }

export type FounderUpdatesSubmission = {
  readonly email: string
  readonly message?: string
  readonly posthogDistinctId?: string
  readonly disclosureVersion: string
  readonly submissionId: string
}

export type ParseResult =
  | { ok: true; value: FounderUpdatesSubmission }
  | {
      ok: false
      error: "invalid_body" | "invalid_email" | "message_too_long" | "stale_disclosure" | "honeypot"
    }

const MAX_MESSAGE = 1000
const MAX_DISTINCT_ID = 128
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const invalid = { ok: false, error: "invalid_body" } as const

export function parseFounderUpdatesSubmission(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid
  const record = body as Record<string, unknown>
  const { email, message, website_url, disclosure_version, submission_id, posthog_distinct_id } =
    record

  if (typeof email !== "string") return invalid
  if (typeof disclosure_version !== "string") return invalid
  if (typeof submission_id !== "string" || !UUID.test(submission_id)) return invalid
  if (message !== undefined && typeof message !== "string") return invalid
  if (website_url !== undefined && typeof website_url !== "string") return invalid
  if (posthog_distinct_id !== undefined && typeof posthog_distinct_id !== "string") return invalid
  if (typeof posthog_distinct_id === "string" && posthog_distinct_id.length > MAX_DISTINCT_ID) {
    return invalid
  }

  if (typeof website_url === "string" && website_url.trim() !== "") {
    return { ok: false, error: "honeypot" }
  }
  const normalized = normalizeEmail(email)
  if (normalized === undefined) return { ok: false, error: "invalid_email" }
  const trimmedMessage = message?.trim()
  if (trimmedMessage !== undefined && trimmedMessage.length > MAX_MESSAGE) {
    return { ok: false, error: "message_too_long" }
  }
  if (disclosure_version !== DISCLOSURE_VERSION) return { ok: false, error: "stale_disclosure" }

  const distinctId = posthog_distinct_id?.trim()
  return {
    ok: true,
    value: {
      email: normalized,
      ...(trimmedMessage ? { message: trimmedMessage } : {}),
      ...(distinctId ? { posthogDistinctId: distinctId } : {}),
      disclosureVersion: disclosure_version,
      submissionId: submission_id,
    },
  }
}
