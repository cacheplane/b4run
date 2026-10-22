import { type GrowthEnv, loadGrowthEnv } from "./env"

export interface SequenceEnv extends GrowthEnv {
  readonly sequenceEnabled: boolean
  /** Required (throws) when `sequenceEnabled`. */
  readonly sequenceStartAt?: Date
  readonly deliveryEnabled: boolean
  /** Required (throws) when `deliveryEnabled`. */
  readonly resendApiKey?: string
  readonly cronSecret?: string
  readonly founderEmail: string
}

const DEFAULT_FOUNDER_EMAIL = "brian@b4.run"

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function parseStartAt(value: string | undefined): Date {
  if (value === undefined) throw new Error("GROWTH_SEQUENCE_START_AT is not set")
  const millis = Date.parse(value)
  if (Number.isNaN(millis)) {
    throw new Error("GROWTH_SEQUENCE_START_AT must be an ISO 8601 date-time")
  }
  return new Date(millis)
}

/** Reads the founder-sequence configuration over the growth base. Call lazily, never at import. */
export function loadSequenceEnv(env: NodeJS.ProcessEnv = process.env): SequenceEnv {
  const base = loadGrowthEnv(env)
  const sequenceEnabled = env.GROWTH_SEQUENCE_ENABLED === "true"
  const deliveryEnabled = env.GROWTH_DELIVERY_ENABLED === "true"
  const sequenceStartAt = sequenceEnabled
    ? parseStartAt(optional(env, "GROWTH_SEQUENCE_START_AT"))
    : undefined
  const resendApiKey = optional(env, "RESEND_API_KEY")
  if (deliveryEnabled && resendApiKey === undefined) {
    throw new Error("RESEND_API_KEY is not set")
  }
  const cronSecret = optional(env, "CRON_SECRET")
  return {
    ...base,
    sequenceEnabled,
    deliveryEnabled,
    founderEmail: optional(env, "GROWTH_FOUNDER_EMAIL") ?? DEFAULT_FOUNDER_EMAIL,
    ...(sequenceStartAt !== undefined ? { sequenceStartAt } : {}),
    ...(resendApiKey !== undefined ? { resendApiKey } : {}),
    ...(cronSecret !== undefined ? { cronSecret } : {}),
  }
}
