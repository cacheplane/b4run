import { Pool } from "pg"
import { describe, expect, test } from "vitest"
import { createPostgresPool } from "../src/node.js"

// ---------------------------------------------------------------------------
// `createPostgresPool` is the `/node` entry's pool builder made public, so a
// generated deployment entry (the CLI's Vercel `stores.mjs`) can open the same
// `pg` pool the package opens for itself — with the same 'error' listener —
// instead of importing `pg` by a bare specifier the app never declared.
// Nothing here connects: the pool is lazy until its first query.
// ---------------------------------------------------------------------------

describe("createPostgresPool", () => {
  test("returns a real pg Pool built from the given config", async () => {
    const pool = createPostgresPool({ connectionString: "postgres://user:pw@localhost:1/db" })
    try {
      expect(pool).toBeInstanceOf(Pool)
      expect(pool.options.connectionString).toBe("postgres://user:pw@localhost:1/db")
    } finally {
      await pool.end()
    }
  })

  test("attaches the idle-client 'error' listener so a dropped connection cannot crash the process", async () => {
    const pool = createPostgresPool({ connectionString: "postgres://user:pw@localhost:1/db" })
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "))
    try {
      expect(pool.listenerCount("error")).toBe(1)
      // An 'error' with no listener throws out of emit; with the listener it
      // is a warning naming the pool, and nothing else.
      expect(() => pool.emit("error", new Error("idle client dropped"))).not.toThrow()
      expect(warnings).toEqual([
        "[b4:storage] postgres pool client error (connection dropped): Error: idle client dropped",
      ])
    } finally {
      console.warn = realWarn
      await pool.end()
    }
  })

  test("passes pool options such as custom type parsers through untouched", async () => {
    const types = { getTypeParser: () => (value: string) => value }
    const pool = createPostgresPool({ connectionString: "postgres://u:p@localhost:1/db", types })
    try {
      expect(pool.options.types).toBe(types)
    } finally {
      await pool.end()
    }
  })
})
