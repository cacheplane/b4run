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

/**
 * The environment the controller reads. Unknown keys are stripped rather than
 * rejected, which is how rung 0's `FACTORY_WORKER_OUTBOX` and
 * `FACTORY_RECEIPT_WAIT_MS` stop mattering without breaking an environment that
 * still sets them: the trust transfer they existed for is gone, so they name
 * nothing, but an operator's old service file keeps starting.
 */
const EnvSchema = z.object({
  FACTORY_WORKER_URL: z
    .string({ message: "FACTORY_WORKER_URL is required" })
    .url()
    .refine((value) => /^https?:/.test(value), { message: "FACTORY_WORKER_URL must be http(s)" }),
  FACTORY_WORKER_ROUTE: z.string().min(1).default("/build#agent"),
  FACTORY_STATE_DIR: z.string({ message: "FACTORY_STATE_DIR is required" }).min(1),
  FACTORY_EXPORT_DIR: z.string().min(1).optional(),
  FACTORY_ARTIFACTS_DIR: z.string().min(1).optional(),
  FACTORY_APPROVAL_TTL_MS: positiveInt("FACTORY_APPROVAL_TTL_MS"),
  FACTORY_MAX_ACTIVE_MS: positiveInt("FACTORY_MAX_ACTIVE_MS"),
  FACTORY_MAX_CHANGED_BYTES: positiveInt("FACTORY_MAX_CHANGED_BYTES"),
  FACTORY_BUILDER_APP_ROOT: z.string({ message: "FACTORY_BUILDER_APP_ROOT is required" }).min(1),
})

export interface FactoryConfig {
  readonly workerUrl: string
  readonly workerRoute: string
  readonly stateDir: string
  readonly registryPath: string
  /** Where the approved bytes are written, and the bundle's destination identity. */
  readonly exportDir: string
  /** Content-addressed evidence store for candidate bytes and check output. */
  readonly artifactsDir: string
  readonly approvalTtlMs: number
  readonly maxActiveMs: number
  readonly maxChangedBytes: number
  /** The BUILDER app's root: where its installation store (`.b4/workspaces`) lives. */
  readonly builderAppRoot: string
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
    stateDir: e.FACTORY_STATE_DIR,
    registryPath: join(e.FACTORY_STATE_DIR, "registry.sqlite"),
    exportDir: e.FACTORY_EXPORT_DIR ?? join(e.FACTORY_STATE_DIR, "exports"),
    artifactsDir: e.FACTORY_ARTIFACTS_DIR ?? join(e.FACTORY_STATE_DIR, "artifacts"),
    approvalTtlMs: e.FACTORY_APPROVAL_TTL_MS ?? 900_000,
    maxActiveMs: e.FACTORY_MAX_ACTIVE_MS ?? 1_200_000,
    maxChangedBytes: e.FACTORY_MAX_CHANGED_BYTES ?? 1024 * 1024,
    builderAppRoot: e.FACTORY_BUILDER_APP_ROOT,
  }
}
