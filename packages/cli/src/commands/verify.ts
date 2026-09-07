import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { RouteManifest, RouteToolTypes } from "@b4run/core"
import { renderB4Types } from "@b4run/core"
import { discoverRoutes, extractToolTypesForRoute, findB4App } from "@b4run/core/node"
import type { B4ErrorCode } from "@b4run/sdk"
import type { SandboxProvider } from "@b4run/workspace"
import { type Command, CommanderError } from "commander"
import { loadB4Config } from "../lib/node-config.js"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { collectRouteProviders } from "../lib/runtime/collect-route-providers.js"
import { collectUnknownModelIdWarnings } from "../lib/runtime/warn-unknown-model-ids.js"
import { checkDependencies } from "../lib/verify/check-dependencies.js"
import { checkRuntime, type RuntimeCheckResult } from "../lib/verify/check-runtime.js"

interface VerifyOptions {
  readonly cwd?: string
  readonly json?: boolean
  readonly envFile?: string
}

interface VerifyCheckCounts {
  readonly failed: number
  readonly passed: number
  readonly total: number
}

interface VerifyAppCheckResult {
  readonly appRoot: string
  readonly configPath: string
  readonly b4Dir: string
  readonly name: "app"
  readonly routesDir: string
  readonly status: "passed"
}

interface VerifyRoutesCheckResult {
  readonly name: "routes"
  readonly routeCount: number
  readonly status: "passed"
}

interface VerifyTypegenCheckResult {
  readonly name: "typegen"
  readonly renderedBytes: number
  readonly status: "passed"
}

interface VerifyDepsCheckResult {
  readonly missingEnvVars: readonly string[]
  readonly missingPackages: readonly string[]
  readonly name: "deps"
  readonly status: "passed" | "warning"
}

interface VerifyFailedCheckResult {
  readonly error: {
    readonly message: string
  }
  readonly name: "app" | "deps" | "routes" | "typegen"
  readonly status: "failed"
}

type VerifyCheckResult =
  | RuntimeCheckResult
  | VerifyAppCheckResult
  | VerifyDepsCheckResult
  | VerifyFailedCheckResult
  | VerifyRoutesCheckResult
  | VerifyTypegenCheckResult

type B4App = Awaited<ReturnType<typeof findB4App>>

interface VerifySuccessResult {
  readonly appRoot: string
  readonly checks: readonly VerifyCheckResult[]
  readonly counts: VerifyCheckCounts
  readonly status: "passed"
}

interface VerifyFailureResult {
  readonly appRoot: string
  readonly checks: readonly VerifyCheckResult[]
  readonly counts: VerifyCheckCounts
  readonly status: "failed"
}

interface VerifyAppOutcome {
  readonly manifest?: RouteManifest
  readonly result: VerifyFailureResult | VerifySuccessResult
}

const FAILED_STATUS = "failed" as const
const PASSED_STATUS = "passed" as const

export function registerVerifyCommand(program: Command, io: CommandIo): void {
  program
    .command("verify")
    .description("Verify B4.run app integrity")
    .option("--cwd <path>", "Path to the B4.run app root or a child directory within it")
    .option("--json", "Print the normalized verify result as JSON")
    .option(
      "--env-file <path>",
      "Path to a .env file (overrides b4.config.ts env and the default ./.env)",
    )
    .action(async (options: VerifyOptions) => {
      await runVerifyCommand(options, io)
    })
}

export async function runVerifyCommand(options: VerifyOptions, io: CommandIo): Promise<void> {
  if (options.json) {
    const { result } = await verifyApp(options)
    writeLine(io.stdout, JSON.stringify(result, null, 2))

    if (result.status === FAILED_STATUS) {
      throw new CommanderError(1, "b4.verify.failed", "")
    }

    return
  }

  const { manifest, result } = await verifyApp(options)

  if (result.status === PASSED_STATUS) {
    const routesCheck = result.checks.find(
      (check): check is VerifyRoutesCheckResult => check.name === "routes",
    )
    const depsCheck = result.checks.find(
      (check): check is VerifyDepsCheckResult => check.name === "deps",
    ) as VerifyDepsCheckResult | undefined

    writeLine(
      io.stdout,
      `B4.run app integrity OK: ${result.counts.passed} checks passed, ${routesCheck?.routeCount ?? 0} routes discovered.`,
    )

    if (depsCheck && depsCheck.missingPackages.length > 0) {
      writeLine(
        io.stdout,
        `Warning: Missing packages: ${depsCheck.missingPackages.join(", ")}. Install with: npm install ${depsCheck.missingPackages.join(" ")}`,
      )
    }

    if (depsCheck && depsCheck.missingEnvVars.length > 0) {
      writeLine(
        io.stdout,
        `Warning: Missing environment variables: ${depsCheck.missingEnvVars.join(", ")}. Create a .env file or set these in your shell.`,
      )
    }

    const runtimeCheck = result.checks.find(
      (check): check is RuntimeCheckResult => check.name === "runtime",
    )
    if (runtimeCheck) {
      writeLine(
        io.stdout,
        `Runtime: Node ${runtimeCheck.node.version} OK (floor ${runtimeCheck.node.floor}).`,
      )
      if (runtimeCheck.docker) {
        writeLine(io.stdout, `Sandbox: Docker ${runtimeCheck.docker.detail}.`)
      }
    }

    if (manifest) {
      // Advisory model-id pass shared with `b4 check`; never affects the result.
      const modelIdWarnings = await collectUnknownModelIdWarnings(manifest)
      for (const warning of modelIdWarnings) {
        writeLine(io.stdout, `\n${warning}`)
      }
    }

    return
  }

  const code = getFailureCode(result)
  throw new CliError(`Verify failed: ${getFailureMessage(result)}`, 1, code ? { code } : {})
}

async function verifyApp(options: VerifyOptions): Promise<VerifyAppOutcome> {
  let app: B4App

  try {
    app = await findB4App(options.cwd ? { cwd: options.cwd } : {})
  } catch (error) {
    return {
      result: createVerifyFailureResult(
        inferFailureAppRoot(options, formatErrorMessage(error)),
        [],
        "app",
        error,
      ),
    }
  }

  const checks: VerifyCheckResult[] = [
    {
      appRoot: app.appRoot,
      configPath: app.configPath,
      b4Dir: app.b4Dir,
      name: "app",
      routesDir: app.routesDir,
      status: PASSED_STATUS,
    },
  ]

  let manifest: Awaited<ReturnType<typeof discoverRoutes>>

  try {
    manifest = await discoverRoutes({ appRoot: app.appRoot })
  } catch (error) {
    return { result: createVerifyFailureResult(app.appRoot, checks, "routes", error) }
  }

  checks.push({
    name: "routes",
    routeCount: manifest.routes.length,
    status: PASSED_STATUS,
  })

  let renderedTypes: string

  try {
    const sharedToolsDir = join(app.appRoot, "src")
    const routeToolTypes: RouteToolTypes[] = []
    for (const route of manifest.routes) {
      const tools = await extractToolTypesForRoute({
        routeDir: route.routeDir,
        sharedToolsDir,
      })
      routeToolTypes.push({ pathname: route.pathname, tools })
    }
    renderedTypes = renderB4Types(manifest, routeToolTypes)
  } catch (error) {
    return { manifest, result: createVerifyFailureResult(app.appRoot, checks, "typegen", error) }
  }

  checks.push({
    name: "typegen",
    renderedBytes: Buffer.byteLength(renderedTypes, "utf8"),
    status: PASSED_STATUS,
  })

  // Derive the providers the app's routes actually use, so the deps check flags
  // the API key the app needs (e.g. ANTHROPIC_API_KEY) rather than a hardcoded one.
  const providers = await collectRouteProviders(manifest)

  // Check dependencies and environment variables (advisory, not blocking)
  const depsResult = await checkDependencies({
    appRoot: app.appRoot,
    providers,
    ...(options.envFile !== undefined ? { envFile: options.envFile } : {}),
  })
  const hasWarnings = depsResult.missingPackages.length > 0 || depsResult.missingEnvVars.length > 0
  checks.push({
    missingEnvVars: depsResult.missingEnvVars,
    missingPackages: depsResult.missingPackages,
    name: "deps",
    status: hasWarnings ? "warning" : PASSED_STATUS,
  } as VerifyDepsCheckResult)

  // Environment-readiness gate: Node floor + (when a sandbox is configured) the
  // provider's Docker/daemon preflight — resolved the same way collect-sandbox-errors
  // does, from b4.config.ts's sandbox.provider. A failed runtime check fails verify.
  const sandboxProvider = await resolveSandboxProvider(app.appRoot)
  const runtime = await checkRuntime(sandboxProvider ? { sandboxProvider } : {})
  checks.push(runtime)

  const failed = checks.filter((check) => check.status === FAILED_STATUS).length
  const counts: VerifyCheckCounts = {
    failed,
    passed: checks.length - failed,
    total: checks.length,
  }

  if (failed > 0) {
    return {
      manifest,
      result: { appRoot: app.appRoot, checks, counts, status: FAILED_STATUS },
    }
  }

  return {
    manifest,
    result: { appRoot: app.appRoot, checks, counts, status: PASSED_STATUS },
  }
}

/** Resolve b4.config.ts's sandbox provider (name + preflight), if configured. */
async function resolveSandboxProvider(
  appRoot: string,
): Promise<Pick<SandboxProvider, "preflight" | "name"> | undefined> {
  try {
    const loaded = await loadB4Config({ appRoot })
    return loaded.config.sandbox?.provider
  } catch {
    return undefined
  }
}

function createVerifyFailureResult(
  appRoot: string,
  checks: readonly VerifyCheckResult[],
  name: VerifyFailedCheckResult["name"],
  error: unknown,
): VerifyFailureResult {
  const message = formatErrorMessage(error)
  const nextChecks: VerifyCheckResult[] = [
    ...checks,
    {
      error: {
        message,
      },
      name,
      status: FAILED_STATUS,
    },
  ]
  const passed = nextChecks.filter((check) => check.status === PASSED_STATUS).length

  return {
    appRoot,
    checks: nextChecks,
    counts: {
      failed: 1,
      passed,
      total: nextChecks.length,
    },
    status: FAILED_STATUS,
  }
}

function getFailureMessage(result: VerifyFailureResult): string {
  const failedCheck = [...result.checks].reverse().find((check) => check.status === FAILED_STATUS)

  if (failedCheck?.name === "runtime") {
    return runtimeFailureMessage(failedCheck)
  }
  // Only VerifyFailedCheckResult carries an `error` field.
  if (failedCheck && "error" in failedCheck) {
    return failedCheck.error.message
  }
  return "Verification failed."
}

function runtimeFailureMessage(runtime: RuntimeCheckResult): string {
  const reasons: string[] = []
  if (!runtime.node.ok) {
    reasons.push(`Node ${runtime.node.version} is below the required floor ${runtime.node.floor}.`)
  }
  if (runtime.docker && !runtime.docker.ok) {
    reasons.push(`Docker sandbox unavailable: ${runtime.docker.detail}.`)
  }
  return reasons.join(" ") || "Runtime check failed."
}

/**
 * The B4_E code for a failed verify result, when the failure is
 * attributable to a registered code. Only the runtime check currently
 * carries codes; a stale Node takes priority over an unreachable sandbox
 * daemon since it is reported first in `runtimeFailureMessage`.
 */
function getFailureCode(result: VerifyFailureResult): B4ErrorCode | undefined {
  const failedCheck = [...result.checks].reverse().find((check) => check.status === FAILED_STATUS)

  if (failedCheck?.name === "runtime") {
    return failedCheck.node.code ?? failedCheck.docker?.code
  }
  return undefined
}

function inferFailureAppRoot(options: VerifyOptions, message: string): string {
  const fromMessage = /^Invalid B4.run app at (.+?)\. Missing: /u.exec(message)?.[1]

  if (fromMessage) {
    return fromMessage
  }

  return findAppRootFromCwd(options.cwd) ?? resolve(options.cwd ?? process.cwd())
}

function findAppRootFromCwd(cwd = process.cwd()): string | null {
  let currentDir = resolve(cwd)

  while (true) {
    if (existsSync(join(currentDir, "b4.config.ts"))) {
      return currentDir
    }

    const parentDir = dirname(currentDir)

    if (parentDir === currentDir) {
      return null
    }

    currentDir = parentDir
  }
}
