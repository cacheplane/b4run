import { defineAuth } from "@b4run/sdk"

/** Resolve the caller once per request, from a trusted header. Replace it with your token check. */
export default defineAuth({
  authenticate: ({ headers }) => {
    const id = headers["x-user-id"]
    return id === undefined ? undefined : { id }
  },
})
