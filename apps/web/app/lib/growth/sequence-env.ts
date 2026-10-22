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

const START_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/

function parseStartAt(value: string | undefined): Date {
  if (value === undefined) throw new Error("GROWTH_SEQUENCE_START_AT is not set")
  const invalid = new Error(
    "GROWTH_SEQUENCE_START_AT must be an ISO date-time with a UTC offset, in the form YYYY-MM-DDTHH:MM:SS+HH:MM or ending in Z",
  )
  const match = START_AT_PATTERN.exec(value)
  if (match === null) throw invalid
  const millis = Date.parse(value)
  if (Number.isNaN(millis)) throw invalid
  const zone = match[8] as string
  const offsetMinutes =
    zone === "Z"
      ? 0
      : (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)))
  // Re-derive the wall-clock time at the given offset; rolled-over inputs such as
  // 2026-02-30 or 25:00 come back different from what was written.
  const wall = new Date(millis + offsetMinutes * 60_000)
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  const derived = [
    pad(wall.getUTCFullYear(), 4),
    pad(wall.getUTCMonth() + 1),
    pad(wall.getUTCDate()),
    pad(wall.getUTCHours()),
    pad(wall.getUTCMinutes()),
    pad(wall.getUTCSeconds()),
  ]
  const given = [match[1], match[2], match[3], match[4], match[5], match[6] ?? "00"]
  if (derived.some((part, index) => part !== given[index])) throw invalid
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
