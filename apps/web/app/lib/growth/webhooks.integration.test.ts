import { describe, expect, it } from "vitest"
import { acceptFounderUpdatesForm, contactJourney, DISCLOSURE_VERSION } from "./contacts"
import type { SqlExecutor } from "./database"
import type { GrowthEnv } from "./env"
import { GROWTH_DB_TESTS_ENABLED, withMigratedDatabase } from "./test-support/postgres"
import { type ParsedResendEvent, processResendEvent } from "./webhooks"

const SECRET = "test-secret"
const T0 = new Date("2026-10-21T10:00:00.000Z")
const T1 = new Date("2026-10-21T11:00:00.000Z")

async function contact(executor: SqlExecutor, email = "ada@example.com") {
  const result = await acceptFounderUpdatesForm(executor, SECRET, {
    email,
    disclosureVersion: DISCLOSURE_VERSION,
    submissionId: `sub-${email}`,
    now: T0,
  })
  return result.contactId
}

async function send(executor: SqlExecutor, contactId: string, providerEmailId: string) {
  await executor.query(
    "insert into growth_sends (contact_id, step, idempotency_key, status, due_at, provider_email_id, delivery_status) values ($1, 1, $2, 'submitted', $3, $4, 'submitted')",
    [contactId, `key-${providerEmailId}`, T0, providerEmailId],
  )
}

const deliveryStatus = async (executor: SqlExecutor, providerEmailId: string) =>
  (
    await executor.query<{ delivery_status: string }>(
      "select delivery_status from growth_sends where provider_email_id = $1",
      [providerEmailId],
    )
  ).rows[0]?.delivery_status

function event(overrides: Partial<ParsedResendEvent> = {}): ParsedResendEvent {
  return {
    type: "email.bounced",
    occurredAt: T1,
    providerEmailId: "em_1",
    to: ["ada@example.com"],
    tags: { environment: "production" },
    bounceType: "permanent",
    ...overrides,
  }
}

const run = (
  executor: SqlExecutor,
  e: ParsedResendEvent,
  environment: GrowthEnv["environment"] = "production",
) =>
  processResendEvent(executor, {
    event: e,
    environment,
    emailHmacSecret: SECRET,
    now: T1,
  })

describe.skipIf(!GROWTH_DB_TESTS_ENABLED)("growth resend webhook", () => {
  it("stops a contact on a permanent bounce and is idempotent on replay", async () => {
    await withMigratedDatabase(async (executor) => {
      const id = await contact(executor)
      await send(executor, id, "em_1")
      expect(await run(executor, event())).toBe("stopped")
      expect(await run(executor, event())).toBe("already_stopped")
      const kinds = (await contactJourney(executor, id)).map((entry) => entry.kind)
      expect(kinds.filter((kind) => kind === "stop.hard_bounce")).toHaveLength(1)
      expect(await deliveryStatus(executor, "em_1")).toBe("bounced")
    })
  }, 120_000)

  it("ignores an event tagged for the other environment", async () => {
    await withMigratedDatabase(async (executor) => {
      const id = await contact(executor)
      await send(executor, id, "em_1")
      const outcome = await run(executor, event({ tags: { environment: "preview" } }))
      expect(outcome).toBe("ignored_environment")
      expect(await deliveryStatus(executor, "em_1")).toBe("submitted")
      const kinds = (await contactJourney(executor, id)).map((entry) => entry.kind)
      expect(kinds).not.toContain("stop.hard_bounce")
    })
  }, 120_000)

  it("processes an untagged event only in production", async () => {
    await withMigratedDatabase(async (executor) => {
      const id = await contact(executor)
      await send(executor, id, "em_1")
      expect(await run(executor, event({ tags: {} }), "preview")).toBe("ignored_environment")
      expect(await run(executor, event({ tags: {} }))).toBe("stopped")
    })
  }, 120_000)

  it("upgrades delivery_status and never downgrades it", async () => {
    await withMigratedDatabase(async (executor) => {
      const id = await contact(executor)
      await send(executor, id, "em_1")
      const step = (type: ParsedResendEvent["type"], extra: Partial<ParsedResendEvent> = {}) =>
        run(executor, event({ type, ...extra }))
      expect(await step("email.delivered")).toBe("updated_delivery")
      expect(await deliveryStatus(executor, "em_1")).toBe("delivered")
      await step("email.bounced", { bounceType: "transient" })
      expect(await deliveryStatus(executor, "em_1")).toBe("delivered")
      await step("email.bounced", { bounceType: "unknown" })
      expect(await deliveryStatus(executor, "em_1")).toBe("delivered")
      await step("email.bounced", { bounceType: "permanent" })
      expect(await deliveryStatus(executor, "em_1")).toBe("bounced")
      await step("email.delivered")
      await step("email.sent")
      await step("email.failed")
      expect(await deliveryStatus(executor, "em_1")).toBe("bounced")
      await step("email.complained")
      expect(await deliveryStatus(executor, "em_1")).toBe("complained")
      await step("email.suppressed")
      expect(await deliveryStatus(executor, "em_1")).toBe("complained")
    })
  }, 120_000)

  it("treats a transient bounce as a delivery update only", async () => {
    await withMigratedDatabase(async (executor) => {
      const id = await contact(executor)
      await send(executor, id, "em_1")
      expect(await run(executor, event({ bounceType: "transient" }))).toBe("updated_delivery")
      expect(await deliveryStatus(executor, "em_1")).toBe("submitted")
      const kinds = (await contactJourney(executor, id)).map((entry) => entry.kind)
      expect(kinds.some((kind) => kind.startsWith("stop."))).toBe(false)
    })
  }, 120_000)

  it("resolves the contact by recipient address when no send matches", async () => {
    await withMigratedDatabase(async (executor) => {
      const id = await contact(executor)
      expect(
        await run(executor, event({ type: "email.complained", providerEmailId: "em_x" })),
      ).toBe("stopped")
      const kinds = (await contactJourney(executor, id)).map((entry) => entry.kind)
      expect(kinds).toContain("stop.complaint")
      expect(
        await run(executor, event({ providerEmailId: "em_y", to: ["nobody@example.com"] })),
      ).toBe("no_contact")
    })
  }, 120_000)

  it("never stops a contact on a digest bounce, complaint or suppression, even when the recipient matches", async () => {
    await withMigratedDatabase(async (executor) => {
      const id = await contact(executor, "founder@example.com")
      for (const type of ["email.bounced", "email.complained", "email.suppressed"] as const) {
        expect(
          await run(
            executor,
            event({
              type,
              providerEmailId: `em_digest_${type}`,
              to: ["founder@example.com"],
              tags: { environment: "production", kind: "digest" },
            }),
          ),
        ).toBe("ignored_type")
      }
      const kinds = (await contactJourney(executor, id)).map((entry) => entry.kind)
      expect(kinds.some((kind) => kind.startsWith("stop."))).toBe(false)
      const stopped = await executor.query<{ stopped_at: Date | null }>(
        "select stopped_at from growth_contacts where id = $1",
        [id],
      )
      expect(stopped.rows[0]?.stopped_at).toBeNull()
    })
  }, 120_000)
})
