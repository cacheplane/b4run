/**
 * Provider errors classified by LangChain itself, not hand-stamped: each one
 * is thrown through a real `AsyncCaller` with `maxRetries: 0`, so its name,
 * `retryable` stamp and rate-limit metadata are exactly what a chat model
 * built on `@langchain/core` hands back.
 */
import { AsyncCaller } from "@langchain/core/utils/async_caller"

interface HttpErrorShape {
  readonly status: number
  readonly message: string
  readonly headers?: Readonly<Record<string, string>>
  readonly code?: string
}

function httpError(shape: HttpErrorShape): Error {
  // Mirrors the provider SDKs' APIError: `status`, `headers`, and an
  // `error.code` from the response body.
  return Object.assign(new Error(shape.message), {
    status: shape.status,
    headers: shape.headers ?? {},
    ...(shape.code !== undefined ? { error: { code: shape.code } } : {}),
  })
}

async function classify(shape: HttpErrorShape): Promise<Error> {
  const caller = new AsyncCaller({ maxRetries: 0 })
  try {
    await caller.call(() => Promise.reject(httpError(shape)))
  } catch (error) {
    return error as Error
  }
  throw new Error("AsyncCaller resolved a call that always rejects")
}

/** A 429 with no `Retry-After`: LangChain's `RateLimitCapacityError`. */
export function headerlessRateLimit(): Promise<Error> {
  return classify({ status: 429, message: "Rate limit reached for requests" })
}

/** A 429 whose `Retry-After` (seconds) is too long for LangChain to wait out. */
export function longRetryAfterRateLimit(seconds: number): Promise<Error> {
  return classify({
    status: 429,
    message: "Rate limit reached for requests",
    headers: { "retry-after": String(seconds) },
  })
}

/** A quota 429: LangChain's `InsufficientQuotaError`, stamped not retryable. */
export function quotaExhausted(): Promise<Error> {
  return classify({
    status: 429,
    message: "You exceeded your current quota, please check your plan and billing details.",
    code: "insufficient_quota",
  })
}

/**
 * A 429 whose `Retry-After` LangChain waits out itself: stamped retryable
 * with `rateLimitType: "wait"`, which B4's own layer must leave alone.
 */
export function shortRetryAfterRateLimit(seconds: number): Promise<Error> {
  return classify({
    status: 429,
    message: "Rate limit reached for requests",
    headers: { "retry-after": String(seconds) },
  })
}

/** A 503, which LangChain retries itself; B4's own layer must leave it alone. */
export function serviceUnavailable(): Promise<Error> {
  return classify({ status: 503, message: "503 Service Unavailable" })
}
