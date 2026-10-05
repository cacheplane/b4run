import { allow, defineMiddleware, reject } from "@b4run/sdk"
import { principalOf } from "./auth.js"

/**
 * Route execution needs a principal; tools read it as `ctx.middleware.visitorId`.
 *
 * Inert in development: with no `B4_INTERNAL_TOKEN`, `principalOf` returns the
 * local principal for every request. Behind the deployed proxy, a request with
 * no valid `X-B4-Visitor` is refused before any route runs.
 */
export default defineMiddleware(async (req) => {
  const user = await principalOf(req.headers)
  if (!user) return reject(401, { error: "unauthorized" })
  return allow({ visitorId: user.id })
})
