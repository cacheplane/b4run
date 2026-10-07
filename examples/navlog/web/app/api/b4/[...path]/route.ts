import { type NextRequest, NextResponse } from "next/server"
import { guardRequest } from "../../../lib/guarded-request"
import { resolveProxyTarget } from "../../../lib/proxy-allowlist"
import {
  isOwnerApprovalPath,
  isOwnerCookie,
  ownerCookieName,
  readCookie,
  upstreamHeaders,
} from "../../../lib/proxy-guard"

// Same-origin proxy to the B4.run server. A B4.run server sends no CORS headers
// unless `server.cors` is configured, and this app deliberately does not
// depend on that — the browser never learns B4.run's address. Every routing decision is in
// `lib/proxy-allowlist.ts`, which is where the tests are; this file is the
// adapter and deliberately holds no policy of its own. The deployment guards
// (origin, visitor cookie, rate limit, token) are in `lib/proxy-guard.ts`.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Matches app/api/copilotkit/[...path]/route.ts and the dev server's own bind address.
// `localhost` is not equivalent: on a dual-stack box it resolves `::1` first,
// which either pays a failed-connect retry or times out outright if `::1` is
// blackholed, while `127.0.0.1` (what the dev server actually binds) works
// immediately.
const SERVER_URL = process.env.B4_SERVER_URL ?? "http://127.0.0.1:3002"

// Next also routes HEAD requests into the GET export; the allowlist has no
// HEAD entries, so those deliberately fall through to the 403 branch below —
// still the honest answer: this proxy does not carry HEAD.
async function forward(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const guarded = await guardRequest(request, "b4")
  if (guarded.rejection !== undefined) return guarded.rejection
  const { path } = await context.params
  const target = resolveProxyTarget(request.method, path ?? [], SERVER_URL)
  if (target === null) {
    // 403, NOT 404: a 404 would read as "no such thing yet" and hide a broken
    // allowlist. "Refused, and deliberately" is what actually happened.
    return guarded.finish(NextResponse.json({ error: "Not proxied" }, { status: 403 }))
  }
  // Approving a memory changes what the agent believes for every visitor, so
  // in the deployed demo only the owner (the cookie `/api/admin` sets) may.
  // Inert in development, where there is no token and no other visitor.
  if (
    guarded.config.internalToken !== undefined &&
    isOwnerApprovalPath(path ?? []) &&
    !isOwnerCookie(
      readCookie(request.headers.get("cookie"), ownerCookieName(guarded.config)),
      process.env.B4_DEMO_ADMIN_TOKEN,
    )
  ) {
    return guarded.finish(
      NextResponse.json(
        { error: "owner_only", message: "Approving memories is reserved for the demo owner." },
        { status: 403 },
      ),
    )
  }
  try {
    // Every allowlisted route takes no request body, query string or auth
    // header, so none is forwarded — widen this deliberately if you add one
    // that does. The only headers sent are the guard's: the visitor id, and
    // the internal token when deployed. `signal` propagates a client abort so
    // it stops holding an upstream socket open; beyond that there is
    // deliberately no timeout, since undici's default is enough for a
    // localhost dev proxy.
    const upstream = await fetch(target, {
      headers: upstreamHeaders({
        internalToken: guarded.config.internalToken,
        visitorId: guarded.visitorId,
      }),
      method: request.method,
      signal: request.signal,
    })
    const headers: Record<string, string> = {
      // Every allowlisted route is volatile (candidates change on approve/
      // reject, thread state changes as the run progresses), so default to
      // no-store rather than let a client-facing cache serve a stale answer;
      // `force-dynamic` above only governs Next's own caches, not this.
      "cache-control": upstream.headers.get("cache-control") ?? "no-store",
    }
    const contentType = upstream.headers.get("content-type")
    if (contentType !== null) {
      headers["content-type"] = contentType
    }
    // Pass the body and status through untouched: the UI shows the B4.run
    // server's own error messages rather than a re-worded copy of them.
    return guarded.finish(new Response(upstream.body, { headers, status: upstream.status }))
  } catch (error) {
    // `fetch failed` (the error's own message) never says why; the useful
    // part of an undici network failure — ECONNREFUSED, etc. — is on `cause`.
    const cause = error instanceof Error && error.cause !== undefined ? error.cause : error
    return guarded.finish(
      NextResponse.json(
        { error: `Cannot reach the B4.run server at ${SERVER_URL}: ${String(cause)}` },
        { status: 502 },
      ),
    )
  }
}

export const GET = forward
export const POST = forward
