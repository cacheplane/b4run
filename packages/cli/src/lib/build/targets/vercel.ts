import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join, relative } from "node:path"

import { build } from "esbuild"

import { CliError, formatErrorMessage } from "../../output.js"
import type { BuildTarget } from "./index.js"
import { assertVercelBuildPaths, emitVercelFunction, emitVercelStatic } from "./vercel-assets.js"
import { composeVercelRoutes, resolveVercelBuildConfig } from "./vercel-compose.js"
import { reconcileVercelConfig } from "./vercel-config.js"
import { createVercelNodeCompatibilityPlugin } from "./vercel-node-compat.js"
import { publishVercelOutput, validateVercelOutput, writeVercelMetadata } from "./vercel-output.js"
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

export const vercelTarget: BuildTarget = {
  name: "vercel",
  async emit(ctx) {
    // Config shape and every named path are checked before `.vercel/` exists.
    const composition = resolveVercelBuildConfig(ctx.config?.build?.vercel, ctx.appRoot)
    await assertVercelBuildPaths(composition, ctx.appRoot)
    const { functionName } = composition

    const vercelDir = join(ctx.appRoot, ".vercel")
    const invocationDir = join(vercelDir, `.b4-vercel-${randomUUID()}`)
    const runtimeDir = join(invocationDir, "runtime")
    const stagedOutput = join(invocationDir, "output")
    const finalOutput = join(vercelDir, "output")
    const functionDirName = `${functionName}.func`
    const functionEntryPath = join(stagedOutput, "functions", functionDirName, "index.mjs")
    let didFail = false
    let primaryError: unknown
    let cleanupDidFail = false
    let cleanupError: unknown
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
        routes: composeVercelRoutes({
          functionName,
          hasStatic: composition.static !== undefined,
          routes: composition.routes,
          ...(composition.static?.spaFallback
            ? { spaFallback: composition.static.spaFallback }
            : {}),
        }),
      })
      await validateVercelOutput(stagedOutput, { functionName })
      const rootConfig = await reconcileVercelConfig({
        appRoot: ctx.appRoot,
        buildDir: ctx.buildDir,
        ...(ctx.io ? { io: ctx.io } : {}),
      })
      await publishVercelOutput({ stagedOutput, vercelDir })

      const published = (stagedPath: string) =>
        join(finalOutput, relative(stagedOutput, stagedPath))
      artifacts = [
        join(finalOutput, "config.json"),
        join(finalOutput, "functions", functionDirName, ".vc-config.json"),
        join(finalOutput, "functions", functionDirName, "index.mjs"),
        ...(stagedStatic ? [published(stagedStatic)] : []),
        ...stagedFunctionFiles.map(published),
        rootConfig.artifactPath,
      ]
    } catch (error) {
      didFail = true
      primaryError = error
    } finally {
      try {
        await cleanupFileOps.rm(invocationDir, {
          force: true,
          recursive: true,
        })
      } catch (error) {
        cleanupDidFail = true
        cleanupError = error
      }
    }

    if (cleanupDidFail) {
      if (!didFail) {
        throw new CliError(
          `Published valid Vercel output at ${finalOutput}, but could not remove its invocation directory at ${invocationDir}. The final output remains valid; inspect or remove the invocation directory manually. Cleanup failed: ${formatErrorMessage(cleanupError)}`,
          1,
          { cause: cleanupError },
        )
      }

      throw new AggregateError(
        [primaryError, cleanupError],
        `The Vercel build failed: ${formatErrorMessage(primaryError)} Its invocation directory at ${invocationDir} also could not be removed. The original build error remains the primary cause; inspect or remove the invocation directory manually. Cleanup failed: ${formatErrorMessage(cleanupError)}`,
        { cause: primaryError },
      )
    }

    if (didFail) throw primaryError
    return { artifacts }
  },
}
