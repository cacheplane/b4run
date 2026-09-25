import { allow, defineMiddleware, reject } from "@b4run/sdk"

export default defineMiddleware(async (req) => {
  if (!req.headers["x-api-key"]) {
    return reject(401, { error: "Missing x-api-key" })
  }
  return allow()
})
