import { describe, expect, it } from "vitest"
import type { SqlExecutor } from "./database"
import {
  admitInboundReceipt,
  type ForwardDeps,
  forwardInboundReceipt,
  type InboundRuntime,
  type ReceivedEmail,
  type ReceivedReference,
  recoverInbound,
} from "./inbound"
import type { Mailer, OutgoingEmail } from "./mailer"
import { GROWTH_DB_TESTS_ENABLED, withMigratedDatabase } from "./test-support/postgres"

const ID = "56761188-7520-42d8-8898-ff6fc54ce618"
const T0 = new Date("2026-10-22T10:00:00.000Z")
const RAW = new TextEncoder().encode("From: ada@example.com\r\nSubject: Secret subject\r\n\r\nHi")

const received = (id: string): ReceivedEmail => ({
  id,
  to: ["Brian <brian@b4.run>"],
  from: "Ada <ada@example.com>",
  subject: "Secret subject",
  text: "Secret body",
  raw: { download_url: "https://example.resend.com/raw/1" },
})

const receipt = async (executor: SqlExecutor, id = ID) =>
  (
    await executor.query<{
      status: string
      attempts: number
      first_attempted_at: Date | null
      forward_provider_id: string | null
      last_error_code: string | null
    }>(
      "select status, attempts, first_attempted_at, forward_provider_id, last_error_code from growth_inbound_receipts where id = $1",
      [id],
    )
  ).rows[0]

function deps(mailer: Mailer, now: () => Date = () => T0): ForwardDeps {
  return {
    environment: "test",
    getReceived: async (id) => received(id),
    downloadRaw: async () => RAW,
    mailer,
    now,
  }
}

function countingMailer(onSend?: (email: OutgoingEmail) => Promise<void>) {
  const sent: OutgoingEmail[] = []
  const mailer: Mailer = {
    async send(email) {
      sent.push(email)
      await onSend?.(email)
      return { kind: "accepted", providerEmailId: `em_fwd_${sent.length}` }
    },
  }
  return { mailer, sent }
}

describe.skipIf(!GROWTH_DB_TESTS_ENABLED)("growth inbound forwarding", () => {
  it("admits a receipt once however often it is replayed", async () => {
    await withMigratedDatabase(async (executor) => {
      expect(await admitInboundReceipt(executor, { id: ID, receivedAt: T0 })).toBe(true)
      expect(await admitInboundReceipt(executor, { id: ID, receivedAt: T0 })).toBe(false)
      const count = await executor.query<{ n: string }>(
        "select count(*)::text as n from growth_inbound_receipts",
      )
      expect(count.rows[0]?.n).toBe("1")
      expect(await receipt(executor)).toMatchObject({ status: "pending", attempts: 0 })
    })
  }, 120_000)

  it("forwards once when the webhook and recovery race on one receipt", async () => {
    await withMigratedDatabase(async (executor) => {
      await admitInboundReceipt(executor, { id: ID, receivedAt: T0 })
      const { mailer, sent } = countingMailer(
        // Hold the row lock long enough for the other call to queue behind it.
        () => new Promise((resolve) => setTimeout(resolve, 200)),
      )
      // Both calls finish their provider reads before either reserves or locks the receipt.
      let arrived = 0
      let release: () => void = () => undefined
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const racing: ForwardDeps = {
        ...deps(mailer),
        async downloadRaw() {
          arrived += 1
          if (arrived === 2) release()
          await barrier
          return RAW
        },
      }
      const results = await Promise.all([
        forwardInboundReceipt(executor, ID, racing),
        forwardInboundReceipt(executor, ID, racing),
      ])
      expect(sent).toHaveLength(1)
      expect(results.map((result) => result.outcome).sort()).toEqual([
        "already_forwarded",
        "forwarded",
      ])
      expect(await receipt(executor)).toMatchObject({
        status: "forwarded",
        attempts: 1,
        forward_provider_id: "em_fwd_1",
        last_error_code: null,
      })
      // A later replay changes nothing.
      expect(await forwardInboundReceipt(executor, ID, deps(mailer))).toEqual({
        outcome: "already_forwarded",
      })
      expect(sent).toHaveLength(1)
    })
  }, 120_000)

  it("persists the first-attempt time before the send and keeps it on retry", async () => {
    await withMigratedDatabase(async (executor) => {
      await admitInboundReceipt(executor, { id: ID, receivedAt: T0 })
      const seen: (Date | null | undefined)[] = []
      const failing: Mailer = {
        async send() {
          // Read on a separate pool connection: only committed data is visible.
          seen.push((await receipt(executor))?.first_attempted_at)
          return { kind: "retryable", code: "timeout" }
        },
      }
      expect(await forwardInboundReceipt(executor, ID, deps(failing))).toEqual({
        outcome: "retry",
        code: "timeout",
      })
      expect(seen).toEqual([T0])
      const later = new Date(T0.getTime() + 600_000)
      await forwardInboundReceipt(
        executor,
        ID,
        deps(failing, () => later),
      )
      expect(await receipt(executor)).toMatchObject({
        status: "pending",
        attempts: 2,
        first_attempted_at: T0,
        last_error_code: "timeout",
      })
    })
  }, 120_000)

  it("fails without sending once the first attempt is 23 hours old", async () => {
    await withMigratedDatabase(async (executor) => {
      await admitInboundReceipt(executor, { id: ID, receivedAt: T0 })
      await executor.query(
        "update growth_inbound_receipts set first_attempted_at = $2, attempts = 1 where id = $1",
        [ID, T0],
      )
      const { mailer, sent } = countingMailer()
      const result = await forwardInboundReceipt(
        executor,
        ID,
        deps(mailer, () => new Date(T0.getTime() + 23 * 3600 * 1000)),
      )
      expect(result).toEqual({ outcome: "failed", code: "idempotency_window_expired" })
      expect(sent).toHaveLength(0)
      expect(await receipt(executor)).toMatchObject({
        status: "failed",
        forward_provider_id: null,
        last_error_code: "idempotency_window_expired",
      })
    })
  }, 120_000)

  it("recovers a message the webhook missed and forwards it, ignoring other recipients", async () => {
    await withMigratedDatabase(async (executor) => {
      const now = new Date("2026-10-22T12:00:00.000Z")
      const listing: ReceivedReference[] = [
        { id: "missed", receivedAt: new Date("2026-10-22T11:00:00.000Z"), admitted: true },
        { id: "hello", receivedAt: new Date("2026-10-22T10:00:00.000Z"), admitted: false },
        { id: "stale", receivedAt: new Date("2026-10-18T10:00:00.000Z"), admitted: true },
      ]
      const { mailer, sent } = countingMailer()
      const runtime: InboundRuntime = {
        ...deps(mailer, () => now),
        async *listReceived() {
          yield* listing
        },
      }
      const report = await recoverInbound(executor, { ...runtime, canContinue: () => true })
      expect(report).toEqual({ admitted: 1, forwarded: 1, failed: 0, retrying: 0 })
      expect(sent.map((email) => email.headers["X-B4-Forwarded"])).toEqual(["missed"])
      const ids = await executor.query<{ id: string }>(
        "select id from growth_inbound_receipts order by id",
      )
      expect(ids.rows.map((row) => row.id)).toEqual(["missed"])
      expect(await receipt(executor, "missed")).toMatchObject({ status: "forwarded" })

      // A second pass finds nothing new and sends nothing.
      expect(await recoverInbound(executor, { ...runtime, canContinue: () => true })).toEqual({
        admitted: 0,
        forwarded: 0,
        failed: 0,
        retrying: 0,
      })
      expect(sent).toHaveLength(1)
    })
  }, 120_000)

  it("stores no address, subject or body", async () => {
    await withMigratedDatabase(async (executor) => {
      await admitInboundReceipt(executor, { id: ID, receivedAt: T0 })
      const { mailer } = countingMailer()
      await forwardInboundReceipt(executor, ID, deps(mailer))
      const columns = await executor.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name = 'growth_inbound_receipts' order by ordinal_position",
      )
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        "id",
        "received_at",
        "status",
        "attempts",
        "first_attempted_at",
        "forward_provider_id",
        "last_error_code",
        "created_at",
        "updated_at",
      ])
      const rows = await executor.query("select * from growth_inbound_receipts")
      const dump = JSON.stringify(rows.rows)
      expect(dump).not.toMatch(/@|Secret|cacheplane|b4\.run/)
    })
  }, 120_000)
})
