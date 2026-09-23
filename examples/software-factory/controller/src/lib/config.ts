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
 * The drafter app's sandbox image, pinned by digest, copied from `drafter/src/drafter-image.ts`
 * rather than imported: the controller imports no drafter source. The image is half of the
 * provider's identity (the scope is the other half), so a controller reading a drafter thread
 * with a different image opens no workspace; `config.test.ts` pins the two literals equal.
 */
export const DRAFTER_IMAGE =
  "node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6"

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
  FACTORY_INTAKE_ROUTE: z.string().min(1).default("/intake#agent"),
  // Parsed but no longer read: the drafter thread is read through the drafter app's root
  // and image (below), not through a catalog task's workspace. Removed in Task 4.
  FACTORY_INTAKE_TASK: z.string().min(1).optional(),
  FACTORY_DRAFTER_APP_ROOT: z.string().min(1).optional(),
  FACTORY_DRAFTER_IMAGE: z.string().min(1).default(DRAFTER_IMAGE),
})

/**
 * Where a controller with state directory `stateDir` writes generated tasks. Shared with the
 * CLI, which reads the state directory without loading the rest of the configuration.
 */
export function generatedTasksDirFor(stateDir: string): string {
  return join(stateDir, "tasks")
}

export interface FactoryConfig {
  readonly workerUrl: string
  readonly workerRoute: string
  readonly stateDir: string
  readonly registryPath: string
  /** Where the approved bytes are written, and the bundle's destination identity. */
  readonly exportDir: string
  /** Content-addressed evidence store for candidate bytes and check output. */
  readonly artifactsDir: string
  /**
   * Where the controller writes tasks drafted from issues, in the shipped catalog's shape.
   * Always under the state directory: the catalog search path is a fact about this
   * controller's state, not an operator knob.
   */
  readonly generatedTasksDir: string
  readonly approvalTtlMs: number
  readonly maxActiveMs: number
  readonly maxChangedBytes: number
  /** The BUILDER app's root: where its installation store (`.b4/workspaces`) lives. */
  readonly builderAppRoot: string
  /** The route the drafter turn runs on. */
  readonly intakeRoute: string
  /**
   * The 3a way of reading the drafter thread: the catalog task whose builder workspace the
   * drafter ran in. Still parsed so an operator's environment keeps starting, but nothing
   * reads it any more: the drafter thread is read through {@link drafterAppRoot}. Removed in
   * Task 4.
   */
  readonly intakeTaskId?: string
  /**
   * The DRAFTER app's root: where its installation store (`.b4/workspaces`) lives, which is
   * how the controller resolves an intake thread to the workspace the drafter wrote `draft/`
   * in. Absent, the `intake` command refuses before spending anything.
   */
  readonly drafterAppRoot?: string
  /**
   * The drafter's sandbox image: with the fixed scope, the identity of the provider that
   * addresses a drafter thread's workspace. Must equal what the drafter app booted with
   * (`FACTORY_DRAFTER_IMAGE` on both, else the pinned default on both).
   */
  readonly drafterImage: string
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
    generatedTasksDir: generatedTasksDirFor(e.FACTORY_STATE_DIR),
    approvalTtlMs: e.FACTORY_APPROVAL_TTL_MS ?? 900_000,
    maxActiveMs: e.FACTORY_MAX_ACTIVE_MS ?? 1_200_000,
    maxChangedBytes: e.FACTORY_MAX_CHANGED_BYTES ?? 1024 * 1024,
    builderAppRoot: e.FACTORY_BUILDER_APP_ROOT,
    intakeRoute: e.FACTORY_INTAKE_ROUTE,
    ...(e.FACTORY_INTAKE_TASK !== undefined ? { intakeTaskId: e.FACTORY_INTAKE_TASK } : {}),
    ...(e.FACTORY_DRAFTER_APP_ROOT !== undefined
      ? { drafterAppRoot: e.FACTORY_DRAFTER_APP_ROOT }
      : {}),
    drafterImage: e.FACTORY_DRAFTER_IMAGE,
  }
}
