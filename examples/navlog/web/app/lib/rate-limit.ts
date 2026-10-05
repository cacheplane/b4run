import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"
import type { LimiterVerdict } from "./proxy-guard"

/** Built on first use; `null` once we know Upstash is not configured. */
let limiter: Ratelimit | null | undefined

function getLimiter(): Ratelimit | null {
  if (limiter !== undefined) return limiter
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    limiter = null
    return limiter
  }
  limiter = new Ratelimit({
    redis: new Redis({ url, token }),
    // Ten requests a minute per visitor with a burst of ten: a planning turn is
    // one request, so this is generous for a person and tight for a script.
    limiter: Ratelimit.tokenBucket(10, "60 s", 10),
    analytics: false,
    prefix: "navlog",
  })
  return limiter
}

/**
 * Per visitor id; "unconfigured" when Upstash is absent or unreachable, so the
 * proxy fails open rather than taking the demo down with its limiter.
 */
export async function limiterVerdict(visitorId: string): Promise<LimiterVerdict> {
  const rl = getLimiter()
  if (rl === null) return "unconfigured"
  try {
    const { success } = await rl.limit(visitorId)
    return success ? "allow" : "limit"
  } catch (error) {
    console.warn(`[navlog] rate limiter unavailable, allowing the request: ${String(error)}`)
    return "unconfigured"
  }
}
