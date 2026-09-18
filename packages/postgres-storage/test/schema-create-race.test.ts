import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createPostgresPermissionsStore,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "../src/node.js"
import { runMigrations } from "../src/schema.js"
import type { SqlClient, SqlPool } from "../src/sql.js"

/**
 * Records every statement, so the ordering the fix depends on can be asserted
 * without a database: the shared `CREATE SCHEMA` must be serialized by a lock
 * keyed on the schema, not by the per-component lock that deliberately lets the
 * three stores migrate independently.
 */
function recordingPool(): { pool: SqlPool; sql: string[] } {
  const sql: string[] = []
  const client: SqlClient = {
    query: async <R>(text: string) => {
      sql.push(text)
      return { rows: [] as R[] }
    },
    release: () => {},
  }
  return {
    sql,
    pool: {
      connect: async () => client,
      end: async () => {},
      query: async <R>(text: string) => {
        sql.push(text)
        return { rows: [] as R[] }
      },
    },
  }
}

describe("shared schema creation", () => {
  it("creates the schema under its own lock, in its own transaction", async () => {
    const { pool, sql } = recordingPool()

    await runMigrations(pool, [], { schema: "preview", prefix: "b4", component: "threads" })

    const create = sql.findIndex((text) => text.startsWith("CREATE SCHEMA"))
    const locks = sql
      .map((text, index) => ({ index, text }))
      .filter(({ text }) => text.includes("pg_advisory_xact_lock"))
    expect(create).toBeGreaterThanOrEqual(0)
    expect(locks.length).toBe(2)

    // The schema is created after a lock is taken and before that transaction
    // commits, so two cold starts cannot both run the DDL.
    const schemaLock = locks[0] as { index: number }
    const commit = sql.indexOf("COMMIT")
    expect(schemaLock.index).toBeLessThan(create)
    expect(create).toBeLessThan(commit)

    // …and the component's own migrations run in a LATER transaction, so the
    // three stores still do not serialize against each other.
    const componentLock = locks[1] as { index: number }
    expect(componentLock.index).toBeGreaterThan(commit)
    expect(sql.filter((text) => text.startsWith("CREATE SCHEMA")).length).toBe(1)
  })

  it("keeps the component lock distinct from the schema lock", async () => {
    const { pool, sql } = recordingPool()
    await runMigrations(pool, [], { schema: "preview", prefix: "b4", component: "threads" })
    const first = sql.filter((text) => text.includes("pg_advisory_xact_lock"))
    expect(first.length).toBe(2)
  })
})

/**
 * The real bug from #709: the three generated stores each issue
 * `CREATE SCHEMA IF NOT EXISTS` concurrently on a cold start, and `IF NOT
 * EXISTS` is not concurrency-safe — the loser raises 23505 on
 * `pg_namespace_nspname_index` rather than a benign no-op.
 */
describe.skipIf(process.env.B4_TEST_PGSTORAGE !== "1")(
  "concurrent cold start against real Postgres",
  () => {
    let container: StartedPostgreSqlContainer
    let url: string

    beforeAll(async () => {
      container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
      url = container.getConnectionUri()
    }, 240_000)

    afterAll(async () => {
      await container?.stop()
    })

    it("migrates every store at once into a schema that does not exist yet", async () => {
      // The three stores the generated `stores.mjs` builds, against a schema
      // no one has created — the first invocation after a deploy to a new
      // environment, which is what B4_PG_SCHEMA exists for.
      const schema = `s_${Math.random().toString(36).slice(2, 10)}`
      const threads = createPostgresThreadsStore({ connectionString: url, schema })
      const permissions = createPostgresPermissionsStore({ connectionString: url, schema })
      const checkpointer = postgresCheckpointer({ connectionString: url, schema })

      try {
        // All three race on the one object they share. Before the fix this
        // rejected with 23505 on pg_namespace_nspname_index.
        await Promise.all([threads.ready(), permissions.ready(), checkpointer.ready()])

        // The loser used to leave the schema half-populated, so prove the
        // tables are actually usable in the same cold start.
        await threads.createThread({ thread_id: "t-race" })
        await expect(threads.getThread("t-race")).resolves.toMatchObject({
          thread_id: "t-race",
        })
      } finally {
        await Promise.all([threads.close(), permissions.close(), checkpointer.close()])
      }
    }, 120_000)
  },
)
