/**
 * `GET /agui/:routeId` — what one route's AG-UI endpoint will honor, as an
 * AG-UI `AgentCapabilities` document.
 *
 * Every claim is DERIVED from the code that enforces it, never restated:
 *
 * - `tools.clientProvided` is every gate `POST` puts in front of a non-empty
 *   `tools`: the route opted in (`resolveRunEnvelopePolicy`, else 422), it is
 *   an `agent()` route (`checkRouteClientToolsSupport`, else 422), and a
 *   client tool store resolved at boot (else 503).
 * - `output.structuredOutput` is `checkRouteResponseFormatSupport`, the same
 *   preflight that turns an unsupported `hashbrown.responseSchema` into a 422.
 * - `humanInTheLoop.interrupts` is `route.mode === "agent"`, the `canPark`
 *   every settle site passes; a chain/graph/workflow route is invoked without
 *   a checkpointer and cannot park.
 * - `humanInTheLoop.approvals` is "this route CAN pause for an approval that
 *   can be answered": an `agent()` route whose permissions store is
 *   interactive, on a runtime whose grant mode does not refuse every resume
 *   (`grantsRefuseEveryResume`). Whether a given turn WILL ask depends on its
 *   tools, persisted grants and the call itself, none of which is knowable
 *   without running it. Non-interactive fails a gate closed and bypass never
 *   consults one, so both advertise `false`.
 * - `humanInTheLoop.approveWithEdits` is `false`: `resolvePendingResume`
 *   accepts only once/always/deny and answers anything else with 400.
 * - `tools.parallelCalls` is `true` for an `agent()` route: the LangChain
 *   adapter pins `createAgent`'s v2 one-task-per-call execution.
 *
 * AG-UI reads an omitted field as UNKNOWN, not unsupported, so a claim this
 * runtime cannot settle — what an agent route exporting a raw runnable does on
 * its own, or anything about a route on a boot that cannot load route modules
 * — is left out rather than guessed. A route module that fails to import is
 * not "unknown": the error propagates, as it does from `POST`'s preflight.
 *
 * Gated as `POST` is: an unknown route is 404 before middleware, and route
 * middleware runs before anything about the route is disclosed. Middleware
 * sees `method: "GET"`, no body and no route params.
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
import { type ApprovalGrantRuntime, grantsRefuseEveryResume } from "./approval-grants.js"
import type { ClientToolRuntime } from "./client-tool-runtime.js"
import { headersToRecord, runMiddleware } from "./middleware.js"
import { resolveRunEnvelopePolicy } from "./run-envelope.js"
import type { RuntimeRegistry } from "./runtime-registry-core.js"
import { createRequestErrorBody } from "./server-errors.js"
import { statusResponse } from "./status-response.js"

export interface AgUiCapabilitiesRequestOptions {
  readonly appRoot: string
  /** The boot-resolved grant mode and store, as `POST`'s resume gate reads them. */
  readonly approvalGrants?: ApprovalGrantRuntime
  readonly boot?: Pick<BootResolvedInstances, "bootFallbacks" | "config">
  /** The boot-resolved client tool store, as `POST` reads it. */
  readonly clientTools?: Pick<ClientToolRuntime, "store">
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
  const { middleware, registry, request, routeKey } = options

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

  const capabilities =
    route.mode === "agent"
      ? await agentCapabilities(options, route)
      : // Invoked once, without a checkpointer: no model tool calls, no parks,
        // and `POST` refuses both client tools and a response schema.
        {
          humanInTheLoop: {
            approvals: false,
            approveWithEdits: false,
            interrupts: false,
            supported: false,
          },
          output: { structuredOutput: false },
          tools: { clientProvided: false, supported: false },
        }
  // Per caller: middleware decided this caller may see it, and a shared cache
  // must not hand it to one that middleware would have refused.
  return Response.json(capabilities, { headers: { "cache-control": "no-store" } })
}

async function agentCapabilities(
  options: AgUiCapabilitiesRequestOptions,
  route: RuntimeRegistry["entries"][number],
): Promise<AgentCapabilities> {
  const bootFallbacks = options.boot?.bootFallbacks
  const routeModule = {
    appRoot: options.appRoot,
    bootFallbacks,
    routeFile: route.routeFile,
    routeId: route.routeId,
  }
  let isDescriptor: boolean
  let structuredOutput: boolean
  try {
    // Both preflights share one memoized module load.
    isDescriptor = (await checkRouteClientToolsSupport(routeModule)).ok
    structuredOutput = (await checkRouteResponseFormatSupport(routeModule)).ok
  } catch (error) {
    // With node fallbacks the load is the one `POST` would do, and its
    // failure is the route's — surfaced, never dressed up as a document.
    if (bootFallbacks) throw error
    // Without them, and without a static manifest seeding the module cache,
    // this runtime cannot read route modules here at all: nothing about the
    // route is settled, so nothing is claimed.
    return {}
  }

  const grants = options.approvalGrants
  const approvalsAnswerable =
    grants === undefined || !grantsRefuseEveryResume(grants.mode, grants.store)
  const approvals =
    isDescriptor &&
    approvalsAnswerable &&
    (await permissionsMode(options.permissionsStore)) === "interactive"
  const clientProvided =
    isDescriptor &&
    resolveRunEnvelopePolicy(options.config ?? options.boot?.config, route.routeId).clientTools &&
    options.clientTools?.store !== undefined
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
      clientProvided,
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
