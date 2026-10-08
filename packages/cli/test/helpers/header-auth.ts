import { defineAuth } from "@b4run/sdk"

/**
 * A test app's `src/auth.ts`: the principal is `{ id }` from the first of
 * `names` the request carries, and a request with none of them is anonymous.
 * Lets a thread-access test keep driving callers with a header while its policy
 * reads `req.principal`.
 */
export function headerAuth(...names: readonly string[]) {
  return defineAuth({
    authenticate: ({ headers }) => {
      const id = names.map((name) => headers[name]).find((value) => value !== undefined)
      return id === undefined ? undefined : { id }
    },
  })
}
