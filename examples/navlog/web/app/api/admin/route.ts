import { NextResponse } from "next/server"
import {
  guardConfigFromEnv,
  ownerCookieName,
  ownerCookieValue,
  tokensMatch,
} from "../../lib/proxy-guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** A shorter admin token is guessable through this route, so it disables the route. */
const MIN_ADMIN_TOKEN_LENGTH = 32

/** Thirty days: long enough for a demo owner, short enough to rotate by forgetting. */
const OWNER_COOKIE_MAX_AGE = 60 * 60 * 24 * 30

/**
 * `GET /api/admin?token=<B4_DEMO_ADMIN_TOKEN>` makes this browser the demo
 * owner: it sets the HTTP-only cookie the b4 proxy requires before it forwards
 * a memory approve or reject. The cookie holds an HMAC of the token, never the
 * token. A wrong token gets 403 and no cookie. With no
 * `B4_DEMO_ADMIN_TOKEN` configured, or one shorter than 32 characters, the route
 * does not exist (404).
 */
export function GET(request: Request): Response {
  const expected = process.env.B4_DEMO_ADMIN_TOKEN
  if (!expected || expected.length < MIN_ADMIN_TOKEN_LENGTH) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const url = new URL(request.url)
  if (!tokensMatch(url.searchParams.get("token") ?? undefined, expected)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 })
  }

  const config = guardConfigFromEnv()
  const secure = config.internalToken ? "; Secure" : ""
  const response = NextResponse.redirect(new URL("/", url), 303)
  response.headers.append(
    "set-cookie",
    `${ownerCookieName(config)}=${ownerCookieValue(expected)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OWNER_COOKIE_MAX_AGE}${secure}`,
  )
  // The token was in the URL; keep it out of caches and the Referer of the next page.
  response.headers.set("cache-control", "no-store")
  response.headers.set("referrer-policy", "no-referrer")
  return response
}
