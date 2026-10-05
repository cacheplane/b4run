/**
 * The one place this app turns a request into a principal.
 *
 * B4.run has two authorization files with two different jobs. `src/middleware.ts`
 * answers "may this caller run this route"; `src/thread-access.ts` answers "may
 * this caller create, read, mutate or destroy this thread". Nothing makes them
 * agree, and two independent header parsers is a confused deputy waiting to
 * happen. So both import this module, and neither parses a header of its own.
 *
 * Behind the deployed proxy (`B4_INTERNAL_TOKEN` set), the web proxy mints a
 * visitor id into an HTTP-only cookie and forwards it as `X-B4-Visitor` on
 * every upstream call, together with the shared token as `X-Internal-Token`.
 * The visitor header is trusted only on a request that also carries the token,
 * which this module checks itself, so route runs (the middleware) and thread
 * routes (the thread-access policy) refuse an untokened call even when the app
 * runs the plain `.b4/build/server.mjs`. Those two are all it gates: `/healthz`
 * and the `/memory/*` review routes answer without a principal. The example
 * repository's `main.mjs` guards the whole process with the same token.
 *
 * In local development (no token) there is no proxy and one local principal
 * owns everything, which is what `b4 dev`, the harness lanes and the tests
 * expect.
 */

import { timingSafeEqual } from "node:crypto"

export interface Principal {
  readonly id: string
  readonly isAdmin: boolean
  readonly org: string
}

/** Who owns everything when no proxy guards the server (local development). */
export const LOCAL_PRINCIPAL: Principal = { id: "local", isAdmin: true, org: "local" }

/** What the web proxy mints: `v-` and base64url. Anything else is not a visitor. */
const VISITOR_ID = /^v-[A-Za-z0-9_-]{8,64}$/

/**
 * Resolve the caller, or `undefined` when there is no principal.
 *
 * `undefined` means "no principal", and every caller must read it as a denial,
 * never as an anonymous allow.
 *
 * `headers` arrives with lowercase keys and repeated headers joined with ", ",
 * so two `X-B4-Visitor` headers become one string that the strict pattern
 * rejects.
 */
export async function principalOf(
  headers: Readonly<Record<string, string>>,
): Promise<Principal | undefined> {
  const token = process.env.B4_INTERNAL_TOKEN
  if (!token) return await Promise.resolve(LOCAL_PRINCIPAL)
  if (!sameSecret(headers["x-internal-token"], token)) return undefined
  const id = headers["x-b4-visitor"]
  if (id === undefined || !VISITOR_ID.test(id)) return undefined
  return { id, isAdmin: false, org: "demo" }
}

/** Constant-time comparison; unequal lengths are refused before comparing. */
function sameSecret(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
