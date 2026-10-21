import { describe, expect, it } from "vitest"
import { type GrowthEnv, loadGrowthEnv as load } from "./env"

const loadGrowthEnv = (env: Record<string, string | undefined>): GrowthEnv =>
  load(env as NodeJS.ProcessEnv)

const base = {
  GROWTH_DATABASE_URL: "postgres://u:p@localhost/db",
  GROWTH_EMAIL_HMAC_SECRET: "a",
  GROWTH_TOKEN_SECRET: "b",
  GROWTH_ENVIRONMENT: "test",
}

describe("loadGrowthEnv", () => {
  it("loads required values and defaults the origin", () => {
    expect(loadGrowthEnv(base)).toEqual({
      databaseUrl: base.GROWTH_DATABASE_URL,
      emailHmacSecret: "a",
      tokenSecret: "b",
      environment: "test",
      publicOrigin: "https://b4.run",
    })
  })

  it("carries the optional values", () => {
    const env = loadGrowthEnv({
      ...base,
      RESEND_WEBHOOK_SECRET: "w",
      NEXT_PUBLIC_POSTHOG_KEY: "k",
      GROWTH_PUBLIC_ORIGIN: "https://preview.b4.run/",
    })
    expect(env).toMatchObject({
      resendWebhookSecret: "w",
      posthogKey: "k",
      publicOrigin: "https://preview.b4.run",
    })
  })

  it.each(["GROWTH_DATABASE_URL", "GROWTH_EMAIL_HMAC_SECRET", "GROWTH_TOKEN_SECRET"])(
    "fails fast on a blank %s",
    (name) => {
      expect(() => loadGrowthEnv({ ...base, [name]: "  " })).toThrow(name)
      const { [name]: _removed, ...rest } = base as Record<string, string>
      expect(() => loadGrowthEnv(rest)).toThrow(name)
    },
  )

  it.each(["", "prod", "Production", undefined])("rejects environment %s", (value) => {
    const env: Record<string, string | undefined> = {
      ...base,
      GROWTH_ENVIRONMENT: value,
    }
    expect(() => loadGrowthEnv(env)).toThrow("GROWTH_ENVIRONMENT")
  })
})
