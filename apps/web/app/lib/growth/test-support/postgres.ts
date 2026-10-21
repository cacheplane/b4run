import { fileURLToPath } from "node:url"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { createPgExecutor, type SqlExecutor } from "../database"
import { applyMigrations } from "../migrations"

export const GROWTH_DB_TESTS_ENABLED = process.env.B4_TEST_GROWTH_DB === "1"

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations", import.meta.url))

export async function withMigratedDatabase<T>(
  fn: (executor: SqlExecutor) => Promise<T>,
): Promise<T> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start()
  const executor = createPgExecutor(container.getConnectionUri())
  try {
    await applyMigrations({ directory: MIGRATIONS_DIRECTORY, executor })
    return await fn(executor)
  } finally {
    await executor.end().catch(() => undefined)
    await container.stop()
  }
}
