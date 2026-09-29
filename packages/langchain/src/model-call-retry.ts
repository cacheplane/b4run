/**
 * `agent({ retry })` for one model call.
 *
 * Two layers, both scoped to a single model request:
 *
 * 1. LangChain's own. Every built-in provider's chat model (except
 *    `ChatOllama`, whose chat requests bypass it) sends each request through
 *    `@langchain/core`'s `AsyncCaller`, which retries 5xx and network errors
 *    and waits out a 429 whose `Retry-After` is 60s or less. B4 sets its
 *    budget with the model's `maxRetries` ({@link providerMaxRetries}).
 * 2. This module's. `AsyncCaller` hands back, without retrying, a 429 it
 *    classifies as a capacity limit (no `Retry-After`, or one over 60s). That
 *    error is raised when the request is made, before any token, so B4 can
 *    send the same model call again without repeating output
 *    ({@link retryCapacityErrors}). A capacity 429 whose `retryAfterMs` is
 *    longer than B4's 10s cap is surfaced at once instead: retrying sooner
 *    than the server asked would only spend an attempt on another 429.
 */
import type { RetryConfig } from "@b4run/sdk"
import { getRetryable } from "@langchain/core/errors"

export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_BASE_DELAY_MS = 1000
export const MAX_RETRY_DELAY_MS = 10_000
const JITTER_MS = 500

export interface ModelRetryPolicy {
  /** Attempts per model call, counting the first. */
  readonly maxAttempts: number
  /** Milliseconds before the first capacity retry; doubles each time. */
  readonly baseDelay: number
}

/**
 * The route's retry policy, defaulted and checked. Throws on a value that
 * cannot mean anything (zero or fractional attempts, a negative delay), so a
 * typo fails the route instead of silently changing how often it retries.
 */
export function resolveModelRetryPolicy(retry: RetryConfig | undefined): ModelRetryPolicy {
  const maxAttempts = retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelay = retry?.baseDelay ?? DEFAULT_BASE_DELAY_MS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      `agent() retry.maxAttempts must be a whole number of at least 1, got ${String(maxAttempts)}.`,
    )
  }
  if (!Number.isFinite(baseDelay) || baseDelay < 0) {
    throw new Error(
      `agent() retry.baseDelay must be a number of milliseconds of at least 0, got ${String(baseDelay)}.`,
    )
  }
  return { maxAttempts, baseDelay }
}

/** The chat model's `maxRetries`: the attempts after the first. */
export function providerMaxRetries(policy: ModelRetryPolicy): number {
  return policy.maxAttempts - 1
}

/**
 * The `maxRetries` for a chat model B4.run builds from an `agent()`'s
 * `retry`: `maxAttempts - 1`, with `maxAttempts` defaulting to 3. Throws on an
 * invalid `retry`, like the route itself. Used for the models B4 builds
 * besides the route's own: the summarizer, and the `b4 memory` distillation
 * model (which has no route and passes `undefined`, the default policy).
 */
export function modelMaxRetries(retry: RetryConfig | undefined): number {
  return providerMaxRetries(resolveModelRetryPolicy(retry))
}

/**
 * A 429 LangChain classified as a capacity limit and stamped retryable.
 * Recognised by LangChain's own stamps, never by message text: the
 * `retryable` mark (`getRetryable`, a `Symbol.for` key, so duplicate copies
 * of `@langchain/core` agree) and the `rateLimitType` it sets alongside.
 * A quota 429 carries `rateLimitType: "stop"` and `retryable: false`.
 */
export function isCapacityRateLimitError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    getRetryable(error) === true &&
    (error as { rateLimitType?: unknown }).rateLimitType === "capacity"
  )
}

/**
 * The wait before capacity retry `retryIndex` (0 for the first retry), or
 * `undefined` when B4 must not retry at all.
 *
 * - The error carries a `retryAfterMs` (LangChain parsed a `Retry-After`
 *   header, or a "try again in …" message): wait exactly that when it is 10s
 *   or less; otherwise `undefined`, so the error surfaces right away with its
 *   `retryAfterMs` for the caller to act on.
 * - No `retryAfterMs`: `baseDelay * 2^retryIndex` plus up to 500ms of jitter,
 *   capped at 10s.
 */
export function capacityRetryDelay(
  error: unknown,
  retryIndex: number,
  baseDelay: number,
  random: () => number,
): number | undefined {
  const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return retryAfterMs <= MAX_RETRY_DELAY_MS ? retryAfterMs : undefined
  }
  return Math.min(baseDelay * 2 ** retryIndex + random() * JITTER_MS, MAX_RETRY_DELAY_MS)
}

/** Time source for the backoff; replaced in tests. */
export interface RetryClock {
  readonly sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>
  readonly random: () => number
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted")
}

export const systemRetryClock: RetryClock = {
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal))
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortReason(signal as AbortSignal))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      signal?.addEventListener("abort", onAbort, { once: true })
    }),
  random: () => Math.random(),
}

/**
 * Run one model call, sending it again after a capacity 429 until it
 * succeeds, fails another way, has used `maxAttempts` attempts, or hits a
 * capacity 429 whose `retryAfterMs` is over the 10s cap. An abort during the
 * wait rejects with the signal's reason and sends nothing more.
 */
export async function retryCapacityErrors<T>(
  call: () => T | Promise<T>,
  policy: ModelRetryPolicy,
  options: { readonly signal?: AbortSignal; readonly clock?: RetryClock } = {},
): Promise<T> {
  const clock = options.clock ?? systemRetryClock
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call()
    } catch (error) {
      if (!isCapacityRateLimitError(error) || attempt >= policy.maxAttempts) throw error
      if (options.signal?.aborted) throw error
      const delay = capacityRetryDelay(error, attempt - 1, policy.baseDelay, clock.random)
      if (delay === undefined) throw error
      await clock.sleep(delay, options.signal)
    }
  }
}
