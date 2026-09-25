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
 * `request.text()` with a ceiling. Decoding matches `text()` (UTF-8, invalid
 * sequences replaced), so an endpoint that switches to this reads the same
 * string it read before for every body under the limit. Pure: every runtime the
 * fetch core serves (Node, Hono, Vercel) enforces the limit the same way.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid request body limit")
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
  try {
    for (;;) {
      const { done, value } = await reader.read()
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
