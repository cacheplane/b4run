import { parseArgs } from "node:util"
import type { StopReason } from "../app/lib/growth/contacts"
import { runControl } from "../app/lib/growth/control"
import { createPgExecutor } from "../app/lib/growth/database"
import { loadGrowthEnv } from "../app/lib/growth/env"

const COMMANDS = ["status", "approve", "stop", "delete"] as const
type Command = (typeof COMMANDS)[number]

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      email: { type: "string" },
      reason: { type: "string" },
      force: { type: "boolean" },
    },
  })
  const command = COMMANDS.find((candidate) => candidate === positionals[0]) as Command | undefined
  if (command === undefined) {
    throw new Error(
      "usage: growth:control <status|approve|stop|delete> --email <address> [--reason <reason>] [--force]",
    )
  }
  if (values.email === undefined) throw new Error("--email is required")
  const env = loadGrowthEnv()
  const executor = createPgExecutor(env.databaseUrl)
  try {
    console.log(
      await runControl(executor, env, {
        command,
        email: values.email,
        ...(values.reason !== undefined ? { reason: values.reason as StopReason } : {}),
        ...(values.force === true ? { force: true } : {}),
        now: new Date(),
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
