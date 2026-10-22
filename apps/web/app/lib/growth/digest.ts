import type { SqlExecutor } from "./database"
import { safeErrorCode } from "./errors"
import { composeDigestEmail, type Mailer } from "./mailer"
import { isSendWindow, pacificCalendarDate, pacificMorningOf, SEQUENCE_TIME_ZONE } from "./schedule"
import type { SequenceStep } from "./sequence-copy"
import type { SequenceEnv } from "./sequence-env"
import { createActionToken, founderStopUrl } from "./tokens"

export interface DigestData {
  readonly date: string
  readonly newContacts: readonly { email: string; approvedAt: Date }[]
  readonly inFlight: readonly {
    contactId: string
    email: string
    nextStep: SequenceStep
    dueAt: Date
  }[]
}

export type DigestOutcome =
  | "sent"
  | "nothing_to_report"
  | "already_sent"
  | "outside_window"
  | "failed"

export const DIGEST_KIND = "digest.sent"
const DEFAULT_LOOKBACK_MS = 24 * 3600 * 1000

export const digestEventKey = (date: string) => `digest:${date}`

const pacificFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SEQUENCE_TIME_ZONE,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
})

/** For example `Thu 2026-10-22 07:00 PDT`. */
function pacificTime(date: Date): string {
  const p = Object.fromEntries(
    pacificFormat.formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`
}

/** Contacts approved in `(since, now]`, and every contact with a pending or leased send. */
export async function readDigestData(
  executor: SqlExecutor,
  input: { now: Date; since: Date },
): Promise<DigestData> {
  const contacts = await executor.query<{ email: string; approved_at: Date }>(
    "select email, approved_at from growth_contacts where approved_at > $1 and approved_at <= $2 and stopped_at is null and deleted_at is null and email is not null order by approved_at, id",
    [input.since, input.now],
  )
  const sends = await executor.query<{
    contact_id: string
    email: string
    step: number
    due_at: Date
  }>(
    "select s.contact_id, c.email, s.step, s.due_at from growth_sends s join growth_contacts c on c.id = s.contact_id where s.status in ('pending', 'leased') and c.stopped_at is null and c.deleted_at is null and c.email is not null order by s.due_at, s.id",
  )
  return {
    date: pacificCalendarDate(input.now).date,
    newContacts: contacts.rows.map((row) => ({ email: row.email, approvedAt: row.approved_at })),
    inFlight: sends.rows.map((row) => ({
      contactId: row.contact_id,
      email: row.email,
      nextStep: row.step as SequenceStep,
      dueAt: row.due_at,
    })),
  }
}

export function renderDigestText(
  data: DigestData,
  stopUrlFor: (contactId: string) => string,
): string {
  const newLines = data.newContacts.map(
    (contact) => `- ${contact.email}, approved ${pacificTime(contact.approvedAt)}`,
  )
  const inFlightLines = data.inFlight.map(
    (entry) =>
      `- ${entry.email}: step ${entry.nextStep} due ${pacificTime(entry.dueAt)}\n  Stop: ${stopUrlFor(entry.contactId)}`,
  )
  return [
    `B4.run founder digest ${data.date}`,
    "",
    `New contacts since the last digest: ${data.newContacts.length}`,
    newLines.length > 0 ? newLines.join("\n") : "none",
    "",
    `Sequences in flight: ${data.inFlight.length}`,
    inFlightLines.length > 0 ? inFlightLines.join("\n") : "none",
    "",
    "A stop link ends that contact's sequence; it expires after seven days.",
  ].join("\n")
}

class DigestNotAccepted extends Error {
  constructor(readonly code: string) {
    super("digest not accepted")
  }
}

/**
 * Sends the founder digest once per Pacific weekday, during the send window, when there is
 * something to report. The day is claimed in the same transaction that sends, so a send the
 * mailer does not accept leaves no claim and the next tick retries under the same key.
 */
export async function sendDailyDigest(
  executor: SqlExecutor,
  input: { env: SequenceEnv; mailer: Mailer; now: Date },
): Promise<DigestOutcome> {
  const { env, mailer, now } = input
  if (!isSendWindow(now)) return "outside_window"
  const { date } = pacificCalendarDate(now)
  const eventKey = digestEventKey(date)

  const existing = await executor.query<{ id: string }>(
    "select id from growth_activity where event_key = $1",
    [eventKey],
  )
  if (existing.rowCount > 0) return "already_sent"

  const previous = await executor.query<{ occurred_at: Date }>(
    "select occurred_at from growth_activity where kind = $1 order by occurred_at desc limit 1",
    [DIGEST_KIND],
  )
  const since = previous.rows[0]?.occurred_at ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS)
  const data = await readDigestData(executor, { now, since })
  if (data.newContacts.length === 0 && data.inFlight.length === 0) return "nothing_to_report"

  // Minted from the digest date's 07:00, so every retry that day carries the same links.
  const issuedAt = pacificMorningOf(now)
  const text = renderDigestText(data, (contactId) =>
    founderStopUrl(
      env.publicOrigin,
      createActionToken({
        keyring: env.tokenKeyring,
        contactId,
        purpose: "founder_stop",
        issuedAt,
      }),
    ),
  )
  const email = composeDigestEmail({
    to: env.founderEmail,
    date,
    text,
    environment: env.environment,
  })

  try {
    return await executor.transaction(async (tx): Promise<DigestOutcome> => {
      const claim = await tx.query(
        "insert into growth_activity (event_key, contact_id, kind, occurred_at, data) values ($1, null, $2, $3, $4::jsonb) on conflict (event_key) do nothing returning id",
        [
          eventKey,
          DIGEST_KIND,
          now,
          JSON.stringify({
            date,
            new_contacts: data.newContacts.length,
            in_flight: data.inFlight.length,
          }),
        ],
      )
      if (claim.rowCount === 0) return "already_sent"
      const result = await mailer.send(email)
      if (result.kind === "accepted") return "sent"
      // Resend holds a different body under this key only if an earlier attempt was
      // accepted, so the founder already has today's digest.
      if (result.kind === "rejected" && result.code === "idempotency_mismatch") {
        await tx.query(
          "update growth_activity set data = data || '{\"reconciled\": true}'::jsonb where event_key = $1",
          [eventKey],
        )
        return "sent"
      }
      throw new DigestNotAccepted(safeErrorCode(result.code))
    })
  } catch (error) {
    if (!(error instanceof DigestNotAccepted)) throw error
    process.stderr.write(`growth digest not accepted: ${error.code}\n`)
    return "failed"
  }
}
