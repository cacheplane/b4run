import { describe, expect, it } from "vitest"
import { parseEnv } from "./env.ts"

const key = "phx_".padEnd(40, "a")

describe("parseEnv", () => {
  it("defaults the host and coerces the project id", () => {
    const env = parseEnv({ POSTHOG_PERSONAL_API_KEY: key, POSTHOG_PROJECT_ID: "12345" })
    expect(env.POSTHOG_HOST).toBe("https://us.i.posthog.com")
    expect(env.POSTHOG_PROJECT_ID).toBe(12345)
  })

  it("respects a host override", () => {
    const env = parseEnv({
      POSTHOG_PERSONAL_API_KEY: key,
      POSTHOG_PROJECT_ID: "1",
      POSTHOG_HOST: "https://eu.i.posthog.com",
    })
    expect(env.POSTHOG_HOST).toBe("https://eu.i.posthog.com")
  })

  it("rejects a short key", () => {
    expect(() => parseEnv({ POSTHOG_PERSONAL_API_KEY: "short", POSTHOG_PROJECT_ID: "1" })).toThrow(
      /POSTHOG_PERSONAL_API_KEY/,
    )
  })

  it("rejects a non-numeric project id", () => {
    expect(() => parseEnv({ POSTHOG_PERSONAL_API_KEY: key, POSTHOG_PROJECT_ID: "abc" })).toThrow(
      /POSTHOG_PROJECT_ID/,
    )
  })
})
