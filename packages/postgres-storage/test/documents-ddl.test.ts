import { describe, expect, test } from "vitest"
import { createPostgresDocumentStore } from "../src/documents.js"
import { namingFromEnv } from "../src/naming.js"
import { DOCUMENTS_MIGRATIONS } from "../src/schema.js"
import type { SqlPool } from "../src/sql.js"

const naming = { schema: "public", prefix: "b4" }

describe("documents DDL is append-only", () => {
  test("migration 1 is exactly what has already shipped", () => {
    // A SHIPPED migration can never run again on a database that recorded it,
    // so editing one silently gives new databases a shape older ones will
    // never have. That is the bug the hashbrown invoicing example hit — a
    // column default added to a `CREATE TABLE IF NOT EXISTS` applied to fresh
    // databases only, and the insert wrote NULL everywhere else.
    //
    // If this test fails you are editing history. Restore version 1 and
    // express the change as `{ version: 2, up: … }` with an `ALTER TABLE`,
    // which every database will run exactly once.
    expect(DOCUMENTS_MIGRATIONS.map((m) => m.version)).toEqual([1])
    expect(DOCUMENTS_MIGRATIONS[0]?.up(naming).trim()).toBe(
      `CREATE TABLE IF NOT EXISTS public.b4_documents (
        store_name text NOT NULL,
        doc_key text NOT NULL,
        version integer NOT NULL,
        value jsonb NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (store_name, doc_key)
      );`,
    )
  })

  test("no column carries a DEFAULT, so no insert can depend on one", () => {
    // The other half of the rule: with no defaults in the DDL, a statement
    // that forgets a column fails loudly on the NOT NULL instead of quietly
    // writing a different value on old databases than on new ones.
    for (const migration of DOCUMENTS_MIGRATIONS) {
      expect(migration.up(naming)).not.toMatch(/\bDEFAULT\b/i)
    }
  })

  test("every INSERT the store issues names every column", async () => {
    const statements: string[] = []
    const pool: SqlPool = {
      query: async <R>(sql: string) => {
        statements.push(sql)
        return { rows: [{ doc_key: "k" } as R] }
      },
      connect: () => Promise.reject(new Error("unexpected connect")),
      end: () => Promise.resolve(),
    }
    const store = createPostgresDocumentStore<{ n: number }>({
      pool,
      name: "sessions",
      assumeMigrated: true,
    })
    await store.create({ n: 1 })
    await store.commit("k", null, { n: 1 })

    const columns = ["store_name", "doc_key", "version", "value", "created_at", "updated_at"]
    const inserts = statements.filter((sql) => sql.includes("INSERT INTO"))
    expect(inserts).toHaveLength(2)
    for (const sql of inserts) {
      for (const column of columns) expect(sql).toContain(column)
    }
  })
})

describe("createPostgresDocumentStore validation", () => {
  const pool: SqlPool = {
    query: <R>() => Promise.resolve({ rows: [] as R[] }),
    connect: () => Promise.reject(new Error("unexpected connect")),
    end: () => Promise.resolve(),
  }

  test("rejects a schema that is not a lowercase identifier", () => {
    expect(() => createPostgresDocumentStore({ pool, name: "s", schema: "Public" })).toThrow(
      /lowercase SQL identifier/,
    )
  })

  test("rejects an empty store name", () => {
    expect(() => createPostgresDocumentStore({ pool, name: "" })).toThrow(/`name` is required/)
  })

  test("accepts a store name that is not a SQL identifier", () => {
    // The name is a bound parameter, never interpolated, so it is free to be
    // anything — including a name that would collide with a B4.run table.
    expect(() => createPostgresDocumentStore({ pool, name: "threads/v2 🌍" })).not.toThrow()
  })
})

describe("namingFromEnv", () => {
  test("defaults to the package defaults when nothing is set", () => {
    expect(namingFromEnv({})).toEqual({ schema: "public", tablePrefix: "b4" })
    expect(namingFromEnv({ B4_PG_SCHEMA: "", B4_PG_TABLE_PREFIX: "" })).toEqual({
      schema: "public",
      tablePrefix: "b4",
    })
  })

  test("reads literal identifiers", () => {
    expect(namingFromEnv({ B4_PG_SCHEMA: "preview", B4_PG_TABLE_PREFIX: "acme" })).toEqual({
      schema: "preview",
      tablePrefix: "acme",
    })
  })

  test("resolves a $NAME reference to another variable", () => {
    // `B4_PG_SCHEMA=$VERCEL_ENV` is the case this exists for: one deployment
    // config, preview and production in separate schemas of one database.
    expect(namingFromEnv({ B4_PG_SCHEMA: "$VERCEL_ENV", VERCEL_ENV: "preview" }).schema).toBe(
      "preview",
    )
  })

  test("fails by name when a reference is unset, rather than falling back", () => {
    expect(() => namingFromEnv({ B4_PG_SCHEMA: "$VERCEL_ENV" })).toThrow(/VERCEL_ENV/)
    expect(() => namingFromEnv({ B4_PG_SCHEMA: "$" })).toThrow(/empty variable name/)
  })

  test("rejects a value that is not a lowercase identifier", () => {
    // A mixed-case value would be folded to lowercase by unquoted DDL and so
    // never name the tables it appears to.
    expect(() => namingFromEnv({ B4_PG_SCHEMA: "Preview" })).toThrow(/lowercase SQL identifier/)
    expect(() => namingFromEnv({ B4_PG_SCHEMA: "$E", E: "Preview" })).toThrow(/from \$E/)
  })
})
