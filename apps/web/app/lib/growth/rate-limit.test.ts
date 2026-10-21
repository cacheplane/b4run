import { describe, expect, it } from "vitest"
import { createRateLimiter } from "./rate-limit"

describe("createRateLimiter", () => {
  it("refuses the sixth call in a window and slides", () => {
    let t = 0
    const limiter = createRateLimiter({
      limit: 5,
      windowMs: 1000,
      now: () => t,
    })
    for (let i = 0; i < 5; i += 1) expect(limiter.allow("a")).toBe(true)
    expect(limiter.allow("a")).toBe(false)
    expect(limiter.allow("b")).toBe(true)
    t = 1001
    expect(limiter.allow("a")).toBe(true)
  })
})
