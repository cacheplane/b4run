import { CliError } from "../output.js"

/**
 * Parse a --port flag value. Shared by b4 dev and b4 inspect.
 *
 * NOTE: start.ts keeps its own deliberately-different parsePort — it accepts 0
 * as a request for a kernel-assigned ephemeral port. Here 0 is invalid: these
 * commands allocate their own free port when the flag is omitted.
 */
export function parsePort(rawPort: string | undefined): number | undefined {
  if (!rawPort) {
    return undefined
  }

  // Require a purely decimal integer spelling to avoid hex/exponential forms
  // (e.g. 0x1f90 or 1e3) being accepted by Number().
  if (!/^\d+$/.test(rawPort)) {
    throw new CliError(`Invalid port: ${rawPort}`, 2)
  }

  const port = Number(rawPort)

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new CliError(`Invalid port: ${rawPort}`, 2)
  }

  return port
}
