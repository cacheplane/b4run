import { join } from "node:path"
import { z } from "zod"

const positiveInt = (name: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        ctx.addIssue({ code: "custom", message: `${name} must be a positive integer` })
        return z.NEVER
      }
      return parsed
    })

const EnvSchema = z.object({
  FACTORY_WORKER_URL: z
    .string({ message: "FACTORY_WORKER_URL is required" })
    .url()
    .refine((value) => /^https?:/.test(value), { message: "FACTORY_WORKER_URL must be http(s)" }),
  FACTORY_WORKER_ROUTE: z.string().min(1).default("/fix#agent"),
  FACTORY_WORKER_OUTBOX: z.string({ message: "FACTORY_WORKER_OUTBOX is required" }).min(1),
  FACTORY_STATE_DIR: z.string({ message: "FACTORY_STATE_DIR is required" }).min(1),
  FACTORY_APPROVAL_TTL_MS: positiveInt("FACTORY_APPROVAL_TTL_MS"),
  FACTORY_MAX_ACTIVE_MS: positiveInt("FACTORY_MAX_ACTIVE_MS"),
  FACTORY_RECEIPT_WAIT_MS: positiveInt("FACTORY_RECEIPT_WAIT_MS"),
  FACTORY_HTTP_PORT: positiveInt("FACTORY_HTTP_PORT"),
})

export interface FactoryConfig {
  readonly workerUrl: string
  readonly workerRoute: string
  readonly outboxDir: string
  readonly stateDir: string
  readonly registryPath: string
  readonly approvalTtlMs: number
  readonly maxActiveMs: number
  readonly receiptWaitMs: number
  readonly httpPort: number
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): FactoryConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`)
    throw new Error(`Invalid factory configuration:\n${issues.join("\n")}`)
  }
  const e = parsed.data
  return {
    workerUrl: e.FACTORY_WORKER_URL.replace(/\/$/, ""),
    workerRoute: e.FACTORY_WORKER_ROUTE,
    outboxDir: e.FACTORY_WORKER_OUTBOX,
    stateDir: e.FACTORY_STATE_DIR,
    registryPath: join(e.FACTORY_STATE_DIR, "registry.sqlite"),
    approvalTtlMs: e.FACTORY_APPROVAL_TTL_MS ?? 900_000,
    maxActiveMs: e.FACTORY_MAX_ACTIVE_MS ?? 1_200_000,
    receiptWaitMs: e.FACTORY_RECEIPT_WAIT_MS ?? 180_000,
    httpPort: e.FACTORY_HTTP_PORT ?? 4300,
  }
}
