import { describe, expect, test } from "vitest"
import { resolveProxyTarget } from "./proxy-allowlist.js"

const BASE = "http://localhost:3002"

describe("proxy allowlist", () => {
  test("forwards the three memory routes", () => {
    expect(resolveProxyTarget("GET", ["memory", "candidates"], BASE)).toBe(
      "http://localhost:3002/memory/candidates",
    )
    expect(resolveProxyTarget("POST", ["memory", "candidates", "abc", "approve"], BASE)).toBe(
      "http://localhost:3002/memory/candidates/abc/approve",
    )
    expect(resolveProxyTarget("POST", ["memory", "candidates", "abc", "reject"], BASE)).toBe(
      "http://localhost:3002/memory/candidates/abc/reject",
    )
  })

  test("does not proxy thread state: the runtime route's runner reads it server-side", () => {
    expect(resolveProxyTarget("GET", ["threads", "t1", "state"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["threads", "t1", "pending_interrupts"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["threads", "t1", "events"], BASE)).toBeNull()
  })

  test("rejects the wrong method on an allowed path", () => {
    expect(resolveProxyTarget("POST", ["memory", "candidates"], BASE)).toBeNull()
    expect(resolveProxyTarget("DELETE", ["memory", "candidates"], BASE)).toBeNull()
  })

  test("rejects everything not on the list", () => {
    expect(resolveProxyTarget("GET", ["threads"], BASE)).toBeNull()
    expect(resolveProxyTarget("POST", ["threads", "t1", "resume"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["memory", "candidates", "abc"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", ["agent", "run"], BASE)).toBeNull()
    expect(resolveProxyTarget("GET", [], BASE)).toBeNull()
  })

  test("rejects a segment that tries to climb out of the allowed path", () => {
    expect(resolveProxyTarget("POST", ["memory", "candidates", ".", "approve"], BASE)).toBeNull()
    expect(resolveProxyTarget("POST", ["memory", "candidates", "..", "approve"], BASE)).toBeNull()
    expect(resolveProxyTarget("POST", ["memory", "candidates", "a/b", "approve"], BASE)).toBeNull()
    expect(resolveProxyTarget("POST", ["memory", "candidates", "", "approve"], BASE)).toBeNull()
  })

  test("encodes the id rather than letting it forge a path", () => {
    expect(resolveProxyTarget("POST", ["memory", "candidates", "a b", "approve"], BASE)).toBe(
      "http://localhost:3002/memory/candidates/a%20b/approve",
    )
    expect(resolveProxyTarget("POST", ["memory", "candidates", "a?b", "approve"], BASE)).toBe(
      "http://localhost:3002/memory/candidates/a%3Fb/approve",
    )
    expect(resolveProxyTarget("POST", ["memory", "candidates", "a#b", "approve"], BASE)).toBe(
      "http://localhost:3002/memory/candidates/a%23b/approve",
    )
  })

  test("does not let a base with a trailing slash double it", () => {
    expect(resolveProxyTarget("GET", ["memory", "candidates"], "http://localhost:3002/")).toBe(
      "http://localhost:3002/memory/candidates",
    )
  })
})
