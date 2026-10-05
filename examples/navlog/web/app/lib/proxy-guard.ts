/**
 * What a deployed proxy requires of a caller before anything is forwarded.
 *
 * Both proxy routes (`api/b4/[...path]` and `api/copilotkit/[...path]`) are the
 * only door to the B4.run server, so they carry the demo's guardrails:
 *
 * 1. Origin: with `B4_DEMO_ORIGINS` set, a browser call from any other origin is
 *    refused. A request with no `Origin` header (a same-origin GET, curl) passes;
 *    the limiter and the visitor cookie still apply to it.
 * 2. Visitor: every caller gets an HTTP-only `b4_visitor` cookie, and the id in
 *    it is forwarded as `X-B4-Visitor`. The server makes threads owned by that id.
 * 3. Rate limit: per visitor, through Upstash (`rate-limit.ts`). Without Upstash
 *    configured the limiter is skipped: the proxy fails open.
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
import { randomBytes, timingSafeEqual } from "node:crypto"

export interface GuardConfig {
  /** Origins allowed to call the proxy; empty means no origin check (development). */
  readonly allowedOrigins: readonly string[]
  /** The server's B4_INTERNAL_TOKEN; undefined means no token injection (development). */
  readonly internalToken: string | undefined
}

export type LimiterVerdict = "allow" | "limit" | "unconfigured"

export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "reject"; readonly status: number; readonly error: string }

/** The pure policy: origin first, then the limiter. Fails open when the limiter is unconfigured. */
export function decideRequest(
  input: GuardConfig & {
    readonly origin: string | undefined
    readonly visitorId: string
    readonly limiterVerdict: LimiterVerdict
  },
): Decision {
  if (
    input.allowedOrigins.length > 0 &&
    input.origin !== undefined &&
    !input.allowedOrigins.includes(input.origin)
  ) {
    return { kind: "reject", status: 403, error: "origin_not_allowed" }
  }
  if (input.limiterVerdict === "limit") {
    return { kind: "reject", status: 429, error: "rate_limit_exceeded" }
  }
  return { kind: "allow" }
}

export const VISITOR_COOKIE = "b4_visitor"
export const OWNER_COOKIE = "b4_demo_owner"

/** The pattern the server's `principalOf` accepts (server/src/auth.ts). */
const VISITOR_ID = /^v-[A-Za-z0-9_-]{8,64}$/

export function isValidVisitorId(value: string | undefined): value is string {
  return value !== undefined && VISITOR_ID.test(value)
}

export function mintVisitorId(): string {
  return `v-${randomBytes(12).toString("base64url")}`
}

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
