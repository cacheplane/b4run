import { getEventListeners } from "node:events"
import { getRetryable } from "@langchain/core/errors"
import { MiddlewareError } from "langchain"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  capacityRetryDelay,
  isCapacityRateLimitError,
  MAX_RETRY_DELAY_MS,
  modelMaxRetries,
  providerMaxRetries,
  type RetryClock,
  resolveModelRetryPolicy,
  retryCapacityErrors,
  systemRetryClock,
} from "../src/model-call-retry.ts"
import {
  headerlessRateLimit,
  longRetryAfterRateLimit,
  quotaExhausted,
  serviceUnavailable,
  shortRetryAfterRateLimit,
} from "./helpers/langchain-errors.ts"

/** Records every wait instead of sleeping; `random` is pinned. */
function recordingClock(random = 0): RetryClock & { readonly waits: number[] } {
  const waits: number[] = []
  return {
    waits,
    random: () => random,
    sleep: async (ms, signal) => {
      waits.push(ms)
      if (signal?.aborted) throw signal.reason
    },
  }
}

describe("resolveModelRetryPolicy", () => {
  test("defaults to 3 attempts and a 1000ms base delay", () => {
    expect(resolveModelRetryPolicy(undefined)).toEqual({ maxAttempts: 3, baseDelay: 1000 })
    expect(resolveModelRetryPolicy({})).toEqual({ maxAttempts: 3, baseDelay: 1000 })
  })

  test("keeps the author's values", () => {
    expect(resolveModelRetryPolicy({ maxAttempts: 1, baseDelay: 0 })).toEqual({
      maxAttempts: 1,
      baseDelay: 0,
    })
  })

  test.each([0, -1, 1.5, Number.NaN])("rejects maxAttempts %s", (maxAttempts) => {
    expect(() => resolveModelRetryPolicy({ maxAttempts })).toThrow(/retry\.maxAttempts/)
  })

  test.each([-1, Number.POSITIVE_INFINITY, Number.NaN])("rejects baseDelay %s", (baseDelay) => {
    expect(() => resolveModelRetryPolicy({ baseDelay })).toThrow(/retry\.baseDelay/)
  })

  test("rejects an unknown key, naming it and the valid keys", () => {
    const typo = { maxAttemps: 5 } as unknown as Parameters<typeof resolveModelRetryPolicy>[0]
    expect(() => resolveModelRetryPolicy(typo)).toThrow(
      'agent() retry has an unknown key "maxAttemps"; valid keys are maxAttempts, baseDelay.',
    )
  })

  test.each([
    ["null", null],
    ["a number", 3],
    ["a string", "3"],
    ["an array", [3]],
  ])("rejects %s in place of the retry object", (_label, value) => {
    const retry = value as unknown as Parameters<typeof resolveModelRetryPolicy>[0]
    expect(() => resolveModelRetryPolicy(retry)).toThrow(
      /agent\(\) retry must be an object with maxAttempts and\/or baseDelay/,
    )
  })
})

describe("providerMaxRetries", () => {
  test("is the attempts after the first", () => {
    expect(providerMaxRetries({ maxAttempts: 1, baseDelay: 1000 })).toBe(0)
    expect(providerMaxRetries({ maxAttempts: 3, baseDelay: 1000 })).toBe(2)
    expect(providerMaxRetries({ maxAttempts: 5, baseDelay: 1000 })).toBe(4)
  })
})

describe("modelMaxRetries", () => {
  test("maps an agent's retry, defaulting to 3 attempts", () => {
    expect(modelMaxRetries(undefined)).toBe(2)
    expect(modelMaxRetries({ baseDelay: 10 })).toBe(2)
    expect(modelMaxRetries({ maxAttempts: 1 })).toBe(0)
    expect(modelMaxRetries({ maxAttempts: 6 })).toBe(5)
  })

  test("rejects an invalid retry like the route does", () => {
    expect(() => modelMaxRetries({ maxAttempts: 0 })).toThrow(/retry\.maxAttempts/)
  })
})

describe("isCapacityRateLimitError", () => {
  test("recognises LangChain's capacity 429s by their stamps", async () => {
    const headerless = await headerlessRateLimit()
    const longWait = await longRetryAfterRateLimit(120)
    expect(headerless.name).toBe("RateLimitCapacityError")
    expect(getRetryable(headerless)).toBe(true)
    expect(isCapacityRateLimitError(headerless)).toBe(true)
    expect(isCapacityRateLimitError(longWait)).toBe(true)
  })

  test("leaves a quota 429 alone", async () => {
    const quota = await quotaExhausted()
    expect(getRetryable(quota)).toBe(false)
    expect(isCapacityRateLimitError(quota)).toBe(false)
  })

  test("does not match on text or name alone", async () => {
    expect(isCapacityRateLimitError(new Error("429 rate limit"))).toBe(false)
    const named = Object.assign(new Error("slow down"), { name: "RateLimitCapacityError" })
    expect(isCapacityRateLimitError(named)).toBe(false)
    const unstamped = Object.assign(new Error("slow down"), { rateLimitType: "capacity" })
    expect(isCapacityRateLimitError(unstamped)).toBe(false)
    expect(isCapacityRateLimitError(await serviceUnavailable())).toBe(false)
    expect(isCapacityRateLimitError(undefined)).toBe(false)
  })

  test("a 503 comes through LangChain unstamped", async () => {
    const unavailable = await serviceUnavailable()
    expect(getRetryable(unavailable)).toBeUndefined()
    expect((unavailable as { rateLimitType?: unknown }).rateLimitType).toBeUndefined()
  })

  test("leaves a 429 LangChain already waited out", async () => {
    const waited = await shortRetryAfterRateLimit(5)
    expect(getRetryable(waited)).toBe(true)
    expect((waited as { rateLimitType?: unknown }).rateLimitType).toBe("wait")
    expect(isCapacityRateLimitError(waited)).toBe(false)
  })

  test("looks through the MiddlewareError createAgent wraps it in", async () => {
    const capacity = await headerlessRateLimit()
    const wrapped = MiddlewareError.wrap(capacity, "Inner")
    expect(wrapped).not.toBe(capacity)
    expect(wrapped.cause).toBe(capacity)
    expect(isCapacityRateLimitError(wrapped)).toBe(true)
    expect(isCapacityRateLimitError(MiddlewareError.wrap(wrapped, "Innermost"))).toBe(true)
    const quota = MiddlewareError.wrap(await quotaExhausted(), "Inner")
    expect(isCapacityRateLimitError(quota)).toBe(false)
  })
})

describe("capacityRetryDelay", () => {
  test("doubles baseDelay per retry and adds up to 500ms of jitter", async () => {
    const error = await headerlessRateLimit()
    expect(capacityRetryDelay(error, 0, 200, () => 0)).toBe(200)
    expect(capacityRetryDelay(error, 1, 200, () => 0)).toBe(400)
    expect(capacityRetryDelay(error, 2, 200, () => 0.5)).toBe(1050)
  })

  test("caps the backoff at 10 seconds", async () => {
    const error = await headerlessRateLimit()
    expect(capacityRetryDelay(error, 10, 1000, () => 0)).toBe(MAX_RETRY_DELAY_MS)
  })

  test("waits exactly the error's retryAfterMs when it is within 10 seconds", async () => {
    const shortWait = Object.assign(await headerlessRateLimit(), { retryAfterMs: 3000 })
    expect(capacityRetryDelay(shortWait, 0, 200, () => 0.9)).toBe(3000)
    const atCap = Object.assign(await headerlessRateLimit(), { retryAfterMs: MAX_RETRY_DELAY_MS })
    expect(capacityRetryDelay(atCap, 2, 200, () => 0)).toBe(MAX_RETRY_DELAY_MS)
  })

  test("does not retry when retryAfterMs is longer than 10 seconds", async () => {
    const longWait = await longRetryAfterRateLimit(120)
    expect((longWait as { retryAfterMs?: number }).retryAfterMs).toBe(120_000)
    expect(capacityRetryDelay(longWait, 0, 200, () => 0)).toBeUndefined()
    const justOver = Object.assign(await headerlessRateLimit(), { retryAfterMs: 10_001 })
    expect(capacityRetryDelay(justOver, 0, 200, () => 0)).toBeUndefined()
  })

  test("reads retryAfterMs through a MiddlewareError", async () => {
    const longWait = MiddlewareError.wrap(await longRetryAfterRateLimit(120), "Inner")
    expect(capacityRetryDelay(longWait, 0, 200, () => 0)).toBeUndefined()
    const shortWait = Object.assign(await headerlessRateLimit(), { retryAfterMs: 3000 })
    const wrapped = MiddlewareError.wrap(shortWait, "Inner")
    expect(capacityRetryDelay(wrapped, 0, 200, () => 0)).toBe(3000)
  })

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "429"],
  ])("backs off on a non-object error (%s) instead of throwing", (_label, error) => {
    expect(capacityRetryDelay(error, 1, 200, () => 0)).toBe(400)
  })
})

describe("systemRetryClock.sleep", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function abortListeners(signal: AbortSignal): number {
    return getEventListeners(signal, "abort").length
  }

  test("resolves after the delay and removes its abort listener", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let resolved = false
    const sleeping = systemRetryClock.sleep(1000, controller.signal).then(() => {
      resolved = true
    })
    expect(abortListeners(controller.signal)).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await sleeping
    expect(resolved).toBe(true)
    expect(abortListeners(controller.signal)).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("an abort mid-sleep rejects with the reason, clears the timer and the listener", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const outcome = systemRetryClock.sleep(5000, controller.signal).then(
      () => "resolved",
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(vi.getTimerCount()).toBe(1)
    const reason = new Error("client went away")
    controller.abort(reason)
    expect(await outcome).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
    expect(abortListeners(controller.signal)).toBe(0)
  })

  test("an already-aborted signal rejects at once without arming a timer", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = new Error("already gone")
    controller.abort(reason)
    await expect(systemRetryClock.sleep(1000, controller.signal)).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("retryCapacityErrors", () => {
  const policy = { maxAttempts: 3, baseDelay: 100 }

  test("sends the call again after a capacity 429 and returns its result", async () => {
    const clock = recordingClock()
    const capacity = await headerlessRateLimit()
    let calls = 0
    const result = await retryCapacityErrors(
      async () => {
        calls += 1
        if (calls < 3) throw capacity
        return "ok"
      },
      policy,
      { clock },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(3)
    expect(clock.waits).toEqual([100, 200])
  })

  test("stops after maxAttempts and rethrows the last error", async () => {
    const clock = recordingClock()
    const capacity = await headerlessRateLimit()
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw capacity
        },
        policy,
        { clock },
      ),
    ).rejects.toBe(capacity)
    expect(calls).toBe(3)
    expect(clock.waits).toEqual([100, 200])
  })

  test("surfaces a capacity 429 with a Retry-After over the cap at once", async () => {
    const clock = recordingClock()
    const longWait = await longRetryAfterRateLimit(120)
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw longWait
        },
        policy,
        { clock },
      ),
    ).rejects.toBe(longWait)
    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
    expect((longWait as { retryAfterMs?: number }).retryAfterMs).toBe(120_000)
  })

  test("waits a within-cap retryAfterMs, then sends the call again", async () => {
    const clock = recordingClock()
    const shortWait = Object.assign(await headerlessRateLimit(), { retryAfterMs: 4000 })
    let calls = 0
    const result = await retryCapacityErrors(
      async () => {
        calls += 1
        if (calls === 1) throw shortWait
        return "ok"
      },
      policy,
      { clock },
    )
    expect(result).toBe("ok")
    expect(clock.waits).toEqual([4000])
  })

  test("maxAttempts 1 sends the call once", async () => {
    const clock = recordingClock()
    const capacity = await headerlessRateLimit()
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw capacity
        },
        { maxAttempts: 1, baseDelay: 100 },
        { clock },
      ),
    ).rejects.toBe(capacity)
    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  test.each([
    ["a quota 429", quotaExhausted],
    ["a 503", serviceUnavailable],
    ["a 429 LangChain already waited out", () => shortRetryAfterRateLimit(5)],
    ["an unclassified error", async () => new Error("429 rate limit")],
  ])("does not retry %s", async (_label, make) => {
    const clock = recordingClock()
    const error = await make()
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw error
        },
        policy,
        { clock },
      ),
    ).rejects.toBe(error)
    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  test("an abort during the wait stops the retry", async () => {
    const controller = new AbortController()
    const capacity = await headerlessRateLimit()
    const clock: RetryClock = {
      random: () => 0,
      sleep: async (_ms, signal) => {
        controller.abort(new Error("client went away"))
        if (signal?.aborted) throw signal.reason
      },
    }
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw capacity
        },
        policy,
        { signal: controller.signal, clock },
      ),
    ).rejects.toThrow("client went away")
    expect(calls).toBe(1)
  })

  test("an already-aborted signal rejects with its reason and does not wait", async () => {
    const controller = new AbortController()
    const reason = new Error("client went away")
    controller.abort(reason)
    const clock = recordingClock()
    const capacity = await headerlessRateLimit()
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw capacity
        },
        policy,
        { signal: controller.signal, clock },
      ),
    ).rejects.toBe(reason)
    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  test("retries a capacity 429 an inner middleware wrapped, rethrowing the wrapper", async () => {
    const clock = recordingClock()
    const wrapped = MiddlewareError.wrap(await headerlessRateLimit(), "Inner")
    let calls = 0
    await expect(
      retryCapacityErrors(
        async () => {
          calls += 1
          throw wrapped
        },
        policy,
        { clock },
      ),
    ).rejects.toBe(wrapped)
    expect(calls).toBe(3)
    expect(clock.waits).toEqual([100, 200])
  })
})
