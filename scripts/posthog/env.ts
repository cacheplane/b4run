import { z } from "zod"

const envSchema = z.object({
  POSTHOG_PERSONAL_API_KEY: z
    .string()
    .min(20, "POSTHOG_PERSONAL_API_KEY must be at least 20 characters"),
  POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),
  POSTHOG_PROJECT_ID: z.coerce
    .number({ error: "POSTHOG_PROJECT_ID must be numeric" })
    .int("POSTHOG_PROJECT_ID must be an integer")
    .positive("POSTHOG_PROJECT_ID must be positive"),
})

export interface PosthogEnv {
  readonly POSTHOG_PERSONAL_API_KEY: string
  readonly POSTHOG_HOST: string
  readonly POSTHOG_PROJECT_ID: number
}

export function parseEnv(source: Record<string, string | undefined>): PosthogEnv {
  return envSchema.parse(source)
}
