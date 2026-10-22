import type { Command } from "commander"
import { startDevSession } from "../lib/dev/dev-session.js"
import { parsePort } from "../lib/dev/parse-port.js"
import type { CommandIo } from "../lib/output.js"
import type { SignalsEmitter } from "../lib/signals/emitter.js"
import type { RouteKind } from "../lib/signals/events.js"

interface DevOptions {
  readonly port?: string
  readonly envFile?: string
}

export function registerDevCommand(
  program: Command,
  io: CommandIo,
  signals?: SignalsEmitter,
): void {
  program
    .command("dev")
    .description("Start the B4.run local development runtime")
    .option("--port <number>", "Bind b4 dev to a stable localhost port")
    .option(
      "--env-file <path>",
      "Path to a .env file (overrides b4.config.ts env and the default ./.env)",
    )
    .action(async (options: DevOptions) => {
      await runDevCommand(options, io, signals)
    })
}

export async function runDevCommand(
  options: DevOptions,
  io: CommandIo,
  signals?: SignalsEmitter,
): Promise<void> {
  const port = parsePort(options.port)
  const session = await startDevSession({
    cwd: process.cwd(),
    io,
    ...(typeof port === "number" ? { port } : {}),
    ...(options.envFile !== undefined ? { envFile: options.envFile } : {}),
    ...(signals !== undefined
      ? {
          onRunFinished: (routeKind: RouteKind) => {
            signals.devFirstRunCompleted(routeKind)
          },
        }
      : {}),
  })

  const shutdown = async () => {
    await session.close()
  }

  process.once("SIGINT", () => {
    void shutdown()
  })
  process.once("SIGTERM", () => {
    void shutdown()
  })

  await session.waitUntilClosed()
}
