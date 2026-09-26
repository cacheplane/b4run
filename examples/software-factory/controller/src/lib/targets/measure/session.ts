import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join, posix } from "node:path"
import { withWorkspace } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { inspectWorkspace } from "@b4run/workspace"
import { shellJoin } from "../../verification/checks-runner.js"
import { captureDirectory } from "../archive.js"
import type { TargetRecipe } from "../catalog.js"
import {
  TAMPER_INSPECTION_LIMITS,
  targetInspectionOptions,
  targetSandboxPolicy,
  targetWorkspace,
  type WorkspaceTask,
} from "../workspace.js"
import { MeasureError, type TestCounts, type VitestRun } from "./classify.js"

/**
 * One container session over a fresh capture of the target, in the verifier's shape: the
 * target's image by id, the network denied, the workspace inspected as the verifier inspects it.
 */
export interface MeasureSession {
  /** The target's build (`commands.build`) from its command directory. */
  build(): Promise<{
    readonly ok: boolean
    readonly exitCode: number
    readonly output: string
    readonly ms: number
  }>
  /** The files a `vitest list --filesOnly` argv lists, relative to the command directory, sorted. */
  listFiles(argv: readonly string[]): Promise<string[]>
  /** A vitest argv run with a JSON report attached; the report's raw text is returned too. */
  vitest(argv: readonly string[]): Promise<VitestRun>
  /** The workspace's files and digests, as the verifier's tamper check sees them. */
  snapshot(): Promise<Readonly<Record<string, string>>>
  /** The container's cgroup v2 `memory.peak`, in bytes. */
  memoryPeakBytes(): Promise<number>
}

export interface SessionLimits {
  readonly memoryMb: number
  readonly cpus: number
  /** The sandbox's per-command timeout. */
  readonly commandTimeoutMs: number
}

/** Open a session with `limits`, run `use` in it, and tear it down whatever happens. */
export type OpenSession = <T>(
  limits: SessionLimits,
  use: (session: MeasureSession) => Promise<T>,
) => Promise<T>

/**
 * A name `vitest list --filesOnly` printed, without the `[<project>] ` prefix vitest puts before
 * each line when the config names a project: a file name is never passed on with it.
 */
export function withoutProject(name: string): string {
  return name.replace(/^\[[^\]\n]*\] /, "")
}

/**
 * `absolute`, a path vitest named, relative to `directory` (the command directory's absolute
 * path in the container). A path outside it is the harness's failure, not a file's verdict.
 */
export function relativeTo(directory: string, absolute: string): string {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`
  if (!absolute.startsWith(prefix) || absolute.length === prefix.length)
    throw new MeasureError(`vitest named ${absolute}, which is not a file under ${prefix}`)
  return absolute.slice(prefix.length)
}

/** vitest's JSON reporter output, as far as a measurement reads it. */
export interface VitestJsonReport {
  readonly testResults?: readonly {
    readonly name: string
    readonly status: string
    readonly assertionResults?: readonly { readonly status: string }[]
  }[]
}

/**
 * The files a JSON report names, relative to `directory`. `passed` is vitest's own per-file
 * status, exactly: vitest 4 marks a file whose tests are all skipped or todo "passed", and a
 * file that throws on import or has no test "failed". The counts are the file's tests.
 */
export function reportFiles(
  report: VitestJsonReport,
  directory: string,
): NonNullable<VitestRun["files"]> {
  return (report.testResults ?? []).map((result) => {
    const statuses = (result.assertionResults ?? []).map((a) => a.status)
    const passed = statuses.filter((status) => status === "passed").length
    const failed = statuses.filter((status) => status === "failed").length
    // skipped, pending, todo and disabled alike: tests that did not run
    const tests: TestCounts = { passed, failed, skipped: statuses.length - passed - failed }
    return { file: relativeTo(directory, result.name), passed: result.status === "passed", tests }
  })
}

/** What a measurement session captures: the target with no task behind it, no defect. */
export function measureTask(recipe: TargetRecipe): WorkspaceTask {
  return {
    id: `measure-${recipe.id.replace(/[^\w-]/g, "_")}`,
    target: recipe,
    specText: `target:measure of ${recipe.id} at ${recipe.pin}\n`,
    defectPatch: null,
  }
}

/** `text` as JSON, or the harness's failure naming `what` (a truncated report is not a verdict). */
function parseReport(text: string, what: string, output: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new MeasureError(`${what} is not JSON: ${String(error)}`, output)
  }
}

/**
 * Sessions in `imageId` (by id, never by tag) over a fresh capture of `recipe` each, staged
 * under `stagingRoot` (`FACTORY_STATE_DIR`, never the app root), with the network denied as in
 * every target session and the measurement's own memory, CPUs and per-command timeout.
 */
export function dockerSessions(options: {
  readonly recipe: TargetRecipe
  readonly imageId: string
  readonly stagingRoot: string
  /** The repository the capture is archived from: the one the recipe's pin was read in. */
  readonly repositoryRoot: string
  readonly signal: AbortSignal
}): OpenSession {
  const { recipe, stagingRoot, signal } = options
  const provider = dockerSandbox({ scope: "software-factory-measure", image: options.imageId })
  const task = measureTask(recipe)
  const inspection = targetInspectionOptions(task)
  const cd = recipe.commands.cwd === "." ? "" : `${shellJoin(["cd", recipe.commands.cwd])} && `
  return async (limits, use) => {
    const instance = randomUUID()
    const stateRoot = join(stagingRoot, "measurements", "sessions", randomUUID())
    try {
      return await withWorkspace(
        {
          appRoot: stagingRoot,
          stateRoot,
          provider,
          workspace: targetWorkspace(task, "measure", {
            instance,
            captureRoot: stagingRoot,
            repositoryRoot: options.repositoryRoot,
          }),
          policy: {
            ...targetSandboxPolicy(recipe),
            resources: {
              memoryMb: limits.memoryMb,
              cpus: limits.cpus,
              timeoutMs: limits.commandTimeoutMs,
            },
          },
          signal,
        },
        async (handle) => {
          // The command directory in the container: vitest names files by absolute path in it.
          const directory =
            recipe.commands.cwd === "."
              ? handle.workspaceRoot
              : posix.join(handle.workspaceRoot, recipe.commands.cwd)
          const shell = async (command: string) => {
            const started = performance.now()
            const result = await handle.exec.runCommand(
              { command },
              { workspaceRoot: handle.workspaceRoot, signal },
            )
            return { ...result, ms: Math.round(performance.now() - started) }
          }
          /**
           * `line`, then a marker and the file at `path`, both named with a per-run nonce, as the
           * verifier's `runVitestSuite` does. The same limitation holds (checks-runner.ts): the
           * nonce is in the run's argv, so a process the run leaves behind can read it and write
           * the report at `path` in /tmp. Closing that needs the tests run as a uid that cannot
           * reach the report, a follow-up shared with the verifier.
           */
          const withReport = async (line: string, path: string) => {
            const marker = `B4_FACTORY_MEASURE_${randomUUID().replaceAll("-", "")}`
            const result = await shell(
              [
                `rm -f ${path}`,
                line,
                "code=$?",
                "echo",
                `echo ${marker}`,
                `cat ${path} 2>/dev/null`,
                "exit $code",
              ].join("; "),
            )
            const at = result.stdout.lastIndexOf(`${marker}\n`)
            return {
              ...result,
              output: `${at === -1 ? result.stdout : result.stdout.slice(0, at)}\n${result.stderr}`,
              report: at === -1 ? "" : result.stdout.slice(at + marker.length + 1),
            }
          }
          return await use({
            async build() {
              if (recipe.commands.build.length === 0)
                return { ok: true, exitCode: 0, output: "(no build step)\n", ms: 0 }
              const result = await shell(`${cd}${shellJoin(recipe.commands.build)}`)
              return {
                ok: result.exitCode === 0,
                exitCode: result.exitCode,
                output: `${result.stdout}\n${result.stderr}`,
                ms: result.ms,
              }
            },
            async listFiles(argv) {
              const path = `/tmp/b4-factory-measure-list.${randomUUID()}.json`
              const result = await withReport(
                `${cd}${shellJoin([...argv, `--json=${path}`])}`,
                path,
              )
              if (result.exitCode !== 0 || result.report.trim() === "")
                throw new MeasureError(
                  `vitest list failed (exit ${result.exitCode})`,
                  result.output,
                )
              const listed = parseReport(result.report, "vitest list's report", result.output)
              if (
                !Array.isArray(listed) ||
                !listed.every(
                  (entry) =>
                    typeof entry === "object" &&
                    entry !== null &&
                    typeof (entry as { file?: unknown }).file === "string",
                )
              )
                throw new MeasureError("vitest list's report is not a list of files", result.output)
              return (listed as { readonly file: string }[])
                .map((entry) => relativeTo(directory, entry.file))
                .sort()
            },
            async vitest(argv): Promise<VitestRun> {
              const path = `/tmp/b4-factory-measure-report.${randomUUID()}.json`
              const result = await withReport(
                `${cd}${shellJoin([...argv, "--reporter=default", "--reporter=json", `--outputFile=${path}`])}`,
                path,
              )
              const report =
                result.report.trim() === ""
                  ? null
                  : (parseReport(
                      result.report,
                      "vitest's JSON report",
                      result.output,
                    ) as VitestJsonReport)
              return {
                exitCode: result.exitCode,
                output: result.output,
                timedOut: result.exitCode === 124 && /Command timed out after/.test(result.stderr),
                files: report === null ? null : reportFiles(report, directory),
                report: result.report,
                ms: result.ms,
              }
            },
            async snapshot() {
              return (
                await inspectWorkspace(handle, {
                  signal,
                  // The verifier's own limits and options (grade-suite.ts), so a measurement
                  // sees exactly what a verification's tamper check sees.
                  ...TAMPER_INSPECTION_LIMITS,
                  ...inspection,
                })
              ).files
            },
            async memoryPeakBytes() {
              const result = await shell("cat /sys/fs/cgroup/memory.peak")
              const bytes = Number(result.stdout.trim())
              if (result.exitCode !== 0 || !Number.isSafeInteger(bytes) || bytes <= 0)
                throw new MeasureError(
                  `Cannot read this session's cgroup v2 memory.peak (exit ${result.exitCode}): target:measure proposes memory from it and will not guess`,
                  `${result.stdout}\n${result.stderr}`,
                )
              return bytes
            },
          })
        },
      )
    } finally {
      // Settled, never awaited alone: a failed cleanup must not replace the measurement's error.
      await Promise.allSettled([
        rm(stateRoot, { recursive: true, force: true }),
        rm(join(stagingRoot, captureDirectory(task.id, "measure", instance)), {
          recursive: true,
          force: true,
        }),
      ])
    }
  }
}
