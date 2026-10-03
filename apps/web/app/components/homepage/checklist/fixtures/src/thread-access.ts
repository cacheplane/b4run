import { defineThreadAccess, deny, permit } from "@b4run/sdk"
import { principalOf } from "./auth.js"

export default defineThreadAccess({
  create: async (req) => {
    const user = await principalOf(req.headers)
    return user ? permit({ ownerId: user.id }) : deny()
  },
  fallback: async (req) => {
    const user = await principalOf(req.headers)
    const owner = req.thread?.access?.ownerId
    return user !== undefined && owner === user.id ? permit() : deny()
  },
})
