import { useSyncExternalStore } from "react"

const subscribe = (): (() => void) => () => {}

/**
 * False in the server render and during hydration, true once React owns the
 * page. A control rendered on the server is visible before its click handler
 * exists, and a click in that window does nothing; gating it on this keeps it
 * disabled (and Playwright's click waiting, since it waits for "enabled")
 * until the click will work.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
}
