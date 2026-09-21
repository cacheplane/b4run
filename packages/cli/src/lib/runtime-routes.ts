/**
 * The URL surfaces the B4.run runtime owns — the one definition.
 *
 * Every place that has to split "the runtime's routes" from "everything else"
 * reads this: the composed Vercel target's route table
 * (`VERCEL_RUNTIME_ROUTE_SRC`) and the Node dev/edge composition helper
 * (`serve`). A host that hand-writes the list instead drifts — the surface
 * added after the host was written quietly stops being routed to the runtime,
 * and the caller finds out when a probe or an API call gets a 404 (or, behind
 * a SPA fallback, an HTML document and a 200).
 *
 * Keep this in step with the rooted routes the runtime fetch handler answers
 * (`dev/runtime-fetch-core.ts`).
 */
export const RUNTIME_ROUTE_SEGMENTS = ["healthz", "readyz", "agui", "threads", "memory"] as const

/**
 * The runtime's routes as a path-matching source string: a rooted first
 * segment, optionally followed by any deeper path.
 *
 * Written as a Vercel `routes[].src` (it is one) and compiled by
 * {@link isRuntimeOwnedPath} so the local split and the deployed route table
 * cannot disagree about which surfaces the runtime owns.
 */
export const RUNTIME_ROUTE_SRC = `/(${RUNTIME_ROUTE_SEGMENTS.join("|")})(/.*)?`

const RUNTIME_ROUTE_PATTERN = new RegExp(`^${RUNTIME_ROUTE_SRC}$`)

/**
 * Whether the runtime owns `pathname` — a URL pathname with no query string.
 *
 * Anchored on both ends and compiled from {@link RUNTIME_ROUTE_SRC} itself, so
 * `/threads` and `/threads/abc/runs/stream` match while `/threadsafe` does not.
 */
export function isRuntimeOwnedPath(pathname: string): boolean {
  return RUNTIME_ROUTE_PATTERN.test(pathname)
}
