import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"
import type { LimitBucket, LimiterVerdict, LimiterVerdicts } from "./proxy-guard"

/** Built on first use; `null` once we know Upstash is not configured. */
let limiters: Readonly<Record<LimitBucket, Ratelimit>> | null | undefined

function getLimiters(): Readonly<Record<LimitBucket, Ratelimit>> | null {
  if (limiters !== undefined) return limiters
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    limiters = null
    return limiters
  }
  const redis = new Redis({ url, token })
  limiters = {
    // A run is a model call, so this is the spend guard: ten a minute with a
    // burst of ten is generous for a person planning a flight and tight for a
    // script.
    run: new Ratelimit({
      redis,
      limiter: Ratelimit.tokenBucket(10, "60 s", 10),
      analytics: false,
      prefix: "navlog:run",
    }),
    // Reads (thread state, pending interrupts, the memory list) are cheap and
    // the Workbench makes several per turn; this only stops a flood.
    read: new Ratelimit({
      redis,
      limiter: Ratelimit.tokenBucket(120, "60 s", 120),
      analytics: false,
      prefix: "navlog:read",
    }),
  }
  return limiters
}

async function verdict(limiter: Ratelimit, key: string): Promise<LimiterVerdict> {
  try {
    const { success } = await limiter.limit(key)
    return success ? "allow" : "limit"
  } catch (error) {
    // Fail open rather than take the demo down with its limiter.
    console.warn(`[navlog] rate limiter unavailable, allowing the request: ${String(error)}`)
    return "unconfigured"
  }
}

const UNLIMITED: LimiterVerdicts = { visitor: "unconfigured", ip: "unconfigured" }

/**
 * One verdict for the visitor id and one for the client IP, against the
 * bucket's budget. "unconfigured" for both when Upstash is absent or the
 * request draws on no bucket, so the proxy fails open.
 */
export async function limiterVerdicts(
  bucket: LimitBucket | undefined,
  keys: { readonly visitorId: string; readonly ip: string },
): Promise<LimiterVerdicts> {
  const all = getLimiters()
  if (all === null || bucket === undefined) return UNLIMITED
  const limiter = all[bucket]
  const [visitor, ip] = await Promise.all([
    verdict(limiter, `visitor:${keys.visitorId}`),
    verdict(limiter, `ip:${keys.ip}`),
  ])
  return { visitor, ip }
}
