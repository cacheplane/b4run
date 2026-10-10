/**
 * What a deployed proxy requires of a caller before anything is forwarded.
 *
 * Both proxy routes (`api/b4/[...path]` and `api/copilotkit/[...path]`) are the
 * only door to the B4.run server, so they carry the demo's guardrails:
 *
 * 1. Origin: with `B4_DEMO_ORIGINS` set, a browser call from any other origin is
 *    refused. A request with no `Origin` header (a same-origin GET, curl) passes;
 *    the limiter and the visitor cookie still apply to it.
 * 2. Visitor: every caller gets an HTTP-only visitor cookie, and the id in it is
 *    forwarded as `X-B4-Visitor`. The server makes threads owned by that id.
 * 3. Rate limit: through Upstash (`rate-limit.ts`), keyed twice, on the visitor
 *    id AND on the client IP, so clearing the cookie does not reset the budget.
 *    A run (a CopilotKit POST) draws on a tight bucket, a read (an `/api/b4`
 *    GET) on a loose one. Without Upstash, or when it errors, the limiter is
 *    skipped: the proxy fails open.
 * 4. Token: with `B4_INTERNAL_TOKEN` set, every upstream call carries it, and the
 *    server refuses anything that does not.
 *
 * With none of these variables set (local development, the harness lanes) the
 * only effect is the visitor cookie and header, which the server ignores when it
 * has no token of its own.
 *
 * Everything here is pure so it is testable without Next; the request adapter is
 * `guarded-request.ts`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export interface GuardConfig {
  /** Origins allowed to call the proxy; empty means no origin check (development). */
  readonly allowedOrigins: readonly string[]
  /** The server's B4_INTERNAL_TOKEN; undefined means no token injection (development). */
  readonly internalToken: string | undefined
}

export type LimiterVerdict = "allow" | "limit" | "unconfigured"

/** One verdict per key the limiter counts against. */
export interface LimiterVerdicts {
  readonly visitor: LimiterVerdict
  readonly ip: LimiterVerdict
}

/** A run draws on the tight bucket, a read on the loose one. */
export type LimitBucket = "run" | "read"

export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "reject"; readonly status: number; readonly error: string }

/**
 * The pure policy: origin first, then the limiter, which refuses when either
 * key is over its budget. Fails open when the limiter is unconfigured.
 */
export function decideRequest(
  input: GuardConfig & {
    readonly origin: string | undefined
    readonly visitorId: string
    readonly limiterVerdicts: LimiterVerdicts
  },
): Decision {
  if (
    input.allowedOrigins.length > 0 &&
    input.origin !== undefined &&
    !input.allowedOrigins.includes(input.origin)
  ) {
    return { kind: "reject", status: 403, error: "origin_not_allowed" }
  }
  if (input.limiterVerdicts.visitor === "limit" || input.limiterVerdicts.ip === "limit") {
    return { kind: "reject", status: 429, error: "rate_limit_exceeded" }
  }
  return { kind: "allow" }
}

/** Which bucket a request draws on, or `undefined` for one that is not limited. */
export function limitBucketFor(
  surface: "b4" | "copilotkit",
  method: string,
): LimitBucket | undefined {
  if (surface === "copilotkit" && method === "POST") return "run"
  // `/api/copilotkit/info` (a GET) reads the route's capabilities upstream.
  if (method === "GET") return "read"
  return undefined
}

/**
 * The client IP the limiter keys on: `X-Real-IP`, else the first
 * `X-Forwarded-For` hop, else one shared "unknown" key.
 *
 * Trust assumption: this app runs behind Vercel's edge, which overwrites
 * `X-Forwarded-For` and sets `X-Real-IP` to the connecting client, so a caller
 * cannot choose its own key. Behind a proxy that passes client-supplied
 * forwarding headers through, these values are forgeable and the IP key is
 * only as good as that proxy; the visitor key still applies.
 */
export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim()
  if (real) return real
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded ? forwarded : "unknown"
}

/**
 * Cookie names. Deployed (the token set, so the cookies are `Secure`), the
 * `__Host-` prefix makes the browser refuse them unless they are Secure,
 * host-only and `Path=/`, so a sibling subdomain cannot plant one. Development
 * over plain http cannot use the prefix.
 */
export function visitorCookieName(config: GuardConfig): string {
  return config.internalToken ? "__Host-b4_visitor" : "b4_visitor"
}

/** The demo owner's cookie name; `__Host-` prefixed under the same rule as the visitor's. */
export function ownerCookieName(config: GuardConfig): string {
  return config.internalToken ? "__Host-b4_demo_owner" : "b4_demo_owner"
}

/** The pattern the server's `principalOf` accepts (server/src/auth.ts). */
const VISITOR_ID = /^v-[A-Za-z0-9_-]{8,64}$/

/** Whether a visitor id is one the server accepts. */
export function isValidVisitorId(value: string | undefined): value is string {
  return value !== undefined && VISITOR_ID.test(value)
}

/** A fresh random visitor id, in the server's accepted shape. */
export function mintVisitorId(): string {
  return `v-${randomBytes(12).toString("base64url")}`
}

/** The headers the proxy adds upstream: the internal token, when set, and the visitor id. */
export function upstreamHeaders(input: {
  readonly internalToken: string | undefined
  readonly visitorId: string
}): Record<string, string> {
  return {
    ...(input.internalToken ? { "x-internal-token": input.internalToken } : {}),
    "x-b4-visitor": input.visitorId,
  }
}

/** Memory candidate approve/reject: reserved for the demo owner in the deployed demo. */
export function isOwnerApprovalPath(path: readonly string[]): boolean {
  return (
    path.length === 4 &&
    path[0] === "memory" &&
    path[1] === "candidates" &&
    (path[3] === "approve" || path[3] === "reject")
  )
}

/** The guard's config from `B4_DEMO_ORIGINS` (comma-separated) and `B4_INTERNAL_TOKEN`. */
export function guardConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GuardConfig {
  return {
    allowedOrigins: (env.B4_DEMO_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    internalToken: env.B4_INTERNAL_TOKEN || undefined,
  }
}

/** One cookie's value out of a `Cookie` header; works on a plain `Request` as well as Next's. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=")
    if (index === -1) continue
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim()
  }
  return undefined
}

/** Constant-time comparison of a presented secret with the configured one. */
export function tokensMatch(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * What the owner cookie holds: an HMAC of the admin token, never the token
 * itself, so a leaked cookie (a log line, a screenshot of devtools) does not
 * hand over the secret that mints more of them.
 */
export function ownerCookieValue(adminToken: string): string {
  return createHmac("sha256", adminToken).update("b4-demo-owner").digest("base64url")
}

/** Whether a presented owner cookie was minted from `adminToken`, in constant time. */
export function isOwnerCookie(
  presented: string | undefined,
  adminToken: string | undefined,
): boolean {
  if (!adminToken) return false
  return tokensMatch(presented, ownerCookieValue(adminToken))
}
