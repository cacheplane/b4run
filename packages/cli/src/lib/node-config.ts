/**
 * The node lane's `loadB4Config`.
 *
 * `@b4run/core`'s config memo dispatches through a REGISTERED loader so the
 * request path stays free of `node:fs`/`tsx`; the disk loader ships from
 * `@b4run/core/node`. Importing this module registers it.
 *
 * Every CLI module that reads `b4.config.ts` imports `loadB4Config` FROM
 * HERE rather than from `@b4run/core`, so the registration travels with the
 * function and cannot be forgotten at a new entry point. That matters more
 * than usual: the resolvers below it (`resolve-memory`, `resolve-sandbox`)
 * swallow a config-load failure and fall back to defaults, so a missed
 * registration would degrade silently rather than fail loudly.
 */

import { loadB4Config } from "@b4run/core"
import { registerNodeConfigLoader } from "@b4run/core/node"

registerNodeConfigLoader()

export { loadB4Config }
