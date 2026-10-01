/**
 * `GET /agui/:routeId` — what one route's AG-UI endpoint will honor, as an
 * AG-UI `AgentCapabilities` document.
 *
 * Every claim is DERIVED from the code that enforces it, never restated:
 *
 * - `tools.clientProvided` is `resolveRunEnvelopePolicy(...).clientTools` —
 *   the function `POST` admits `tools` with — AND the route preflight `POST`
 *   rejects them with (`checkRouteClientToolsSupport`). A route named in
 *   `server.agui.clientTools` that cannot take them is not advertised as
 *   taking them.
 * - `output.structuredOutput` is `checkRouteResponseFormatSupport`, the same
 *   preflight that turns an unsupported `hashbrown.responseSchema` into a 422.
 * - `humanInTheLoop.interrupts` is `route.mode === "agent"`, the `canPark`
 *   every settle site passes; a chain/graph/workflow route is invoked without
 *   a checkpointer and cannot park.
 * - `humanInTheLoop.approvals` is "this route CAN pause for approval": an
 *   `agent()` route whose permissions store is interactive. Whether a given
 *   turn WILL ask depends on its tools, persisted grants and the call itself,
 *   none of which is knowable without running it. Non-interactive fails a gate
 *   closed and bypass never consults one, so both advertise `false`.
 * - `humanInTheLoop.approveWithEdits` is `false`: `resolvePendingResume`
 *   accepts only once/always/deny and answers anything else with 400.
 * - `tools.parallelCalls` is `true` for an `agent()` route: the LangChain
 *   adapter pins `createAgent`'s v2 one-task-per-call execution.
 *
 * AG-UI reads an omitted field as UNKNOWN, not unsupported, so a claim this
 * runtime cannot settle — an agent route exporting a raw runnable, or a route
 * module that cannot be loaded here — is left out rather than guessed.
 *
 * Gated exactly as `POST` is: an unknown route is 404 before middleware, and
 * route middleware runs before anything about the route is disclosed.
 *
 * Pure: no `node:` imports, so the module is reachable from the edge bundle.
 */

import type { AgentCapabilities } from "@ag-ui/core"
import type { B4Config } from "@b4run/core"
import type { PermissionsStore } from "@b4run/permissions"
import type { MiddlewareHandler, MiddlewareRequest } from "@b4run/sdk"
import {
  type BootResolvedInstances,
  checkRouteClientToolsSupport,
  checkRouteResponseFormatSupport,
} from "../runtime/execute-route-core.js"
import { headersToRecord, runMiddleware } from "./middleware.js"
import { resolveRunEnvelopePolicy } from "./run-envelope.js"
import type { RuntimeRegistry } from "./runtime-registry-core.js"
import { createRequestErrorBody } from "./server-errors.js"
import { statusResponse } from "./status-response.js"

export interface AgUiCapabilitiesRequestOptions {
  readonly appRoot: string
  readonly boot?: Pick<BootResolvedInstances, "bootFallbacks" | "config">
  readonly config?: B4Config
  readonly middleware: MiddlewareHandler | undefined
  readonly permissionsStore?: PermissionsStore | (() => Promise<PermissionsStore>)
  readonly registry: RuntimeRegistry
  readonly request: Request
  readonly routeKey: string
}

export async function handleAgUiCapabilitiesRequest(
  options: AgUiCapabilitiesRequestOptions,
): Promise<Response> {
  const { appRoot, boot, config, middleware, registry, request, routeKey } = options

  const route = registry.lookup(routeKey)
  if (!route) {
    return Response.json(createRequestErrorBody(`Unknown route: ${routeKey}`), { status: 404 })
  }

  const requestUrl = new URL(request.url)
  const middlewareRequest: MiddlewareRequest = {
    assistantId: route.assistantId,
    headers: headersToRecord(request.headers),
    method: "GET",
    params: {},
    routeId: route.routeId,
    url: `${requestUrl.pathname}${requestUrl.search}`,
  }
  const middlewareResult = await runMiddleware(middleware, middlewareRequest)
  if (middlewareResult.action === "reject") {
    return statusResponse(middlewareResult.status, middlewareResult.body)
  }

  const capabilities = await deriveCapabilities({
    appRoot,
    bootFallbacks: boot?.bootFallbacks,
    clientToolsOptIn: resolveRunEnvelopePolicy(config ?? boot?.config, route.routeId).clientTools,
    mode: route.mode,
    permissionsStore: options.permissionsStore,
    routeFile: route.routeFile,
    routeId: route.routeId,
  })
  // Per caller: middleware decided this caller may see it, and a shared cache
  // must not hand it to one that middleware would have refused.
  return Response.json(capabilities, { headers: { "cache-control": "no-store" } })
}

async function deriveCapabilities(options: {
  readonly appRoot: string
  readonly bootFallbacks: BootResolvedInstances["bootFallbacks"]
  readonly clientToolsOptIn: boolean
  readonly mode: RuntimeRegistry["entries"][number]["mode"]
  readonly permissionsStore: AgUiCapabilitiesRequestOptions["permissionsStore"]
  readonly routeFile: string
  readonly routeId: string
}): Promise<AgentCapabilities> {
  if (options.mode !== "agent") {
    // Invoked once, without a checkpointer: no model tool calls, no parks,
    // and `POST` refuses both client tools and a response schema.
    return {
      humanInTheLoop: { approvals: false, interrupts: false, supported: false },
      output: { structuredOutput: false },
      tools: { clientProvided: false, supported: false },
    }
  }

  const routeModule = {
    appRoot: options.appRoot,
    bootFallbacks: options.bootFallbacks,
    routeFile: options.routeFile,
    routeId: options.routeId,
  }
  let isDescriptor: boolean
  let structuredOutput: boolean
  try {
    // Both preflights share one memoized module load.
    isDescriptor = (await checkRouteClientToolsSupport(routeModule)).ok
    structuredOutput = (await checkRouteResponseFormatSupport(routeModule)).ok
  } catch {
    // The module cannot be loaded here (a boot with neither node fallbacks
    // nor a static manifest, or a route that fails to import). What follows
    // from the mode alone still holds; everything else is unknown.
    return {
      humanInTheLoop: { approveWithEdits: false, interrupts: true, supported: true },
    }
  }

  const approvals =
    isDescriptor && (await permissionsMode(options.permissionsStore)) === "interactive"
  return {
    humanInTheLoop: {
      approveWithEdits: false,
      interrupts: true,
      supported: true,
      // A raw runnable gets none of B4.run's permission gates wired in; what
      // it does on its own is not this runtime's to claim.
      ...(isDescriptor ? { approvals } : {}),
    },
    output: { structuredOutput },
    tools: {
      clientProvided: options.clientToolsOptIn && isDescriptor,
      ...(isDescriptor ? { parallelCalls: true, supported: true } : {}),
    },
  }
}

async function permissionsMode(
  store: AgUiCapabilitiesRequestOptions["permissionsStore"],
): Promise<PermissionsStore["mode"] | undefined> {
  if (store === undefined) return undefined
  return (typeof store === "function" ? await store() : store).mode
}
