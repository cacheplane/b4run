import { randomUUID } from "node:crypto"
import { link, lstat, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { B4Config } from "@b4run/core"
import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../../output.js"
import {
  type ResolvedVercelBuild,
  resolveVercelComposition,
  VERCEL_COMPOSITION_KEYS,
} from "./vercel-compose.js"

const B4_VERCEL_BUILD_COMMAND = "node node_modules/@b4run/cli/dist/index.js build"

export const RECOMMENDED_VERCEL_CONFIG = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  buildCommand: B4_VERCEL_BUILD_COMMAND,
  fluid: true,
} as const

interface VercelConfigFileOps {
  readonly link: typeof link
  readonly lstat: typeof lstat
  readonly readFile: typeof readFile
  readonly rename: typeof rename
  readonly rm: typeof rm
  readonly writeFile: typeof writeFile
}

const defaultFileOps: VercelConfigFileOps = { link, lstat, readFile, rename, rm, writeFile }
let fileOps = defaultFileOps

/** @internal Test seam for deterministic filesystem races and failures. */
export function setVercelConfigFileOpsForTesting(
  overrides: Partial<VercelConfigFileOps>,
): () => void {
  const previousFileOps = fileOps
  fileOps = { ...fileOps, ...overrides }
  return () => {
    fileOps = previousFileOps
  }
}

/** Every option `build.vercel` accepts. Anything else is an authoring error. */
const VERCEL_BUILD_OPTION_KEYS: readonly string[] = [
  ...VERCEL_COMPOSITION_KEYS,
  "outDir",
  "reconcileVercelJson",
].sort()

/**
 * Validates the whole of `build.vercel` and resolves it: where the tree is
 * published, whether the `vercel` target reconciles the app-root `vercel.json`,
 * and the composed tree the target emits.
 *
 * Reconciliation is ON unless the flag is exactly `false`, so every way of
 * *nearly* turning it off has to be rejected rather than ignored — a config
 * that reads as configured while the target keeps writing `vercel.json` is the
 * failure this guards. The type only admits the right shape, but a `b4.config.js`
 * or a JSON config arrives untyped, and nothing else in the config path applies
 * a runtime schema. Rejected: a non-boolean flag (`"false"`, `0`), a non-object
 * `build.vercel` (whose `?.` read would yield `undefined`), an unknown key
 * inside it (`reconcileVercelJSON`), and the flag misplaced directly on `build`.
 *
 * `b4 check` and `b4 build` both call this, and the emitter consumes the
 * boolean it returns, so the validated shape and the honored value cannot
 * diverge.
 */
export function resolveVercelBuildConfig(
  build: B4Config["build"] | undefined,
  appRoot: string,
): {
  readonly outDir?: string
  readonly reconcileVercelJson: boolean
  readonly composition: ResolvedVercelBuild
} {
  const buildRecord = isRecord(build) ? build : undefined

  const misplaced = ownProperty(buildRecord, "reconcileVercelJson")
  if (misplaced !== undefined) {
    throw invalidBuildConfig(
      "reconcileVercelJson belongs under build.vercel, not build directly. Use build: { vercel: { reconcileVercelJson: false } }.",
    )
  }

  const misplacedOutDir = ownProperty(buildRecord, "outDir")
  if (misplacedOutDir !== undefined) {
    throw invalidBuildConfig(
      'outDir belongs under build.vercel, not build directly. Use build: { vercel: { outDir: "dist/vercel" } }.',
    )
  }

  const vercel = ownProperty(buildRecord, "vercel")
  if (vercel === undefined) {
    return { composition: resolveVercelComposition(undefined, appRoot), reconcileVercelJson: true }
  }
  if (!isRecord(vercel)) {
    throw invalidBuildConfig(`build.vercel must be an object; received ${JSON.stringify(vercel)}.`)
  }

  const unknownKeys = Object.keys(vercel)
    .filter((key) => !VERCEL_BUILD_OPTION_KEYS.includes(key))
    .sort()
  if (unknownKeys.length > 0) {
    throw invalidBuildConfig(
      `Unknown build.vercel option(s): ${unknownKeys.join(", ")}. Known options: ${VERCEL_BUILD_OPTION_KEYS.join(", ")}.`,
    )
  }

  // An empty or blank `outDir` would resolve to the app root itself, which
  // publication then replaces wholesale — reject it here rather than let the
  // path resolver report a directory the author never typed.
  const outDirValue = ownProperty(vercel, "outDir")
  let outDir: string | undefined
  if (outDirValue !== undefined) {
    if (typeof outDirValue !== "string") {
      throw invalidBuildConfig(
        `build.vercel.outDir must be a string; received ${JSON.stringify(outDirValue)}.`,
      )
    }
    if (outDirValue.trim() === "") {
      throw invalidBuildConfig("build.vercel.outDir must not be empty.")
    }
    outDir = outDirValue
  }

  const reconcileVercelJson = ownProperty(vercel, "reconcileVercelJson")
  if (reconcileVercelJson !== undefined && typeof reconcileVercelJson !== "boolean") {
    throw invalidBuildConfig(
      `build.vercel.reconcileVercelJson must be a boolean; received ${JSON.stringify(reconcileVercelJson)}.`,
    )
  }

  // The composition resolver owns the keys that describe the tree; strip the
  // options that are not part of it so neither half rejects the other's.
  const {
    outDir: _outDir,
    reconcileVercelJson: _flag,
    ...composed
  } = vercel as Record<string, unknown>
  return {
    composition: resolveVercelComposition(
      Object.keys(composed).length > 0 ? composed : undefined,
      appRoot,
    ),
    ...(outDir === undefined ? {} : { outDir }),
    reconcileVercelJson: reconcileVercelJson ?? true,
  }
}

/**
 * Throw-away form of {@link resolveVercelBuildConfig} for validation-only
 * callers. The app root only affects resolved paths, which are discarded here,
 * so validating the shape does not need the real one.
 */
export function assertVercelBuildConfig(build: B4Config["build"] | undefined): void {
  resolveVercelBuildConfig(build, ".")
}

function invalidBuildConfig(detail: string): CliError {
  return new CliError(`Invalid build config:\n${detail}`, 1, { code: "B4_E1003" })
}

export async function reconcileVercelConfig(input: {
  readonly appRoot: string
  readonly buildDir: string
  readonly io?: CommandIo
}): Promise<{ readonly artifactPath: string; readonly created: boolean }> {
  const rootPath = join(input.appRoot, "vercel.json")
  const recommendedConfig = formatRecommendedConfig()
  let rootContents: string

  try {
    rootContents = await fileOps.readFile(rootPath, "utf8")
  } catch (error) {
    if (!isMissingFile(error)) throw error
    if (await publishMissingRootConfig(rootPath, recommendedConfig)) {
      return { artifactPath: rootPath, created: true }
    }
    return await reconcileVercelConfig(input)
  }

  return await reconcileExistingRootConfig(input, rootPath, rootContents, recommendedConfig)
}

async function reconcileExistingRootConfig(
  input: { readonly appRoot: string; readonly buildDir: string; readonly io?: CommandIo },
  rootPath: string,
  rootContents: string,
  recommendedConfig: string,
): Promise<{ readonly artifactPath: string; readonly created: boolean }> {
  const referencePath = join(input.buildDir, "vercel.json")
  let config: unknown
  try {
    config = JSON.parse(rootContents)
  } catch (error) {
    throw new CliError(`Could not parse ${rootPath}: ${formatErrorMessage(error)}`, 1, {
      cause: error,
    })
  }

  const record = isRecord(config) ? config : undefined
  const buildCommand = ownProperty(record, "buildCommand")
  const fluid = ownProperty(record, "fluid")
  if (fluid === false) {
    throw new CliError(
      `${rootPath} sets fluid: false, which conflicts with the supported lifecycle; fluid: true is required.`,
    )
  }

  const buildCommandEstablished = hasProvenBuildCommand(buildCommand)
  const fluidEstablished = fluid === true
  if (buildCommandEstablished && fluidEstablished) {
    return { artifactPath: rootPath, created: false }
  }

  await publishReferenceConfig(referencePath, recommendedConfig)
  if (input.io) {
    writeLine(
      input.io.stderr,
      reconciliationWarning({
        buildCommandEstablished,
        fluidEstablished,
        referencePath,
        rootPath,
      }),
    )
  }
  return { artifactPath: referencePath, created: false }
}

async function publishMissingRootConfig(rootPath: string, contents: string): Promise<boolean> {
  const temporaryPath = temporaryConfigPath(rootPath)
  let removeTemporary = false

  try {
    try {
      removeTemporary = true
      await fileOps.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" })
    } catch (error) {
      if (isAlreadyExists(error)) removeTemporary = false
      throw filesystemError("Could not prepare an atomic root config", rootPath, error)
    }

    try {
      await fileOps.link(temporaryPath, rootPath)
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw filesystemError("Could not publish the atomic root config", rootPath, error)
      }

      let rootStats: Awaited<ReturnType<typeof lstat>>
      try {
        rootStats = await fileOps.lstat(rootPath)
      } catch (lstatError) {
        throw filesystemError("Could not inspect concurrent root config", rootPath, lstatError)
      }
      if (rootStats.isSymbolicLink()) {
        throw new CliError(
          `Cannot safely create ${rootPath}: a broken symbolic link already occupies the root config path.`,
          1,
          { cause: error },
        )
      }
      return false
    }

    return true
  } finally {
    if (removeTemporary) await removeTemporaryConfig(temporaryPath)
  }
}

async function publishReferenceConfig(referencePath: string, contents: string): Promise<void> {
  const temporaryPath = temporaryConfigPath(referencePath)
  let removeTemporary = false

  try {
    try {
      removeTemporary = true
      await fileOps.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" })
    } catch (error) {
      if (isAlreadyExists(error)) removeTemporary = false
      throw filesystemError("Could not prepare an atomic Vercel reference", referencePath, error)
    }

    try {
      await fileOps.rename(temporaryPath, referencePath)
      removeTemporary = false
    } catch (error) {
      throw filesystemError("Could not publish the atomic Vercel reference", referencePath, error)
    }
  } finally {
    if (removeTemporary) await removeTemporaryConfig(temporaryPath)
  }
}

async function removeTemporaryConfig(temporaryPath: string): Promise<void> {
  try {
    await fileOps.rm(temporaryPath, { force: true })
  } catch {
    // A cleanup failure must not hide the root/reference error that caused it.
  }
}

function temporaryConfigPath(targetPath: string): string {
  return join(dirname(targetPath), `.b4-vercel-config-${randomUUID()}.tmp`)
}

function filesystemError(action: string, targetPath: string, cause: unknown): CliError {
  return new CliError(`${action} at ${targetPath}: ${formatErrorMessage(cause)}`, 1, { cause })
}

function formatRecommendedConfig(): string {
  return `${JSON.stringify(RECOMMENDED_VERCEL_CONFIG, null, 2)}\n`
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ownProperty(record: Readonly<Record<string, unknown>> | undefined, key: string): unknown {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined
}

function hasProvenBuildCommand(value: unknown): boolean {
  if (typeof value !== "string") return false
  const command = value.replace(/^[ \t]+|[ \t]+$/g, "")
  return command.split(/[ \t]+/).join(" ") === B4_VERCEL_BUILD_COMMAND
}

function reconciliationWarning(input: {
  readonly buildCommandEstablished: boolean
  readonly fluidEstablished: boolean
  readonly referencePath: string
  readonly rootPath: string
}): string {
  const unavailableContracts = [
    ...(input.buildCommandEstablished
      ? []
      : [
          'the buildCommand contract (a string command demonstrably invoking "node_modules/@b4run/cli/dist/index.js build")',
        ]),
    ...(input.fluidEstablished ? [] : ["the required fluid: true contract"]),
  ]
  const fluidGuidance = input.fluidEstablished
    ? ""
    : " Fluid cannot be guaranteed from source, so deployment portability cannot be guaranteed; Dashboard defaults do not establish the committed contract."

  return `Warning: ${input.rootPath} is user-owned and was not modified. Could not establish ${unavailableContracts.join(" and ")}. Wrote the exact recommended reference to ${input.referencePath}; update the committed root config to establish these contracts.${fluidGuidance}`
}
