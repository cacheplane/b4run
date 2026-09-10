import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph-checkpoint"

// Checkpoint metadata is written by the saver, unlike client-writable thread
// metadata. Never accept this field from upstream: put() replaces it below.
const ROUTES_KEY = "b4:checkpoint-routes"
const wrappers = new WeakMap<BaseCheckpointSaver, Map<string, BaseCheckpointSaver>>()

/** Verified owners of the state in this exact checkpoint, including ancestors. */
export function checkpointRoutes(
  tuple: CheckpointTuple | undefined,
): readonly string[] | undefined {
  const metadata = tuple?.metadata
  if (!metadata || !Object.hasOwn(metadata, ROUTES_KEY)) return undefined
  const stamp: unknown = (metadata as unknown as Record<string, unknown>)[ROUTES_KEY]
  if (typeof stamp !== "object" || stamp === null || Array.isArray(stamp)) return undefined
  if (!Object.hasOwn(stamp, "checkpointId") || !Object.hasOwn(stamp, "routes")) return undefined
  const record = stamp as { checkpointId?: unknown; routes?: unknown }
  if (record.checkpointId !== tuple?.checkpoint.id || !Array.isArray(record.routes))
    return undefined
  if (
    record.routes.length === 0 ||
    ![...record.routes].every((route) => typeof route === "string" && route.length > 0)
  )
    return undefined
  return [...record.routes]
}

/**
 * Bind writes to a server-resolved route, in the same persisted record as the
 * checkpoint. A child can carry its parent's channel values, so it retains all
 * verified parent owners. Unknown ancestry stays unknown; a later public turn
 * must never relabel private state as public.
 *
 * Cache by saver and route to preserve materialized graph identity. All other
 * methods/getters use the original receiver, including custom private fields.
 */
export function routeCheckpointer(
  saver: BaseCheckpointSaver,
  routeKey: string,
): BaseCheckpointSaver {
  let routes = wrappers.get(saver)
  if (!routes) {
    routes = new Map()
    wrappers.set(saver, routes)
  }
  const cached = routes.get(routeKey)
  if (cached) return cached
  const put: BaseCheckpointSaver["put"] = async (config, checkpoint, metadata, versions) => {
    const parentId: unknown = config.configurable?.checkpoint_id
    let owners: readonly string[] | undefined
    if (parentId === undefined || parentId === null) {
      owners = [routeKey]
    } else if (typeof parentId === "string" && parentId.length > 0) {
      const parent = await saver.getTuple(config)
      const parentRoutes = parent?.checkpoint.id === parentId ? checkpointRoutes(parent) : undefined
      if (parentRoutes) owners = [...new Set([...parentRoutes, routeKey])].sort()
    }
    const trustedMetadata: typeof metadata & Record<string, unknown> = { ...metadata }
    delete trustedMetadata[ROUTES_KEY]
    if (owners) trustedMetadata[ROUTES_KEY] = { checkpointId: checkpoint.id, routes: owners }
    return saver.put(config, checkpoint, trustedMetadata, versions)
  }
  const wrapped = new Proxy(saver, {
    get(target, key) {
      if (key === "put") return put
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
    set(target, key, value) {
      return Reflect.set(target, key, value, target)
    },
  })
  routes.set(routeKey, wrapped)
  return wrapped
}
