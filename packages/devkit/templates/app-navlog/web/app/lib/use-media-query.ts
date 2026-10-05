import { useCallback, useSyncExternalStore } from "react"

/**
 * Whether a media query matches, kept current. `true` on the server and where
 * `matchMedia` does not exist (jsdom), so the first render is the desktop
 * layout and a phone switches once on hydration.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {}
      }
      const list = window.matchMedia(query)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia !== "function" || window.matchMedia(query).matches,
    () => true,
  )
}
