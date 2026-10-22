import { describe, expect, it } from "vitest"
import { type GrowthEnv, loadGrowthEnv as load } from "./env"
import { GrowthConfigError } from "./errors"

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
      tokenKeyring: { active: { id: 1, secret: "b" }, previous: [] },
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

  describe("token keyring", () => {
    it("reads the active key id and previous keys", () => {
      const env = loadGrowthEnv({
        ...base,
        GROWTH_TOKEN_KEY_ID: "3",
        GROWTH_TOKEN_PREVIOUS_KEYS: " 1:old-one , 2:has:colons,",
      })
      expect(env.tokenKeyring).toEqual({
        active: { id: 3, secret: "b" },
        previous: [
          { id: 1, secret: "old-one" },
          { id: 2, secret: "has:colons" },
        ],
      })
    })

    it.each(["0", "-1", "1.5", "abc", "01", "1 2"])("rejects key id %s", (id) => {
      expect(() => loadGrowthEnv({ ...base, GROWTH_TOKEN_KEY_ID: id })).toThrow(
        "GROWTH_TOKEN_KEY_ID",
      )
    })

    it.each([
      "nocolon",
      "x:secret",
      "0:secret",
      "1:",
      "1:   ",
      ":secret",
      "2:aaa,2:bbb",
      "1:topsecret,1:topsecret",
    ])("rejects previous keys %s without echoing secrets", (value) => {
      let message = ""
      try {
        loadGrowthEnv({ ...base, GROWTH_TOKEN_PREVIOUS_KEYS: value })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain("GROWTH_TOKEN_PREVIOUS_KEYS")
      for (const leaked of ["topsecret", "aaa", "bbb", "nocolon"]) {
        expect(message).not.toContain(leaked)
      }
    })

    it("rejects a previous id equal to the active id", () => {
      expect(() =>
        loadGrowthEnv({ ...base, GROWTH_TOKEN_KEY_ID: "2", GROWTH_TOKEN_PREVIOUS_KEYS: "2:old" }),
      ).toThrow("GROWTH_TOKEN_PREVIOUS_KEYS")
    })
  })

  it.each([
    { GROWTH_DATABASE_URL: "" },
    { GROWTH_ENVIRONMENT: "prod" },
    { GROWTH_TOKEN_KEY_ID: "0" },
    { GROWTH_TOKEN_PREVIOUS_KEYS: "nocolon" },
    { GROWTH_PUBLIC_ORIGIN: "http://b4.run" },
  ])("throws a config_invalid GrowthConfigError for %o", (override) => {
    let thrown: unknown
    try {
      loadGrowthEnv({ ...base, ...override })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(GrowthConfigError)
    expect((thrown as GrowthConfigError).code).toBe("config_invalid")
  })
})
