import { allow, defineMiddleware } from "@b4run/sdk"
import { controllerRuntime } from "./lib/runtime.js"

/**
 * Not authorization (out of scope for this rung): the only lifecycle hook b4 gives an app.
 * `setup` opens the process's Factory, which reconciles the registry as it opens, so the
 * first request finds a reconciled registry; `dispose` closes it on shutdown.
 */
export default defineMiddleware({
  async setup() {
    await controllerRuntime().factory()
  },
  async dispose() {
    await controllerRuntime().dispose()
  },
  handle: () => allow(),
})
