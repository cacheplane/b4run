import type { Command } from "commander"

import { discoverInitialApp } from "../lib/dev/dev-session.js"
import { type ServeRuntimeHandle, serveRuntime } from "../lib/dev/serve-runtime.js"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"

interface StartOptions {
  readonly host?: string
  readonly port?: string
}

export function registerStartCommand(program: Command, io: CommandIo): void {
  program
    .command("start")
    .description("Serve the app in production (B4.run runtime; binds 0.0.0.0 by default)")
    .option("--host <host>", "Host to bind (default: 0.0.0.0)")
    .option("--port <number>", "Port to bind (default: 8000)")
    .action(async (options: StartOptions) => {
      await runStartCommand(options, io)

      // serveRuntime (installSignalHandlers: true) owns SIGTERM/SIGINT and
      // closes the listening server itself. Once that happens there is
      // nothing left keeping the event loop alive, so the process exits
      // naturally — we don't need to detect the close ourselves, and we must
      // not resolve early, since an early resolve would let the CLI's
      // top-level `process.exit()` tear the server down immediately after it
      // starts.
      await new Promise<void>(() => {})
    })
}

/**
 * Resolve the app root, boot the production runtime server, and log the
 * bound URL. Returns the `serveRuntime` handle (rather than blocking) so
 * tests can drive the server directly — `--port 0`, hit `/healthz`, then
 * call `close()` — without waiting on process signals. The CLI action above
 * is what supplies the "block forever" production behavior.
 */
export async function runStartCommand(
  options: StartOptions,
  io: CommandIo,
): Promise<ServeRuntimeHandle> {
  const port = parsePort(options.port)
  const discoveredApp = await discoverInitialApp(process.cwd())

  const handle = await serveRuntime({
    appRoot: discoveredApp.appRoot,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(port !== undefined ? { port } : {}),
    installSignalHandlers: true,
  })

  writeLine(io.stdout, `b4 start listening on ${handle.url}`)

  return handle
}

function parsePort(rawPort: string | undefined): number | undefined {
  if (!rawPort) {
    return undefined
  }

  const port = Number(rawPort)

  // Digits only: Number() alone would also accept hex (0x1f90), exponent (1e3),
  // signed, and whitespace-padded spellings.
  //
  // Unlike the shared parsePort in lib/dev/parse-port.ts (b4 dev, b4 inspect),
  // 0 is accepted here: it's a legitimate request for a kernel-assigned
  // ephemeral port (and how tests drive this command).
  if (!/^\d+$/.test(rawPort) || port < 0 || port > 65535) {
    throw new CliError(`Invalid port: ${rawPort} (expected an integer from 0 to 65535)`, 2)
  }

  return port
}
