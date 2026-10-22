import { describe, expect, it } from "vitest"
import { GrowthConfigError } from "./errors"
import { loadSequenceEnv as load, type SequenceEnv } from "./sequence-env"

const loadSequenceEnv = (env: Record<string, string | undefined>): SequenceEnv =>
  load(env as NodeJS.ProcessEnv)

const base = {
  GROWTH_DATABASE_URL: "postgres://u:p@localhost/db",
  GROWTH_EMAIL_HMAC_SECRET: "secret-hmac-XYZ",
  GROWTH_TOKEN_SECRET: "secret-token-XYZ",
  GROWTH_ENVIRONMENT: "test",
}

describe("loadSequenceEnv", () => {
  it("defaults both switches off and the founder address", () => {
    const env = loadSequenceEnv(base)
    expect(env.sequenceEnabled).toBe(false)
    expect(env.deliveryEnabled).toBe(false)
    expect(env.sequenceStartAt).toBeUndefined()
    expect(env.resendApiKey).toBeUndefined()
    expect(env.founderEmail).toBe("brian@b4.run")
    expect(env.databaseUrl).toBe(base.GROWTH_DATABASE_URL)
  })

  it("enables a switch only on the exact string true", () => {
    for (const value of ["TRUE", "1", "yes", " true", "false", ""]) {
      const env = loadSequenceEnv({
        ...base,
        GROWTH_SEQUENCE_ENABLED: value,
        GROWTH_DELIVERY_ENABLED: value,
      })
      expect(env.sequenceEnabled).toBe(false)
      expect(env.deliveryEnabled).toBe(false)
    }
  })

  it("loads the enabled configuration", () => {
    const env = loadSequenceEnv({
      ...base,
      GROWTH_SEQUENCE_ENABLED: "true",
      GROWTH_SEQUENCE_START_AT: "2026-11-02T08:00:00-08:00",
      GROWTH_DELIVERY_ENABLED: "true",
      RESEND_API_KEY: " re_key ",
      CRON_SECRET: " cron ",
      GROWTH_FOUNDER_EMAIL: "founder@example.com",
    })
    expect(env.sequenceEnabled).toBe(true)
    expect(env.sequenceStartAt?.toISOString()).toBe("2026-11-02T16:00:00.000Z")
    expect(env.deliveryEnabled).toBe(true)
    expect(env.resendApiKey).toBe("re_key")
    expect(env.cronSecret).toBe("cron")
    expect(env.founderEmail).toBe("founder@example.com")
  })

  it("requires a start time when the sequence is enabled", () => {
    expect(() => loadSequenceEnv({ ...base, GROWTH_SEQUENCE_ENABLED: "true" })).toThrow(
      /GROWTH_SEQUENCE_START_AT/,
    )
  })

  it("rejects an unparseable start time", () => {
    expect(() =>
      loadSequenceEnv({
        ...base,
        GROWTH_SEQUENCE_ENABLED: "true",
        GROWTH_SEQUENCE_START_AT: "next tuesday",
      }),
    ).toThrow(/GROWTH_SEQUENCE_START_AT/)
  })

  it("requires the Resend key when delivery is enabled, without echoing secrets", () => {
    const secrets = ["secret-hmac-XYZ", "secret-token-XYZ", "re_live_XYZ", "cron-XYZ"]
    const attempts = [
      { ...base, GROWTH_DELIVERY_ENABLED: "true", CRON_SECRET: "cron-XYZ" },
      {
        ...base,
        GROWTH_SEQUENCE_ENABLED: "true",
        GROWTH_SEQUENCE_START_AT: "soon",
        RESEND_API_KEY: "re_live_XYZ",
      },
    ]
    const messages = attempts.map((env) => {
      try {
        loadSequenceEnv(env)
      } catch (error) {
        return (error as Error).message
      }
      return expect.unreachable()
    })
    expect(messages[0]).toMatch(/RESEND_API_KEY/)
    for (const message of messages) {
      for (const secret of secrets) expect(message).not.toContain(secret)
    }
  })

  it.each([
    "2026-13-40",
    "soon",
    "2026-02-30T07:00:00Z",
    "2026-11-02T25:00:00Z",
    "2026-11-02",
    "2026-11-02T08:00:00",
    "Nov 2 2026",
    "1",
  ])("rejects the start time %s without echoing it", (value) => {
    try {
      loadSequenceEnv({ ...base, GROWTH_SEQUENCE_ENABLED: "true", GROWTH_SEQUENCE_START_AT: value })
      expect.unreachable()
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain("GROWTH_SEQUENCE_START_AT")
      expect(message).not.toContain(value)
    }
  })

  it("accepts the same instant written in UTC and with an offset", () => {
    for (const value of ["2026-11-02T15:00:00Z", "2026-11-02T07:00:00-08:00"]) {
      const env = loadSequenceEnv({
        ...base,
        GROWTH_SEQUENCE_ENABLED: "true",
        GROWTH_SEQUENCE_START_AT: value,
      })
      expect(env.sequenceStartAt?.toISOString()).toBe("2026-11-02T15:00:00.000Z")
    }
  })

  it("treats a blank CRON_SECRET as unset", () => {
    expect(loadSequenceEnv({ ...base, CRON_SECRET: "   " }).cronSecret).toBeUndefined()
  })

  it("still requires the base growth variables", () => {
    expect(() => loadSequenceEnv({})).toThrow(/GROWTH_DATABASE_URL/)
  })

  it.each([
    { GROWTH_SEQUENCE_ENABLED: "true" },
    { GROWTH_SEQUENCE_ENABLED: "true", GROWTH_SEQUENCE_START_AT: "soon" },
    { GROWTH_DELIVERY_ENABLED: "true" },
    { GROWTH_TOKEN_SECRET: "" },
  ])("throws a config_invalid GrowthConfigError for %o", (override) => {
    let thrown: unknown
    try {
      loadSequenceEnv({ ...base, ...override })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(GrowthConfigError)
    expect((thrown as GrowthConfigError).code).toBe("config_invalid")
  })
})
