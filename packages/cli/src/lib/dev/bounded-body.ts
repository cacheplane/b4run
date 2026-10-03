import { createRequestErrorBody } from "./server-errors.js"

/**
 * A request body over its endpoint's limit. The body was not buffered: a declared
 * `content-length` over the limit is refused before a byte is read, and a
 * streamed body is cancelled the moment it passes the limit.
 */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`)
    this.name = "RequestBodyTooLargeError"
  }
}

/**
 * A request body that did not finish arriving within its endpoint's deadline. The
 * stream was cancelled: a client that trickles a body cannot hold the endpoint.
 */
export class RequestBodyTimeoutError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`Request body did not arrive within ${deadlineMs} ms`)
    this.name = "RequestBodyTimeoutError"
  }
}

/**
 * `request.text()` with a ceiling, and optionally a deadline for the whole body. Decoding matches `text()` (UTF-8, invalid
 * sequences replaced), so an endpoint that switches to this reads the same
 * string it read before for every body under the limit. Pure: every runtime the
 * fetch core serves (Node, Hono, Vercel) enforces the limit the same way.
 */
export async function readBoundedText(
  request: Request,
  maxBytes: number,
  options: { readonly deadlineMs?: number } = {},
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid request body limit")
  const deadlineMs = options.deadlineMs
  if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1))
    throw new Error("Invalid request body deadline")
  const declared = request.headers.get("content-length")?.trim()
  // Refused unread: the host discards a body nobody read, as it does for any
  // handler that answers without reading (on Node, after the response).
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes)
    throw new RequestBodyTooLargeError(maxBytes)
  const body = request.body
  if (!body) return ""
  const reader = body.getReader()
  // Decoded as it arrives: no second full-size byte buffer is ever assembled.
  const decoder = new TextDecoder()
  const parts: string[] = []
  let total = 0
  let timedOut = false
  // Cancelling settles the pending read as done, so the loop below ends at once.
  const timer =
    deadlineMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          reader.cancel().catch(() => {})
        }, deadlineMs)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (timedOut && deadlineMs !== undefined) throw new RequestBodyTimeoutError(deadlineMs)
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        // On Node this discards the rest of the upload without closing the socket
        // (`toWebRequest`), so the 413 reaches the client.
        await reader.cancel().catch(() => {})
        throw new RequestBodyTooLargeError(maxBytes)
      }
      parts.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
  parts.push(decoder.decode())
  return parts.join("")
}

/** The one 413 every bounded endpoint answers. */
export function payloadTooLarge(error: RequestBodyTooLargeError): Response {
  return Response.json(
    createRequestErrorBody(error.message, { code: "payload_too_large", maxBytes: error.maxBytes }),
    { status: 413 },
  )
}
