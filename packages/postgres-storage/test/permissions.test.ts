import { runPermissionsStoreConformance } from "@b4run/testing"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createPostgresPermissionsStore, type PostgresPermissionsStore } from "../src/node.js"

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing required test fixture value")
  return value
}

const enabled = process.env.B4_TEST_PGSTORAGE === "1"
let container: StartedPostgreSqlContainer
let url: string

/** Fresh, never-migrated table set per store — no truncation, no teardown. */
const freshPrefix = () => `t_${Math.random().toString(36).slice(2)}`

describe.skipIf(!enabled)("postgres permissions store against real Postgres", () => {
  beforeAll(async () => {
    // A loaded CI runner can take minutes to pull postgres:16 and accept the
    // first connection; Testcontainers' 60s default is the honest lever here,
    // not a blanket test retry that would hide a genuine failure.
    container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
    url = container.getConnectionUri()
  }, 240_000)

  afterAll(async () => {
    await container?.stop()
  })

  runPermissionsStoreConformance({
    name: "createPostgresPermissionsStore",
    makeStore: (init) =>
      createPostgresPermissionsStore({
        connectionString: url,
        tablePrefix: freshPrefix(),
        mode: init.mode,
        ...(init.config ? { config: init.config } : {}),
      }),
    describe,
    close: (store) => (store as PostgresPermissionsStore).close(),
  })

  test("a grant from one instance is visible to another after load()", async () => {
    // The cross-instance capability the file store does not have: a second
    // process's permissions.json is its own, so an "Always" grant made on
    // instance A never reaches instance B.
    const prefix = freshPrefix()
    const a = createPostgresPermissionsStore({ connectionString: url, tablePrefix: prefix })
    const b = createPostgresPermissionsStore({ connectionString: url, tablePrefix: prefix })
    try {
      await a.load()
      await b.load()
      expect(b.match("bash", "npm install react")).toBe("unknown")

      await a.addAllow("bash", "npm install")
      // Not yet — b's cache is stale until it re-hydrates. Pinning this makes
      // the load() below meaningful rather than trivially true.
      expect(b.match("bash", "npm install react")).toBe("unknown")

      await b.load()
      expect(b.match("bash", "npm install react")).toBe("allow")
    } finally {
      await a.close()
      await b.close()
    }
  }, 60_000)

  test("concurrent addAllow of the same pattern from N stores inserts exactly one row", async () => {
    const prefix = freshPrefix()
    const stores = Array.from({ length: 8 }, () =>
      createPostgresPermissionsStore({ connectionString: url, tablePrefix: prefix }),
    )
    const pool = new Pool({ connectionString: url })
    try {
      await Promise.all(stores.map((s) => s.addAllow("bash", "npm install")))
      const res = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM public.${prefix}_permissions
         WHERE scope = 'runtime' AND kind = 'allow' AND tool = 'bash' AND pattern = 'npm install'`,
      )
      // ON CONFLICT DO NOTHING, not a read-modify-write: no duplicates and no
      // 23505 from the losers.
      expect(res.rows[0]?.n).toBe("1")
      for (const s of stores) expect(s.match("bash", "npm install react")).toBe("allow")
    } finally {
      await pool.end()
      await Promise.all(stores.map((s) => s.close()))
    }
  }, 60_000)

  test("concurrent cold-start permissions migrations against a virgin database all succeed", async () => {
    // Separate stores means separate pools and separate memoized ready()s, so
    // only the advisory lock inside runMigrations prevents 23505 here.
    const prefix = freshPrefix()
    const stores = Array.from({ length: 8 }, () =>
      createPostgresPermissionsStore({ connectionString: url, tablePrefix: prefix }),
    )
    try {
      const results = await Promise.allSettled(stores.map((s) => s.ready()))
      expect(results.filter((r) => r.status === "rejected")).toEqual([])
    } finally {
      await Promise.all(stores.map((s) => s.close()))
    }
  }, 60_000)

  test("config entries are never persisted — only runtime grants reach the table", async () => {
    const prefix = freshPrefix()
    const store = createPostgresPermissionsStore({
      connectionString: url,
      tablePrefix: prefix,
      config: { version: 1, allow: { bash: ["ls"] }, deny: { bash: ["rm"] } },
    })
    const pool = new Pool({ connectionString: url })
    try {
      await store.load()
      await store.addAllow("bash", "cat")
      const res = await pool.query<{ scope: string; kind: string; pattern: string }>(
        `SELECT scope, kind, pattern FROM public.${prefix}_permissions`,
      )
      expect(res.rows).toEqual([{ scope: "runtime", kind: "allow", pattern: "cat" }])
    } finally {
      await pool.end()
      await store.close()
    }
  }, 60_000)

  test("two prefixes in one database do not see each other's grants", async () => {
    const a = createPostgresPermissionsStore({ connectionString: url, tablePrefix: freshPrefix() })
    const b = createPostgresPermissionsStore({ connectionString: url, tablePrefix: freshPrefix() })
    try {
      await a.addAllow("bash", "ls")
      await b.load()
      expect(b.match("bash", "ls -la")).toBe("unknown")
    } finally {
      await a.close()
      await b.close()
    }
  }, 60_000)

  test("an injected pool is shared, not owned: close() leaves it usable", async () => {
    const pool = new Pool({ connectionString: url })
    try {
      const store = createPostgresPermissionsStore({ pool, tablePrefix: freshPrefix() })
      await store.addAllow("bash", "ls")
      await store.close()
      const res = await pool.query("SELECT 1 AS ok")
      expect(res.rows[0]).toEqual({ ok: 1 })
    } finally {
      await pool.end()
    }
  }, 60_000)
  test("preserves empty prefix patterns through the coordinated native addAllow writer", async () => {
    const store = createPostgresPermissionsStore({
      connectionString: url,
      tablePrefix: freshPrefix(),
    })
    try {
      await store.addAllow("bash", "")
      expect(store.match("bash", "anything")).toBe("allow")
    } finally {
      await store.close()
    }
  }, 60_000)
  test("coordinates durable intents across instances and never replays over later SQL rule edits", async () => {
    const prefix = freshPrefix(),
      pool = new Pool({ connectionString: url })
    const a = createPostgresPermissionsStore({ pool, tablePrefix: prefix }),
      b = createPostgresPermissionsStore({ pool, tablePrefix: prefix })
    try {
      await a.load()
      await b.load()
      expect(a.rememberedRules).toBeDefined()
      const intent = await required(a.rememberedRules).prepare("intent-once", [
        { tool: "tool", pattern: "send" },
      ])
      expect(await required(b.rememberedRules).apply(intent)).toBe("applied")
      await pool.query(
        `DELETE FROM public.${prefix}_permissions WHERE scope='runtime' AND kind='allow' AND tool='tool' AND pattern='send'`,
      )
      expect(await required(a.rememberedRules).apply(intent)).toBe("applied")
      await a.load()
      expect(a.match("tool", "send")).toBe("unknown")
      const stale = await required(a.rememberedRules).prepare("intent-stale", [
        { tool: "tool", pattern: "send" },
      ])
      await b.addAllow("tool", "inspect")
      expect(await required(a.rememberedRules).apply(stale)).toBe("superseded")
      expect(a.match("tool", "inspect")).toBe("allow")
      expect(a.match("tool", "send")).toBe("unknown")
    } finally {
      await pool.end()
    }
  }, 60_000)
})

describe("postgres permissions store construction", () => {
  test("rejects an unsafe schema or table prefix before any connection is made", () => {
    expect(() => createPostgresPermissionsStore({ schema: "public; DROP TABLE x" })).toThrow(
      /schema/,
    )
    expect(() => createPostgresPermissionsStore({ tablePrefix: "bad-prefix" })).toThrow(
      /tablePrefix/,
    )
  })

  test("rejects a generated permission identifier that would be truncated before any SQL", () => {
    expect(() => createPostgresPermissionsStore({ tablePrefix: "a".repeat(52) })).toThrow(
      /permissions table/,
    )
    expect(() => createPostgresPermissionsStore({ tablePrefix: "a".repeat(51) })).not.toThrow()
  })

  test("defaults to interactive mode", () => {
    expect(createPostgresPermissionsStore().mode).toBe("interactive")
  })
})
