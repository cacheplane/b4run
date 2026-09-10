/**
 * The NODE half of config loading: reading `b4.config.ts` off disk through
 * the tsx ESM loader. Split out of `config.ts` so the request path keeps the
 * memo (`loadB4Config`/`seedB4Config`) without `node:fs`, `node:path`,
 * `node:url` or `tsx` entering its module graph.
 *
 * Ships from `@b4run/core/node`.
 */

import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { B4_CONFIG_FILE, registerConfigLoader } from "./config.js"
import type { B4Config, LoadB4ConfigOptions, LoadedB4Config } from "./types.js"

let loaderPromise: Promise<void> | undefined

/**
 * Register the tsx ESM loader (idempotent). Exported so callers that import
 * user-authored TS modules directly (e.g. the inspector loading a route's
 * memory.ts) get deterministic TS loading even when no b4.config.ts exists —
 * loadB4Config only registers the loader when a config file is present.
 */
export async function registerTsxLoader(): Promise<void> {
  loaderPromise ??= (async () => {
    const { register } = (await import("tsx/esm/api")) as {
      readonly register: () => unknown
    }
    register()
  })()
  await loaderPromise
}

export async function loadB4ConfigUncached(options: LoadB4ConfigOptions): Promise<LoadedB4Config> {
  const configPath = join(options.appRoot, B4_CONFIG_FILE)
  await access(configPath, constants.F_OK)
  await registerTsxLoader()

  const mod = (await import(pathToFileURL(configPath).href)) as {
    readonly default?: unknown
  }

  if (!mod.default || typeof mod.default !== "object") {
    throw new Error(`${B4_CONFIG_FILE} must export default an object. Got: ${typeof mod.default}`)
  }

  return {
    appRoot: options.appRoot,
    config: mod.default as B4Config,
    configPath,
  }
}

/** Point `loadB4Config` at the disk loader. Idempotent. */
export function registerNodeConfigLoader(): void {
  registerConfigLoader(loadB4ConfigUncached)
}

// Importing this module IS the node opt-in: `@b4run/core/node` re-exports it,
// so every node entry that already reaches for the node barrel gets the disk
// loader with no call site of its own. `registerNodeConfigLoader` stays
// exported for entries that want the wiring explicit and greppable.
registerNodeConfigLoader()
