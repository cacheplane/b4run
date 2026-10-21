import { describe, expect, it } from "vitest"
import {
  acceptFounderUpdatesForm,
  contactJourney,
  DISCLOSURE_VERSION,
  deleteContact,
  findContactByEmail,
  reapproveContact,
  stopContact,
} from "./contacts"
import type { SqlExecutor } from "./database"
import { GROWTH_DB_TESTS_ENABLED, withMigratedDatabase } from "./test-support/postgres"

const SECRET = "test-secret"
const T0 = new Date("2026-10-21T10:00:00.000Z")
const T1 = new Date("2026-10-21T11:00:00.000Z")
const T2 = new Date("2026-10-21T12:00:00.000Z")
const T3 = new Date("2026-10-21T13:00:00.000Z")

let counter = 0
function form(
  executor: SqlExecutor,
  email: string,
  extra: { message?: string; posthogDistinctId?: string; now?: Date } = {},
) {
  counter += 1
  return acceptFounderUpdatesForm(executor, SECRET, {
    email,
    disclosureVersion: DISCLOSURE_VERSION,
    submissionId: `sub-${counter}`,
    now: extra.now ?? T0,
    ...(extra.message !== undefined ? { message: extra.message } : {}),
    ...(extra.posthogDistinctId !== undefined
      ? { posthogDistinctId: extra.posthogDistinctId }
      : {}),
  })
}

async function kinds(executor: SqlExecutor, contactId: string) {
  return (await contactJourney(executor, contactId)).map((entry) => entry.kind)
}

describe.skipIf(!GROWTH_DB_TESTS_ENABLED)("growth contacts", () => {
  it("creates and approves a new contact and records both activities", async () => {
    await withMigratedDatabase(async (executor) => {
      const result = await form(executor, "ada@example.com", {
        message: "hi",
        posthogDistinctId: "ph-1",
      })
      expect(result).toMatchObject({
        approved: true,
        emailKind: "work",
        created: true,
      })
      const journey = await contactJourney(executor, result.contactId)
      expect(journey.map((entry) => entry.kind)).toEqual(["form.accepted", "contact.approved"])
      expect(journey[0]?.data).toEqual({
        form: "founder_updates",
        message: "hi",
        disclosure_version: DISCLOSURE_VERSION,
        email_kind: "work",
      })
      const row = await executor.query<{
        posthog_distinct_id: string
        approved_at: Date
      }>("select posthog_distinct_id, approved_at from growth_contacts where id = $1", [
        result.contactId,
      ])
      expect(row.rows[0]?.posthog_distinct_id).toBe("ph-1")
      expect(row.rows[0]?.approved_at.toISOString()).toBe(T0.toISOString())
    })
  }, 120_000)

  it("accepts the same email twice as one contact with two form.accepted activities", async () => {
    await withMigratedDatabase(async (executor) => {
      const first = await form(executor, "ada@example.com")
      const second = await form(executor, "ada@example.com", { now: T1 })
      expect(second.contactId).toBe(first.contactId)
      expect(second.created).toBe(false)
      expect(second.approved).toBe(true)
      const journey = await kinds(executor, first.contactId)
      expect(journey.filter((kind) => kind === "form.accepted")).toHaveLength(2)
      expect(journey.filter((kind) => kind === "contact.approved")).toHaveLength(1)
      const count = await executor.query("select 1 from growth_contacts")
      expect(count.rowCount).toBe(1)
    })
  }, 120_000)

  it("treats differently-cased and padded spellings as one contact", async () => {
    await withMigratedDatabase(async (executor) => {
      const first = await form(executor, "Ada@Example.com")
      const second = await form(executor, "  ada@EXAMPLE.com  ")
      expect(second.contactId).toBe(first.contactId)
      const found = await findContactByEmail(executor, SECRET, " ADA@example.com")
      expect(found?.id).toBe(first.contactId)
      expect(found?.email).toBe("ada@example.com")
    })
  }, 120_000)

  it("never re-approves a stopped contact on a later form", async () => {
    await withMigratedDatabase(async (executor) => {
      const first = await form(executor, "ada@example.com", {
        posthogDistinctId: "ph-1",
      })
      await stopContact(executor, {
        contactId: first.contactId,
        reason: "unsubscribe",
        provenance: "link",
        now: T1,
      })
      const later = await form(executor, "ada@example.com", {
        message: "secret message",
        posthogDistinctId: "ph-2",
        now: T2,
      })
      expect(later.approved).toBe(false)
      const found = await findContactByEmail(executor, SECRET, "ada@example.com")
      expect(found?.approvedAt).toBeNull()
      expect(found?.stoppedAt?.toISOString()).toBe(T1.toISOString())
      const journey = await contactJourney(executor, first.contactId)
      const lastForm = journey.filter((entry) => entry.kind === "form.accepted").at(-1)
      expect(lastForm?.data).toEqual({
        form: "founder_updates",
        disclosure_version: DISCLOSURE_VERSION,
        email_kind: "work",
      })
      const row = await executor.query<{ posthog_distinct_id: string }>(
        "select posthog_distinct_id from growth_contacts where id = $1",
        [first.contactId],
      )
      expect(row.rows[0]?.posthog_distinct_id).toBe("ph-1")
    })
  }, 120_000)

  it("stop is idempotent and cancels pending sends", async () => {
    await withMigratedDatabase(async (executor) => {
      const { contactId } = await form(executor, "ada@example.com")
      await executor.query(
        "insert into growth_sends (contact_id, step, idempotency_key, status, due_at) values ($1, 1, 'k1', 'pending', now()), ($1, 2, 'k2', 'leased', now()), ($1, 3, 'k3', 'completed', now())",
        [contactId],
      )
      const first = await stopContact(executor, {
        contactId,
        reason: "unsubscribe",
        provenance: "link",
        now: T1,
      })
      const second = await stopContact(executor, {
        contactId,
        reason: "complaint",
        provenance: "webhook",
        now: T2,
      })
      expect(first.applied).toBe(true)
      expect(second.applied).toBe(false)
      const stops = (await kinds(executor, contactId)).filter((kind) => kind.startsWith("stop."))
      expect(stops).toEqual(["stop.unsubscribe"])
      const sends = await executor.query<{
        idempotency_key: string
        status: string
      }>("select idempotency_key, status from growth_sends order by idempotency_key")
      expect(sends.rows.map((row) => row.status)).toEqual(["cancelled", "cancelled", "completed"])
      const found = await findContactByEmail(executor, SECRET, "ada@example.com")
      expect(found?.stopReason).toBe("unsubscribe")
      expect(found?.approvedAt).toBeNull()
    })
  }, 120_000)

  it("reapprove clears the stop and records provenance", async () => {
    await withMigratedDatabase(async (executor) => {
      const { contactId } = await form(executor, "ada@example.com")
      await stopContact(executor, {
        contactId,
        reason: "unsubscribe",
        provenance: "link",
        now: T1,
      })
      const result = await reapproveContact(executor, {
        contactId,
        provenance: "founder: asked to resubscribe",
        now: T2,
      })
      expect(result.applied).toBe(true)
      const found = await findContactByEmail(executor, SECRET, "ada@example.com")
      expect(found?.stoppedAt).toBeNull()
      expect(found?.stopReason).toBeNull()
      expect(found?.approvedAt?.toISOString()).toBe(T2.toISOString())
      const journey = await contactJourney(executor, contactId)
      const entry = journey.find((item) => item.kind === "contact.reapproved")
      expect(entry?.data).toMatchObject({
        provenance: "founder: asked to resubscribe",
      })
    })
  }, 120_000)

  it("delete keeps only the hmac and the stop", async () => {
    await withMigratedDatabase(async (executor) => {
      const { contactId } = await form(executor, "ada@example.com", {
        message: "hello",
        posthogDistinctId: "ph-1",
      })
      await executor.query("update growth_contacts set display_name = 'Ada' where id = $1", [
        contactId,
      ])
      await executor.query(
        "insert into growth_sends (contact_id, step, idempotency_key, status, due_at) values ($1, 1, 'k1', 'pending', now())",
        [contactId],
      )
      const result = await deleteContact(executor, { contactId, now: T1 })
      expect(result.applied).toBe(true)
      expect((await deleteContact(executor, { contactId, now: T2 })).applied).toBe(false)
      const row = await executor.query<Record<string, unknown>>(
        "select email, display_name, posthog_distinct_id, approved_at, stopped_at, stop_reason, deleted_at from growth_contacts where id = $1",
        [contactId],
      )
      expect(row.rows[0]).toMatchObject({
        email: null,
        display_name: null,
        posthog_distinct_id: null,
        approved_at: null,
        stop_reason: "deletion",
      })
      expect(row.rows[0]?.deleted_at).toBeInstanceOf(Date)
      expect(row.rows[0]?.stopped_at).toBeInstanceOf(Date)
      const journey = await contactJourney(executor, contactId)
      expect(journey.filter((entry) => entry.kind === "form.accepted").map((e) => e.data)).toEqual([
        {},
      ])
      expect(journey.map((entry) => entry.kind)).toContain("contact.deleted")
      const send = await executor.query<{ status: string }>("select status from growth_sends")
      expect(send.rows[0]?.status).toBe("cancelled")
      const found = await findContactByEmail(executor, SECRET, "ada@example.com")
      expect(found?.id).toBe(contactId)
      expect(found?.email).toBeNull()
      expect(found?.deletedAt).toBeInstanceOf(Date)
    })
  }, 120_000)

  it("delete on an already-stopped contact keeps the original stop reason", async () => {
    await withMigratedDatabase(async (executor) => {
      const { contactId } = await form(executor, "ada@example.com")
      await stopContact(executor, {
        contactId,
        reason: "complaint",
        provenance: "webhook",
        now: T1,
      })
      await deleteContact(executor, { contactId, now: T2 })
      const found = await findContactByEmail(executor, SECRET, "ada@example.com")
      expect(found?.stopReason).toBe("complaint")
      expect(found?.stoppedAt?.toISOString()).toBe(T1.toISOString())
      expect(found?.deletedAt?.toISOString()).toBe(T2.toISOString())
    })
  }, 120_000)

  it("a later form for a deleted contact stores no message and no distinct id", async () => {
    await withMigratedDatabase(async (executor) => {
      const { contactId } = await form(executor, "ada@example.com", {
        message: "x",
      })
      await deleteContact(executor, { contactId, now: T1 })
      const later = await form(executor, "ada@example.com", {
        message: "I am back",
        posthogDistinctId: "ph-9",
        now: T2,
      })
      expect(later.contactId).toBe(contactId)
      expect(later.approved).toBe(false)
      const row = await executor.query<{
        email: string | null
        posthog_distinct_id: string | null
      }>("select email, posthog_distinct_id from growth_contacts where id = $1", [contactId])
      expect(row.rows[0]).toEqual({ email: null, posthog_distinct_id: null })
      const journey = await contactJourney(executor, contactId)
      const forms = journey.filter((entry) => entry.kind === "form.accepted")
      expect(forms.at(-1)?.data).not.toHaveProperty("message")
      expect(JSON.stringify(journey)).not.toContain("I am back")
      expect(
        (
          await reapproveContact(executor, {
            contactId,
            provenance: "x",
            now: T3,
          })
        ).applied,
      ).toBe(false)
    })
  }, 120_000)

  it("stop after reapproval records a second stop activity", async () => {
    await withMigratedDatabase(async (executor) => {
      const { contactId } = await form(executor, "ada@example.com")
      await stopContact(executor, {
        contactId,
        reason: "unsubscribe",
        provenance: "a",
        now: T1,
      })
      await reapproveContact(executor, { contactId, provenance: "b", now: T2 })
      const again = await stopContact(executor, {
        contactId,
        reason: "unsubscribe",
        provenance: "c",
        now: T3,
      })
      expect(again.applied).toBe(true)
      const stops = (await kinds(executor, contactId)).filter((kind) => kind === "stop.unsubscribe")
      expect(stops).toHaveLength(2)
    })
  }, 120_000)
})
