export type SequenceStep = 1 | 2 | 3

export interface Draft {
  readonly subject: string
  readonly body: string
}

export const BOOKING_URL = "https://b4.run/call"

/** Every link founder-sequence copy may carry. */
export const APPROVED_LINKS: ReadonlySet<string> = new Set([
  BOOKING_URL,
  "https://b4.run/docs/getting-started",
])

const URL_PATTERN = /https?:\/\/[^\s<>()"'“”‘’\]}]+/giu
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu
const HTML_PATTERN = /(?:<\/?[a-z][^>]*>|<!doctype\b[^>]*>|<!--[\s\S]*?-->)/iu
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)/u
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\([^)]*\)/u
const HEADER_PATTERN = /^[ \t]*(?:bcc|cc|from|reply-to|subject|to):/imu
const SURVEILLANCE_PATTERN =
  /\b(?:I saw you|we saw you|I noticed you|we noticed|we observed you|based on your activity|your activity|tracking|telemetry|page[ -]?view|analytics event|your (?:product )?(?:usage|behavior|activity|signals?) (?:show(?:s|ed)?|reveal(?:s|ed)?|indicate(?:s|d)?|suggest(?:s|ed)?))\b/iu
const CALENDAR_PATTERN =
  /(?:calendly\.com|cal\.com|calendar\.google\.com|\/(?:book|calendar|meeting|schedule)(?:\/|\?|$))/iu
const CLICK_WRAPPER_PATTERN =
  /(?:pixel|beacon|open\.gif|utm_(?:campaign|content|medium|source)|\/(?:click|redirect|track)(?:\/|\?|$))/iu
const PROTOCOL_RELATIVE_LINK_PATTERN = /(?:^|[^A-Za-z0-9/:])\/\/[^\s)\]}'"”’]+/u
const DOT_RELATIVE_LINK_PATTERN = /(?:^|[^A-Za-z0-9])\.{1,2}\/[a-z0-9][^\s)\]}'"”’]*/iu
const RELATIVE_LINK_PATTERN = /(?:^|[^A-Za-z0-9/:])\/(?!\/)[a-z0-9][^\s)\]}'"”’]*/iu
const UNSUPPORTED_SCHEME_PATTERN =
  /(?:^|[^A-Za-z0-9])(?!(?:https?):)[a-z][a-z0-9+.-]*:[^\s)\]}'"”’]+/iu

function normalizeSubject(subject: string): string {
  return subject.trim().replace(/[ \t]+/gu, " ")
}

function normalizeBody(body: string): string {
  return body
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
}

function linksIn(value: string): string[] {
  return (value.match(URL_PATTERN) ?? []).map((link) => link.replace(/[.,;:!]+$/u, ""))
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length
}

/** Returns every rule a candidate draft breaks; an empty list means it may be sent. */
export function draftViolations(candidate: unknown): string[] {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return ["draft must be an object"]
  }
  const violations: string[] = []
  const record = candidate as Record<string, unknown>
  if (Object.keys(record).some((field) => field !== "subject" && field !== "body")) {
    violations.push("draft contains unknown fields")
  }
  const rawSubject = record.subject
  const rawBody = record.body
  if (typeof rawSubject !== "string") violations.push("subject must be a string")
  if (typeof rawBody !== "string") violations.push("body must be a string")
  if (typeof rawSubject !== "string" || typeof rawBody !== "string") return violations

  const subject = normalizeSubject(rawSubject)
  const body = normalizeBody(rawBody)
  const message = `${subject}\n${body}`
  const links = linksIn(message)

  if (subject.length === 0) violations.push("subject is empty")
  if (subject.length > 80) violations.push("subject exceeds 80 characters")
  if (body.length === 0) violations.push("body is empty")
  if (rawBody.length > 1_200) violations.push("body exceeds 1200 characters")
  if (/[\r\n]/u.test(rawSubject)) violations.push("subject contains a newline")
  if (linksIn(subject).length > 0) violations.push("subject contains a URL")
  if (wordCount(body) > 120) violations.push("body exceeds 120 words")
  if ((body.match(/\?/gu) ?? []).length > 1) violations.push("body contains more than one question")
  if (links.length > 1) violations.push("message contains more than one link")
  if (links.some((link) => !APPROVED_LINKS.has(link))) {
    violations.push("message contains an unapproved link")
  }
  if (HTML_PATTERN.test(message)) violations.push("message contains HTML")
  if (MARKDOWN_IMAGE_PATTERN.test(message))
    violations.push("message contains markdown image markup")
  if (MARKDOWN_LINK_PATTERN.test(message)) violations.push("message contains markdown link markup")
  if (HEADER_PATTERN.test(message)) violations.push("message contains an injected mail header")
  if (EMAIL_PATTERN.test(message)) violations.push("message contains an email")
  if (SURVEILLANCE_PATTERN.test(message)) violations.push("message contains surveillance language")
  if (CALENDAR_PATTERN.test(message)) violations.push("message contains a calendar link")
  if (CLICK_WRAPPER_PATTERN.test(message)) {
    violations.push("message contains a pixel, beacon, or click-wrapper link")
  }
  if (PROTOCOL_RELATIVE_LINK_PATTERN.test(message)) {
    violations.push("message contains a protocol-relative link")
  }
  if (DOT_RELATIVE_LINK_PATTERN.test(message))
    violations.push("message contains a dot-relative link")
  if (RELATIVE_LINK_PATTERN.test(message)) violations.push("message contains a relative link")
  if (UNSUPPORTED_SCHEME_PATTERN.test(message)) {
    violations.push("message contains an unsupported URL scheme")
  }
  return [...new Set(violations)]
}

export const SEQUENCE_DRAFTS: Readonly<Record<SequenceStep, Draft>> = Object.freeze({
  1: Object.freeze({
    subject: "Engineer to engineer",
    body: `I saw that you signed up for B4.run updates, so I wanted to introduce myself. I'm the founder.

I offer short engineer-to-engineer sessions to help you get your agent running. No sales, just working through whatever is in the way.

Reply if that would help.`,
  }),
  2: Object.freeze({
    subject: "Get your agent into production",
    body: `Even with agents writing a lot of our code, teams still get stuck.

I can work through it with you in a 30-minute hands-on session: fix what is in the way and get your agent running.

No sales. Just the founder and your engineering team.

Book a time with me:
${BOOKING_URL}`,
  }),
  3: Object.freeze({
    subject: "One last note from the B4.run founder",
    body: `One last note from me.

I would like to spend 30 minutes with you and your team, fixing what is in the way and getting your agent running. No sales.

Your feedback also helps me improve B4.run.

Book a time with me:
${BOOKING_URL}

This is my last automated follow-up.`,
  }),
})

/** Returns the normalised draft for a step, throwing when the checker finds any violation. */
export function sequenceDraft(
  step: SequenceStep,
  drafts: Readonly<Record<SequenceStep, Draft>> = SEQUENCE_DRAFTS,
): Draft {
  const draft = drafts[step]
  const violations = draftViolations(draft)
  if (violations.length > 0) {
    throw new Error(`Invalid sequence draft: ${violations.join("; ")}`)
  }
  return {
    subject: normalizeSubject(draft.subject),
    body: normalizeBody(draft.body),
  }
}
