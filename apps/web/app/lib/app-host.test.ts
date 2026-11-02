import { describe, expect, it } from "vitest"
import { flavourForHost, hostFromHeaders } from "./app-host"

describe("flavourForHost", () => {
  it.each([
    ["b4.run", "prod"],
    ["www.b4.run", "prod"],
    ["test.b4.run", "beta"],
    ["local.b4.run", "local"],
    ["B4.RUN", "prod"],
    ["local.b4.run:3000", "local"],
  ])("maps %s to %s", (host, flavour) => {
    expect(flavourForHost(host)).toBe(flavour)
  })

  it.each([
    "example.com",
    "evil.b4.run",
    "b4.run.evil.com",
    "web-git-branch-cacheplane.vercel.app",
    "localhost:3000",
    "",
  ])("rejects %s", (host) => {
    expect(flavourForHost(host)).toBeNull()
  })

  it("rejects a missing host", () => {
    expect(flavourForHost(null)).toBeNull()
    expect(flavourForHost(undefined)).toBeNull()
  })
})

describe("hostFromHeaders", () => {
  it("prefers x-forwarded-host, then host", () => {
    expect(
      hostFromHeaders(new Headers({ "x-forwarded-host": "test.b4.run", host: "internal" })),
    ).toBe("test.b4.run")
    expect(hostFromHeaders(new Headers({ host: "b4.run" }))).toBe("b4.run")
    expect(hostFromHeaders(new Headers())).toBeNull()
  })

  it("takes the first of a forwarded list", () => {
    expect(hostFromHeaders(new Headers({ "x-forwarded-host": "b4.run, proxy.internal" }))).toBe(
      "b4.run",
    )
  })
})
