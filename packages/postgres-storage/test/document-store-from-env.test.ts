import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest"

const enabled = process.env.B4_TEST_PGSTORAGE === "1"

/**
 * The factory memoizes at module scope, so every test gets a fresh module
 * graph. Importing through `vi.resetModules()` is the only way to observe a
 * cold start more than once.
 */
async function freshEntry() {
  vi.resetModules()
  return import("../src/node.js")
}

const withEnv = async <T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> => {
  const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe("documentStoreFromEnv without DATABASE_URL", () => {
  test("falls back to the in-process store", async () => {
    await withEnv({ DATABASE_URL: undefined }, async () => {
      const { documentStoreFromEnv } = await freshEntry()
      const store = await documentStoreFromEnv<{ n: number }>({ name: "sessions" })
      const key = await store.create({ n: 1 })
      expect(await store.load(key)).toEqual({ version: 0, value: { n: 1 } })
    })
  })

  test("hands the same instance back for one name, and a distinct one per name", async () => {
    await withEnv({ DATABASE_URL: undefined }, async () => {
      const { documentStoreFromEnv } = await freshEntry()
      const [a, b, other] = await Promise.all([
        documentStoreFromEnv<{ n: number }>({ name: "sessions" }),
        documentStoreFromEnv<{ n: number }>({ name: "sessions" }),
        documentStoreFromEnv<{ n: number }>({ name: "threads" }),
      ])
      expect(a).toBe(b)
      expect(a).not.toBe(other)
      // Distinct collections, so a key in one is invisible in the other.
      await a.commit("k", null, { n: 1 })
      expect(await other.load("k")).toBeUndefined()
    })
  })
})

describe.skipIf(!enabled)("documentStoreFromEnv with DATABASE_URL", () => {
  let container: StartedPostgreSqlContainer
  let url: string

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withStartupTimeout(180_000).start()
    url = container.getConnectionUri()
  }, 240_000)

  afterAll(async () => {
    await container?.stop()
  })

  afterEach(async () => {
    const { closeDocumentStoresFromEnv } = await import("../src/node.js")
    await closeDocumentStoresFromEnv()
  })

  test("uses Postgres and persists across store instances", async () => {
    const key = await withEnv({ DATABASE_URL: url, B4_PG_TABLE_PREFIX: "t_fromenv" }, async () => {
      const { documentStoreFromEnv, closeDocumentStoresFromEnv } = await freshEntry()
      const store = await documentStoreFromEnv<{ n: number }>({ name: "sessions" })
      const created = await store.create({ n: 1 })
      await closeDocumentStoresFromEnv()
      return created
    })

    await withEnv({ DATABASE_URL: url, B4_PG_TABLE_PREFIX: "t_fromenv" }, async () => {
      const { documentStoreFromEnv } = await freshEntry()
      const store = await documentStoreFromEnv<{ n: number }>({ name: "sessions" })
      // A different process would see exactly this — the point of the whole
      // exercise, and what the memory fallback deliberately does not provide.
      expect(await store.load(key)).toEqual({ version: 0, value: { n: 1 } })
    })
  })

  test("B4_PG_SCHEMA separates one deployment's documents from another's", async () => {
    const write = (schema: string) =>
      withEnv({ DATABASE_URL: url, B4_PG_SCHEMA: schema }, async () => {
        const { documentStoreFromEnv, closeDocumentStoresFromEnv } = await freshEntry()
        const store = await documentStoreFromEnv<{ env: string }>({ name: "sessions" })
        await store.commit("shared", null, { env: schema })
        const read = await store.load("shared")
        await closeDocumentStoresFromEnv()
        return read
      })

    expect((await write("s_preview"))?.value).toEqual({ env: "s_preview" })
    // Same key, same store name, same database: a conflict if the schema were
    // ignored, an independent insert because it is not.
    expect((await write("s_production"))?.value).toEqual({ env: "s_production" })
  })

  test("a failed cold start is not memoized", async () => {
    await withEnv(
      { DATABASE_URL: "postgres://nobody@127.0.0.1:1/none", B4_PG_TABLE_PREFIX: "t_retry" },
      async () => {
        const { documentStoreFromEnv } = await freshEntry()
        await expect(documentStoreFromEnv({ name: "sessions" })).rejects.toThrow()

        // The database comes back. Without dropping the memo, the first boot's
        // connection error would be replayed forever.
        process.env["DATABASE_URL"] = url
        const store = await documentStoreFromEnv<{ n: number }>({ name: "sessions" })
        expect(await store.create({ n: 1 })).toEqual(expect.any(String))
      },
    )
  })
})
