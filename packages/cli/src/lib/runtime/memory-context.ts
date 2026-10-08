/**
 * The pure half of memory resolution: builds the per-request memory
 * capability context from values the caller already has. Kept out of
 * `resolve-memory.ts` because that module reaches `b4.config.ts` (node:fs)
 * and lazily imports the sqlite memory store — neither belongs in the
 * `@b4run/cli/fetch` graph.
 */
import type { MemoryContext, MemoryWritesMode } from "@b4run/core"
// Namespace helpers come from the pure "./namespace" subpath, never the
// barrel: the barrel re-exports sqliteMemoryStore and so reaches node:sqlite.
import { type MemoryScopeTuple, serializeNamespace } from "@b4run/memory/namespace"
import { pureBasename } from "./pure-path.js"
import type { LoadedRouteMemory } from "./route-memory-shape.js"

/** The namespace of a request whose declared scope is incomplete: matches no stored row. */
export const UNSCOPED_NAMESPACE = "b4:unscoped"

/** Build the per-request memory capability context for a route with a memory.ts. */
export function buildMemoryContext(args: {
  defined: LoadedRouteMemory
  store: MemoryContext["store"]
  writes: MemoryWritesMode
  appRoot: string
  routePath: string
  now: () => string
  indexMaxEntries?: number
  extraScope?: Record<string, string>
  /** Resolved embedder when vector recall is enabled — the capability embeds
   *  writes + queries through it. Absent → keyword-only. */
  embedder?: MemoryContext["embedder"]
  /** Hybrid recall tuning threaded to the store's search (no embedder). */
  vector?: MemoryContext["vector"]
}): MemoryContext {
  const { defined } = args
  // Build all available dimensions from known sources.
  const allDims: Record<string, string> = {
    workspace: pureBasename(args.appRoot) || "app",
    route: args.routePath,
    ...(args.extraScope ?? {}),
  }
  // Restrict to only the dimensions this route declared in scope.
  // serializeNamespace accepts the MemoryScopeTuple keys (workspace, route, tenant, user, agent).
  const tuple: Record<string, string> = {}
  const missing: string[] = []
  for (const dim of defined.scope) {
    const value = allDims[dim]
    if (value !== undefined && value !== "") tuple[dim] = value
    else missing.push(dim)
  }
  // Fail closed. Dropping a declared dimension would put this request in the
  // shared namespace — every anonymous caller of a `user`-scoped route
  // reading and writing one memory. Instead memory is unavailable for it.
  // An unscoped request gets a namespace no stored row can have (it is not
  // `key=value`), so even a consumer that forgot to check `unavailable` reads
  // nothing and writes into nobody's memory.
  const namespace =
    missing.length > 0
      ? UNSCOPED_NAMESPACE
      : serializeNamespace(tuple as MemoryScopeTuple & Record<string, string>)
  const schema = defined.schema as {
    safeParse(d: unknown): {
      success: boolean
      data?: unknown
      error?: { message: string }
    }
  }
  return {
    store: args.store,
    namespace,
    ...(missing.length > 0
      ? {
          unavailable:
            `Long-term memory is unavailable for this request: it has no ${missing.join(" or ")} ` +
            "scope (for example, the caller is not signed in). Nothing was recalled or stored.",
        }
      : {}),
    writes: args.writes,
    defined: {
      kind: defined.kind,
      scope: defined.scope,
      ...(defined.identity ? { identity: defined.identity } : {}),
    },
    // The route's zod schema — surfaced as the `remember` tool's `data` shape.
    schema: defined.schema,
    validate: (data: unknown) => {
      const r = schema.safeParse(data)
      return r.success
        ? {
            ok: true as const,
            value: (r.data ?? {}) as Record<string, unknown>,
          }
        : {
            ok: false as const,
            errors: r.error?.message ?? "memory data failed schema validation",
          }
    },
    now: args.now,
    ...(args.indexMaxEntries !== undefined ? { indexMaxEntries: args.indexMaxEntries } : {}),
    ...(args.embedder ? { embedder: args.embedder } : {}),
    ...(args.vector ? { vector: args.vector } : {}),
  }
}
