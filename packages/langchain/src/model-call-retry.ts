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

const RETRY_KEYS: readonly string[] = [
  "maxAttempts",
  "baseDelay",
] satisfies readonly (keyof RetryConfig)[]

/**
 * The route's retry policy, defaulted and checked. Throws on a value that
 * cannot mean anything (not an object, an unknown key such as `maxAttemps`,
 * zero or fractional attempts, a negative delay), so a typo fails the route
 * instead of silently changing how often it retries.
 */
export function resolveModelRetryPolicy(retry: RetryConfig | undefined): ModelRetryPolicy {
  if (retry !== undefined) {
    if (typeof retry !== "object" || retry === null || Array.isArray(retry)) {
      throw new Error(
        `agent() retry must be an object with maxAttempts and/or baseDelay, got ${describeValue(retry)}.`,
      )
    }
    for (const key of Object.keys(retry)) {
      if (!RETRY_KEYS.includes(key)) {
        throw new Error(
          `agent() retry has an unknown key "${key}"; valid keys are ${RETRY_KEYS.join(", ")}.`,
        )
      }
    }
  }
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

function describeValue(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `${typeof value} ${String(value)}`
}

/** The chat model's `maxRetries`: the attempts after the first. */
export function providerMaxRetries(policy: ModelRetryPolicy): number {
  return policy.maxAttempts - 1
}

/**
 * The `maxRetries` for a chat model B4.run builds from a `retry` config:
 * `maxAttempts - 1`, with `maxAttempts` defaulting to 3. Throws on an
 * invalid `retry`, like the route itself. Used for the models B4 builds
 * besides the route's own: the summarizer, which gets its route's `retry`,
 * and the `b4 memory consolidate`/`reflect` distillation model, which has no
 * route and gets `{ maxAttempts }` from `b4.config.ts`'s
 * `memory.distill.retry` (validated by the CLI; unset means 3 attempts).
 *
 * `maxRetries` only reaches models whose requests go through
 * `@langchain/core`'s `AsyncCaller`. `ChatOllama`'s chat requests bypass it,
 * so on an Ollama model this has no effect.
 */
export function modelMaxRetries(retry: RetryConfig | undefined): number {
  return providerMaxRetries(resolveModelRetryPolicy(retry))
}

/** How many `MiddlewareError` layers {@link capacityRateLimitError} looks through. */
const MAX_MIDDLEWARE_WRAPPERS = 8

/**
 * `langchain`'s `MiddlewareError`, recognised by its `~brand` rather than by
 * `instanceof` (so a duplicate copy of `langchain` agrees) or by `name`
 * (which it copies from the error it wraps).
 */
function isMiddlewareError(error: object): error is Error {
  return error instanceof Error && (error as { "~brand"?: unknown })["~brand"] === "MiddlewareError"
}

/**
 * The capacity 429 LangChain raised, or `undefined`. `createAgent` wraps an
 * error thrown out of a `wrapModelCall` in a `MiddlewareError` whose `cause`
 * is the original. B4's middleware is the outermost `wrapModelCall`, so it
 * normally sees the provider's error as is; this also looks through those
 * wrappers so the retry does not depend on that ordering.
 */
function capacityRateLimitError(error: unknown): object | undefined {
  let current = error
  for (let depth = 0; depth <= MAX_MIDDLEWARE_WRAPPERS; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined
    if (
      getRetryable(current) === true &&
      (current as { rateLimitType?: unknown }).rateLimitType === "capacity"
    ) {
      return current
    }
    if (!isMiddlewareError(current)) return undefined
    current = current.cause
  }
  return undefined
}

/**
 * A 429 LangChain classified as a capacity limit and stamped retryable,
 * bare or inside `MiddlewareError`s. Recognised by LangChain's own stamps,
 * never by message text: the `retryable` mark (`getRetryable`, a
 * `Symbol.for` key, so duplicate copies of `@langchain/core` agree) and the
 * `rateLimitType` it sets alongside. A quota 429 carries
 * `rateLimitType: "stop"` and `retryable: false`; a 429 LangChain waited out
 * itself carries `rateLimitType: "wait"`.
 */
export function isCapacityRateLimitError(error: unknown): boolean {
  return capacityRateLimitError(error) !== undefined
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
  const source = capacityRateLimitError(error) ?? error
  const retryAfterMs =
    typeof source === "object" && source !== null
      ? (source as { retryAfterMs?: unknown }).retryAfterMs
      : undefined
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
 * capacity 429 whose `retryAfterMs` is over the 10s cap. An abort, whether
 * the signal was already aborted when the 429 arrived or fires during the
 * wait, rejects with the signal's reason and sends nothing more.
 *
 * Invariant: it only ever retries an error LangChain stamps when the request
 * is made (a capacity 429 is the response to the request itself, raised
 * before any token streams), so sending the call again cannot duplicate
 * streamed output. A failure mid-stream is never a capacity 429 and is
 * rethrown untouched. Widening what this retries would break that.
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
      if (options.signal?.aborted) throw abortReason(options.signal)
      const delay = capacityRetryDelay(error, attempt - 1, policy.baseDelay, clock.random)
      if (delay === undefined) throw error
      await clock.sleep(delay, options.signal)
    }
  }
}
