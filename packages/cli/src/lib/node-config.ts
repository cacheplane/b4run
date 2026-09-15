/**
 * The node lane's `loadB4Config`.
 *
 * `@b4run/core`'s config memo dispatches through a REGISTERED loader so the
 * request path stays free of `node:fs`/`tsx`; the disk loader ships from
 * `@b4run/core/node`. Importing this module registers it.
 *
 * Every CLI module that reads `b4.config.ts` imports `loadB4Config` FROM
 * HERE rather than from `@b4run/core`, so the registration travels with the
 * function and cannot be forgotten at a new entry point. Managed workspace resolution uses
 * loadOptionalB4Config so only a genuinely absent file selects defaults.
 */

import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { loadB4Config } from "@b4run/core"
import { registerNodeConfigLoader } from "@b4run/core/node"

registerNodeConfigLoader()

export { loadB4Config }

/** Missing config is optional; malformed config and missing imports are errors. */
export async function loadOptionalB4Config(appRoot: string) {
  try {
    return (await loadB4Config({ appRoot })).config
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    try {
      await lstat(join(appRoot, "b4.config.ts"))
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw statError
    }
    throw error
  }
}
