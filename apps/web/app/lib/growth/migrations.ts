import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { SqlExecutor } from "./database"

export interface Migration {
  readonly name: string
  readonly checksum: string
  readonly sql: string
}

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/

export async function discoverMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => MIGRATION_FILE.test(name)).sort()
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(directory, name), "utf8")
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") }
    }),
  )
}

const CREATE_LEDGER = `create table if not exists growth_schema_migrations (
  name text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
)`

export async function applyMigrations(input: {
  directory: string
  executor: SqlExecutor
}): Promise<{ applied: string[]; skipped: string[] }> {
  const { directory, executor } = input
  const migrations = await discoverMigrations(directory)
  const applied: string[] = []
  const skipped: string[] = []

  await executor.query(CREATE_LEDGER)

  for (const migration of migrations) {
    await executor.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext('b4-growth-migrations'))")
      const ledger = await tx.query<{ name: string; checksum: string }>(
        "select name, checksum from growth_schema_migrations",
      )
      const recorded = ledger.rows.find((row) => row.name === migration.name)
      if (recorded) {
        if (recorded.checksum !== migration.checksum) {
          throw new Error(`Migration ${migration.name} changed after it was applied`)
        }
        skipped.push(migration.name)
        return
      }
      await tx.query("set local search_path to public")
      await tx.query(migration.sql)
      await tx.query("insert into growth_schema_migrations (name, checksum) values ($1, $2)", [
        migration.name,
        migration.checksum,
      ])
      applied.push(migration.name)
    })
  }

  return { applied, skipped }
}
