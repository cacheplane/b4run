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

const httpUrl = (name: string) =>
  z
    .string()
    .url()
    .refine((value) => /^https?:/.test(value), { message: `${name} must be http(s)` })

/** The builder worker: the one process that runs `/build#agent` for every target's threads. */
export interface WorkerEndpoint {
  /** The builder's Agent Protocol base URL: runs, and reads of its threads' workspaces. */
  readonly url: string
  readonly route: string
  /**
   * Where `dispatch` writes one manifest per work order for the builder's resolver to read:
   * the directory the builder was started with (its `FACTORY_BUILDER_MANIFEST_DIR`).
   */
  readonly manifestDir: string
}

/** The drafter: the one process that runs `/intake#agent` for every issue work order. */
export interface DrafterEndpoint {
  /** The drafter's Agent Protocol base URL: runs, and reads of its threads' `draft/`. */
  readonly url: string
  readonly route: string
  /** Where the controller writes one manifest per work order for the drafter's resolver to read. */
  readonly manifestDir: string
}

export const DEFAULT_WORKER_ROUTE = "/build#agent"
export const DEFAULT_DRAFTER_ROUTE = "/intake#agent"

const WORKER_TOKEN_REQUIRED =
  "FACTORY_WORKER_TOKEN is required: the secret the workers expect (openssl rand -hex 32)"

/**
 * The environment the controller reads. Unknown keys are stripped rather than
 * rejected, which is how rung 0's `FACTORY_WORKER_OUTBOX` and
 * `FACTORY_RECEIPT_WAIT_MS` (and 3a's `FACTORY_INTAKE_ROUTE` and `FACTORY_INTAKE_TASK`)
 * stop mattering without breaking an environment that still sets them: they name nothing,
 * but an operator's old service file keeps starting.
 */
const EnvSchema = z.object({
  /** The builder pair: the one builder worker, for every target at every pin. */
  FACTORY_WORKER_URL: httpUrl("FACTORY_WORKER_URL").optional(),
  FACTORY_WORKER_ROUTE: z.string().min(1).default(DEFAULT_WORKER_ROUTE),
  FACTORY_BUILDER_MANIFEST_DIR: z.string().min(1).optional(),
  FACTORY_STATE_DIR: z.string({ message: "FACTORY_STATE_DIR is required" }).min(1),
  FACTORY_EXPORT_DIR: z.string().min(1).optional(),
  FACTORY_ARTIFACTS_DIR: z.string().min(1).optional(),
  FACTORY_APPROVAL_TTL_MS: positiveInt("FACTORY_APPROVAL_TTL_MS"),
  FACTORY_MAX_ACTIVE_MS: positiveInt("FACTORY_MAX_ACTIVE_MS"),
  FACTORY_MAX_CHANGED_BYTES: positiveInt("FACTORY_MAX_CHANGED_BYTES"),
  FACTORY_MAX_INTAKE_ATTEMPTS: positiveInt("FACTORY_MAX_INTAKE_ATTEMPTS"),
  FACTORY_MAX_CANDIDATE_ATTEMPTS: positiveInt("FACTORY_MAX_CANDIDATE_ATTEMPTS"),
  /** The drafter: its URL configures it, and its manifest directory comes with it. */
  FACTORY_DRAFTER_URL: httpUrl("FACTORY_DRAFTER_URL").optional(),
  FACTORY_DRAFTER_ROUTE: z.string().min(1).default(DEFAULT_DRAFTER_ROUTE),
  FACTORY_DRAFTER_MANIFEST_DIR: z.string().min(1).optional(),
  /**
   * The secret every worker's thread-access policy requires: `authorization: Bearer <token>`.
   * Every message below names the variable and never its value.
   */
  FACTORY_WORKER_TOKEN: z
    .string({ message: WORKER_TOKEN_REQUIRED })
    .min(1, { message: WORKER_TOKEN_REQUIRED })
    .min(32, { message: "FACTORY_WORKER_TOKEN must be at least 32 characters" })
    .regex(/^\S+$/, { message: "FACTORY_WORKER_TOKEN must contain no whitespace" }),
})

/**
 * Where a controller with state directory `stateDir` writes generated tasks. Shared with the
 * CLI, which reads the state directory without loading the rest of the configuration.
 */
export function generatedTasksDirFor(stateDir: string): string {
  return join(stateDir, "tasks")
}

export interface FactoryConfig {
  /**
   * The one builder worker: every target's work orders, at every pin. Each work order's
   * manifest carries the image, policy and permissions its thread runs with.
   */
  readonly builder: WorkerEndpoint
  /** The drafter. Absent, the `intake` command refuses before spending anything. */
  readonly drafter?: DrafterEndpoint
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
  /**
   * Drafter turns an issue intake may spend before it blocks: fixed on the row at create,
   * like `maxActiveMs`, so a restart with another value leaves existing work orders alone.
   */
  readonly maxIntakeAttempts: number
  /**
   * Builder dispatches a work order may spend: the first, plus one per `retry` of a candidate
   * failure. Fixed on the row at create, like `maxIntakeAttempts`.
   */
  readonly maxCandidateAttempts: number
  /** Sent to every worker as `authorization: Bearer <token>`. Never journalled or logged. */
  readonly workerToken: string
  /** One line per variable set here that the controller ignores; the runtime prints each at boot. */
  readonly warnings: readonly string[]
}

/**
 * Variables an older controller read, refused by name rather than stripped like other unknown
 * keys: each one used to decide which builder a work order went to or what it ran with, so an
 * operator still setting it would otherwise believe it still does.
 */
const RETIRED: Readonly<Record<string, string>> = {
  FACTORY_WORKERS:
    "one builder serves every target and pin: set FACTORY_WORKER_URL and FACTORY_BUILDER_MANIFEST_DIR",
  FACTORY_BUILDER_TARGET:
    "the builder boots with no target file; each work order's manifest carries its target",
  FACTORY_BUILDER_APP_ROOT:
    "the controller reads the builder's threads over its URL (sandbox.workspaceRead), not through its app root",
  FACTORY_DRAFTER_APP_ROOT:
    "the controller reads the drafter's threads over its URL (sandbox.workspaceRead), not through its app root",
}

/**
 * Variables the controller no longer reads but does not refuse, because a worker still reads
 * them and an operator may run both from one environment. Each is reported once at boot
 * ({@link FactoryConfig.warnings}) so nobody believes it still changes the controller.
 */
const IGNORED: Readonly<Record<string, string>> = {
  FACTORY_DRAFTER_IMAGE:
    "FACTORY_DRAFTER_IMAGE is ignored by the controller: only the drafter reads it (the controller reads drafter threads over FACTORY_DRAFTER_URL)",
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): FactoryConfig {
  const retired = Object.keys(RETIRED).filter((name) => env[name] !== undefined)
  if (retired.length > 0)
    throw new Error(
      `Invalid factory configuration:\n${retired.map((name) => `${name} is retired: ${RETIRED[name]}`).join("\n")}`,
    )
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`)
    throw new Error(`Invalid factory configuration:\n${issues.join("\n")}`)
  }
  const e = parsed.data
  const invalid = (message: string) => new Error(`Invalid factory configuration:\n${message}`)
  /** Set by the operator, as opposed to defaulted by the schema. */
  const isSet = (name: string) => env[name] !== undefined
  if (e.FACTORY_WORKER_URL === undefined) throw invalid("FACTORY_WORKER_URL is required")
  if (e.FACTORY_BUILDER_MANIFEST_DIR === undefined)
    throw invalid(
      "FACTORY_BUILDER_MANIFEST_DIR is required: the directory the builder was started with",
    )
  const builder: WorkerEndpoint = {
    url: e.FACTORY_WORKER_URL.replace(/\/$/, ""),
    route: e.FACTORY_WORKER_ROUTE,
    manifestDir: e.FACTORY_BUILDER_MANIFEST_DIR,
  }
  // The drafter is configured by its URL. Its manifest directory is where intake writes and
  // the drafter reads, so it comes with the URL; its other knobs mean nothing without the
  // drafter, and an operator who set one is told so rather than left waiting for an intake
  // that will refuse.
  if (e.FACTORY_DRAFTER_URL === undefined) {
    const stray = ["FACTORY_DRAFTER_ROUTE", "FACTORY_DRAFTER_MANIFEST_DIR"].filter(isSet)
    if (stray.length > 0)
      throw invalid(
        `${stray.join(" and ")} ${stray.length > 1 ? "are" : "is"} set but the drafter is not: set FACTORY_DRAFTER_URL, or unset ${stray.length > 1 ? "them" : "it"}`,
      )
  } else if (e.FACTORY_DRAFTER_MANIFEST_DIR === undefined)
    throw invalid("FACTORY_DRAFTER_MANIFEST_DIR is required with FACTORY_DRAFTER_URL")
  const drafter: DrafterEndpoint | undefined =
    e.FACTORY_DRAFTER_URL !== undefined && e.FACTORY_DRAFTER_MANIFEST_DIR !== undefined
      ? {
          url: e.FACTORY_DRAFTER_URL.replace(/\/$/, ""),
          route: e.FACTORY_DRAFTER_ROUTE,
          manifestDir: e.FACTORY_DRAFTER_MANIFEST_DIR,
        }
      : undefined
  return {
    builder,
    ...(drafter !== undefined ? { drafter } : {}),
    stateDir: e.FACTORY_STATE_DIR,
    registryPath: join(e.FACTORY_STATE_DIR, "registry.sqlite"),
    exportDir: e.FACTORY_EXPORT_DIR ?? join(e.FACTORY_STATE_DIR, "exports"),
    artifactsDir: e.FACTORY_ARTIFACTS_DIR ?? join(e.FACTORY_STATE_DIR, "artifacts"),
    generatedTasksDir: generatedTasksDirFor(e.FACTORY_STATE_DIR),
    approvalTtlMs: e.FACTORY_APPROVAL_TTL_MS ?? 900_000,
    maxActiveMs: e.FACTORY_MAX_ACTIVE_MS ?? 1_200_000,
    maxChangedBytes: e.FACTORY_MAX_CHANGED_BYTES ?? 1024 * 1024,
    maxIntakeAttempts: e.FACTORY_MAX_INTAKE_ATTEMPTS ?? 2,
    maxCandidateAttempts: e.FACTORY_MAX_CANDIDATE_ATTEMPTS ?? 2,
    workerToken: e.FACTORY_WORKER_TOKEN,
    warnings: Object.keys(IGNORED)
      .filter((name) => env[name] !== undefined)
      .map((name) => IGNORED[name] as string),
  }
}
