import { Command } from "commander"
import { runMemoryCommand } from "./memory.js"

const program = new Command().name("fixture")
program
  .command("memory [subcommand] [args...]")
  .description("Manage memory")
  .option("--cwd <path>", "App directory")
  .action(async (subcommand: string, args: string[], options: { cwd?: string }) => {
    await runMemoryCommand(subcommand, args, options)
  })

await program.parseAsync(process.argv)
