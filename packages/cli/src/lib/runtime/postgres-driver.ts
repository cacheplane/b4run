/**
 * The pure decisions the emitted `stores.mjs` makes before it opens a pool:
 * which Postgres driver talks to `DATABASE_URL`, and what `B4_PG_WS_PROXY`
 * means. Exported through `@b4run/cli/fetch` so the generated file runs this
 * code rather than a copy of it, and so it can be tested without a build.
 *
 * No `node:` imports and no `process` — this is reachable from the edge-safe
 * fetch entry, whose module graph is pinned by `test/fetch-entry-purity.test.ts`.
 */

/** The driver a generated store factory opens its pool with. */
export type PostgresDriver = "neon" | "pg"

/** A normalised `B4_PG_WS_PROXY`: what the neon driver dials, and over what. */
export interface WsProxyTarget {
  /** `host:port` (or bare `host`) with no scheme — the form the driver prefixes itself. */
  readonly address: string
  /** `wss://` keeps TLS on the WebSocket; bare and `ws://` values turn it off. */
  readonly secure: boolean
}

export interface PostgresDriverSelection {
  readonly driver: PostgresDriver
  /** Present only when the neon driver is to dial a proxy. */
  readonly wsProxy?: WsProxyTarget
}

export interface SelectPostgresDriverInput {
  readonly databaseUrl: string
  /** The raw `B4_PG_DRIVER` value, if set. */
  readonly driver?: string | undefined
  readonly target: "hono" | "vercel"
  /** The raw `B4_PG_WS_PROXY` value, if set. */
  readonly wsProxy?: string | undefined
}

const WS_PROXY_FORMS = "host:port, optionally prefixed with ws:// or wss://"

function wsProxyError(value: string, detail: string): Error {
  return new Error(
    `B4_PG_WS_PROXY must be ${WS_PROXY_FORMS} (${detail}); received ${JSON.stringify(value)}.`,
  )
}

/**
 * Normalise a `B4_PG_WS_PROXY` value.
 *
 * `@neondatabase/serverless` builds the proxy URL itself — scheme from
 * `useSecureWebSocket`, path from `wsProxy(host, port)` — so the value it needs
 * is a bare `host:port`. People reasonably write `ws://host:port`, which used
 * to fail deep inside the driver with a message that named neither the
 * variable nor the format. Both spellings are accepted here; anything the
 * driver would append itself (a path, a query) is rejected up front.
 *
 * An empty or whitespace-only value is "unset", which is what an empty
 * `B4_PG_WS_PROXY=` line in an env file means in practice.
 */
export function normalizeWsProxy(value: string | undefined): WsProxyTarget | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === "") return undefined

  let secure = false
  let rest = trimmed
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)
  if (scheme) {
    const name = scheme[1]?.toLowerCase()
    if (name === "wss") secure = true
    else if (name !== "ws")
      throw wsProxyError(value, `the ${name}:// scheme is not a WebSocket scheme`)
    rest = trimmed.slice(scheme[0].length)
  }
  if (rest.endsWith("/")) rest = rest.slice(0, -1)
  if (rest === "") throw wsProxyError(value, "no host after the scheme")
  if (/[/?#]/.test(rest)) {
    throw wsProxyError(value, "the driver appends the /v1?address= path itself")
  }
  if (/\s/.test(rest)) throw wsProxyError(value, "the host contains whitespace")
  return { address: rest, secure }
}

const NEON_HOST_SUFFIX = ".neon.tech"

/** Does this connection string point at a Neon endpoint? */
function isNeonHost(databaseUrl: string): boolean {
  let hostname: string
  try {
    hostname = new URL(databaseUrl).hostname
  } catch {
    // Not a WHATWG URL. `pg` accepts a few forms `URL` does not, so leave the
    // verdict to the driver rather than guessing it is Neon.
    return false
  }
  return hostname.toLowerCase().endsWith(NEON_HOST_SUFFIX)
}

function parseDriver(value: string | undefined): PostgresDriver | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim().toLowerCase()
  if (trimmed === "") return undefined
  if (trimmed === "neon" || trimmed === "pg") return trimmed
  throw new Error(`B4_PG_DRIVER must be "neon" or "pg"; received ${JSON.stringify(value)}.`)
}

/**
 * Decide which driver the generated stores open their pool with.
 *
 * On `vercel` (a Node function with real TCP):
 *  1. `B4_PG_DRIVER` wins when set;
 *  2. otherwise a configured `B4_PG_WS_PROXY` means the neon driver — the proxy
 *     exists only for it, and a working proxy setup keeps working;
 *  3. otherwise a `*.neon.tech` host uses the neon driver and everything else
 *     (local Postgres, RDS, Supabase, …) gets a pooled `pg` connection, which
 *     is the only one of the two that can reach a plain Postgres at all.
 *
 * On `hono` (workerd, no TCP) the neon driver is the only option, so asking
 * for `pg` is an error rather than a silent downgrade.
 */
export function selectPostgresDriver(input: SelectPostgresDriverInput): PostgresDriverSelection {
  const requested = parseDriver(input.driver)
  const wsProxy = normalizeWsProxy(input.wsProxy)

  if (input.target === "hono") {
    if (requested === "pg") {
      throw new Error(
        "B4_PG_DRIVER=pg is not supported on the hono target: a workerd isolate has no TCP " +
          "sockets, so only the @neondatabase/serverless WebSocket driver can reach Postgres there.",
      )
    }
    return wsProxy ? { driver: "neon", wsProxy } : { driver: "neon" }
  }

  if (requested === "pg") {
    if (wsProxy) {
      throw new Error(
        "B4_PG_WS_PROXY is set alongside B4_PG_DRIVER=pg, but the WebSocket proxy only applies to " +
          "the neon driver. Unset one of them: drop B4_PG_WS_PROXY to connect over TCP with pg, or " +
          "drop B4_PG_DRIVER to keep dialling the proxy.",
      )
    }
    return { driver: "pg" }
  }
  if (requested === "neon" || wsProxy || isNeonHost(input.databaseUrl)) {
    return wsProxy ? { driver: "neon", wsProxy } : { driver: "neon" }
  }
  return { driver: "pg" }
}
