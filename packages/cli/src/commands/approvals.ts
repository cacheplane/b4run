/**
 * `b4 approvals prune` — delete settled approval grant records by hand
 * (cacheplane/b4run#902). The runtime sweeps the same store hourly wherever
 * it voids superseded grants; this is the operator's handle for cron or a
 * one-off. Outstanding grants are never deleted, however old.
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { createInterruptGrantStore } from "@b4run/sqlite-storage"
import type { Command } from "commander"
import {
  resolveApprovalGrantRetentionMs,
  validateInterruptGrantStore,
} from "../lib/dev/approval-grants.js"
import { MAX_CLIENT_TOOL_TTL_MS } from "../lib/dev/client-tool-runtime.js"
import { loadOptionalB4Config } from "../lib/node-config.js"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"
import { resolveInterruptGrantStore } from "../lib/runtime/execute-route.js"

interface ApprovalsOptions {
  readonly cwd?: string
}

const USAGE = ["b4 approvals <subcommand> [args]", "  subcommands: prune [--retention <ms>]"].join(
  "\n",
)

export function registerApprovalsCommand(program: Command, io: CommandIo): void {
  program
    .command("approvals [subcommand] [args...]")
    .description("Manage the records behind human-in-the-loop approval grants")
    .option("--cwd <path>", "Path to the B4.run app root")
    // The subcommand owns `--retention`; without this commander would claim it.
    .passThroughOptions()
    .addHelpText("after", `\n${USAGE}`)
    .action(async (subcommand: string | undefined, args: string[], options: ApprovalsOptions) => {
      const argv = subcommand ? [subcommand, ...args] : []
      await runApprovalsCommand(argv, options, io)
    })
}

export async function runApprovalsCommand(
  argv: readonly string[],
  options: ApprovalsOptions,
  io: CommandIo,
): Promise<void> {
  const subcommand = argv[0]
  if (!subcommand) throw new CliError(`Missing subcommand.\n${USAGE}`, 1)
  const appRoot = options.cwd ? resolve(options.cwd) : process.cwd()
  switch (subcommand) {
    case "prune":
      await runPrune(appRoot, argv.slice(1), io)
      return
    default:
      throw new CliError(`Unknown subcommand: "${subcommand}".\n${USAGE}`, 1)
  }
}

async function runPrune(appRoot: string, args: readonly string[], io: CommandIo): Promise<void> {
  const usage = "Usage: b4 approvals prune [--retention <ms>]"
  let retentionOverride: number | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--retention") {
      const raw = args[++i]
      if (raw === undefined) throw new CliError(`Missing value for --retention.\n${usage}`, 1)
      const parsed = Number(raw)
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_CLIENT_TOOL_TTL_MS) {
        throw new CliError(
          `Invalid --retention value: "${raw}" (expected a positive integer number of milliseconds no greater than ${MAX_CLIENT_TOOL_TTL_MS}).\n${usage}`,
          1,
        )
      }
      retentionOverride = parsed
    } else {
      throw new CliError(`Unknown argument: "${arg}".\n${usage}`, 1)
    }
  }

  // The same validators the boot runs, so a mistyped config or a store
  // missing a method fails here too instead of silently defaulting. One
  // difference: the boot checks the store only when grants are on, while this
  // command validates a configured store whenever it would prune through it.
  const approvals = (await loadOptionalB4Config(appRoot))?.approvals
  const configured = validateInterruptGrantStore(approvals?.grantStore)
  const retentionMs =
    retentionOverride ?? resolveApprovalGrantRetentionMs(approvals?.grantRetentionMs)

  // Grants may have been switched off after rows were written: an existing
  // default file is still opened, as the client tool store resolver does.
  // With grants on and no file yet, the resolver creates the default SQLite
  // store (as the dev server would at its next boot) and the pass prunes 0.
  const defaultPath = resolve(appRoot, ".b4/interrupt-grants.sqlite")
  const store =
    configured ??
    (await resolveInterruptGrantStore(appRoot)) ??
    (existsSync(defaultPath) ? createInterruptGrantStore({ path: defaultPath }) : undefined)
  if (!store) {
    writeLine(io.stdout, "no approval grant store for this app; nothing to prune")
    return
  }
  const deleted = await store.prune({ before: new Date(Date.now() - retentionMs).toISOString() })
  writeLine(io.stdout, `pruned: ${deleted}`)
}
