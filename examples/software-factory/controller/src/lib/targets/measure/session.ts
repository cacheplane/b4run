import { MeasureError, type TestCounts, type VitestRun } from "./classify.js"

/**
 * One container session over a fresh capture of the target, in the verifier's shape: the
 * target's image by id, the network denied, the workspace inspected as the verifier inspects it.
 */
export interface MeasureSession {
  /** The target's build (`commands.build`) from its command directory. */
  build(): Promise<{ readonly ok: boolean; readonly output: string; readonly ms: number }>
  /** The files a `vitest list --filesOnly` argv lists, relative to the command directory, sorted. */
  listFiles(argv: readonly string[]): Promise<string[]>
  /** A vitest argv run with a JSON report attached. */
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
