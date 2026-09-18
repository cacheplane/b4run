import { isAbsolute, normalize, resolve, sep } from "node:path"

import { CliError } from "../../output.js"

/**
 * The runtime function's name: `functions/b4.func`, routed from `/b4`.
 *
 * Deliberately not `index`. The Build Output API also serves a function named
 * `index` at `/`, so an `index.func` shadows a static `index.html` — the whole
 * of #687. That is a property of the name, not of whether this particular
 * build happens to emit static assets, so the name is off the root always
 * rather than only when `build.vercel.static` is set. `functionName` overrides
 * it for anyone who needs the old path.
 */
export const DEFAULT_VERCEL_FUNCTION_NAME = "b4"

/**
 * The one name the Build Output API also serves at `/`. Rejected beside
 * `static` because it would shadow the static root.
 */
export const ROOT_VERCEL_FUNCTION_NAME = "index"

/**
 * The URL surfaces the B4.run runtime owns, used when a SPA fallback needs
 * every other path.
 *
 * Keep this in step with the rooted routes the runtime fetch handler answers
 * (`runtime-fetch-core.ts`): a surface missing here does not 404 on a Vercel
 * deployment that configures a fallback — it quietly serves the SPA document
 * instead, so a probe or an API call gets HTML and a 200.
 */
export const VERCEL_RUNTIME_ROUTE_SRC = "/(healthz|readyz|agui|threads|memory)(/.*)?"

export const DEFAULT_VERCEL_FUNCTION_RUNTIME = "nodejs24.x"

/** Route keys Vercel documents for `config.json` routes (besides `src`). */
export const VERCEL_ROUTE_KEYS: readonly string[] = [
  "src",
  "dest",
  "headers",
  "methods",
  "status",
  "continue",
  "check",
  "caseSensitive",
  "has",
  "missing",
  "important",
  "override",
  "locale",
  "middlewarePath",
  "middlewareRawSrc",
]

/**
 * Every `build.vercel` rejection, coded and linked the same way.
 *
 * `b4 check` renders the code and docs link from `CliError`, and
 * `check-error-codes.test.ts` asserts that shape for build-config errors — a
 * bare `CliError` here would print an uncoded line for a `build.vercel` key
 * while its siblings print the coded form.
 */
export function invalidBuildConfig(detail: string): CliError {
  return new CliError(`Invalid build config:\n${detail}`, 1, { code: "B4_E1003" })
}

const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const FUNCTION_RUNTIME_PATTERN = /^nodejs\d+\.x$/

export type VercelRoute = Readonly<Record<string, unknown>> & {
  readonly src: string
}

export interface ResolvedVercelFunction {
  readonly name: string
  /** Absolute path to the function's entry module. */
  readonly entry: string
  readonly runtime: string
  readonly maxDuration?: number
  readonly supportsResponseStreaming?: boolean
}

export interface ResolvedVercelBuild {
  readonly functionName: string
  /**
   * `maxDuration` for the runtime function, in seconds. Absent leaves the
   * property off `.vc-config.json`, where Vercel applies the plan's default.
   */
  readonly maxDuration?: number
  readonly static?: {
    /** Absolute path to the directory copied into `static/`. */
    readonly dir: string
    /** Path relative to `dir` of the SPA document, when configured. */
    readonly spaFallback?: string
  }
  readonly functions: readonly ResolvedVercelFunction[]
  readonly routes: readonly VercelRoute[]
}

/** The `build.vercel` keys that describe the composed tree. */
export const VERCEL_COMPOSITION_KEYS: readonly string[] = [
  "functionName",
  "maxDuration",
  "static",
  "functions",
  "routes",
]

/**
 * Resolve the composed-tree half of `build.vercel` against the app root. Pure:
 * existence of `static.dir`, `spaFallback`, and each `entry` is checked by the
 * target when it composes the tree, not here.
 *
 * Callers reach this through `resolveVercelBuildConfig`, which owns the shape
 * of `build.vercel` as a whole — including the keys this function ignores.
 */
export function resolveVercelComposition(input: unknown, appRoot: string): ResolvedVercelBuild {
  if (input === undefined) {
    return {
      functionName: DEFAULT_VERCEL_FUNCTION_NAME,
      functions: [],
      routes: [],
    }
  }
  const config = asRecord(input, "build.vercel")
  assertKnownKeys(config, VERCEL_COMPOSITION_KEYS, "build.vercel")

  const staticConfig = resolveStatic(config.static, appRoot)
  const functions = resolveFunctions(config.functions, appRoot)
  const routes = resolveRoutes(config.routes)

  const maxDuration = assertMaxDuration(config.maxDuration, "build.vercel.maxDuration")
  const functionName =
    config.functionName === undefined
      ? DEFAULT_VERCEL_FUNCTION_NAME
      : assertFunctionName(config.functionName, "build.vercel.functionName")
  if (staticConfig && functionName === ROOT_VERCEL_FUNCTION_NAME) {
    throw invalidBuildConfig(
      `build.vercel.functionName "${ROOT_VERCEL_FUNCTION_NAME}" cannot be combined with build.vercel.static: a function named "${ROOT_VERCEL_FUNCTION_NAME}" is also served at "/" and would shadow the static root. Choose another name (the default is "${DEFAULT_VERCEL_FUNCTION_NAME}").`,
    )
  }
  const collision = functions.find((fn) => fn.name === functionName)
  if (collision) {
    throw invalidBuildConfig(
      `build.vercel.functions.${collision.name} collides with the runtime function name "${functionName}"; rename the function or set build.vercel.functionName.`,
    )
  }

  return {
    functionName,
    ...(maxDuration !== undefined ? { maxDuration } : {}),
    ...(staticConfig ? { static: staticConfig } : {}),
    functions,
    routes,
  }
}

/**
 * Order the Build Output routes: user routes, then the filesystem phase, then
 * the runtime function, then the SPA fallback. With nothing composed the result
 * is exactly the historical catch-all.
 */
export function composeVercelRoutes(input: {
  readonly functionName: string
  readonly routes: readonly VercelRoute[]
  readonly hasStatic?: boolean
  readonly spaFallback?: string
}): Readonly<Record<string, unknown>>[] {
  const composed = input.routes.length > 0 || input.hasStatic === true || input.spaFallback
  const runtimeSrc = input.spaFallback ? VERCEL_RUNTIME_ROUTE_SRC : "/(.*)"
  return [
    ...input.routes,
    ...(composed ? [{ handle: "filesystem" }] : []),
    { dest: `/${input.functionName}`, src: runtimeSrc },
    ...(input.spaFallback ? [{ dest: `/${input.spaFallback}`, src: "/(.*)" }] : []),
  ]
}

function resolveStatic(value: unknown, appRoot: string): ResolvedVercelBuild["static"] {
  if (value === undefined) return undefined
  const record = asRecord(value, "build.vercel.static")
  assertKnownKeys(record, ["dir", "spaFallback"], "build.vercel.static")
  const dir = assertNonEmptyString(record.dir, "build.vercel.static.dir")
  if (record.spaFallback === undefined) return { dir: resolve(appRoot, dir) }
  const spaFallback = assertNonEmptyString(record.spaFallback, "build.vercel.static.spaFallback")
  const normalized = normalize(spaFallback)
  if (
    isAbsolute(spaFallback) ||
    spaFallback.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`)
  ) {
    throw invalidBuildConfig(
      `build.vercel.static.spaFallback must be a path inside build.vercel.static.dir, got ${JSON.stringify(spaFallback)}`,
    )
  }
  return { dir: resolve(appRoot, dir), spaFallback }
}

function resolveFunctions(value: unknown, appRoot: string): ResolvedVercelFunction[] {
  if (value === undefined) return []
  const record = asRecord(value, "build.vercel.functions")
  return Object.entries(record).map(([rawName, definition]) => {
    const location = FUNCTION_NAME_PATTERN.test(rawName)
      ? `build.vercel.functions.${rawName}`
      : `build.vercel.functions[${JSON.stringify(rawName)}]`
    const name = assertFunctionName(rawName, location)
    const fn = asRecord(definition, location)
    assertKnownKeys(fn, ["entry", "runtime", "maxDuration", "supportsResponseStreaming"], location)
    const entry = assertNonEmptyString(fn.entry, `${location}.entry`)
    const runtime =
      fn.runtime === undefined
        ? DEFAULT_VERCEL_FUNCTION_RUNTIME
        : assertNonEmptyString(fn.runtime, `${location}.runtime`)
    if (!FUNCTION_RUNTIME_PATTERN.test(runtime)) {
      throw invalidBuildConfig(
        `${location}.runtime must be a Node runtime such as "${DEFAULT_VERCEL_FUNCTION_RUNTIME}", got ${JSON.stringify(runtime)}`,
      )
    }
    const maxDuration = assertMaxDuration(fn.maxDuration, `${location}.maxDuration`)
    if (
      fn.supportsResponseStreaming !== undefined &&
      typeof fn.supportsResponseStreaming !== "boolean"
    ) {
      throw invalidBuildConfig(`${location}.supportsResponseStreaming must be a boolean`)
    }
    return {
      entry: resolve(appRoot, entry),
      ...(maxDuration !== undefined ? { maxDuration } : {}),
      name,
      runtime,
      ...(fn.supportsResponseStreaming !== undefined
        ? { supportsResponseStreaming: fn.supportsResponseStreaming }
        : {}),
    }
  })
}

function resolveRoutes(value: unknown): VercelRoute[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalidBuildConfig("build.vercel.routes must be an array")
  return value.map((route, index) => {
    const location = `build.vercel.routes[${index}]`
    const record = asRecord(route, location)
    if ("handle" in record) {
      throw invalidBuildConfig(
        `${location}.handle is not allowed: b4 build owns the route phases and inserts { handle: "filesystem" } itself`,
      )
    }
    assertKnownKeys(record, VERCEL_ROUTE_KEYS, location)
    const src = assertNonEmptyString(record.src, `${location}.src`)
    return { ...record, src }
  })
}

/**
 * `maxDuration` in seconds, for the runtime function and for each composed
 * function. Vercel rejects a non-integer or non-positive duration at deploy
 * time; catching it here names the offending key instead.
 */
function assertMaxDuration(value: unknown, location: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalidBuildConfig(`${location} must be a positive integer number of seconds`)
  }
  return value
}

function assertFunctionName(value: unknown, location: string): string {
  const name = assertNonEmptyString(value, location)
  if (!FUNCTION_NAME_PATTERN.test(name)) {
    throw invalidBuildConfig(
      `${location} must match ${FUNCTION_NAME_PATTERN} (one path segment), got ${JSON.stringify(name)}`,
    )
  }
  return name
}

function assertNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidBuildConfig(`${location} must be a non-empty string`)
  }
  return value
}

function assertKnownKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  location: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key))
      throw invalidBuildConfig(`${location}.${key} is not a known property`)
  }
}

function asRecord(value: unknown, location: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidBuildConfig(`${location} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}
