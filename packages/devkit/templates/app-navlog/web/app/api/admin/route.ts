import { NextResponse } from "next/server"
import { OWNER_COOKIE, tokensMatch } from "../../lib/proxy-guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Thirty days: long enough for a demo owner, short enough to rotate by forgetting. */
const OWNER_COOKIE_MAX_AGE = 60 * 60 * 24 * 30

/**
 * `GET /api/admin?token=<B4_DEMO_ADMIN_TOKEN>` makes this browser the demo
 * owner: it sets the HTTP-only cookie the b4 proxy requires before it forwards
 * a memory approve or reject. A wrong token gets 403 and no cookie. With no
 * `B4_DEMO_ADMIN_TOKEN` configured the route does not exist (404).
 */
export function GET(request: Request): Response {
  const expected = process.env.B4_DEMO_ADMIN_TOKEN
  if (!expected) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const url = new URL(request.url)
  if (!tokensMatch(url.searchParams.get("token") ?? undefined, expected)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 })
  }

  const secure = process.env.B4_INTERNAL_TOKEN ? "; Secure" : ""
  const response = NextResponse.redirect(new URL("/", url), 303)
  response.headers.append(
    "set-cookie",
    `${OWNER_COOKIE}=${expected}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OWNER_COOKIE_MAX_AGE}${secure}`,
  )
  // The token was in the URL; keep it out of caches and the Referer of the next page.
  response.headers.set("cache-control", "no-store")
  response.headers.set("referrer-policy", "no-referrer")
  return response
}
