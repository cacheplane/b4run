import { HttpAgent, type HttpAgentConfig } from "@ag-ui/client"
import type { AgentCapabilities, RunAgentInput } from "@ag-ui/core"
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
 *
 * With a `responseSchema`, every run's `forwardedProps` also carries
 * `responseSchema`, which B4.run binds on the route's root model as the
 * provider's structured output. The route must allow that key in
 * `server.agui.clientForwardedProps`.
 */
export class B4HttpAgent extends HttpAgent {
  /** The JSON Schema every run asks the route's final answer to match, if any. */
  readonly responseSchema: Readonly<Record<string, unknown>> | undefined

  constructor(config: B4HttpAgentConfig) {
    super(config)
    this.responseSchema = config.responseSchema
  }

  protected override requestInit(input: RunAgentInput): RequestInit {
    const init = super.requestInit(input)
    if (this.responseSchema === undefined) return init
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    const forwardedProps = isRecord(body.forwardedProps) ? body.forwardedProps : {}
    return {
      ...init,
      body: JSON.stringify({
        ...body,
        forwardedProps: { ...forwardedProps, responseSchema: this.responseSchema },
      }),
    }
  }

  /**
   * `HttpAgent.clone()` builds the copy with `Object.create` and copies only
   * the fields it knows, so the schema is copied here. CopilotKit clones the
   * registered agent for every run.
   */
  override clone(): B4HttpAgent {
    const copy = super.clone() as B4HttpAgent
    ;(copy as { responseSchema: Readonly<Record<string, unknown>> | undefined }).responseSchema =
      this.responseSchema
    return copy
  }

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

/** `HttpAgent`'s config plus the run's optional response schema. */
export interface B4HttpAgentConfig extends HttpAgentConfig {
  /**
   * A JSON Schema the route's final assistant message must match. Sent on
   * every run as `forwardedProps.responseSchema`, alongside any other
   * `forwardedProps` the run carries, which B4.run binds on the root model as
   * the provider's structured output. Tool-calling turns are unaffected.
   */
  readonly responseSchema?: Readonly<Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Header names are case-insensitive; a caller's `accept` would otherwise be merged with ours. */
function withoutHeader(headers: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== name))
}

export { type ForwardIdentityOptions, forwardIdentity } from "./forward-identity.js"
