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

const httpUrl = (name: string) =>
  z
    .string()
    .url()
    .refine((value) => /^https?:/.test(value), { message: `${name} must be http(s)` })

/** One builder worker: the process that runs `/build#agent` for one target's threads. */
export interface WorkerEndpoint {
  readonly url: string
  /** The worker app's root: where its installation store (`.b4/workspaces`) lives. */
  readonly appRoot: string
  readonly route: string
  /**
   * Where `dispatch` writes one manifest per work order for this worker's resolver to read:
   * the builder process's `FACTORY_BUILDER_MANIFEST_DIR`. `<appRoot>/.factory/manifests` by
   * default.
   */
  readonly manifestDir: string
}

/** The drafter: the one process that runs `/intake#agent` for every issue work order. */
export interface DrafterEndpoint {
  readonly url: string
  /**
   * The drafter app's root: where its installation store (`.b4/workspaces`) lives, which is
   * how the controller resolves an intake thread to the workspace the drafter wrote `draft/` in.
   */
  readonly appRoot: string
  readonly route: string
  /** Where the controller writes one manifest per work order for the drafter's resolver to read. */
  readonly manifestDir: string
}

/** The wildcard key: a worker entry every target resolves to when it has no entry of its own. */
export const ANY_TARGET = "*"
export const DEFAULT_WORKER_ROUTE = "/build#agent"
export const DEFAULT_DRAFTER_ROUTE = "/intake#agent"

const WorkerEndpointSchema = z
  .object({
    url: httpUrl("url"),
    appRoot: z.string().min(1),
    route: z.string().min(1).default(DEFAULT_WORKER_ROUTE),
    manifestDir: z.string().min(1).optional(),
  })
  .strict()

/**
 * `FACTORY_WORKERS`: a JSON object from target id (or `*`) to worker entry. Parsed here so a
 * malformed value is reported under the variable's name like every other issue.
 */
const WorkersEnv = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined
    let raw: unknown
    try {
      raw = JSON.parse(value)
    } catch (error) {
      ctx.addIssue({ code: "custom", message: `FACTORY_WORKERS is not JSON: ${String(error)}` })
      return z.NEVER
    }
    const parsed = z.record(z.string().min(1), WorkerEndpointSchema).safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`)
      ctx.addIssue({ code: "custom", message: `FACTORY_WORKERS: ${issues.join("; ")}` })
      return z.NEVER
    }
    if (Object.keys(parsed.data).length === 0) {
      ctx.addIssue({ code: "custom", message: "FACTORY_WORKERS names no worker" })
      return z.NEVER
    }
    return parsed.data
  })

/**
 * The environment the controller reads. Unknown keys are stripped rather than
 * rejected, which is how rung 0's `FACTORY_WORKER_OUTBOX` and
 * `FACTORY_RECEIPT_WAIT_MS` (and 3a's `FACTORY_INTAKE_ROUTE` and `FACTORY_INTAKE_TASK`)
 * stop mattering without breaking an environment that still sets them: they name nothing,
 * but an operator's old service file keeps starting.
 */
const EnvSchema = z.object({
  /** One worker per target. Exclusive with the legacy single-worker pair below. */
  FACTORY_WORKERS: WorkersEnv,
  /** The legacy pair: one builder worker for every target (`workers["*"]`). */
  FACTORY_WORKER_URL: httpUrl("FACTORY_WORKER_URL").optional(),
  FACTORY_WORKER_ROUTE: z.string().min(1).default(DEFAULT_WORKER_ROUTE),
  FACTORY_BUILDER_APP_ROOT: z.string().min(1).optional(),
  FACTORY_BUILDER_MANIFEST_DIR: z.string().min(1).optional(),
  FACTORY_STATE_DIR: z.string({ message: "FACTORY_STATE_DIR is required" }).min(1),
  FACTORY_EXPORT_DIR: z.string().min(1).optional(),
  FACTORY_ARTIFACTS_DIR: z.string().min(1).optional(),
  FACTORY_APPROVAL_TTL_MS: positiveInt("FACTORY_APPROVAL_TTL_MS"),
  FACTORY_MAX_ACTIVE_MS: positiveInt("FACTORY_MAX_ACTIVE_MS"),
  FACTORY_MAX_CHANGED_BYTES: positiveInt("FACTORY_MAX_CHANGED_BYTES"),
  /** The drafter pair: set both or neither. */
  FACTORY_DRAFTER_URL: httpUrl("FACTORY_DRAFTER_URL").optional(),
  FACTORY_DRAFTER_APP_ROOT: z.string().min(1).optional(),
  FACTORY_DRAFTER_ROUTE: z.string().min(1).default(DEFAULT_DRAFTER_ROUTE),
  FACTORY_DRAFTER_MANIFEST_DIR: z.string().min(1).optional(),
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
  /**
   * The builder workers by target id. `*` is the wildcard entry every target without one of
   * its own resolves to; the legacy `FACTORY_WORKER_URL` + `FACTORY_BUILDER_APP_ROOT` pair
   * is exactly that one entry. Resolve through {@link workerEndpointFor}.
   */
  readonly workers: Readonly<Record<string, WorkerEndpoint>>
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
   * The drafter's sandbox image: with the fixed scope, the identity of the provider that
   * addresses a drafter thread's workspace. Must equal what the drafter app booted with
   * (`FACTORY_DRAFTER_IMAGE` on both, else the pinned default on both).
   */
  readonly drafterImage: string
}

/** The worker entry for `targetId`: its own, else the wildcard, else none. */
export function workerEndpointFor(
  workers: Readonly<Record<string, WorkerEndpoint>>,
  targetId: string,
): WorkerEndpoint | undefined {
  return workers[targetId] ?? workers[ANY_TARGET]
}

/** Where a worker app reads its manifests when nobody says otherwise. */
function defaultManifestDir(appRoot: string): string {
  return join(appRoot, ".factory", "manifests")
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): FactoryConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`)
    throw new Error(`Invalid factory configuration:\n${issues.join("\n")}`)
  }
  const e = parsed.data
  const invalid = (message: string) => new Error(`Invalid factory configuration:\n${message}`)
  /** Set by the operator, as opposed to defaulted by the schema. */
  const isSet = (name: string) => env[name] !== undefined
  // The worker map: `FACTORY_WORKERS`, or the legacy pair as the one wildcard entry. Never
  // both: two sources for the same target would leave which one wins to the reader. A knob
  // of the other form is refused by name rather than ignored, so an operator who set it
  // learns it does nothing.
  if (e.FACTORY_WORKERS !== undefined) {
    const stray = [
      "FACTORY_WORKER_URL",
      "FACTORY_BUILDER_APP_ROOT",
      "FACTORY_WORKER_ROUTE",
      "FACTORY_BUILDER_MANIFEST_DIR",
    ].filter(isSet)
    if (stray.length > 0)
      throw invalid(
        `FACTORY_WORKERS is set; unset ${stray.join(" and ")} (the entries carry url, appRoot, route and manifestDir)`,
      )
  }
  let workers: Readonly<Record<string, WorkerEndpoint>>
  if (e.FACTORY_WORKERS !== undefined) {
    workers = Object.fromEntries(
      Object.entries(e.FACTORY_WORKERS).map(([id, entry]) => [
        id,
        {
          url: entry.url.replace(/\/$/, ""),
          appRoot: entry.appRoot,
          route: entry.route,
          manifestDir: entry.manifestDir ?? defaultManifestDir(entry.appRoot),
        },
      ]),
    )
    // One process has one installation store: two entries at one URL naming different app
    // roots would read one of the two threads' workspaces from a store that never held it.
    const byUrl = new Map<string, [string, WorkerEndpoint]>()
    for (const [id, entry] of Object.entries(workers)) {
      const seen = byUrl.get(entry.url)
      if (seen !== undefined && seen[1].appRoot !== entry.appRoot)
        throw invalid(
          `FACTORY_WORKERS: workers ${seen[0]} and ${id} share ${entry.url} but name different app roots (${seen[1].appRoot}, ${entry.appRoot})`,
        )
      // Nor one manifest directory: the process reads the one it booted with, and a manifest
      // written anywhere else is one its resolver never finds.
      if (seen !== undefined && seen[1].manifestDir !== entry.manifestDir)
        throw invalid(
          `FACTORY_WORKERS: workers ${seen[0]} and ${id} share ${entry.url} but name different manifest directories (${seen[1].manifestDir}, ${entry.manifestDir})`,
        )
      byUrl.set(entry.url, [id, entry])
    }
  } else {
    if (e.FACTORY_WORKER_URL === undefined && e.FACTORY_BUILDER_APP_ROOT === undefined)
      throw invalid("FACTORY_WORKERS or FACTORY_WORKER_URL is required")
    if (e.FACTORY_WORKER_URL === undefined)
      throw invalid("FACTORY_WORKER_URL is required with FACTORY_BUILDER_APP_ROOT")
    if (e.FACTORY_BUILDER_APP_ROOT === undefined)
      throw invalid("FACTORY_BUILDER_APP_ROOT is required with FACTORY_WORKER_URL")
    workers = {
      [ANY_TARGET]: {
        url: e.FACTORY_WORKER_URL.replace(/\/$/, ""),
        appRoot: e.FACTORY_BUILDER_APP_ROOT,
        route: e.FACTORY_WORKER_ROUTE,
        manifestDir:
          e.FACTORY_BUILDER_MANIFEST_DIR ?? defaultManifestDir(e.FACTORY_BUILDER_APP_ROOT),
      },
    }
  }
  // The drafter: a URL without an app root could start a turn nobody can read, and an app
  // root without a URL could read a thread nobody can start. Its other knobs mean nothing
  // without the pair, and an operator who set one is told so rather than left waiting for
  // an intake that will refuse.
  if ((e.FACTORY_DRAFTER_URL === undefined) !== (e.FACTORY_DRAFTER_APP_ROOT === undefined))
    throw invalid("FACTORY_DRAFTER_URL and FACTORY_DRAFTER_APP_ROOT: set both or neither")
  if (e.FACTORY_DRAFTER_URL === undefined) {
    const stray = [
      "FACTORY_DRAFTER_ROUTE",
      "FACTORY_DRAFTER_MANIFEST_DIR",
      "FACTORY_DRAFTER_IMAGE",
    ].filter(isSet)
    if (stray.length > 0)
      throw invalid(
        `${stray.join(" and ")} ${stray.length > 1 ? "are" : "is"} set but the drafter is not: set FACTORY_DRAFTER_URL and FACTORY_DRAFTER_APP_ROOT, or unset ${stray.length > 1 ? "them" : "it"}`,
      )
  }
  const drafter: DrafterEndpoint | undefined =
    e.FACTORY_DRAFTER_URL !== undefined && e.FACTORY_DRAFTER_APP_ROOT !== undefined
      ? {
          url: e.FACTORY_DRAFTER_URL.replace(/\/$/, ""),
          appRoot: e.FACTORY_DRAFTER_APP_ROOT,
          route: e.FACTORY_DRAFTER_ROUTE,
          manifestDir:
            e.FACTORY_DRAFTER_MANIFEST_DIR ?? defaultManifestDir(e.FACTORY_DRAFTER_APP_ROOT),
        }
      : undefined
  return {
    workers,
    ...(drafter !== undefined ? { drafter } : {}),
    stateDir: e.FACTORY_STATE_DIR,
    registryPath: join(e.FACTORY_STATE_DIR, "registry.sqlite"),
    exportDir: e.FACTORY_EXPORT_DIR ?? join(e.FACTORY_STATE_DIR, "exports"),
    artifactsDir: e.FACTORY_ARTIFACTS_DIR ?? join(e.FACTORY_STATE_DIR, "artifacts"),
    generatedTasksDir: generatedTasksDirFor(e.FACTORY_STATE_DIR),
    approvalTtlMs: e.FACTORY_APPROVAL_TTL_MS ?? 900_000,
    maxActiveMs: e.FACTORY_MAX_ACTIVE_MS ?? 1_200_000,
    maxChangedBytes: e.FACTORY_MAX_CHANGED_BYTES ?? 1024 * 1024,
    drafterImage: e.FACTORY_DRAFTER_IMAGE,
  }
}
