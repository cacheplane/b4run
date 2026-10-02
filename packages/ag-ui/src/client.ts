import { HttpAgent } from "@ag-ui/client"
import type { AgentCapabilities } from "@ag-ui/core"
import { AgentCapabilitiesSchema } from "@ag-ui/core/schemas"

/**
 * How long `getCapabilities()` waits for B4.run. CopilotKit's runtime awaits
 * every agent's capabilities before it answers `/info`, so a server that
 * accepts the connection and then hangs would hang `/info` with it.
 */
const CAPABILITIES_TIMEOUT_MS = 10_000

/**
 * An AG-UI `HttpAgent` for a B4.run route that can also report what the route
 * honors. `getCapabilities()` reads `GET` on the same URL the agent runs
 * against (`/agui/:routeId`), with the same headers and `fetch`, so a caller
 * that is allowed to run the route is the caller that sees its capabilities.
 *
 * CopilotKit's runtime calls `getCapabilities()` for every registered agent
 * when it answers `/info`; a plain `HttpAgent` does not implement it, so its
 * capabilities are never reported.
 *
 * A server that answers with anything but a 2xx — including a B4.run release
 * that predates the endpoint (404) or route middleware refusing the caller —
 * makes it throw rather than report an empty document: AG-UI reads an absent
 * field as unknown, and an empty object would claim "nothing declared" as if
 * the server had said so. So does a server that has not answered within
 * ten seconds.
 */
export class B4HttpAgent extends HttpAgent {
  async getCapabilities(): Promise<AgentCapabilities> {
    const response = await this.fetch(this.url, {
      headers: { ...withoutHeader(this.headers, "accept"), Accept: "application/json" },
      method: "GET",
      signal: AbortSignal.timeout(CAPABILITIES_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`B4.run capabilities request failed: ${response.status} ${this.url}`)
    }
    // The schema's inferred output spells optionals as `T | undefined`; the
    // generated `AgentCapabilities` spells them as absent-or-present. Same
    // wire shape — the parse validated it — so the assertion only reconciles
    // the two spellings under exactOptionalPropertyTypes.
    return AgentCapabilitiesSchema.parse(await response.json()) as AgentCapabilities
  }
}

/** Header names are case-insensitive; a caller's `accept` would otherwise be merged with ours. */
function withoutHeader(headers: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== name))
}
