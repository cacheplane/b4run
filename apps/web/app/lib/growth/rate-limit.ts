export function createRateLimiter(input: { limit: number; windowMs: number; now?: () => number }): {
  allow(key: string): boolean
} {
  const now = input.now ?? Date.now
  const hits = new Map<string, number[]>()
  return {
    allow(key) {
      const t = now()
      const cutoff = t - input.windowMs
      for (const [k, stamps] of hits) {
        const live = stamps.filter((stamp) => stamp > cutoff)
        if (live.length === 0) hits.delete(k)
        else hits.set(k, live)
      }
      const current = hits.get(key) ?? []
      if (current.length >= input.limit) return false
      current.push(t)
      hits.set(key, current)
      return true
    },
  }
}

// Per serverless instance, best effort. Vercel sets x-forwarded-for itself, so its first value is the client.
export const FORM_RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000 }
