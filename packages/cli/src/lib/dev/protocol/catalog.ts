/** Standard Agent resources over the runtime registry. This is a discovery
 * projection only: authorization never changes execution's registry. */

import { toRouteSegments } from "@b4run/core"
import { isB4Agent } from "@b4run/sdk"
import type { AgentLimitsV1, AgentSchema, B4Agent } from "@b4run/sdk/agent-protocol"
import {
  type BootResolvedInstances,
  getPreparedRouteModules,
} from "../../runtime/execute-route-core.js"
import { pureDirname } from "../../runtime/pure-path.js"
import { isPublicRunnableRoute } from "../../runtime/route-identity.js"
import { checkAgentProtocolDefault } from "../../verify/check-runtime.js"
import {
  type AgUiCapabilitiesRequestOptions,
  deriveAgUiCapabilities,
} from "../agui-capabilities.js"
import { requestPrincipal } from "../auth.js"
import { headersToRecord, runMiddleware } from "../middleware.js"
import type { RuntimeRegistry, RuntimeRegistryEntry } from "../runtime-registry-core.js"

/** Schema documents supplied by the resolved adapter/binding, never request JSON
 * or inert route config. No duplicate adapter execution contract is introduced. */
export type ResolvedAgentSchema = Pick<
  AgentSchema,
  "input_schema" | "output_schema" | "state_schema" | "config_schema"
>

export interface AgentCatalogOptions extends Omit<AgUiCapabilitiesRequestOptions, "routeKey"> {
  /** Effective ceilings owned by the resolved host. There are no catalog defaults. */
  readonly limits: AgentLimitsV1
  /** Already resolved adapter schema documents, keyed by exact canonical ID. */
  readonly routeSchemas?: ReadonlyMap<string, ResolvedAgentSchema>
  readonly resolved?: Pick<BootResolvedInstances, "checkpointer">
}

export class AgentCatalogError extends Error {
  constructor(
    readonly code: "not_found" | "agent_required" | "invalid_argument",
    readonly status: 404 | 422,
    message: string,
  ) {
    super(message)
    this.name = "AgentCatalogError"
  }
}

export interface AgentCatalog {
  list(query?: { readonly offset?: number; readonly limit?: number }): Promise<readonly B4Agent[]>
  get(agentId: string): Promise<B4Agent>
  schema(agentId: string): Promise<AgentSchema>
  /** Omitted REST selection only. ASP's assistantId remains required. */
  select(agentId?: string): RuntimeRegistryEntry
}

type AgentAuthorizationOptions = Pick<AgentCatalogOptions, "request" | "registry" | "middleware">
/** The shared route authorization pass. Exact receipts select the original
 * Agent without reading mutable default selection, descriptions or schemas. */
async function authorizedProtocolAgents(
  options: AgentAuthorizationOptions,
): Promise<RuntimeRegistryEntry[]> {
  const entries: RuntimeRegistryEntry[] = []
  const url = new URL(options.request.url)
  // Complete the authorization pass before any protected description import or
  // pagination. A denied default stays denied; it never becomes a fallback.
  for (const route of options.registry.entries.filter(isPublicRunnableRoute)) {
    const decision = await runMiddleware(options.middleware, {
      assistantId: route.assistantId,
      headers: headersToRecord(options.request.headers),
      principal: requestPrincipal(options.request),
      method: options.request.method,
      params: {},
      routeId: route.routeId,
      url: `${url.pathname}${url.search}`,
    })
    if (decision.action !== "reject") entries.push(route)
  }
  return entries
}
export async function authorizeProtocolAgent(
  options: AgentAuthorizationOptions,
  agentId: string,
): Promise<void> {
  const entries = await authorizedProtocolAgents(options)
  if (!entries.some((entry) => entry.assistantId === agentId))
    throw new AgentCatalogError("not_found", 404, "Agent not found")
}

export async function createAgentCatalog(options: AgentCatalogOptions): Promise<AgentCatalog> {
  validateLimits(options.limits)
  const defaultId = checkAgentProtocolDefault(
    options.config ?? options.boot?.config,
    options.registry.entries,
  )
  const entries = await authorizedProtocolAgents(options)
  const ids = new Set(entries.map((entry) => entry.assistantId))
  const routeIds = new Set(entries.map((entry) => entry.routeId))
  // Native subagent preflights scan a descriptor index. Limit that incidental
  // scan to authorized routes, without changing the runtime's actual registry.
  const registry: RuntimeRegistry = {
    appRoot: options.registry.appRoot,
    entries,
    lookup: (id) => entries.find((entry) => entry.assistantId === id) ?? null,
    // Even hand-built registries get a frozen authorized manifest; leaving it
    // absent would let native preflights rediscover the full protected tree.
    manifest: {
      appRoot: options.registry.appRoot,
      routes:
        options.registry.manifest?.routes.filter((route) => routeIds.has(route.id)) ??
        entries.map((route) => ({
          id: route.routeId,
          pathname: route.routeId,
          kind: route.mode,
          entryFile: route.routeFile,
          routeDir: pureDirname(route.routeFile),
          segments: toRouteSegments(route.routeId.split("/").filter(Boolean)),
        })),
    },
  }
  const boot =
    options.boot === undefined
      ? undefined
      : {
          ...options.boot,
          ...(options.boot.staticModules !== undefined
            ? {
                staticModules: {
                  ...options.boot.staticModules,
                  routes: options.boot.staticModules.routes.filter((route) =>
                    ids.has(route.assistantId),
                  ),
                },
              }
            : {}),
        }
  const select = (agentId?: string): RuntimeRegistryEntry => {
    const id = agentId ?? defaultId
    if (id === undefined)
      throw new AgentCatalogError("agent_required", 422, "An agent_id is required")
    const route = registry.lookup(id)
    if (!route) throw new AgentCatalogError("not_found", 404, "Agent not found")
    return route
  }
  const descriptions = new Map<string, Promise<B4Agent>>()
  const describe = (route: RuntimeRegistryEntry): Promise<B4Agent> => {
    const existing = descriptions.get(route.assistantId)
    if (existing) return existing
    const loading = (async (): Promise<B4Agent> => {
      const prepared =
        boot?.bootFallbacks !== undefined || boot?.staticModules !== undefined
          ? await getPreparedRouteModules(
              { appRoot: options.appRoot, routeFile: route.routeFile, routeId: route.routeId },
              boot.bootFallbacks,
            )
          : undefined
      if (prepared !== undefined && prepared.module.kind !== route.mode) {
        throw new Error("Loaded route kind does not match its canonical Agent ID")
      }
      const description = isB4Agent(prepared?.module.entry)
        ? prepared.module.entry.description
        : undefined
      const native = await deriveAgUiCapabilities(
        { ...options, registry, ...(boot !== undefined ? { boot } : {}) },
        route,
        options.resolved ?? {},
      )
      return {
        agent_id: route.assistantId,
        name: route.routeId,
        ...(description !== undefined ? { description } : {}),
        capabilities: {
          // The existing AG-UI binding is the one active transport in this host.
          // Its native declaration is kept whole, including unknown omissions.
          "run.b4.agui": {
            v: 1,
            path: `/agui/${encodeURIComponent(route.assistantId)}`,
            capabilities: native,
          },
        },
        metadata: {
          b4: {
            v: 1,
            kind: route.mode,
            isDefault: route.assistantId === defaultId,
            schemas: {},
            limits: options.limits,
          },
        },
      }
    })()
    descriptions.set(route.assistantId, loading)
    loading.catch(() => {
      if (descriptions.get(route.assistantId) === loading) descriptions.delete(route.assistantId)
    })
    return loading
  }
  return {
    select,
    get: async (id) => describe(select(id)),
    schema: async (id) => {
      const route = select(id)
      // Import errors are real route errors even for a route with no schema API.
      await describe(route)
      return {
        ...(options.routeSchemas?.get(route.assistantId) ?? {
          input_schema: {},
          output_schema: {},
        }),
        agent_id: route.assistantId,
      }
    },
    list: async (query = {}) => {
      const offset = query.offset ?? 0
      uint(offset, "offset")
      if (query.limit !== undefined) uint(query.limit, "limit")
      return Promise.all(
        entries
          .slice(offset, query.limit === undefined ? undefined : offset + query.limit)
          .map(describe),
      )
    },
  }
}

function uint(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AgentCatalogError("invalid_argument", 422, `${path} must be a known unsigned integer`)
  }
}

function validateLimits(limits: AgentLimitsV1): void {
  uint(limits.requestBytes, "limits.requestBytes")
  uint(limits.pendingPrompts, "limits.pendingPrompts")
  for (const key of ["snapshotBytes", "eventBytes"] as const) {
    if (limits[key] !== undefined) uint(limits[key], `limits.${key}`)
  }
  for (const [name, keys] of Object.entries({
    inbox: ["entries", "bytes", "textBytes"],
    viewer: ["events", "bytes"],
    staging: ["uploadBytes", "quotaBytes", "deadlineMs"],
  })) {
    const group = limits[name]
    if (group !== undefined) {
      const record = group as Record<string, unknown> | null
      for (const key of keys) uint(record?.[key], `limits.${name}.${key}`)
    }
  }
  if (limits.inspection !== undefined) {
    uint(limits.inspection.requestBytes, "limits.inspection.requestBytes")
    uint(limits.inspection.responseBytes, "limits.inspection.responseBytes")
    for (const key of ["defaults", "caps"] as const) {
      for (const bound of ["maxEntries", "maxFileBytes", "maxTotalBytes"] as const) {
        uint(limits.inspection[key]?.[bound], `limits.inspection.${key}.${bound}`)
      }
    }
  }
}
