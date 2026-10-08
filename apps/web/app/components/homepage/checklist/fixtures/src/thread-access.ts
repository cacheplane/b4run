import { defineThreadAccess, deny, permit } from "@b4run/sdk"

export default defineThreadAccess({
  create: (req) => (req.principal ? permit({ ownerId: req.principal.id }) : deny()),
  fallback: (req) => {
    const owner = req.thread?.access?.ownerId
    return req.principal !== undefined && owner === req.principal.id ? permit() : deny()
  },
})
