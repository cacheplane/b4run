import { describe, expect, it } from "vitest"
import { acceptFounderUpdatesForm, DISCLOSURE_VERSION } from "./contacts"
import type { SqlExecutor } from "./database"
import { readDigestData, sendDailyDigest } from "./digest"
import type { Mailer, OutgoingEmail, SendResult } from "./mailer"
import { enrollApprovedContacts } from "./sequence"
import type { SequenceEnv } from "./sequence-env"
import { GROWTH_DB_TESTS_ENABLED, withMigratedDatabase } from "./test-support/postgres"
import { verifyActionToken } from "./tokens"

const SECRET = "test-secret"
const START_AT = new Date("2026-10-20T00:00:00.000Z")
// Wednesday 03:00 PDT.
const APPROVED = new Date("2026-10-21T10:00:00.000Z")
// Thursday 07:10 and 07:40 PDT.
const THURSDAY = new Date("2026-10-22T14:10:00.000Z")
const THURSDAY_LATER = new Date("2026-10-22T14:40:00.000Z")
// Thursday 07:00 PDT, the stop tokens' issue time.
const THURSDAY_MORNING = new Date("2026-10-22T14:00:00.000Z")
// Friday 07:10 PDT.
const FRIDAY = new Date("2026-10-23T14:10:00.000Z")

const env: SequenceEnv = {
  databaseUrl: "postgres://unused",
  emailHmacSecret: SECRET,
  tokenKeyring: { active: { id: 1, secret: "token-secret-value" }, previous: [] },
  environment: "test",
  publicOrigin: "https://b4.run",
  sequenceEnabled: true,
  sequenceStartAt: START_AT,
  deliveryEnabled: true,
  resendApiKey: "re_test",
  founderEmail: "founder@example.com",
}

interface RecordingMailer extends Mailer {
  readonly calls: OutgoingEmail[]
}

function recordingMailer(results: readonly SendResult[] = []): RecordingMailer {
  const calls: OutgoingEmail[] = []
  return {
    calls,
    async send(email) {
      calls.push(email)
      return results[calls.length - 1] ?? { kind: "accepted", providerEmailId: "em_digest" }
    },
  }
}

let counter = 0
async function approve(executor: SqlExecutor, email: string, now: Date) {
  counter += 1
  const result = await acceptFounderUpdatesForm(executor, SECRET, {
    email,
    disclosureVersion: DISCLOSURE_VERSION,
    submissionId: `digest-sub-${counter}`,
    now,
  })
  return result.contactId
}

async function digestActivity(executor: SqlExecutor) {
  const result = await executor.query<{
    event_key: string
    contact_id: string | null
    occurred_at: Date
    data: Record<string, unknown>
  }>(
    "select event_key, contact_id, occurred_at, data from growth_activity where kind = 'digest.sent' order by occurred_at",
  )
  return result.rows
}

const stopTokenIn = (text: string) => /founder-stop\?token=([A-Za-z0-9_.-]+)/.exec(text)?.[1]

describe.skipIf(!GROWTH_DB_TESTS_ENABLED)("growth founder digest", () => {
  it("sends once per Pacific date with a founder stop link per in-flight contact", async () => {
    await withMigratedDatabase(async (executor) => {
      const contactId = await approve(executor, "ada@example.com", APPROVED)
      await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })
      const mailer = recordingMailer()

      expect(await sendDailyDigest(executor, { env, mailer, now: THURSDAY })).toBe("sent")
      expect(await sendDailyDigest(executor, { env, mailer, now: THURSDAY_LATER })).toBe(
        "already_sent",
      )
      expect(mailer.calls).toHaveLength(1)

      const email = mailer.calls[0] as OutgoingEmail
      expect(email.to).toBe("founder@example.com")
      expect(email.bcc).toBeUndefined()
      expect(email.idempotencyKey).toBe("digest:2026-10-22")
      expect(email.text).toContain("ada@example.com")
      expect(email.text).toContain("step 1 due Thu 2026-10-22 07:00 PDT")
      const token = stopTokenIn(email.text)
      expect(token).toBeDefined()
      expect(
        verifyActionToken({
          token: token as string,
          keyring: env.tokenKeyring,
          purpose: "founder_stop",
          now: THURSDAY,
        }),
      ).toEqual({ ok: true, contactId })
      // Seven days after 07:00 Thursday, plus one second, the link has expired.
      expect(
        verifyActionToken({
          token: token as string,
          keyring: env.tokenKeyring,
          purpose: "founder_stop",
          now: new Date(THURSDAY_MORNING.getTime() + 604_801_000),
        }).ok,
      ).toBe(false)

      const activity = await digestActivity(executor)
      expect(activity).toHaveLength(1)
      expect(activity[0]).toMatchObject({ event_key: "digest:2026-10-22", contact_id: null })
      expect(activity[0]?.occurred_at.toISOString()).toBe(THURSDAY.toISOString())
      expect(JSON.stringify(activity[0]?.data)).not.toContain("@")
    })
  }, 120_000)

  it("rolls back the claim when the mailer does not accept, and the retry carries the same body", async () => {
    await withMigratedDatabase(async (executor) => {
      await approve(executor, "ada@example.com", APPROVED)
      await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })
      const mailer = recordingMailer([{ kind: "retryable", code: "timeout" }])

      expect(await sendDailyDigest(executor, { env, mailer, now: THURSDAY })).toBe("failed")
      expect(await digestActivity(executor)).toHaveLength(0)
      expect(await sendDailyDigest(executor, { env, mailer, now: THURSDAY_LATER })).toBe("sent")
      expect(mailer.calls).toHaveLength(2)
      expect(mailer.calls[1]?.idempotencyKey).toBe(mailer.calls[0]?.idempotencyKey)
      expect(mailer.calls[1]?.text).toBe(mailer.calls[0]?.text)
      expect(await digestActivity(executor)).toHaveLength(1)
    })
  }, 120_000)

  it("sends and claims nothing when there is nothing to report", async () => {
    await withMigratedDatabase(async (executor) => {
      // Approved more than 24 hours before the digest and never enrolled.
      await approve(executor, "old@example.com", new Date("2026-10-20T10:00:00.000Z"))
      const mailer = recordingMailer()
      expect(await sendDailyDigest(executor, { env, mailer, now: THURSDAY })).toBe(
        "nothing_to_report",
      )
      expect(mailer.calls).toHaveLength(0)
      expect(await digestActivity(executor)).toHaveLength(0)
    })
  }, 120_000)

  it("does nothing outside hour 7 on a Pacific weekday", async () => {
    await withMigratedDatabase(async (executor) => {
      await approve(executor, "ada@example.com", APPROVED)
      await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })
      const mailer = recordingMailer()
      for (const now of [
        new Date("2026-10-22T13:59:00.000Z"),
        new Date("2026-10-22T15:00:00.000Z"),
        // Saturday 07:10 PDT.
        new Date("2026-10-24T14:10:00.000Z"),
      ]) {
        expect(await sendDailyDigest(executor, { env, mailer, now })).toBe("outside_window")
      }
      expect(mailer.calls).toHaveLength(0)
      expect(await digestActivity(executor)).toHaveLength(0)
    })
  }, 120_000)

  it("lists only contacts approved since the previous digest", async () => {
    await withMigratedDatabase(async (executor) => {
      await approve(executor, "ada@example.com", APPROVED)
      await enrollApprovedContacts(executor, { startAt: START_AT, now: APPROVED })
      const mailer = recordingMailer()
      expect(await sendDailyDigest(executor, { env, mailer, now: THURSDAY })).toBe("sent")

      // Thursday 13:00 PDT, after Thursday's digest.
      await approve(executor, "grace@example.com", new Date("2026-10-22T20:00:00.000Z"))
      const data = await readDigestData(executor, { now: FRIDAY, since: THURSDAY })
      expect(data.date).toBe("2026-10-23")
      expect(data.newContacts.map((entry) => entry.email)).toEqual(["grace@example.com"])
      expect(data.inFlight.map((entry) => [entry.email, entry.nextStep])).toEqual([
        ["ada@example.com", 1],
      ])

      expect(await sendDailyDigest(executor, { env, mailer, now: FRIDAY })).toBe("sent")
      const friday = mailer.calls[1] as OutgoingEmail
      expect(friday.idempotencyKey).toBe("digest:2026-10-23")
      expect(friday.text).toContain("New contacts since the last digest: 1")
      expect(friday.text).toContain("- grace@example.com, approved")
      expect(friday.text).not.toContain("- ada@example.com, approved")
      expect(friday.text).toContain("- ada@example.com: step 1 due")
    })
  }, 120_000)
})
