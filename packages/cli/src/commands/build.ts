import { mkdir, rm, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { type BuildTargetName, isBuildTargetName } from "@b4run/core"
import { discoverRoutes } from "@b4run/core/node"
import type { Command } from "commander"
import {
  type BuildEmitContext,
  buildTargets,
  DEFAULT_BUILD_TARGETS,
  knownTargetNames,
} from "../lib/build/targets/index.js"
import { assertRouteMarkerFileLimits } from "../lib/build/targets/marker-files.js"
import { resolveVercelOutputDir } from "../lib/build/targets/vercel.js"
import { resolveVercelBuildConfig } from "../lib/build/targets/vercel-config.js"
import { captureWorkspaceArtifact } from "../lib/build/workspace-artifact.js"
import { loadOptionalB4Config } from "../lib/node-config.js"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"
import { runTypegen } from "../lib/typegen/run-typegen.js"

interface BuildOptions {
  readonly clean?: boolean
  readonly cwd?: string
  readonly outDir?: string
}

export function registerBuildCommand(program: Command, io: CommandIo): void {
  program
    .command("build")
    .description(
      "Generate deployment artifacts (node + langsmith by default; hono + vercel opt-in via build.targets)",
    )
    .option("--clean", "Remove .b4/build/ before generating")
    .option("--cwd <path>", "Path to the B4.run app root")
    .option(
      "--out-dir <dir>",
      "Where the vercel target publishes its Build Output tree, relative to the app root (default: .vercel/output; overrides build.vercel.outDir)",
    )
    .action(async (options: BuildOptions) => {
      await runBuildCommand(options, io)
    })
}

export async function runBuildCommand(options: BuildOptions, io: CommandIo): Promise<void> {
  const manifest = await discoverRoutes({
    ...(options.cwd ? { appRoot: options.cwd } : {}),
  })

  const config = await loadOptionalB4Config(manifest.appRoot)
  const vercelBuildConfig = resolveVercelBuildConfig(config?.build)

  // The config type only admits known names, but a JS config or a JSON one
  // arrives untyped — so validate the ENTIRE list up front, before emitting
  // anything: an unknown target must fail fast, not after earlier targets
  // already wrote files to disk.
  const configuredTargets: readonly string[] = config?.build?.targets ?? DEFAULT_BUILD_TARGETS
  const targetNames: BuildTargetName[] = []
  for (const name of configuredTargets) {
    if (!isBuildTargetName(name)) {
      throw new CliError(
        `Unknown build target "${name}". Known targets: ${knownTargetNames().join(", ")}.`,
      )
    }
    targetNames.push(name)
  }

  if (options.outDir !== undefined && !targetNames.includes("vercel")) {
    throw new CliError(
      `--out-dir only applies to the "vercel" build target, which is not configured. Add "vercel" to build.targets in b4.config.ts or drop the flag.`,
    )
  }
  const vercelOutputDir = targetNames.includes("vercel")
    ? resolveVercelOutputDir({
        appRoot: manifest.appRoot,
        ...(options.outDir !== undefined
          ? { outDir: options.outDir, source: "--out-dir" as const }
          : vercelBuildConfig.outDir !== undefined
            ? { outDir: vercelBuildConfig.outDir, source: "build.vercel.outDir" as const }
            : {}),
      })
    : undefined

  if (targetNames.length === 0) {
    writeLine(io.stderr, "no build targets configured; nothing emitted")
    return
  }

  // Validate all bundled markers before typegen, cleaning prior output, or any
  // target emission: an earlier node target must not leave a partial build.
  if (targetNames.some((name) => name === "hono" || name === "vercel")) {
    await assertRouteMarkerFileLimits({ appRoot: manifest.appRoot, manifest })
  }

  let workspaceArtifact: Awaited<ReturnType<typeof captureWorkspaceArtifact>> | undefined
  if (config?.sandbox?.workspace) {
    if (targetNames.some((name) => name !== "node"))
      throw new CliError('Managed workspaces require build.targets: ["node"]')
    if (!config.sandbox.provider.workspaces)
      throw new CliError("Sandbox provider does not support managed workspaces")
    if (!(await stat(join(manifest.appRoot, "workspace"))).isDirectory())
      throw new CliError("Managed workspaces require app-root workspace/ capability")
    workspaceArtifact = await captureWorkspaceArtifact(manifest.appRoot, config.sandbox.workspace)
  }

  // Run typegen as pre-step to produce .b4/routes/<id>/tools.json and .b4/b4.generated.d.ts
  await runTypegen({ appRoot: manifest.appRoot, manifest })

  const buildDir = resolve(manifest.appRoot, ".b4", "build")

  if (options.clean) {
    await rm(buildDir, { recursive: true, force: true })
  }

  await mkdir(buildDir, { recursive: true })

  const ctx: BuildEmitContext = {
    appRoot: manifest.appRoot,
    buildDir,
    io,
    manifest,
    ...(vercelOutputDir ? { vercelOutputDir } : {}),
    ...(workspaceArtifact ? { workspaceArtifact } : {}),
    ...(config?.build ? { buildConfig: config.build } : {}),
  }

  const emitted: string[] = []
  for (const name of targetNames) {
    const { artifacts } = await buildTargets[name].emit(ctx)
    emitted.push(...artifacts)
  }

  writeLine(io.stdout, `Build complete: ${relative(process.cwd(), buildDir)}`)
  writeLine(io.stdout, `  ${manifest.routes.length} route(s) compiled`)
  writeLine(io.stdout, `  targets: ${targetNames.join(", ")}`)
  for (const artifact of emitted) {
    writeLine(io.stdout, `  wrote ${relative(process.cwd(), artifact)}`)
  }
}
