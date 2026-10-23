import { GrowthConfigError } from "./errors"
import { normalizePublicOrigin, type TokenKey, type TokenKeyring } from "./tokens"

export interface GrowthEnv {
  readonly databaseUrl: string
  readonly emailHmacSecret: string
  readonly tokenKeyring: TokenKeyring
  readonly environment: "production" | "preview" | "test"
  readonly publicOrigin: string
  readonly resendWebhookSecret?: string
  /** Resend sending key; the inbound forward prefers it over the receiving key. */
  readonly resendApiKey?: string
  /** Full-access Resend key for the receiving API. Inbound forwarding is off without it. */
  readonly resendReceivingApiKey?: string
  readonly resendInboundWebhookSecret?: string
  readonly posthogKey?: string
  /** `GROWTH_FOUNDER_EMAIL` when set: the digest and BCC address, and one of B4's own senders. */
  readonly founderEmail?: string
}

const ENVIRONMENTS = ["production", "preview", "test"] as const

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new GrowthConfigError(`${name} is not set`)
  return value
}

/** A trimmed variable, or undefined when it is unset or blank. */
export function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

const KEY_ID_PATTERN = /^[1-9]\d*$/
const PREVIOUS_KEYS_ERROR =
  "GROWTH_TOKEN_PREVIOUS_KEYS must be comma-separated id:secret entries with distinct positive integer ids and non-blank secrets"

function parseKeyId(value: string): number | undefined {
  if (!KEY_ID_PATTERN.test(value)) return undefined
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : undefined
}

function loadTokenKeyring(env: NodeJS.ProcessEnv, secret: string): TokenKeyring {
  const rawId = optional(env, "GROWTH_TOKEN_KEY_ID") ?? "1"
  const activeId = parseKeyId(rawId)
  if (activeId === undefined) {
    throw new GrowthConfigError("GROWTH_TOKEN_KEY_ID must be a positive integer")
  }
  const previous: TokenKey[] = []
  const seen = new Set<number>([activeId])
  const entries = (env.GROWTH_TOKEN_PREVIOUS_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
  for (const entry of entries) {
    const colon = entry.indexOf(":")
    if (colon === -1) throw new GrowthConfigError(PREVIOUS_KEYS_ERROR)
    const id = parseKeyId(entry.slice(0, colon).trim())
    const previousSecret = entry.slice(colon + 1).trim()
    if (id === undefined || previousSecret === "" || seen.has(id)) {
      throw new GrowthConfigError(PREVIOUS_KEYS_ERROR)
    }
    seen.add(id)
    previous.push({ id, secret: previousSecret })
  }
  return { active: { id: activeId, secret }, previous }
}

/** Reads the growth configuration, failing fast on a missing secret. Call lazily, never at import. */
export function loadGrowthEnv(env: NodeJS.ProcessEnv = process.env): GrowthEnv {
  const databaseUrl = required(env, "GROWTH_DATABASE_URL")
  const emailHmacSecret = required(env, "GROWTH_EMAIL_HMAC_SECRET")
  const tokenKeyring = loadTokenKeyring(env, required(env, "GROWTH_TOKEN_SECRET"))
  const environment = env.GROWTH_ENVIRONMENT
  if (!ENVIRONMENTS.some((allowed) => allowed === environment)) {
    throw new GrowthConfigError("GROWTH_ENVIRONMENT must be one of production, preview, test")
  }
  const resendWebhookSecret = optional(env, "RESEND_WEBHOOK_SECRET")
  const resendApiKey = optional(env, "RESEND_API_KEY")
  const resendReceivingApiKey = optional(env, "RESEND_RECEIVING_API_KEY")
  const resendInboundWebhookSecret = optional(env, "RESEND_INBOUND_WEBHOOK_SECRET")
  const posthogKey = optional(env, "NEXT_PUBLIC_POSTHOG_KEY")
  const founderEmail = optional(env, "GROWTH_FOUNDER_EMAIL")
  return {
    databaseUrl,
    emailHmacSecret,
    tokenKeyring,
    environment: environment as GrowthEnv["environment"],
    publicOrigin: normalizePublicOrigin(optional(env, "GROWTH_PUBLIC_ORIGIN") ?? "https://b4.run"),
    ...(resendWebhookSecret !== undefined ? { resendWebhookSecret } : {}),
    ...(resendApiKey !== undefined ? { resendApiKey } : {}),
    ...(resendReceivingApiKey !== undefined ? { resendReceivingApiKey } : {}),
    ...(resendInboundWebhookSecret !== undefined ? { resendInboundWebhookSecret } : {}),
    ...(posthogKey !== undefined ? { posthogKey } : {}),
    ...(founderEmail !== undefined ? { founderEmail } : {}),
  }
}
