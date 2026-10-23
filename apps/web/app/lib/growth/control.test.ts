import { describe, expect, it } from "vitest"
import { acceptFounderUpdatesForm, DISCLOSURE_VERSION, stopContact } from "./contacts"
import { runControl, runReport } from "./control"
import type { GrowthEnv } from "./env"
import { recordingExecutor } from "./fake-executor"
import { enrollApprovedContacts } from "./sequence"
import { GROWTH_DB_TESTS_ENABLED, withMigratedDatabase } from "./test-support/postgres"

const env: GrowthEnv = {
  databaseUrl: "postgres://unused",
  emailHmacSecret: "hmac-secret-value",
  tokenKeyring: { active: { id: 1, secret: "token-secret-value" }, previous: [] },
  environment: "test",
  publicOrigin: "https://b4.run",
}
const NOW = new Date("2026-10-21T10:00:00.000Z")
const LATER = new Date("2026-10-21T11:00:00.000Z")
const CONTACT_ID = "11111111-1111-4111-8111-111111111111"

function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        id: CONTACT_ID,
        email: "ada@example.com",
        approved_at: NOW,
        stopped_at: null,
        stop_reason: null,
        deleted_at: null,
        created_at: NOW,
        ...overrides,
      },
    ],
    rowCount: 1,
  }
}

describe("growth control and report (recorded SQL)", () => {
  it("answers no contact found when the lookup misses", async () => {
    for (const command of ["status", "approve", "stop", "delete"] as const) {
      const { executor, calls } = recordingExecutor()
      await expect(
        runControl(executor, env, { command, email: "nobody@example.com", now: NOW }),
      ).rejects.toThrow("no contact found for that address")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.text).toContain("from growth_contacts where email_hmac = $1")
      expect(calls[0]?.params[0]).not.toBe("nobody@example.com")
    }
    const { executor } = recordingExecutor()
    await expect(
      runReport(executor, env, { command: "journey", email: "nobody@example.com" }),
    ).rejects.toThrow("no contact found for that address")
  })

  it("rejects a stop reason outside the founder-allowed set", async () => {
    const { executor, calls } = recordingExecutor()
    await expect(
      runControl(executor, env, {
        command: "stop",
        email: "a@example.com",
        reason: "complaint",
        now: NOW,
      }),
    ).rejects.toThrow("--reason must be manual_suppression or reply_received")
    expect(calls).toHaveLength(0)
  })

  it("counts with parameterless select queries and prints totals", async () => {
    const { executor, calls } = recordingExecutor([
      {
        rows: [{ contacts: "5", approved: "3", deleted: "1" }],
        rowCount: 1,
      },
      {
        rows: [
          { stop_reason: "unsubscribe", total: "2" },
          { stop_reason: "deletion", total: "1" },
        ],
        rowCount: 2,
      },
    ])
    const output = await runReport(executor, env, { command: "counts" })
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.text.trimStart().startsWith("select")).toBe(true)
    expect(calls[0]?.text).toContain("approved_at is not null and deleted_at is null")
    expect(calls[1]?.text).toContain("group by stop_reason")
    expect(output).toContain("contacts: 5")
    expect(output).toContain("approved: 3")
    expect(output).toContain("deleted: 1")
    expect(output).toContain("stopped unsubscribe: 2")
    expect(output).toContain("stopped deletion: 1")
  })

  it("status prints the unsubscribe url and never a secret", async () => {
    const { executor } = recordingExecutor([
      {
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            email: "ada@example.com",
            approved_at: NOW,
            stopped_at: null,
            stop_reason: null,
            deleted_at: null,
            created_at: NOW,
          },
        ],
        rowCount: 1,
      },
    ])
    const output = await runControl(executor, env, {
      command: "status",
      email: "ada@example.com",
      now: NOW,
    })
    expect(output).toContain("https://b4.run/api/growth/unsubscribe?token=")
    expect(output).not.toContain(env.emailHmacSecret)
    expect(output).not.toContain(env.tokenKeyring.active.secret)
  })

  it("status prints a sequence line per step and not enrolled for missing steps", async () => {
    const { executor, calls } = recordingExecutor([
      contactRow(),
      {
        rows: [
          {
            step: 1,
            status: "completed",
            delivery_status: "delivered",
            due_at: new Date("2026-10-22T14:00:00.000Z"),
          },
          {
            step: 2,
            status: "pending",
            delivery_status: "not_submitted",
            due_at: new Date("2026-10-27T14:00:00.000Z"),
          },
        ],
        rowCount: 2,
      },
    ])
    const output = await runControl(executor, env, {
      command: "status",
      email: "ada@example.com",
      now: NOW,
    })
    expect(calls[1]?.text).toContain("from growth_sends where contact_id = $1")
    expect(calls[1]?.params).toEqual([CONTACT_ID])
    expect(output).toContain("step 1: completed delivered due 2026-10-22T14:00:00.000Z")
    expect(output).toContain("step 2: pending not_submitted due 2026-10-27T14:00:00.000Z")
    expect(output).toContain("step 3: not enrolled")
    expect(output).not.toContain("not re-enrolled")
  })

  it("status says when a contact was stopped by their reply", async () => {
    const { executor, calls } = recordingExecutor([
      contactRow({ approved_at: null, stopped_at: LATER, stop_reason: "reply_received" }),
      { rows: [{ provenance: "mailbox_reply" }], rowCount: 1 },
    ])
    const output = await runControl(executor, env, {
      command: "status",
      email: "ada@example.com",
      now: LATER,
    })
    expect(calls[1]?.text).toContain("kind like 'stop.%'")
    expect(calls[1]?.params).toEqual([CONTACT_ID])
    expect(output).toContain("state: stopped: reply_received")
    expect(output).toContain("stopped by: their reply to the sequence")

    const manual = recordingExecutor([
      contactRow({ approved_at: null, stopped_at: LATER, stop_reason: "manual_suppression" }),
      { rows: [{ provenance: "founder_cli" }], rowCount: 1 },
    ])
    expect(
      await runControl(manual.executor, env, {
        command: "status",
        email: "ada@example.com",
        now: LATER,
      }),
    ).toContain("stopped by: founder_cli")
  })

  it("status says a contact reapproved after enrollment is not re-enrolled", async () => {
    const { executor } = recordingExecutor([
      contactRow({ approved_at: LATER }),
      {
        rows: [
          {
            step: 1,
            status: "cancelled",
            delivery_status: "not_submitted",
            due_at: new Date("2026-10-22T14:00:00.000Z"),
          },
        ],
        rowCount: 1,
      },
      {
        rows: [
          { kind: "sequence.enrolled", at: NOW },
          { kind: "contact.reapproved", at: LATER },
        ],
        rowCount: 2,
      },
    ])
    const output = await runControl(executor, env, {
      command: "status",
      email: "ada@example.com",
      now: LATER,
    })
    expect(output).toContain("sequence: not re-enrolled (once per contact)")
  })

  it("approve refuses a contact stopped for a complaint or hard bounce without force", async () => {
    for (const reason of ["complaint", "hard_bounce"] as const) {
      const { executor, calls } = recordingExecutor([
        contactRow({ approved_at: null, stopped_at: NOW, stop_reason: reason }),
      ])
      await expect(
        runControl(executor, env, { command: "approve", email: "ada@example.com", now: LATER }),
      ).rejects.toThrow(
        `refusing to reapprove a contact stopped for ${reason}; pass --force to override`,
      )
      expect(calls).toHaveLength(1)
    }
    const { executor, calls } = recordingExecutor([
      contactRow({ approved_at: null, stopped_at: NOW, stop_reason: "complaint" }),
      { rows: [{ id: CONTACT_ID }], rowCount: 1 },
    ])
    expect(
      await runControl(executor, env, {
        command: "approve",
        email: "ada@example.com",
        force: true,
        now: LATER,
      }),
    ).toBe("approved")
    expect(calls[1]?.text).toContain("update growth_contacts set stopped_at = null")
  })

  it("approve reapproves other stop reasons without force", async () => {
    const { executor } = recordingExecutor([
      contactRow({ approved_at: null, stopped_at: NOW, stop_reason: "unsubscribe" }),
      { rows: [{ id: CONTACT_ID }], rowCount: 1 },
    ])
    expect(
      await runControl(executor, env, { command: "approve", email: "ada@example.com", now: LATER }),
    ).toBe("approved")
  })

  it("reports sends by step and status, by delivery status, and the last digest date", async () => {
    const { executor, calls } = recordingExecutor([
      {
        rows: [
          { step: 1, status: "completed", total: "4" },
          { step: 2, status: "pending", total: "1" },
        ],
        rowCount: 2,
      },
      {
        rows: [
          { delivery_status: "delivered", total: "3" },
          { delivery_status: "not_submitted", total: "2" },
        ],
        rowCount: 2,
      },
      { rows: [{ date: "2026-10-22" }], rowCount: 1 },
      { rows: [{ total: "1" }], rowCount: 1 },
      {
        rows: [
          { reply_status: "matched", total: "2" },
          { reply_status: "pending", total: "1" },
        ],
        rowCount: 2,
      },
    ])
    const output = await runReport(executor, env, { command: "sends" })
    expect(calls).toHaveLength(5)
    for (const call of calls) expect(call.text.trimStart().startsWith("select")).toBe(true)
    expect(calls[0]?.text).toContain("group by step, status")
    expect(calls[1]?.text).toContain("group by delivery_status")
    expect(calls[2]?.params).toEqual(["digest.sent"])
    expect(output).toContain("step 1 completed: 4")
    expect(output).toContain("step 2 pending: 1")
    expect(output).toContain("delivery delivered: 3")
    expect(output).toContain("delivery not_submitted: 2")
    expect(output).toContain("last digest: 2026-10-22")
    expect(calls[4]?.text).toContain("group by reply_status")
    expect(output).toContain("submitted without message id: 1")
    expect(output).toContain("inbound reply matched: 2")
    expect(output).toContain("inbound reply pending: 1")
    expect(output).not.toContain("@")
  })

  it("reports no digest when none has been sent", async () => {
    const { executor } = recordingExecutor()
    const output = await runReport(executor, env, { command: "sends" })
    expect(output).toContain("last digest: none")
  })
})

describe.skipIf(!GROWTH_DB_TESTS_ENABLED)("growth control and report (database)", () => {
  it("runs every command end to end", async () => {
    await withMigratedDatabase(async (executor) => {
      const email = "ada@example.com"
      await acceptFounderUpdatesForm(executor, env.emailHmacSecret, {
        email,
        message: "hello",
        disclosureVersion: DISCLOSURE_VERSION,
        submissionId: "sub-1",
        now: NOW,
      })

      const status = await runControl(executor, env, { command: "status", email, now: NOW })
      expect(status).toContain("approved")
      expect(status).toContain("/api/growth/unsubscribe?token=")

      expect(await runControl(executor, env, { command: "stop", email, now: LATER })).toContain(
        "stopped (manual_suppression)",
      )
      expect(await runControl(executor, env, { command: "status", email, now: LATER })).toContain(
        "stopped: manual_suppression",
      )
      expect(await runControl(executor, env, { command: "approve", email, now: LATER })).toContain(
        "approved",
      )

      const journey = await runReport(executor, env, { command: "journey", email })
      expect(journey).toContain("form.accepted")
      expect(journey).toContain("stop.manual_suppression")
      expect(journey).toContain("contact.reapproved")
      expect(journey).not.toContain(email)

      const counts = await runReport(executor, env, { command: "counts" })
      expect(counts).toContain("contacts: 1")
      expect(counts).toContain("approved: 1")

      const deleted = await runControl(executor, env, { command: "delete", email, now: LATER })
      expect(deleted).toContain("deleted")
      expect(deleted).toContain("redacted")

      const after = await runReport(executor, env, { command: "counts" })
      expect(after).toContain("contacts: 1")
      expect(after).toContain("approved: 0")
      expect(after).toContain("deleted: 1")
      expect(after).toContain("stopped deletion: 1")
    })
  }, 120_000)
  it("guards reapproval and reports sequence progress end to end", async () => {
    await withMigratedDatabase(async (executor) => {
      const email = "grace@example.com"
      const enrolledAt = new Date("2026-10-21T10:30:00.000Z")
      const { contactId } = await acceptFounderUpdatesForm(executor, env.emailHmacSecret, {
        email,
        disclosureVersion: DISCLOSURE_VERSION,
        submissionId: "sub-2",
        now: NOW,
      })
      expect(await runControl(executor, env, { command: "status", email, now: NOW })).toContain(
        "step 1: not enrolled",
      )

      await enrollApprovedContacts(executor, {
        startAt: new Date("2026-10-20T00:00:00.000Z"),
        now: enrolledAt,
      })
      const enrolled = await runControl(executor, env, { command: "status", email, now: LATER })
      expect(enrolled).toContain("step 1: pending not_submitted due 2026-10-22T14:00:00.000Z")
      expect(enrolled).toContain("step 2: not enrolled")
      expect(enrolled).not.toContain("not re-enrolled")

      await stopContact(executor, {
        contactId,
        reason: "complaint",
        provenance: "test",
        now: LATER,
      })
      const later = new Date("2026-10-21T12:00:00.000Z")
      await expect(
        runControl(executor, env, { command: "approve", email, now: later }),
      ).rejects.toThrow(
        "refusing to reapprove a contact stopped for complaint; pass --force to override",
      )
      expect(
        await runControl(executor, env, { command: "approve", email, force: true, now: later }),
      ).toBe("approved")

      const reapproved = await runControl(executor, env, { command: "status", email, now: later })
      expect(reapproved).toContain("state: approved")
      expect(reapproved).toContain("step 1: cancelled not_submitted")
      expect(reapproved).toContain("sequence: not re-enrolled (once per contact)")

      await executor.query(
        "insert into growth_activity (event_key, contact_id, kind, occurred_at, data) values ($1, null, $2, $3, $4::jsonb)",
        ["digest:2026-10-22", "digest.sent", later, JSON.stringify({ date: "2026-10-22" })],
      )
      const sends = await runReport(executor, env, { command: "sends" })
      expect(sends).toContain("step 1 cancelled: 1")
      expect(sends).toContain("delivery not_submitted: 1")
      expect(sends).toContain("last digest: 2026-10-22")
      expect(sends).not.toContain(email)
    })
  }, 120_000)
})
