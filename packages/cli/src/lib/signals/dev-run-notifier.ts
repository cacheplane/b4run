/**
 * A process-wide hook the AG-UI handler calls when a run finishes, so the
 * `b4 dev` child can tell its parent without threading a parameter through
 * the runtime. No listener is set outside the dev child (`serveRuntime`,
 * `b4 start`, embedded hosts), so there it is a no-op. Type-only imports keep
 * this module safe for the edge entry graph.
 */
import type { RouteKind } from "./events.js"

export type DevRunListener = (info: { readonly routeKind: RouteKind }) => void

let listener: DevRunListener | null = null

export function setDevRunListener(next: DevRunListener | null): void {
  listener = next
}

export function notifyDevRunFinished(info: { readonly routeKind: RouteKind }): void {
  const current = listener
  if (current === null) return
  try {
    current(info)
  } catch {
    // A listener failure must never affect the run.
  }
}
