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

  const port = Number(rawPort)

  // Digits only: Number() alone would also accept hex (0x1f90), exponent (1e3),
  // signed, and whitespace-padded spellings.
  if (!/^\d+$/.test(rawPort) || port <= 0 || port > 65535) {
    throw new CliError(`Invalid port: ${rawPort} (expected an integer from 1 to 65535)`, 2)
  }

  return port
}
