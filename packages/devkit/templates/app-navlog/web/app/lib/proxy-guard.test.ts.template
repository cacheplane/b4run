import { describe, expect, test } from "vitest"
import {
  clientIp,
  decideRequest,
  guardConfigFromEnv,
  isOwnerApprovalPath,
  isOwnerCookie,
  isValidVisitorId,
  limitBucketFor,
  mintVisitorId,
  ownerCookieName,
  ownerCookieValue,
  readCookie,
  tokensMatch,
  upstreamHeaders,
  visitorCookieName,
} from "./proxy-guard"

const base = { allowedOrigins: ["https://navlog.b4.run"], internalToken: "secret" }
const ALLOW = { visitor: "allow", ip: "allow" } as const

describe("decideRequest", () => {
  test("rejects a cross-origin request when an allowlist is configured", () => {
    expect(
      decideRequest({
        ...base,
        origin: "https://evil.example",
        visitorId: "v-1",
        limiterVerdicts: ALLOW,
      }),
    ).toEqual({ kind: "reject", status: 403, error: "origin_not_allowed" })
  })

  test("allows a same-origin request and a request with no Origin header", () => {
    expect(
      decideRequest({
        ...base,
        origin: "https://navlog.b4.run",
        visitorId: "v-1",
        limiterVerdicts: ALLOW,
      }),
    ).toEqual({ kind: "allow" })
    expect(
      decideRequest({ ...base, origin: undefined, visitorId: "v-1", limiterVerdicts: ALLOW }),
    ).toEqual({ kind: "allow" })
  })

  test("allows everything when no allowlist is configured (local development)", () => {
    expect(
      decideRequest({
        allowedOrigins: [],
        internalToken: undefined,
        origin: "http://localhost:3010",
        visitorId: "v-1",
        limiterVerdicts: ALLOW,
      }),
    ).toEqual({ kind: "allow" })
  })

  test("rejects with 429 when the limiter says so", () => {
    expect(
      decideRequest({
        ...base,
        origin: undefined,
        visitorId: "v-1",
        limiterVerdicts: { visitor: "limit", ip: "allow" },
      }),
    ).toEqual({ kind: "reject", status: 429, error: "rate_limit_exceeded" })
  })

  test("rejects with 429 when the IP is over budget even though the visitor is not", () => {
    // A script that drops its cookie on every call mints a fresh visitor each
    // time; the IP key is what still counts it.
    expect(
      decideRequest({
        ...base,
        origin: undefined,
        visitorId: "v-1",
        limiterVerdicts: { visitor: "allow", ip: "limit" },
      }),
    ).toEqual({ kind: "reject", status: 429, error: "rate_limit_exceeded" })
  })

  test("fails open when the limiter is unconfigured", () => {
    expect(
      decideRequest({
        ...base,
        origin: undefined,
        visitorId: "v-1",
        limiterVerdicts: { visitor: "unconfigured", ip: "unconfigured" },
      }),
    ).toEqual({ kind: "allow" })
  })
})

describe("mintVisitorId", () => {
  test("produces ids the server's pattern accepts and never repeats", () => {
    const a = mintVisitorId()
    const b = mintVisitorId()
    expect(a).toMatch(/^v-[A-Za-z0-9_-]{8,64}$/)
    expect(isValidVisitorId(a)).toBe(true)
    expect(a).not.toBe(b)
  })

  test("a malformed cookie value is not a visitor id", () => {
    expect(isValidVisitorId("v-short")).toBe(false)
    expect(isValidVisitorId("v-abcdefgh, v-ijklmnop")).toBe(false)
    expect(isValidVisitorId(undefined)).toBe(false)
  })
})

describe("upstreamHeaders", () => {
  test("injects the token and the visitor id when configured, and only the visitor id otherwise", () => {
    expect(upstreamHeaders({ internalToken: "secret", visitorId: "v-1" })).toEqual({
      "x-internal-token": "secret",
      "x-b4-visitor": "v-1",
    })
    expect(upstreamHeaders({ internalToken: undefined, visitorId: "v-1" })).toEqual({
      "x-b4-visitor": "v-1",
    })
  })
})

describe("isOwnerApprovalPath", () => {
  test("names the memory candidate approve and reject paths only", () => {
    expect(isOwnerApprovalPath(["memory", "candidates", "abc", "approve"])).toBe(true)
    expect(isOwnerApprovalPath(["memory", "candidates", "abc", "reject"])).toBe(true)
    expect(isOwnerApprovalPath(["memory", "candidates"])).toBe(false)
    expect(isOwnerApprovalPath(["threads", "t1", "state"])).toBe(false)
  })
})

describe("guardConfigFromEnv", () => {
  test("reads the comma-separated origins and the token", () => {
    expect(
      guardConfigFromEnv({
        B4_DEMO_ORIGINS: " https://a.example , https://b.example,",
        B4_INTERNAL_TOKEN: "secret",
      }),
    ).toEqual({
      allowedOrigins: ["https://a.example", "https://b.example"],
      internalToken: "secret",
    })
  })

  test("is the inert development config with nothing set", () => {
    expect(guardConfigFromEnv({ B4_INTERNAL_TOKEN: "" })).toEqual({
      allowedOrigins: [],
      internalToken: undefined,
    })
  })
})

describe("readCookie", () => {
  test("finds one cookie among several, and nothing when it is absent", () => {
    expect(readCookie("a=1; b4_visitor=v-abcdefgh; c=3", "b4_visitor")).toBe("v-abcdefgh")
    expect(readCookie("a=1", "b4_visitor")).toBeUndefined()
    expect(readCookie(null, "b4_visitor")).toBeUndefined()
  })
})

describe("tokensMatch", () => {
  test("is true for equal tokens only, and false when either is missing", () => {
    expect(tokensMatch("owner-secret", "owner-secret")).toBe(true)
    expect(tokensMatch("owner-secret", "owner-secreT")).toBe(false)
    expect(tokensMatch("short", "owner-secret")).toBe(false)
    expect(tokensMatch(undefined, "owner-secret")).toBe(false)
    expect(tokensMatch("owner-secret", undefined)).toBe(false)
  })
})

describe("limitBucketFor", () => {
  test("runs draw on the tight bucket, reads on the loose one, everything else on none", () => {
    expect(limitBucketFor("copilotkit", "POST")).toBe("run")
    expect(limitBucketFor("b4", "GET")).toBe("read")
    expect(limitBucketFor("copilotkit", "GET")).toBe("read")
    expect(limitBucketFor("b4", "POST")).toBeUndefined()
  })
})

describe("clientIp", () => {
  test("is X-Real-IP, then the first forwarded hop, then one shared unknown key", () => {
    expect(
      clientIp(
        new Headers({ "x-real-ip": "198.51.100.2", "x-forwarded-for": "203.0.113.7, 10.0.0.1" }),
      ),
    ).toBe("198.51.100.2")
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    )
    expect(clientIp(new Headers())).toBe("unknown")
  })
})

describe("cookie names", () => {
  test("carry the __Host- prefix when deployed and plain names in development", () => {
    const deployed = { allowedOrigins: [], internalToken: "secret" }
    const local = { allowedOrigins: [], internalToken: undefined }
    expect(visitorCookieName(deployed)).toBe("__Host-b4_visitor")
    expect(ownerCookieName(deployed)).toBe("__Host-b4_demo_owner")
    expect(visitorCookieName(local)).toBe("b4_visitor")
    expect(ownerCookieName(local)).toBe("b4_demo_owner")
  })
})

describe("owner cookie", () => {
  test("holds an HMAC of the admin token, never the token, and verifies only that", () => {
    const value = ownerCookieValue("owner-secret")
    expect(value).not.toContain("owner-secret")
    expect(isOwnerCookie(value, "owner-secret")).toBe(true)
    expect(isOwnerCookie("owner-secret", "owner-secret")).toBe(false)
    expect(isOwnerCookie(ownerCookieValue("other-secret"), "owner-secret")).toBe(false)
    expect(isOwnerCookie(value, undefined)).toBe(false)
  })
})
