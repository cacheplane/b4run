/**
 * `b4 client-tools prune` — delete settled and expired client tool call
 * records, and settled server tool call records, by hand (cacheplane/b4run#880
 * follow-up). The runtime sweeps the
 * same store opportunistically when an AG-UI turn settles; this is the
 * operator's handle for cron or a one-off.
 *
 * Lives beside `b4 memory prune`, not under `b4 threads`: `threads` talks to
 * a running server by URL, while this opens the app's local store.
 */
import { resolve } from "node:path"
import type { Command } from "commander"
import {
  clientToolPruneCutoff,
  MAX_CLIENT_TOOL_TTL_MS,
  resolveClientToolRetentionMs,
  resolveClientToolTtlMs,
  validateClientToolStore,
} from "../lib/dev/client-tool-runtime.js"
import { loadOptionalB4Config } from "../lib/node-config.js"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"
import { resolveClientToolCallStore } from "../lib/runtime/execute-route.js"

interface ClientToolsOptions {
  readonly cwd?: string
}

const USAGE = [
  "b4 client-tools <subcommand> [args]",
  "  subcommands: prune [--retention <ms>]",
].join("\n")

export function registerClientToolsCommand(program: Command, io: CommandIo): void {
  program
    .command("client-tools [subcommand] [args...]")
    .description("Manage the records behind client-provided AG-UI tools")
    .option("--cwd <path>", "Path to the B4.run app root")
    // The subcommand owns `--retention`; without this commander would claim it.
    .passThroughOptions()
    .addHelpText("after", `\n${USAGE}`)
    .action(async (subcommand: string | undefined, args: string[], options: ClientToolsOptions) => {
      const argv = subcommand ? [subcommand, ...args] : []
      await runClientToolsCommand(argv, options, io)
    })
}

export async function runClientToolsCommand(
  argv: readonly string[],
  options: ClientToolsOptions,
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
  const usage = "Usage: b4 client-tools prune [--retention <ms>]"
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

  // The same validators the server boot runs, so a mistyped config fails here
  // too instead of silently pruning with the default.
  const agui = (await loadOptionalB4Config(appRoot))?.server?.agui
  const ttlMs = resolveClientToolTtlMs(agui?.clientToolTtlMs)
  const retentionMs = retentionOverride ?? resolveClientToolRetentionMs(agui?.clientToolRetentionMs)
  // Shape-checks a configured `clientToolStore` the way the boot does (throws
  // naming the missing methods); the resolver below still picks the store,
  // because it also owns the SQLite default.
  validateClientToolStore(agui?.clientToolStore)

  const store = await resolveClientToolCallStore(appRoot)
  if (!store) {
    writeLine(io.stdout, "no client tool store for this app; nothing to prune")
    return
  }
  const deleted = await store.prune({
    before: clientToolPruneCutoff(new Date(), { ttlMs, retentionMs }),
  })
  writeLine(io.stdout, `pruned: ${deleted}`)
}
