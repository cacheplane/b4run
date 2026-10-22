import { describe, expect, it } from "vitest"
import { acceptFounderUpdatesForm, DISCLOSURE_VERSION } from "./contacts"
import { runControl, runReport } from "./control"
import type { GrowthEnv } from "./env"
import { recordingExecutor } from "./fake-executor"
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
})
