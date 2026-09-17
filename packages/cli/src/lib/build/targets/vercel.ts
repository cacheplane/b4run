import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"

import { build } from "esbuild"

import { CliError, formatErrorMessage } from "../../output.js"
import type { BuildTarget } from "./index.js"
import { reconcileVercelConfig } from "./vercel-config.js"
import { createVercelNodeCompatibilityPlugin } from "./vercel-node-compat.js"
import {
  publishVercelOutput,
  resolveVercelFunctionName,
  validateVercelOutput,
  vercelFunctionDir,
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

export const vercelTarget: BuildTarget = {
  name: "vercel",
  async emit(ctx) {
    // Resolved before any filesystem work so a bad name fails fast.
    const functionName = resolveVercelFunctionName(ctx.config)
    const vercelDir = join(ctx.appRoot, ".vercel")
    const invocationDir = join(vercelDir, `.b4-vercel-${randomUUID()}`)
    const runtimeDir = join(invocationDir, "runtime")
    const stagedOutput = join(invocationDir, "output")
    const finalOutput = join(vercelDir, "output")
    const finalFunctionDir = vercelFunctionDir(finalOutput, functionName)
    const functionEntryPath = join(vercelFunctionDir(stagedOutput, functionName), "index.mjs")
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
          `Could not bundle the generated Vercel runtime: ${formatErrorMessage(error)}. The Vercel function directory boundary at ${finalFunctionDir} must contain every application, provider, and runtime dependency; install the missing import as a runtime dependency and rebuild.`,
          1,
          { cause: error },
        )
      }

      await writeVercelMetadata(stagedOutput, { functionName })
      await validateVercelOutput(stagedOutput, { functionName })
      const rootConfig = await reconcileVercelConfig({
        appRoot: ctx.appRoot,
        buildDir: ctx.buildDir,
        ...(ctx.io ? { io: ctx.io } : {}),
      })
      await publishVercelOutput({ stagedOutput, vercelDir })

      artifacts = [
        join(finalOutput, "config.json"),
        join(finalFunctionDir, ".vc-config.json"),
        join(finalFunctionDir, "index.mjs"),
        rootConfig.artifactPath,
      ]
    } catch (error) {
      didFail = true
      primaryError = error
    } finally {
      try {
        await cleanupFileOps.rm(invocationDir, { force: true, recursive: true })
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
