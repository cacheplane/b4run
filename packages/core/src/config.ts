import type { B4Config, LoadB4ConfigOptions, LoadedB4Config } from "./types.js"

export const B4_CONFIG_FILE = "b4.config.ts"

/**
 * How a config is materialized for an appRoot. The only implementation B4.run
 * ships reads `b4.config.ts` from disk through the tsx loader and lives in
 * `config-node.ts` (`@b4run/core/node`) — this module stays free of `node:`
 * imports so the request path never drags the filesystem or a TS loader in.
 */
export type B4ConfigLoader = (options: LoadB4ConfigOptions) => Promise<LoadedB4Config>

let configLoader: B4ConfigLoader | undefined

/**
 * Opt this process into loading configs. The node lane registers the disk
 * loader (`registerNodeConfigLoader` in `@b4run/core/node`); an embedder on a
 * runtime with no filesystem either registers its own or seeds the memo with
 * `seedB4Config` and never reaches this path at all.
 */
export function registerConfigLoader(loader: B4ConfigLoader): void {
  configLoader = loader
}

/** Test-only: drop the registered loader so a suite can exercise its absence. */
export function __clearConfigLoaderForTests(): void {
  configLoader = undefined
}

const configCache = new Map<string, Promise<LoadedB4Config>>()

/**
 * Loads the config for the given appRoot through the registered loader,
 * memoized for the lifetime of the process. Config edits during `b4 dev` are
 * picked up because the dev loop restarts the child process on config changes
 * — a fresh process means a fresh (empty) cache.
 */
export function loadB4Config(options: LoadB4ConfigOptions): Promise<LoadedB4Config> {
  const cached = configCache.get(options.appRoot)
  if (cached) return cached
  const loader = configLoader
  if (!loader) {
    // Rejected, never thrown synchronously: every caller treats this as a
    // promise-returning function.
    return Promise.reject(
      new Error(
        `${options.appRoot}: no config loader registered — this runtime cannot read ${B4_CONFIG_FILE}; pass \`config\` to the runtime instead (see the edge deployment docs).`,
      ),
    )
  }
  const loading = loader(options)
  configCache.set(options.appRoot, loading)
  // A failed load must not be cached forever (e.g. a transient syntax error
  // would otherwise poison the process) — evict on rejection, but only if the
  // cache still holds THIS load: a seedB4Config that raced in while the
  // load was in flight must not be evicted by the stale rejection.
  loading.catch(() => {
    if (configCache.get(options.appRoot) === loading) {
      configCache.delete(options.appRoot)
    }
  })
  return loading
}

/**
 * Prime the per-appRoot config memo with an already-constructed B4Config —
 * the static-wiring seam for runtimes with no filesystem (edge) and for
 * callers that carry their config as an object. Symmetric with
 * seedPreparedRouteModules. Overwrites any cached entry: an explicit seed
 * always beats a disk load, and survives an in-flight disk load rejecting
 * after the seed lands (the rejection eviction is identity-checked).
 */
export function seedB4Config(appRoot: string, config: B4Config): void {
  configCache.set(appRoot, Promise.resolve({ appRoot, config, configPath: "<seeded>" }))
}

/** Test-only: clear the memo so fixtures can reload a mutated config. */
export function __clearB4ConfigCacheForTests(): void {
  configCache.clear()
}
