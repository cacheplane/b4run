import { createExecutionErrorBody } from "./server-errors.js"

/**
 * Build a JSON reply for a caller-supplied status code (middleware rejects),
 * mirroring the pre-refactor `sendJson` wire behavior. `sendJson` assigned
 * `res.statusCode` verbatim and let Node frame the response, which the web
 * `Response` constructor cannot always express:
 *
 * - **204 / 304** — Node suppressed the body (no Content-Length, no payload)
 *   while still sending `content-type: application/json`. `Response.json`
 *   would throw on these null-body statuses, so build the equivalent
 *   body-less Response directly. Exact wire parity.
 * - **205** — a null-body status for `Response`, but Node *did* send the JSON
 *   body. The body is dropped here (documented divergence; a 205 with a body
 *   is pathological and unrepresentable as a web Response).
 * - **body `undefined`** — `reject(status)` with the body omitted is a
 *   documented middleware call, and `JSON.stringify(undefined)` is `undefined`,
 *   so the old `sendJson` did `res.end(undefined)`: an empty payload under the
 *   JSON content-type, at the requested status. `Response.json(undefined)`
 *   throws instead, which used to fall into the catch below and answer 500 —
 *   so build the empty-bodied Response directly. Exact wire parity.
 * - **status < 200 or > 599** — Node accepted 100-999 verbatim and threw on
 *   the rest (which the old server's catch turned into a 500). `Response`
 *   only accepts 200-599, so everything outside that range becomes the same
 *   standard 500 the old server produced for invalid codes (documented
 *   divergence for 100-199 / 600-999, which the old server passed through).
 */
export function statusResponse(status: number, body: unknown): Response {
  if (status === 204 || status === 205 || status === 304) {
    return new Response(null, {
      headers: { "content-type": "application/json" },
      status,
    })
  }
  try {
    // Inside the `try` so an out-of-range status still becomes the 500 below:
    // the `Response` constructor throws on those exactly as `Response.json` does.
    if (body === undefined) {
      return new Response(null, {
        headers: { "content-type": "application/json" },
        status,
      })
    }
    return Response.json(body, { status })
  } catch {
    return Response.json(createExecutionErrorBody("Unexpected runtime server failure"), {
      status: 500,
    })
  }
}
