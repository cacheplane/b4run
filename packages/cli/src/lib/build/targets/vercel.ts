import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { build } from "esbuild"

import { CliError, formatErrorMessage, writeLine } from "../../output.js"
import type { BuildTarget } from "./index.js"
import { assertVercelBuildPaths, emitVercelFunction, emitVercelStatic } from "./vercel-assets.js"
import { composeVercelRoutes } from "./vercel-compose.js"
import { reconcileVercelConfig, resolveVercelBuildConfig } from "./vercel-config.js"
import { createVercelNodeCompatibilityPlugin } from "./vercel-node-compat.js"
import {
  isVercelPathWithin,
  publishVercelOutput,
  validateVercelOutput,
  writeVercelMetadata,
} from "./vercel-output.js"
import { emitWebRuntimeArtifacts } from "./web-runtime.js"

interface VercelTargetCleanupFileOps {
  readonly rm: typeof rm
}

const defaultCleanupFileOps: VercelTargetCleanupFileOps = { rm }
let cleanupFileOps = defaultCleanupFileOps

/** @internal Test seam for deterministic invocation-cleanup failures. */
export function setVercelTargetCleanupFileOpsForTesting(
  overrides: VercelTargetCleanupFileOps,
): () => void {
  const previousFileOps = cleanupFileOps
  cleanupFileOps = { ...cleanupFileOps, ...overrides }
  return () => {
    cleanupFileOps = previousFileOps
  }
}

/** The Build Output directory Vercel deploys from when nothing overrides it. */
export function defaultVercelOutputDir(appRoot: string): string {
  return join(appRoot, ".vercel", "output")
}

/**
 * Resolve the `vercel` target's output directory against the app root and
 * refuse one that contains the app root: publication replaces that directory
 * wholesale, so pointing it at the app or an ancestor would move the app.
 */
export function resolveVercelOutputDir(input: {
  readonly appRoot: string
  readonly outDir?: string
  readonly source?: "--out-dir" | "build.vercel.outDir"
}): string {
  if (input.outDir === undefined) return defaultVercelOutputDir(input.appRoot)
  const outputDir = resolve(input.appRoot, input.outDir)
  if (isVercelPathWithin(outputDir, input.appRoot)) {
    throw new CliError(
      `The Vercel output directory ${outputDir} (from ${input.source ?? "the build options"}: ${JSON.stringify(input.outDir)}) contains the app root ${input.appRoot}. The build replaces that directory wholesale, so choose a directory that is not the app root or one of its ancestors.`,
    )
  }
  return outputDir
}

export const vercelTarget: BuildTarget = {
  name: "vercel",
  async emit(ctx) {
    // One resolver validates the whole of `build.vercel`, and every named path
    // is checked, before anything is written — so a near-miss config cannot
    // read as configured while the build goes on to write a tree from it.
    const { composition, reconcileVercelJson: reconcileRootConfig } = resolveVercelBuildConfig(
      ctx.buildConfig,
      ctx.appRoot,
    )
    await assertVercelBuildPaths(composition, ctx.appRoot)
    const { functionName } = composition
    const functionDirName = `${functionName}.func`

    const finalOutput = ctx.vercelOutputDir ?? defaultVercelOutputDir(ctx.appRoot)
    const invocationName = `.b4-vercel-${randomUUID()}`
    // The generated runtime stays inside the app root so its imports resolve
    // from the app's node_modules; the output tree is staged beside its final
    // location so publication is a same-device rename. For the default
    // `.vercel/output` both live in one invocation directory.
    const invocationDir = join(ctx.appRoot, ".vercel", invocationName)
    const runtimeDir = join(invocationDir, "runtime")
    const stagingDir = join(dirname(finalOutput), invocationName)
    const stagedOutput = join(stagingDir, "output")
    const invocationDirs = [...new Set([invocationDir, stagingDir])]
    const functionEntryPath = join(stagedOutput, "functions", functionDirName, "index.mjs")
    let didFail = false
    let primaryError: unknown
    let cleanupDidFail = false
    let cleanupError: unknown
    let failedCleanupDir = invocationDir
    let artifacts: string[] = []

    try {
      const runtime = await emitWebRuntimeArtifacts(ctx, {
        outputDir: runtimeDir,
        targetName: "vercel",
      })

      try {
        await build({
          absWorkingDir: ctx.appRoot,
          bundle: true,
          conditions: ["b4-static-provider-imports", "module"],
          entryPoints: [runtime.appPath],
          format: "esm",
          minify: false,
          outfile: functionEntryPath,
          platform: "node",
          plugins: [createVercelNodeCompatibilityPlugin()],
          sourcemap: false,
          target: "node24",
        })
      } catch (error) {
        throw new CliError(
          `Could not bundle the generated Vercel runtime: ${formatErrorMessage(error)}. The Vercel function directory boundary at ${join(finalOutput, "functions", functionDirName)} must contain every application, provider, and runtime dependency; install the missing import as a runtime dependency and rebuild.`,
          1,
          { cause: error },
        )
      }

      const stagedStatic = await emitVercelStatic(composition, stagedOutput)
      const stagedFunctionFiles: string[] = []
      for (const fn of composition.functions) {
        stagedFunctionFiles.push(
          ...(await emitVercelFunction(fn, {
            appRoot: ctx.appRoot,
            outputDir: stagedOutput,
          })),
        )
      }

      await writeVercelMetadata(stagedOutput, {
        functionName,
        ...(composition.maxDuration === undefined ? {} : { maxDuration: composition.maxDuration }),
        routes: composeVercelRoutes({
          functionName,
          hasStatic: composition.static !== undefined,
          routes: composition.routes,
          ...(composition.static?.spaFallback
            ? { spaFallback: composition.static.spaFallback }
            : {}),
        }),
      })
      await validateVercelOutput(stagedOutput, {
        functionName,
        ...(composition.maxDuration === undefined ? {} : { maxDuration: composition.maxDuration }),
      })
      // A prebuilt flow (`vercel deploy --prebuilt`) never runs the root
      // `buildCommand`, so the opt-out leaves `vercel.json` unread, unwritten,
      // and out of the artifact list rather than requiring a file that exists
      // only to satisfy the reconciler.
      const rootConfigArtifacts: string[] = []
      if (reconcileRootConfig) {
        const rootConfig = await reconcileVercelConfig({
          appRoot: ctx.appRoot,
          buildDir: ctx.buildDir,
          ...(ctx.io ? { io: ctx.io } : {}),
        })
        rootConfigArtifacts.push(rootConfig.artifactPath)
      } else if (ctx.io) {
        writeLine(
          ctx.io.stdout,
          "vercel: root config reconciliation is off (build.vercel.reconcileVercelJson: false); vercel.json was not created, read, or modified. A prebuilt deploy runs no buildCommand at all; enable Fluid compute in the Vercel project settings, which this build no longer checks.",
        )
      }
      await publishVercelOutput({ outputDir: finalOutput, stagedOutput })

      const published = (stagedPath: string) =>
        join(finalOutput, relative(stagedOutput, stagedPath))
      artifacts = [
        join(finalOutput, "config.json"),
        join(finalOutput, "functions", functionDirName, ".vc-config.json"),
        join(finalOutput, "functions", functionDirName, "index.mjs"),
        ...(stagedStatic ? [published(stagedStatic)] : []),
        ...stagedFunctionFiles.map(published),
        ...rootConfigArtifacts,
      ]
    } catch (error) {
      didFail = true
      primaryError = error
    } finally {
      for (const directory of invocationDirs) {
        try {
          await cleanupFileOps.rm(directory, { force: true, recursive: true })
        } catch (error) {
          if (cleanupDidFail) continue
          cleanupDidFail = true
          cleanupError = error
          failedCleanupDir = directory
        }
      }
    }

    if (cleanupDidFail) {
      if (!didFail) {
        throw new CliError(
          `Published valid Vercel output at ${finalOutput}, but could not remove its invocation directory at ${failedCleanupDir}. The final output remains valid; inspect or remove the invocation directory manually. Cleanup failed: ${formatErrorMessage(cleanupError)}`,
          1,
          { cause: cleanupError },
        )
      }

      throw new AggregateError(
        [primaryError, cleanupError],
        `The Vercel build failed: ${formatErrorMessage(primaryError)} Its invocation directory at ${failedCleanupDir} also could not be removed. The original build error remains the primary cause; inspect or remove the invocation directory manually. Cleanup failed: ${formatErrorMessage(cleanupError)}`,
        { cause: primaryError },
      )
    }

    if (didFail) throw primaryError
    return { artifacts }
  },
}
