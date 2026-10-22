import { fileURLToPath } from "node:url"
import { createPgExecutor, loadGrowthDatabaseUrl } from "../app/lib/growth/database"
import { applyMigrations } from "../app/lib/growth/migrations"

const directory = fileURLToPath(new URL("../app/lib/growth/migrations", import.meta.url))

async function main(): Promise<void> {
  const executor = createPgExecutor(loadGrowthDatabaseUrl())
  try {
    const { applied, skipped } = await applyMigrations({ directory, executor })
    console.log(`applied: ${applied.join(", ") || "(none)"}`)
    console.log(`skipped: ${skipped.join(", ") || "(none)"}`)
  } finally {
    await executor.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
