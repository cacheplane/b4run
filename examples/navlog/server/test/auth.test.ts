import { afterEach, describe, expect, it, vi } from "vitest"
import { LOCAL_PRINCIPAL, principalOf } from "../src/auth.ts"

const TOKEN = "secret-0123456789abcdefghijklmnopqrstuv"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("principalOf", () => {
  it("is the visitor named by X-B4-Visitor when the guard is active", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", TOKEN)
    expect(await principalOf({ "x-internal-token": TOKEN, "x-b4-visitor": "v-abcdefgh" })).toEqual({
      id: "v-abcdefgh",
      isAdmin: false,
      org: "demo",
    })
  })

  it("is nobody when the guard is active and the header is missing or malformed", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", TOKEN)
    const tokened = { "x-internal-token": TOKEN }
    expect(await principalOf(tokened)).toBeUndefined()
    // Repeated headers arrive joined with ", ".
    expect(
      await principalOf({ ...tokened, "x-b4-visitor": "v-abcdefgh, v-ijklmnop" }),
    ).toBeUndefined()
    expect(await principalOf({ ...tokened, "x-b4-visitor": "../x" })).toBeUndefined()
    expect(await principalOf({ ...tokened, "x-b4-visitor": "v-short" })).toBeUndefined()
  })

  it("is nobody when the guard is active and the token is missing or wrong", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", TOKEN)
    // Without main.mjs in front (a scaffold running .b4/build/server.mjs), the
    // visitor header alone must not open anything.
    expect(await principalOf({ "x-b4-visitor": "v-abcdefgh" })).toBeUndefined()
    expect(
      await principalOf({ "x-internal-token": "wrong", "x-b4-visitor": "v-abcdefgh" }),
    ).toBeUndefined()
    expect(
      await principalOf({ "x-internal-token": `${TOKEN}x`, "x-b4-visitor": "v-abcdefgh" }),
    ).toBeUndefined()
  })

  it("is the local principal when no guard is configured", async () => {
    vi.stubEnv("B4_INTERNAL_TOKEN", "")
    expect(await principalOf({})).toEqual(LOCAL_PRINCIPAL)
    expect(await principalOf({ "x-b4-visitor": "v-abcdefgh" })).toEqual(LOCAL_PRINCIPAL)
  })
})
