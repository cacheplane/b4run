import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { initSchema } from "../src/index.js"

const enabled = process.env.B4_TEST_PGVECTOR === "1"
let container: StartedPostgreSqlContainer
let url: string

/**
 * `IF NOT EXISTS` is not concurrency-safe in Postgres. Two sessions running the
 * same one race on the catalog and the loser raises 23505 rather than a benign
 * no-op — on `pg_extension` for the extension, `pg_namespace` for the schema,
 * `pg_type` for a table and `pg_class` for an index.
 *
 * That matters here because a serverless deploy scales 0→N and every isolate
 * cold-starts `initSchema` at once against a database no one has initialized.
 * The in-process memoization in `pgvector-store.ts` covers one process only.
 *
 * This is the same defect `@b4run/postgres-storage` carried as issue #709.
 */
describe.skipIf(!enabled)("concurrent initSchema", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    url = container.getConnectionUri()
  }, 120_000)

  afterAll(async () => {
    await container?.stop()
  })

  test("initializes a virgin schema from several connections at once", async () => {
    const pool = new Pool({ connectionString: url })
    pool.on("error", () => {})
    const schema = `s_${Math.random().toString(36).slice(2, 10)}`
    const opts = { prefix: "m", schema, dimensions: 3, m: 16, efConstruction: 64 }

    try {
      // Six cold starts, as a scale-from-zero deploy produces.
      const attempts = Array.from({ length: 6 }, async () => {
        const client = await pool.connect()
        try {
          await initSchema(client, opts)
        } finally {
          client.release()
        }
      })

      await expect(Promise.all(attempts)).resolves.toBeDefined()

      // Every object exists exactly once, so the winner did not leave the
      // losers with a half-built schema.
      const tables = await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_tables WHERE schemaname = $1",
        [schema],
      )
      expect(Number(tables.rows[0]?.n)).toBe(2)
    } finally {
      await pool.end()
    }
  }, 120_000)
})
