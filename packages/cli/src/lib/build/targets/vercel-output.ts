import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { build } from "esbuild"

import { CliError, formatErrorMessage } from "../../output.js"
import {
  composeVercelRoutes,
  DEFAULT_VERCEL_FUNCTION_NAME,
  VERCEL_ROUTE_KEYS,
} from "./vercel-compose.js"

export const VERCEL_BUILD_OUTPUT_CONFIG = {
  routes: [{ dest: `/${DEFAULT_VERCEL_FUNCTION_NAME}`, src: "/(.*)" }],
  version: 3,
} as const

/**
 * The runtime function's Vercel config.
 *
 * `supportsResponseStreaming` is not optional for this function: the runtime
 * answers `/agui/:routeId` and `/threads/:id/runs/stream` with
 * `text/event-stream`, and without the flag Vercel's Node launcher buffers the
 * whole body, so a browser receives nothing until the run finishes rather than
 * tokens as they are produced. It is a fact about what the runtime serves, not
 * a deployment preference, so it is fixed here rather than configurable.
 */
export const VERCEL_FUNCTION_CONFIG = {
  handler: "index.mjs",
  launcherType: "Nodejs",
  runtime: "nodejs24.x",
  supportsResponseStreaming: true,
} as const

type PathOperations = Pick<typeof import("node:path"), "isAbsolute" | "relative" | "sep">

export interface VercelMetadataOptions {
  /** Runtime function name; `functions/<name>.func`. Default `index`. */
  readonly functionName?: string
  /**
   * `maxDuration` for the runtime function, in seconds. Omitted leaves the
   * property off `.vc-config.json`, where Vercel applies the plan's default.
   */
  readonly maxDuration?: number
  /** Complete `config.json` route list. Default: the runtime catch-all. */
  readonly routes?: readonly Readonly<Record<string, unknown>>[]
}

export async function writeVercelMetadata(
  outputDir: string,
  options: VercelMetadataOptions = {},
): Promise<{
  readonly configPath: string
  readonly functionConfigPath: string
  readonly functionDir: string
}> {
  const functionName = options.functionName ?? DEFAULT_VERCEL_FUNCTION_NAME
  const routes = options.routes ?? composeVercelRoutes({ functionName, routes: [] })
  const configPath = join(outputDir, "config.json")
  const functionDir = join(outputDir, "functions", `${functionName}.func`)
  const functionConfigPath = join(functionDir, ".vc-config.json")

  const functionConfig = {
    ...VERCEL_FUNCTION_CONFIG,
    ...(options.maxDuration !== undefined ? { maxDuration: options.maxDuration } : {}),
  }

  await mkdir(functionDir, { recursive: true })
  await Promise.all([
    writeFile(configPath, stringifyJson({ routes, version: 3 }), "utf8"),
    writeFile(functionConfigPath, stringifyJson(functionConfig), "utf8"),
  ])

  return { configPath, functionConfigPath, functionDir }
}

/**
 * Validate a Build Output tree. `config.json` must route to the runtime
 * function; the runtime function's config is exact; every other
 * `functions/*.func` must be a self-contained Node function.
 */
export async function validateVercelOutput(
  outputDir: string,
  options: { readonly functionName?: string; readonly maxDuration?: number } = {},
): Promise<void> {
  const functionName = options.functionName ?? DEFAULT_VERCEL_FUNCTION_NAME
  const configPath = join(outputDir, "config.json")
  const functionsDir = join(outputDir, "functions")
  const functionDir = join(functionsDir, `${functionName}.func`)
  const functionConfigPath = join(functionDir, ".vc-config.json")

  validateBuildOutputConfig(await readJson(configPath), configPath, functionName)
  validateFunctionConfig(
    await readJson(functionConfigPath),
    functionConfigPath,
    options.maxDuration,
  )
  await validateFunctionDirectory(functionDir)

  for (const entry of await readdir(functionsDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".func") || entry.name === `${functionName}.func`) continue
    const extraDir = join(functionsDir, entry.name)
    const extraConfigPath = join(extraDir, ".vc-config.json")
    validateExtraFunctionConfig(await readJson(extraConfigPath), extraConfigPath)
    await validateFunctionDirectory(extraDir)
  }
}

async function validateFunctionDirectory(functionDir: string): Promise<void> {
  const entryPath = join(functionDir, "index.mjs")
  const functionDirStats = await lstatOrThrow(
    functionDir,
    `Vercel function directory is missing: ${functionDir}`,
  )
  if (!functionDirStats.isDirectory()) {
    throw new Error(`Vercel function directory must be a directory: ${functionDir}`)
  }

  const entryStats = await lstatOrThrow(entryPath, `Vercel function entry is missing: ${entryPath}`)
  if (!entryStats.isFile()) {
    throw new Error(`Vercel function entry must be a regular file: ${entryPath}`)
  }

  const realFunctionDir = await realpathOrThrow(
    functionDir,
    `Unable to resolve Vercel function directory ${functionDir}`,
  )
  await validateFunctionTree(functionDir, realFunctionDir)
  await validateRuntimeDependencies(entryPath, functionDir, realFunctionDir)
}

/**
 * Atomically replace `outputDir` (`.vercel/output` by default) with one fully
 * validated staged tree. The prior output is parked beside it during the swap.
 */
export async function publishVercelOutput(input: {
  readonly outputDir: string
  readonly stagedOutput: string
  readonly fileOps?: Pick<typeof import("node:fs/promises"), "rename" | "rm">
}): Promise<void> {
  const fileOps = input.fileOps ?? { rename, rm }
  const outputDir = input.outputDir
  const backupPath = join(dirname(outputDir), `.b4-vercel-output-backup-${randomUUID()}`)
  let backupCreated = false

  try {
    await fileOps.rename(outputDir, backupPath)
    backupCreated = true
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new CliError(
        `Could not preserve the existing Vercel output at ${outputDir}: ${formatErrorMessage(error)}`,
        1,
        { cause: error },
      )
    }
  }

  try {
    await fileOps.rename(input.stagedOutput, outputDir)
  } catch (publicationError) {
    if (backupCreated) {
      try {
        await fileOps.rename(backupPath, outputDir)
        backupCreated = false
      } catch (rollbackError) {
        throw new AggregateError(
          [publicationError, rollbackError],
          `Could not publish Vercel output and could not restore the prior output. The recoverable backup remains at ${backupPath}. Publication failed: ${formatErrorMessage(publicationError)}. Rollback failed: ${formatErrorMessage(rollbackError)}.`,
          { cause: publicationError },
        )
      }
    }

    throw new CliError(
      `Could not publish the staged Vercel output at ${outputDir}: ${formatErrorMessage(publicationError)}`,
      1,
      { cause: publicationError },
    )
  }

  if (!backupCreated) return

  try {
    await fileOps.rm(backupPath, { force: true, recursive: true })
  } catch (cleanupError) {
    throw new CliError(
      `Published the new Vercel output at ${outputDir}, but could not remove its prior-output backup at ${backupPath}. The new output remains valid; inspect or remove the backup manually. Cleanup failed: ${formatErrorMessage(cleanupError)}`,
      1,
      { cause: cleanupError },
    )
  }
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function readJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    throw errorWithCause(`Unable to read Vercel metadata ${path}`, error)
  }

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw errorWithCause(`Invalid JSON in Vercel metadata ${path}`, error)
  }
}

/**
 * The Build Output config may be composed by the build itself (static assets,
 * further functions, their routes) or after it, so this asserts the parts the
 * runtime function depends on rather than the exact catch-all a bare build
 * writes: a version-3 config whose route list still reaches the runtime
 * function, with route shapes the Build Output API accepts.
 */
function validateBuildOutputConfig(value: unknown, configPath: string, functionName: string): void {
  const config = asRecord(value, configPath)
  if (config.version !== VERCEL_BUILD_OUTPUT_CONFIG.version) {
    throw new Error(`${configPath} property "version" must be 3`)
  }
  if (!Array.isArray(config.routes)) {
    throw new Error(`${configPath} property "routes" must be an array`)
  }
  if (config.routes.length === 0) {
    throw new Error(`${configPath} property "routes" must be a non-empty array`)
  }

  const runtimeDest = `/${functionName}`
  let sawFilesystemPhase = false
  let sawRuntimeRoute = false
  config.routes.forEach((entry, index) => {
    const prefix = `routes[${index}].`
    const route = asRecord(entry, `${configPath} property "routes[${index}]"`)
    if ("handle" in route) {
      validateExactProperties(route, ["handle"], configPath, prefix)
      if (route.handle !== "filesystem") {
        throw new Error(`${configPath} property "${prefix}handle" must be "filesystem"`)
      }
      if (sawFilesystemPhase) {
        throw new Error(`${configPath} property "${prefix}handle" may appear once`)
      }
      sawFilesystemPhase = true
      return
    }
    validateExactProperties(route, VERCEL_ROUTE_KEYS, configPath, prefix)
    if (typeof route.src !== "string" || route.src.length === 0) {
      throw new Error(`${configPath} property "${prefix}src" must be a non-empty string`)
    }
    if (route.dest !== undefined && typeof route.dest !== "string") {
      throw new Error(`${configPath} property "${prefix}dest" must be a string`)
    }
    if (route.dest === runtimeDest) sawRuntimeRoute = true
  })
  if (!sawRuntimeRoute) {
    throw new Error(
      `${configPath} property "routes" must contain a route with dest ${JSON.stringify(runtimeDest)} so requests reach the runtime function`,
    )
  }
}

function validateFunctionConfig(value: unknown, configPath: string, maxDuration?: number): void {
  const config = asRecord(value, configPath)
  // The fixed properties stay exact. `maxDuration` is the one property the app
  // chooses, so it is allowed only when configured, and then must be that value:
  // a tree whose duration disagrees with the config it was built from is not one
  // this build wrote.
  validateExactProperties(
    config,
    [...Object.keys(VERCEL_FUNCTION_CONFIG), ...(maxDuration === undefined ? [] : ["maxDuration"])],
    configPath,
  )
  for (const [property, expected] of Object.entries(VERCEL_FUNCTION_CONFIG)) {
    if (config[property] !== expected) {
      throw new Error(`${configPath} property "${property}" must be ${JSON.stringify(expected)}`)
    }
  }
  if (maxDuration !== undefined && config.maxDuration !== maxDuration) {
    throw new Error(`${configPath} property "maxDuration" must be ${JSON.stringify(maxDuration)}`)
  }
}

const EXTRA_FUNCTION_RUNTIME = /^nodejs\d+\.x$/

function validateExtraFunctionConfig(value: unknown, configPath: string): void {
  const config = asRecord(value, configPath)
  validateExactProperties(
    config,
    ["handler", "launcherType", "runtime", "maxDuration", "supportsResponseStreaming"],
    configPath,
  )
  if (config.handler !== VERCEL_FUNCTION_CONFIG.handler) {
    throw new Error(`${configPath} property "handler" must be "${VERCEL_FUNCTION_CONFIG.handler}"`)
  }
  if (config.launcherType !== VERCEL_FUNCTION_CONFIG.launcherType) {
    throw new Error(
      `${configPath} property "launcherType" must be "${VERCEL_FUNCTION_CONFIG.launcherType}"`,
    )
  }
  if (typeof config.runtime !== "string" || !EXTRA_FUNCTION_RUNTIME.test(config.runtime)) {
    throw new Error(
      `${configPath} property "runtime" must be a Node runtime such as "${VERCEL_FUNCTION_CONFIG.runtime}"`,
    )
  }
  if (
    config.maxDuration !== undefined &&
    (typeof config.maxDuration !== "number" ||
      !Number.isInteger(config.maxDuration) ||
      config.maxDuration < 1)
  ) {
    throw new Error(`${configPath} property "maxDuration" must be a positive integer`)
  }
  if (
    config.supportsResponseStreaming !== undefined &&
    typeof config.supportsResponseStreaming !== "boolean"
  ) {
    throw new Error(`${configPath} property "supportsResponseStreaming" must be a boolean`)
  }
}

function validateExactProperties(
  value: Record<string, unknown>,
  allowedProperties: readonly string[],
  location: string,
  propertyPrefix = "",
): void {
  for (const property of Object.keys(value)) {
    if (!allowedProperties.includes(property)) {
      throw new Error(`${location} property "${propertyPrefix}${property}" is not allowed`)
    }
  }
}

function asRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

async function lstatOrThrow(path: string, message: string) {
  try {
    return await lstat(path)
  } catch (error) {
    throw errorWithCause(message, error)
  }
}

async function realpathOrThrow(path: string, message: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw errorWithCause(message, error)
  }
}

async function validateFunctionTree(functionDir: string, realFunctionDir: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const entryStats = await lstat(path)
      if (entryStats.isSymbolicLink()) {
        const target = await realpathOrThrow(
          path,
          `Vercel function symlink cannot be resolved: ${path}`,
        )
        if (!isVercelPathWithin(realFunctionDir, target)) {
          throw new Error(
            `Vercel function symlink resolves outside ${functionDir}: ${path} -> ${target}`,
          )
        }
        continue
      }
      if (entryStats.isDirectory()) await visit(path)
    }
  }

  await visit(functionDir)
}

async function validateRuntimeDependencies(
  entryPath: string,
  functionDir: string,
  realFunctionDir: string,
): Promise<void> {
  let metafile: Awaited<ReturnType<typeof build>>["metafile"]
  try {
    const result = await build({
      absPaths: ["metafile"],
      bundle: true,
      entryPoints: [entryPath],
      external: ["node:*"],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "node",
      supported: { "dynamic-import": false },
      write: false,
    })
    metafile = result.metafile
  } catch (error) {
    throw errorWithCause(`Unable to resolve Vercel function dependencies from ${entryPath}`, error)
  }

  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    validateExternalDependencies(inputPath, input.imports)
    if (isBundledDataModule(inputPath)) continue
    if (isVirtualInput(inputPath)) {
      throw new Error(`Vercel function contains unsupported virtual input ${inputPath}`)
    }

    const realInputPath = await realpathOrThrow(
      inputPath,
      `Unable to resolve Vercel function dependency input ${inputPath}`,
    )
    if (!isVercelPathWithin(realFunctionDir, realInputPath)) {
      throw new Error(
        `Vercel function dependency resolves outside ${functionDir}: ${inputPath} -> ${realInputPath}`,
      )
    }
  }
}

function validateExternalDependencies(
  importer: string,
  dependencies: ReadonlyArray<{
    readonly external?: boolean
    readonly path: string
  }>,
): void {
  for (const dependency of dependencies) {
    if (!dependency.external) continue
    if (dependency.path === "module" || dependency.path === "node:module") {
      throw new Error(
        `Vercel function runtime loader ${JSON.stringify(dependency.path)} is forbidden from ${importer}`,
      )
    }
    if (dependency.path === "<runtime>") {
      throw new Error(`Vercel function nonliteral dynamic import is forbidden from ${importer}`)
    }
    if (!isBuiltin(dependency.path)) {
      throw new Error(
        `Vercel function external dependency ${JSON.stringify(dependency.path)} from ${importer} is not an allowed Node builtin`,
      )
    }
  }
}

function isBundledDataModule(path: string): boolean {
  return path.startsWith("<data:") && path.endsWith(">")
}

function isVirtualInput(path: string): boolean {
  return path.startsWith("<") && path.endsWith(">")
}

export function isVercelPathWithin(
  root: string,
  path: string,
  pathOperations: PathOperations = { isAbsolute, relative, sep },
): boolean {
  const pathRelativeToRoot = pathOperations.relative(root, path)
  return (
    !pathOperations.isAbsolute(pathRelativeToRoot) &&
    (pathRelativeToRoot === "" ||
      (!pathRelativeToRoot.startsWith(`..${pathOperations.sep}`) && pathRelativeToRoot !== ".."))
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorWithCause(message: string, cause: unknown): Error {
  return new Error(`${message}: ${errorMessage(cause)}`, { cause })
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
