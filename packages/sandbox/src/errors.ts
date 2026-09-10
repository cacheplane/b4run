import type { B4ErrorCode } from "@b4run/sdk"

/** An `Error` tagged with a stable B4.run registry code so surfaces can link docs. */
export interface B4CodedError extends Error {
  readonly code: B4ErrorCode
}

/**
 * Construct a "sandbox unavailable" error carrying the `B4_E2001` code. The
 * code rides on the error object so an HTTP/SSE error body (or any caught-error
 * surface) can attach the docs link without re-deriving it from the message.
 */
export function sandboxUnavailable(message: string): B4CodedError {
  const error = new Error(message) as Error & { code: B4ErrorCode }
  error.code = "B4_E2001"
  return error
}
