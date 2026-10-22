import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { applyMigrations } from "./migrations"
import { GROWTH_DB_TESTS_ENABLED, withMigratedDatabase } from "./test-support/postgres"

describe.skipIf(!GROWTH_DB_TESTS_ENABLED)("growth schema", () => {
  it("creates exactly the three growth tables, the ledger, and the citext extension", async () => {
    await withMigratedDatabase(async (executor) => {
      const tables = await executor.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' and table_name like 'growth_%' order by table_name",
      )
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "growth_activity",
        "growth_contacts",
        "growth_schema_migrations",
        "growth_sends",
      ])
      const extensions = await executor.query<{ extname: string }>(
        "select extname from pg_extension where extname in ('citext', 'pgcrypto') order by extname",
      )
      expect(extensions.rows.map((row) => row.extname)).toEqual(["citext", "pgcrypto"])

      const again = await applyMigrations({
        directory: fileURLToPath(new URL("./migrations", import.meta.url)),
        executor,
      })
      expect(again.applied).toEqual([])

      const columns = await executor.query<{ data_type: string }>(
        "select data_type from information_schema.columns where table_name = 'growth_sends' and column_name = 'first_attempted_at'",
      )
      expect(columns.rows.map((row) => row.data_type)).toEqual(["timestamp with time zone"])
    })
  }, 120_000)

  it("enforces the status and delivery_status checks on growth_sends", async () => {
    await withMigratedDatabase(async (executor) => {
      const contact = await executor.query<{ id: string }>(
        "insert into growth_contacts (email, email_hmac, source, disclosure_version) values ('a@example.com', 'h1', 'test', 'v1') returning id",
      )
      const contactId = contact.rows[0]?.id
      const insert = (status: string, delivery: string, key: string) =>
        executor.query(
          "insert into growth_sends (contact_id, step, idempotency_key, status, due_at, delivery_status) values ($1, 1, $2, $3, now(), $4)",
          [contactId, key, status, delivery],
        )
      await expect(insert("bogus", "not_submitted", "k1")).rejects.toThrow()
      await expect(insert("pending", "bogus", "k2")).rejects.toThrow()
      await expect(insert("pending", "not_submitted", "k3")).resolves.toBeDefined()
    })
  }, 120_000)
})
