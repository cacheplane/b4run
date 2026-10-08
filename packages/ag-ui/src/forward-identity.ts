/**
 * Forward the current caller to a B4.run server from a server-side AG-UI
 * client: a CopilotKit runtime route, or any proxy that talks to B4.run on a
 * browser's behalf.
 *
 * The hop from that route to B4.run is server-to-server, so the route can vouch
 * for who the browser is: it sends the caller's identity in headers it alone
 * sets (alongside a shared secret, typically), and the B4.run app's
 * `src/auth.ts` checks the secret and reads the identity. Two things make that
 * safe, and this wrapper does both on every upstream call:
 *
 * - **Strip.** CopilotKit copies the browser's `authorization` and `x-*`
 *   headers onto the agent for a run, so a browser could send the identity
 *   headers itself. Every declared header is deleted from whatever the call
 *   carried before anything is set.
 * - **Set.** `resolve()` supplies the current request's values. It is called
 *   per upstream call, because the agent and runner are shared across requests:
 *   read the caller from request-scoped state, such as an `AsyncLocalStorage`
 *   the route's handler runs inside.
 *
 * Hand the returned `fetch` to both `B4HttpAgent` (runs) and
 * `createB4AgentRunner` (thread replay), so neither path can forget it.
 */

export interface ForwardIdentityOptions {
  /**
   * The header names this forwarding owns, case-insensitive. Each is always
   * stripped from what the call carried, whether or not `resolve` sets it.
   *
   * On a LangSmith deployment, do not use `x-*` names for a secret: LangGraph
   * copies `x-*` request headers into the stored thread config.
   */
  readonly headers: readonly string[]
  /**
   * The current caller's header values, or `undefined` to send none (the
   * B4.run app then sees an anonymous request). Every key must be one of
   * `headers`.
   */
  readonly resolve: () => Readonly<Record<string, string>> | undefined
  /** The fetch to wrap. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch
}

/** A `fetch` that strips the declared identity headers and sets the current caller's. */
export function forwardIdentity(options: ForwardIdentityOptions): typeof fetch {
  const owned = new Set(options.headers.map((name) => name.toLowerCase()))
  if (owned.size === 0) throw new TypeError("forwardIdentity: declare at least one header")
  const inner = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    for (const name of owned) headers.delete(name)
    const values = options.resolve()
    if (values !== undefined) {
      for (const [name, value] of Object.entries(values)) {
        if (!owned.has(name.toLowerCase())) {
          throw new TypeError(
            `forwardIdentity: resolve() returned "${name}", which is not one of the declared headers, ` +
              "so a browser could also send it. Add it to `headers`.",
          )
        }
        headers.set(name, value)
      }
    }
    return inner(input, { ...init, headers })
  }) as typeof fetch
}
