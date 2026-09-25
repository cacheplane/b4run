/**
 * A controllable `window.matchMedia` for tests. jsdom has none, and GSAP's
 * `matchMedia()` needs one. Not used by the site.
 */
export interface MediaStub {
  /** Sets which queries match, then notifies listeners the way a browser does. */
  change(next: Readonly<Record<string, boolean>>): Promise<void>
  restore(): void
}

type Listener = () => void

export function stubMatchMedia(initial: Readonly<Record<string, boolean>>): MediaStub {
  const matching = new Map(Object.entries(initial))
  const listeners = new Set<Listener>()
  const previous = Object.getOwnPropertyDescriptor(window, "matchMedia")
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      get matches() {
        return matching.get(query) ?? false
      },
      onchange: null,
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => false,
    }),
  })
  return {
    async change(next) {
      // GSAP ignores media changes that arrive within 2ms of the last one.
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (const [query, matches] of Object.entries(next)) matching.set(query, matches)
      for (const listener of [...listeners]) listener()
    },
    restore() {
      if (previous) Object.defineProperty(window, "matchMedia", previous)
      else Reflect.deleteProperty(window, "matchMedia")
    },
  }
}
