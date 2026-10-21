import { normalizePublicOrigin } from "./tokens"

export interface GrowthEnv {
  readonly databaseUrl: string
  readonly emailHmacSecret: string
  readonly tokenSecret: string
  readonly environment: "production" | "preview" | "test"
  readonly publicOrigin: string
  readonly resendWebhookSecret?: string
  readonly posthogKey?: string
}

const ENVIRONMENTS = ["production", "preview", "test"] as const

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

/** Reads the growth configuration, failing fast on a missing secret. Call lazily, never at import. */
export function loadGrowthEnv(env: NodeJS.ProcessEnv = process.env): GrowthEnv {
  const databaseUrl = required(env, "GROWTH_DATABASE_URL")
  const emailHmacSecret = required(env, "GROWTH_EMAIL_HMAC_SECRET")
  const tokenSecret = required(env, "GROWTH_TOKEN_SECRET")
  const environment = env.GROWTH_ENVIRONMENT
  if (!ENVIRONMENTS.some((allowed) => allowed === environment)) {
    throw new Error("GROWTH_ENVIRONMENT must be one of production, preview, test")
  }
  const resendWebhookSecret = optional(env, "RESEND_WEBHOOK_SECRET")
  const posthogKey = optional(env, "NEXT_PUBLIC_POSTHOG_KEY")
  return {
    databaseUrl,
    emailHmacSecret,
    tokenSecret,
    environment: environment as GrowthEnv["environment"],
    publicOrigin: normalizePublicOrigin(optional(env, "GROWTH_PUBLIC_ORIGIN") ?? "https://b4.run"),
    ...(resendWebhookSecret !== undefined ? { resendWebhookSecret } : {}),
    ...(posthogKey !== undefined ? { posthogKey } : {}),
  }
}
