import { afterEach, describe, expect, it, vi } from "vitest"
import { LOCAL_PRINCIPAL, principalOf } from "../src/auth.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("principalOf", () => {
  it("is the visitor named by X-B4-Visitor when the guard is active", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "secret")
    expect(await principalOf({ "x-b4-visitor": "v-abcdefgh" })).toEqual({
      id: "v-abcdefgh",
      isAdmin: false,
      org: "demo",
    })
  })

  it("is nobody when the guard is active and the header is missing or malformed", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "secret")
    expect(await principalOf({})).toBeUndefined()
    // Repeated headers arrive joined with ", ".
    expect(await principalOf({ "x-b4-visitor": "v-abcdefgh, v-ijklmnop" })).toBeUndefined()
    expect(await principalOf({ "x-b4-visitor": "../x" })).toBeUndefined()
    expect(await principalOf({ "x-b4-visitor": "v-short" })).toBeUndefined()
  })

  it("is the local principal when no guard is configured", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "")
    expect(await principalOf({})).toEqual(LOCAL_PRINCIPAL)
    expect(await principalOf({ "x-b4-visitor": "v-abcdefgh" })).toEqual(LOCAL_PRINCIPAL)
  })
})
