import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SqlExecutor, SqlQueryResult, SqlTransaction } from "./database"
import { applyMigrations, discoverMigrations } from "./migrations"

interface Call {
  readonly text: string
  readonly params: readonly unknown[] | undefined
}

function createFakeExecutor() {
  const ledger = new Map<string, string>()
  const calls: Call[] = []
  const executor: SqlExecutor = {
    async query<Row extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<SqlQueryResult<Row>> {
      calls.push({ text, params })
      const normalized = text.replace(/\s+/g, " ").trim().toLowerCase()
      if (normalized === "select name, checksum from growth_schema_migrations") {
        const rows = [...ledger].map(([name, checksum]) => ({ name, checksum }))
        return { rows: rows as unknown as Row[], rowCount: rows.length }
      }
      if (normalized.startsWith("insert into growth_schema_migrations")) {
        ledger.set(String(params?.[0]), String(params?.[1]))
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    async transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      return fn(executor)
    },
    async end() {},
  }
  return { executor, calls, ledger }
}

async function migrationDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "growth-migrations-"))
  await mkdir(directory, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(directory, name), body)
  }
  return directory
}

describe("migrations", () => {
  it("discovers migrations in name order and ignores other files", async () => {
    const directory = await migrationDirectory({
      "0002_b.sql": "select 2;",
      "0001_a.sql": "select 1;",
      "notes.md": "ignore me",
    })
    const migrations = await discoverMigrations(directory)
    expect(migrations.map((migration) => migration.name)).toEqual(["0001_a.sql", "0002_b.sql"])
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it("applies each migration once and skips it on the next run", async () => {
    const directory = await migrationDirectory({
      "0001_a.sql": "select 1;",
      "0002_b.sql": "select 2;",
    })
    const { executor, calls } = createFakeExecutor()

    const first = await applyMigrations({ directory, executor })
    expect(first).toEqual({ applied: ["0001_a.sql", "0002_b.sql"], skipped: [] })
    expect(calls.some((call) => call.text.includes("pg_advisory_xact_lock"))).toBe(true)
    expect(calls.some((call) => call.text === "select 2;")).toBe(true)

    const second = await applyMigrations({ directory, executor })
    expect(second).toEqual({ applied: [], skipped: ["0001_a.sql", "0002_b.sql"] })
  })

  it("refuses an applied migration whose checksum changed", async () => {
    const directory = await migrationDirectory({ "0001_a.sql": "select 1;" })
    const { executor } = createFakeExecutor()
    await applyMigrations({ directory, executor })

    await writeFile(join(directory, "0001_a.sql"), "select 1; -- edited")
    await expect(applyMigrations({ directory, executor })).rejects.toThrow(
      "Migration 0001_a.sql changed after it was applied",
    )
  })
})
