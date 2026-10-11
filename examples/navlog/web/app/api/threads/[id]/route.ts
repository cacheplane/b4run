import { guardRequest } from "../../../lib/guarded-request"
import { upstreamHeaders } from "../../../lib/proxy-guard"

// Whether this visitor can open a thread: `GET /api/threads/<id>` answers 204
// when the B4.run server will serve it to them, 404 when it will not (no such
// thread, or another visitor's). The sidebar asks before it trusts a thread
// it remembers: the list lives in this browser's storage, ownership lives in
// the visitor cookie, and a cleared cookie leaves rows the server now refuses.
//
// The answer is the status alone. The thread's metadata and history stay
// server-side (the `/api/b4` proxy deliberately does not carry them), so this
// route reads `GET /threads/:id` and sends back nothing but what it learned.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The same default as the other routes: the address the dev server binds.
const SERVER_URL = process.env.B4_SERVER_URL ?? "http://127.0.0.1:3002"

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guardRequest(request, "b4")
  if (guarded.rejection !== undefined) return guarded.rejection
  const { id } = await context.params
  const noStore = { "cache-control": "no-store" }
  try {
    const upstream = await fetch(
      `${SERVER_URL.replace(/\/+$/, "")}/threads/${encodeURIComponent(id)}`,
      {
        headers: upstreamHeaders({
          internalToken: guarded.config.internalToken,
          visitorId: guarded.visitorId,
        }),
        signal: request.signal,
      },
    )
    // Only the verdict crosses: open it, or it is not yours. Anything else
    // (a server error) is passed on as a status, so the sidebar keeps the row.
    await upstream.body?.cancel()
    const status = upstream.ok ? 204 : upstream.status
    return guarded.finish(new Response(null, { status, headers: noStore }))
  } catch {
    // Unreachable: the same 502 the proxy answers, so the caller keeps the row.
    return guarded.finish(new Response(null, { status: 502, headers: noStore }))
  }
}
