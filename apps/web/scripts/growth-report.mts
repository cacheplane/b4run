import { parseArgs } from "node:util"
import { runReport } from "../app/lib/growth/control"
import { createPgExecutor } from "../app/lib/growth/database"
import { loadGrowthEnv } from "../app/lib/growth/env"

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { email: { type: "string" } },
  })
  const command = positionals[0]
  if (command !== "journey" && command !== "counts" && command !== "sends") {
    throw new Error("usage: growth:report <journey --email <address>|counts|sends>")
  }
  const env = loadGrowthEnv()
  const executor = createPgExecutor(env.databaseUrl)
  try {
    console.log(
      await runReport(executor, env, {
        command,
        ...(values.email !== undefined ? { email: values.email } : {}),
      }),
    )
  } finally {
    await executor.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
