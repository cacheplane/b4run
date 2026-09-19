import { ConflictError } from "@b4run/sdk"
import { runDocumentStoreConformance } from "@b4run/testing"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createPostgresDocumentStore, type PostgresDocumentStore } from "../src/node.js"

const enabled = process.env.B4_TEST_PGSTORAGE === "1"
let container: StartedPostgreSqlContainer
let url: string

/** Fresh, never-migrated table set per store — no truncation, no teardown. */
const freshPrefix = () => `t_${Math.random().toString(36).slice(2)}`

describe.skipIf(!enabled)("postgres document store against real Postgres", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
    url = container.getConnectionUri()
  }, 240_000)

  afterAll(async () => {
    await container?.stop()
  })

  // The same suite the in-process store answers in `@b4run/testing`. If these
  // two ever disagree, one of them is wrong — which is the entire reason the
  // memory implementation is not allowed to be a mock.
  runDocumentStoreConformance({
    name: "createPostgresDocumentStore",
    makeStore: () =>
      createPostgresDocumentStore({
        connectionString: url,
        name: "conformance",
        tablePrefix: freshPrefix(),
      }),
    describe,
    close: (store) => (store as PostgresDocumentStore<unknown>).close(),
  })

  test("two stores with different names in one table do not see each other", async () => {
    const prefix = freshPrefix()
    const a = createPostgresDocumentStore<{ n: number }>({
      connectionString: url,
      name: "sessions",
      tablePrefix: prefix,
    })
    const b = createPostgresDocumentStore<{ n: number }>({
      connectionString: url,
      name: "threads",
      tablePrefix: prefix,
    })
    try {
      await a.commit("shared-key", null, { n: 1 })
      // Same key, different collection: an insert, not a conflict. This is what
      // the composite primary key buys, and why an app may name a store
      // `threads` without colliding with B4.run's own `<prefix>_threads`.
      await b.commit("shared-key", null, { n: 2 })
      expect((await a.load("shared-key"))?.value).toEqual({ n: 1 })
      expect((await b.load("shared-key"))?.value).toEqual({ n: 2 })
    } finally {
      await a.close()
      await b.close()
    }
  })

  test("a second process reattaches to the same collection", async () => {
    const prefix = freshPrefix()
    const first = createPostgresDocumentStore<{ n: number }>({
      connectionString: url,
      name: "sessions",
      tablePrefix: prefix,
    })
    const key = await first.create({ n: 1 })
    await first.close()

    const second = createPostgresDocumentStore<{ n: number }>({
      connectionString: url,
      name: "sessions",
      tablePrefix: prefix,
    })
    try {
      expect(await second.load(key)).toEqual({ version: 0, value: { n: 1 } })
    } finally {
      await second.close()
    }
  })

  test("concurrent commits across SEPARATE stores still produce one winner", async () => {
    // The conformance suite races one store against itself, which a purely
    // in-process CAS could survive. This races eight independent stores on
    // eight pooled connections, so only the database's own row-level locking
    // can settle it — the two-tabs case as it actually arrives in production.
    const prefix = freshPrefix()
    const built = Array.from({ length: 8 }, () =>
      createPostgresDocumentStore<{ n: number }>({
        connectionString: url,
        name: "sessions",
        tablePrefix: prefix,
      }),
    )
    const first = built[0]
    if (!first) throw new Error("unreachable")
    try {
      const key = await first.create({ n: 0 })
      const results = await Promise.allSettled(
        built.map((store, i) => store.commit(key, 0, { n: i + 1 })),
      )
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictError)
      }
      expect((await first.load(key))?.version).toBe(1)

      // …and the same for the claim-once insert.
      const claims = await Promise.allSettled(
        built.map((store, i) => store.commit("claim", null, { n: i })),
      )
      expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    } finally {
      await Promise.all(built.map((store) => store.close()))
    }
  })

  test("concurrent cold starts all migrate successfully", async () => {
    // Eight processes booting at once against a virgin database is what the
    // advisory lock in `runMigrations` exists for (#723); without it, seven of
    // these fail with 23505 on the catalog index.
    const prefix = freshPrefix()
    const pool = new Pool({ connectionString: url })
    pool.on("error", () => undefined)
    try {
      const built = Array.from({ length: 8 }, () =>
        createPostgresDocumentStore<{ n: number }>({ pool, name: "sessions", tablePrefix: prefix }),
      )
      const results = await Promise.allSettled(built.map((store) => store.ready()))
      expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    } finally {
      await pool.end()
    }
  })

  test("a value round-trips through jsonb unchanged", async () => {
    const store = createPostgresDocumentStore<Record<string, unknown>>({
      connectionString: url,
      name: "shapes",
      tablePrefix: freshPrefix(),
    })
    try {
      const value = {
        nested: { deep: { list: [1, 2, 3] } },
        unicode: "héllo 🌍",
        nul: null,
        bool: false,
        zero: 0,
        empty: {},
        emptyList: [],
      }
      const key = await store.create(value)
      expect((await store.load(key))?.value).toEqual(value)
    } finally {
      await store.close()
    }
  })

  test("the tables land in the configured schema", async () => {
    const schema = `s_${Math.random().toString(36).slice(2)}`
    const store = createPostgresDocumentStore<{ n: number }>({
      connectionString: url,
      name: "sessions",
      schema,
    })
    const admin = new Pool({ connectionString: url })
    admin.on("error", () => undefined)
    try {
      await store.ready()
      const res = await admin.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
        [schema],
      )
      expect(res.rows.map((r) => r.table_name)).toEqual(["b4_documents", "b4_documents_migrations"])
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await admin.end()
      await store.close()
    }
  })
})
